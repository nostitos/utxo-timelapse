#include <app/BlockEncoder.h>
#include <app/Cfg.h>
#include <app/Utxo.h>
#include <app/fetchAllBlockHeaders.h>
#include <util/BlockHeightProgressBar.h>
#include <util/HttpClient.h>
#include <util/Throttle.h>
#include <util/args.h>
#include <util/hex.h>
#include <util/kbhit.h>
#include <util/log.h>
#include <util/parallelToSequential.h>
#include <util/reserve.h>
#include <util/rss.h>

#include <doctest.h>
#include <fmt/format.h>
#include <simdjson.h>
#include <unordered_map>

#include <filesystem>
#include <fstream>
#include <limits>
#include <string_view>

using namespace std::literals;

namespace {

// 5781.343 src/cpp/app/utxo_to_change.cpp(134) |     660105 height,    7788404 bytes,   6377.508 MB max RSS, utxo: (  80314186
// txids,  115288432 vout's used,  117964800 allocated (  18 bulk))

struct VoutsToAdd {
    buv::TxIdPrefix txIdPrefix{};
    std::vector<int64_t> satoshi{};
};

struct PreprocessedBlockData {
    buv::ChangesInBlock cib{};
    // robin_hood::unordered_node_map<buv::TxIdPrefix, std::vector<uint16_t>> voutsToRemove{};
    std::unordered_map<buv::TxIdPrefix, std::vector<uint16_t>> voutsToRemove{};
    std::vector<VoutsToAdd> voutsToAdd{};
};

[[nodiscard]] auto preprocessBlockData(simdjson::dom::element const& blockData) -> PreprocessedBlockData {
    auto pbd = PreprocessedBlockData();
    auto& bd = pbd.cib.beginBlock(blockData["height"].get_uint64());

    bd.hash = util::fromHex<32>(blockData["hash"].get_string().value().data());
    bd.merkleRoot = util::fromHex<32>(blockData["merkleroot"].get_string().value().data());
    bd.chainWork = util::fromHex<32>(blockData["chainwork"].get_string().value().data());
    bd.difficulty(blockData["difficulty"].get_double());
    bd.version = blockData["version"].get_uint64();
    bd.time = blockData["time"].get_uint64().value();
    bd.medianTime = blockData["mediantime"].get_uint64().value();
    bd.nonce = blockData["nonce"].get_uint64();
    bd.bits = util::fromHex<4>(blockData["bits"].get_string().value().data());
    bd.nTx = blockData["nTx"].get_uint64();
    bd.size = blockData["size"].get_uint64();
    bd.strippedSize = blockData["strippedsize"].get_uint64();
    bd.weight = blockData["weight"].get_uint64();

    auto isCoinbaseTx = true;
    for (auto const& tx : blockData["tx"]) {
        if (!isCoinbaseTx) {
            // first transaction is coinbase, has no inputs
            for (auto const& vin : tx["vin"]) {
                // txid & voutNr exactly define what is spent
                auto sourceTxid = util::fromHex<buv::txidPrefixSize>(vin["txid"].get_c_str());
                auto sourceVout = static_cast<uint16_t>(vin["vout"].get_uint64());

                // This is the limiting factor: this has to iterate the linked list.
                // Is there a way to parallelize this? Not easily.
                //
                // One optimization might be make this a two step process: create a map of all data that we want to remove, so we
                // only have to walk through each list once. This should even work well because the utxo should be sorted!
                pbd.voutsToRemove[sourceTxid].push_back(sourceVout);
            }
        } else {
            isCoinbaseTx = false;
        }

        // add all outputs from this transaction to the utxo
        auto txid = util::fromHex<buv::txidPrefixSize>(tx["txid"].get_c_str());

        auto vouts = VoutsToAdd();
        vouts.txIdPrefix = txid;
        for (auto const& vout : tx["vout"]) {
            auto sat = std::llround(vout["value"].get_double() * 100'000'000);
            vouts.satoshi.push_back(sat);
            // we can already add the additions here, no access to utxo needed for that
            pbd.cib.addChange(sat, bd.blockHeight);
        }
        pbd.voutsToAdd.push_back(std::move(vouts));
    }

    // make sure all removals vout's are sorted
    for (auto& vouts : pbd.voutsToRemove) {
        std::sort(vouts.second.begin(), vouts.second.end());
    }

    // this sort is not necessary, but a bit of a performance benefit
    pbd.cib.sort();

    return pbd;
}

struct ResourceData {
    std::unique_ptr<util::HttpClient> cli{};
    simdjson::dom::parser jsonParser{};
    PreprocessedBlockData preprocessedBlockData{};
    std::string error{};
};

} // namespace

TEST_CASE("utxo_to_change" * doctest::skip()) {
    auto cfg = buv::parseCfg(util::args::get("-cfg").value());

    auto cli = util::HttpClient::create(cfg.bitcoinRpcUrl.c_str());
    auto jsonParser = simdjson::dom::parser();

    auto allBlockHeaders = buv::fetchAllBlockHeaders(cli);

    // Variables for checkpoint/resume
    uint32_t startBlockIndex = 0;
    auto utxo = std::make_unique<buv::Utxo>();
    bool isResuming = false;

    // Check for existing checkpoint
    if (!cfg.checkpointFile.empty() && std::filesystem::exists(cfg.checkpointFile)) {
        try {
            LOG("Found checkpoint file {}, attempting to resume...", cfg.checkpointFile);
            auto [checkpointBlockHeight, loadedUtxo] = buv::load(cfg.checkpointFile);
            utxo = std::make_unique<buv::Utxo>(std::move(loadedUtxo));

            // The vector index corresponds to the block height.
            // We want to start from the next block.
            if (checkpointBlockHeight + 1 < allBlockHeaders.size()) {
                startBlockIndex = checkpointBlockHeight + 1;
                LOG("Resuming from block {} (index {})", checkpointBlockHeight + 1, startBlockIndex);
                isResuming = true;
            } else {
                LOG("Checkpoint is at end of chain, starting from scratch or skipping.");
                isResuming = false;
                startBlockIndex = 0;
            }
        } catch (std::exception const& e) {
            LOG("Failed to load checkpoint: {}. Starting from scratch.", e.what());
            utxo = std::make_unique<buv::Utxo>();
            startBlockIndex = 0;
            isResuming = false;
        }
    }

    // Track the offset for block processing (don't erase headers!)
    uint32_t blockOffset = 0;
    size_t numBlocksToProcess = allBlockHeaders.size();

    if (!isResuming && cfg.skipBlocks > 0 && cfg.skipBlocks < allBlockHeaders.size()) {
        blockOffset = cfg.skipBlocks;
        numBlocksToProcess = allBlockHeaders.size() - cfg.skipBlocks;
    } else if (startBlockIndex > 0) {
        blockOffset = startBlockIndex;
        numBlocksToProcess = allBlockHeaders.size() - startBlockIndex;
    }

    auto throttler = util::ThrottlePeriodic(200ms);

    // Open output file in append mode if resuming, otherwise truncate
    auto fout = std::ofstream(cfg.blkFile, std::ios::binary | (isResuming ? std::ios::app : std::ios::out));

    auto resources = std::vector<ResourceData>(cfg.utxoToChangeNumResources);
    for (auto& resource : resources) {
        resource.cli = util::HttpClient::create(cfg.bitcoinRpcUrl.c_str());
    }

    // sum up all nTx for blocks we're actually processing
    auto totalNumTx = size_t();
    for (size_t i = blockOffset; i < allBlockHeaders.size(); ++i) {
        totalNumTx += allBlockHeaders[i].nTx;
    }

    auto numWorkers = cfg.utxoToChangeNumThreads;
    fmt::print("\n");
    auto pbs = util::HeightAndTxProgressBar::create(numWorkers, numBlocksToProcess, totalNumTx);

    // Checkpoint tracking
    uint32_t lastCheckpointBlock = 0;
    auto checkpointInterval = cfg.checkpointIntervalBlocks;

    auto numWorkersSum = size_t();
    auto numWorkersCount = size_t();
    auto numWorkersExponentialAverage = float();

    auto numSallUtxoOptUsed = std::array<size_t, 2>();

    auto numTxProcessed = size_t();
    auto numActiveWorkers = std::atomic<size_t>();

    // Error handling variables
    auto abortFlag = std::atomic<bool>(false);
    auto firstError = std::string();

    util::parallelToSequential(
        util::SequenceId{numBlocksToProcess},
        util::ResourceId{resources.size()},
        util::ConcurrentWorkers{numWorkers},

        [&](util::ResourceId resourceId, util::SequenceId sequenceId) {
            // this is done in parallel, do as much as we can here!
            ++numActiveWorkers;
            auto& res = resources[resourceId.count()];

            if (abortFlag) {
                --numActiveWorkers;
                return;
            }

            res.error.clear(); // Clear previous error

            try {
                // Use blockOffset to get the correct block header
                auto actualBlockIndex = blockOffset + sequenceId.count();
                auto hash = util::toHex(allBlockHeaders[actualBlockIndex].hash);

                auto jsonData = res.cli->get("/rest/block/{}.json", hash);
                simdjson::dom::element blockData = res.jsonParser.parse(jsonData);
                res.preprocessedBlockData = preprocessBlockData(blockData);
            } catch (std::exception const& e) {
                res.error = e.what();
                abortFlag = true;
            } catch (...) {
                res.error = "Unknown exception in parallel worker";
                abortFlag = true;
            }
            --numActiveWorkers;
        },
        [&](util::ResourceId resourceId, util::SequenceId /*sequenceId*/) {
            auto& res = resources[resourceId.count()];

            if (abortFlag) {
                return;
            }

            if (!res.error.empty()) {
                if (firstError.empty())
                    firstError = res.error;
                abortFlag = true;
                return;
            }

            try {
                // done serially, try to do as little as possible here
                auto& cib = res.preprocessedBlockData.cib;

                // integrate block data: all adds (has to be done before the removals!)
                for (auto const& voutToAdd : res.preprocessedBlockData.voutsToAdd) {
                    bool isSmallUtxoOptimizationUsed =
                        utxo->insert(voutToAdd.txIdPrefix, cib.blockData().blockHeight, voutToAdd.satoshi);

                    ++numSallUtxoOptUsed[isSmallUtxoOptimizationUsed ? 1U : 0U];
                }

                // integrate block data: all removes
                for (auto const& voutToRemove : res.preprocessedBlockData.voutsToRemove) {
                    utxo->removeAllSorted(voutToRemove.first, voutToRemove.second, [&cib](int64_t satoshi, uint32_t blockHeight) {
                        cib.addChange(-satoshi, blockHeight);
                    });
                }
                cib.finalizeBlock();
                fout << cib.encode();

                numTxProcessed += cib.blockData().nTx;

                numWorkersSum += numActiveWorkers;
                numWorkersCount += 1;

                if (throttler() || numTxProcessed >= totalNumTx) {
                    numWorkersExponentialAverage =
                        numWorkersExponentialAverage * 0.95F + (static_cast<float>(numWorkersSum) / numWorkersCount) * 0.05F;
                    pbs->set_progress(numWorkersExponentialAverage, cib.blockData().blockHeight + 1, numTxProcessed);
                    numWorkersSum = 0;
                    numWorkersCount = 0;
                }

                if (util::kbhit()) {
                    std::getchar();
                    for (size_t i = 0; i < numSallUtxoOptUsed.size(); ++i) {
                        fmt::print("\n{:3}: {:12}", i, numSallUtxoOptUsed[i]);
                    }
                    fmt::print("\n\n\n\n\n");
                }

                // Periodic checkpoint saving
                if (!cfg.checkpointFile.empty() && checkpointInterval > 0) {
                    auto currentBlock = cib.blockData().blockHeight;
                    if (currentBlock - lastCheckpointBlock >= checkpointInterval) {
                        fout.flush(); // Ensure output is written before checkpoint
                        buv::serialize(currentBlock, *utxo, cfg.checkpointFile);
                        lastCheckpointBlock = currentBlock;
                    }
                }
            } catch (std::exception const& e) {
                if (firstError.empty())
                    firstError = e.what();
                abortFlag = true;
            } catch (...) {
                if (firstError.empty())
                    firstError = "Unknown exception in sequential worker";
                abortFlag = true;
            }
        });

    if (abortFlag) {
        throw std::runtime_error(fmt::format("Processing aborted due to worker error: {}", firstError));
    }

    pbs = {};

    LOG("Done!");
}

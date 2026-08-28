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
#include <util/writeBinary.h>

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

// Validates that the existing changes.blk1 tail matches the checkpoint exactly:
// the record at cp.lastRecordOffset must be block cp.blockHeight with cp.blockHash,
// and must end exactly at cp.blkFileSize. Throws with a descriptive message otherwise.
// Returns the on-disk file size (which may be larger; the caller truncates).
auto validateBlkTail(buv::Checkpoint const& cp, std::filesystem::path const& blkFile) -> uint64_t {
    if (!std::filesystem::exists(blkFile)) {
        throw std::runtime_error(fmt::format("checkpoint expects blk file '{}', but it does not exist", blkFile.string()));
    }
    auto onDiskSize = static_cast<uint64_t>(std::filesystem::file_size(blkFile));
    if (onDiskSize < cp.blkFileSize) {
        throw std::runtime_error(fmt::format(
            "blk file '{}' is smaller ({} bytes) than the checkpoint expects ({} bytes); file and checkpoint do not belong together",
            blkFile.string(),
            onDiskSize,
            cp.blkFileSize));
    }
    if (cp.lastRecordOffset + 12U + 32U > cp.blkFileSize) {
        throw std::runtime_error("checkpoint lastRecordOffset/blkFileSize are inconsistent");
    }

    auto fin = std::ifstream(blkFile, std::ios::binary);
    if (!fin.is_open()) {
        throw std::runtime_error(fmt::format("could not open blk file '{}' for tail validation", blkFile.string()));
    }
    fin.seekg(static_cast<std::streamoff>(cp.lastRecordOffset));

    // record layout: 4 marker, 4 blockHeight, 4 numBytes, then payload starting with 32-byte block hash
    auto marker = std::array<char, 4>();
    fin.read(marker.data(), marker.size());
    auto recBlockHeight = util::readBinary<uint32_t>(fin);
    auto recNumBytes = util::readBinary<uint32_t>(fin);
    auto recHash = std::array<uint8_t, 32>();
    fin.read(reinterpret_cast<char*>(recHash.data()), recHash.size());
    if (!fin) {
        throw std::runtime_error("blk tail validation: could not read the last record");
    }
    if (std::string_view(marker.data(), 4) != std::string_view("BLK\x02", 4)) {
        throw std::runtime_error("blk tail validation: no BLK record at checkpoint's lastRecordOffset");
    }
    if (recBlockHeight != cp.blockHeight) {
        throw std::runtime_error(fmt::format(
            "blk tail validation: record at tail is block {}, checkpoint is block {}", recBlockHeight, cp.blockHeight));
    }
    if (recHash != cp.blockHash) {
        throw std::runtime_error(fmt::format(
            "blk tail validation: block {} hash mismatch between blk file and checkpoint", recBlockHeight));
    }
    if (cp.lastRecordOffset + 12U + recNumBytes != cp.blkFileSize) {
        throw std::runtime_error(fmt::format(
            "blk tail validation: record at tail ends at {} but checkpoint expects file size {}",
            cp.lastRecordOffset + 12U + recNumBytes,
            cp.blkFileSize));
    }
    return onDiskSize;
}

} // namespace

// Round-trip and tail-validation test for the v2 checkpoint format. Run with:
//   ./buv -ns -tc=checkpoint_v2
TEST_CASE("checkpoint_v2" * doctest::skip()) {
    auto tmpDir = std::filesystem::temp_directory_path() / "buv_checkpoint_v2_test";
    std::filesystem::create_directories(tmpDir);
    auto cpFile = tmpDir / "checkpoint.utxo";
    auto blkFile = tmpDir / "changes.blk1";

    // Build a small UTXO set with known creation heights, incl. a sparse entry.
    auto utxo = buv::Utxo();
    auto txidA = buv::TxIdPrefix{1, 2, 3, 4, 5, 6, 7, 8};
    auto txidB = buv::TxIdPrefix{9, 10, 11, 12, 13, 14, 15, 16};
    auto txidC = buv::TxIdPrefix{17, 18, 19, 20, 21, 22, 23, 24};
    utxo.insert(txidA, 100, {5000000000LL});                                  // coinbase-like, height 100
    utxo.insert(txidB, 200, {123LL, 456LL, 789LL, 1011LL});                   // 4 vouts -> chunk path
    utxo.insert(txidC, 300, {42LL, 77LL});                                    // small-utxo path
    // Partially spend txidB (vouts 0 and 2), leaving a sparse {1,3} set.
    auto spent = std::vector<std::pair<int64_t, uint32_t>>();
    utxo.removeAllSorted(txidB, {0, 2}, [&](int64_t sat, uint32_t height) { spent.emplace_back(sat, height); });
    REQUIRE(spent.size() == 2);
    CHECK(spent[0].second == 200);

    // Write a fake BLK file whose tail is a valid record for block 300.
    auto cib = buv::ChangesInBlock();
    auto& bd = cib.beginBlock(300);
    bd.hash = std::array<uint8_t, 32>{0xAA, 0xBB, 0xCC};
    cib.addChange(42, 300);
    cib.finalizeBlock();
    auto record = cib.encode();
    {
        auto fout = std::ofstream(blkFile, std::ios::binary);
        fout << record;
    }

    // Serialize + load round trip.
    buv::serialize(300, record.size(), 0, bd.hash, utxo, cpFile);
    auto cp = buv::load(cpFile);
    CHECK(cp.blockHeight == 300);
    CHECK(cp.blkFileSize == record.size());
    CHECK(cp.lastRecordOffset == 0);
    CHECK(cp.blockHash == bd.hash);
    CHECK(cp.utxo.map().size() == 3);

    // Creation heights survive the round trip (this is what v1 lost).
    auto checkEntry = [&](buv::TxIdPrefix const& txid, uint32_t expectedHeight, std::vector<std::pair<uint16_t, int64_t>> expected) {
        auto it = cp.utxo.map().find(txid);
        REQUIRE(it != cp.utxo.map().end());
        CHECK(it->second.blockHeight() == expectedHeight);
        auto got = std::vector<std::pair<uint16_t, int64_t>>();
        cp.utxo.removeAllSorted(txid, [&] {
            auto vouts = std::vector<uint16_t>();
            for (auto const& [vout, sat] : expected) {
                vouts.push_back(vout);
            }
            return vouts;
        }(), [&](int64_t sat, uint32_t height) {
            CHECK(height == expectedHeight);
            got.emplace_back(0, sat);
        });
        REQUIRE(got.size() == expected.size());
        for (size_t i = 0; i < expected.size(); ++i) {
            CHECK(got[i].second == expected[i].second);
        }
    };
    checkEntry(txidA, 100, {{0, 5000000000LL}});
    checkEntry(txidB, 200, {{1, 456LL}, {3, 1011LL}});
    checkEntry(txidC, 300, {{0, 42LL}, {1, 77LL}});

    // Tail validation: correct case passes and reports the on-disk size.
    CHECK(validateBlkTail(cp, blkFile) == record.size());

    // Extra bytes after the checkpointed tail are allowed (they get truncated by resume).
    {
        auto fapp = std::ofstream(blkFile, std::ios::binary | std::ios::app);
        fapp << "garbage-after-checkpoint";
    }
    CHECK(validateBlkTail(cp, blkFile) == record.size() + 24);

    // A wrong hash must be rejected.
    auto cpBad = buv::load(cpFile);
    cpBad.blockHash[0] ^= 0xFF;
    CHECK_THROWS(validateBlkTail(cpBad, blkFile));

    // Legacy v1 files must be rejected with a clear error.
    auto v1File = tmpDir / "legacy.utxo";
    {
        auto fout = std::ofstream(v1File, std::ios::binary);
        fout.write("UTXO", 4);
    }
    CHECK_THROWS(static_cast<void>(buv::load(v1File)));

    std::filesystem::remove_all(tmpDir);
    LOG("checkpoint_v2 round trip OK");
}

TEST_CASE("utxo_to_change" * doctest::skip()) {
    auto cfg = buv::parseCfg(util::args::get("-cfg").value());

    auto cli = util::HttpClient::create(cfg.bitcoinRpcUrl.c_str());
    auto jsonParser = simdjson::dom::parser();

    auto allBlockHeaders = buv::fetchAllBlockHeaders(cli);

    // Variables for checkpoint/resume
    uint32_t startBlockIndex = 0;
    auto utxo = std::make_unique<buv::Utxo>();
    bool isResuming = false;
    uint64_t blkBytesWritten = 0; // exact size of the blk file's valid prefix; grows as records are appended
    uint64_t resumedLastRecordOffset = 0;

    // Check for existing checkpoint
    if (!cfg.checkpointFile.empty() && std::filesystem::exists(cfg.checkpointFile)) {
        try {
            LOG("Found checkpoint file {}, attempting to resume...", cfg.checkpointFile);
            auto cp = buv::load(cfg.checkpointFile);

            // chain identity / reorg check: the checkpointed block must still be in the best chain
            if (cp.blockHeight >= allBlockHeaders.size()) {
                throw std::runtime_error(fmt::format(
                    "checkpoint is at block {} but the node only has {} blocks", cp.blockHeight, allBlockHeaders.size()));
            }
            if (allBlockHeaders[cp.blockHeight].hash != cp.blockHash) {
                throw std::runtime_error(fmt::format(
                    "checkpoint block {} is not in the node's best chain (reorg?); a full rebuild is required",
                    cp.blockHeight));
            }

            // BLK tail validation: the on-disk file must end (at cp.blkFileSize) with exactly
            // the checkpointed block. Anything after it was written after the checkpoint and
            // is re-created, so truncate it away.
            auto onDiskSize = validateBlkTail(cp, cfg.blkFile);
            if (onDiskSize > cp.blkFileSize) {
                LOG("Truncating '{}' from {} to {} bytes (records past the checkpoint get re-appended)",
                    cfg.blkFile,
                    onDiskSize,
                    cp.blkFileSize);
                std::filesystem::resize_file(cfg.blkFile, cp.blkFileSize);
            }

            utxo = std::make_unique<buv::Utxo>(std::move(cp.utxo));
            blkBytesWritten = cp.blkFileSize;
            resumedLastRecordOffset = cp.lastRecordOffset;

            // The vector index corresponds to the block height.
            // We want to start from the next block.
            if (cp.blockHeight + 1 < allBlockHeaders.size()) {
                startBlockIndex = cp.blockHeight + 1;
                LOG("Resuming from block {} (index {})", cp.blockHeight + 1, startBlockIndex);
                isResuming = true;
            } else {
                LOG("Checkpoint is at end of chain, nothing to do.");
                return;
            }
        } catch (std::exception const& e) {
            if (!cfg.allowBlkFileTruncate) {
                throw std::runtime_error(fmt::format(
                    "Failed to load checkpoint '{}': {}. Refusing to start from scratch because that would truncate '{}'. "
                    "Fix or remove the checkpoint, or set allowBlkFileTruncate=true to overwrite the blk file.",
                    cfg.checkpointFile,
                    e.what(),
                    cfg.blkFile));
            }
            LOG("Failed to load checkpoint: {}. Starting from scratch because allowBlkFileTruncate=true.", e.what());
            utxo = std::make_unique<buv::Utxo>();
            startBlockIndex = 0;
            isResuming = false;
            blkBytesWritten = 0;
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

    // Open output file in append mode if resuming. Truncation of an existing
    // non-empty blk file requires an explicit config opt-in.
    if (!isResuming && !cfg.allowBlkFileTruncate && std::filesystem::exists(cfg.blkFile) &&
        std::filesystem::file_size(cfg.blkFile) > 0) {
        throw std::runtime_error(fmt::format(
            "Refusing to truncate existing blk file '{}' ({} bytes). Resume from a matching checkpoint, "
            "point blkFile at a new path, or set allowBlkFileTruncate=true to overwrite.",
            cfg.blkFile,
            std::filesystem::file_size(cfg.blkFile)));
    }
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
    uint64_t lastRecordOffset = resumedLastRecordOffset;
    auto lastBlockHash = std::array<uint8_t, 32>();
    uint32_t lastBlockWritten = 0;
    if (isResuming) {
        lastBlockWritten = startBlockIndex - 1;
        lastBlockHash = allBlockHeaders[lastBlockWritten].hash;
        lastCheckpointBlock = lastBlockWritten;
    }

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

            if (!res.error.empty()) {
                if (firstError.empty())
                    firstError = res.error;
                abortFlag = true;
                return;
            }

            if (abortFlag) {
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
                auto encoded = cib.encode();
                auto recordOffset = blkBytesWritten;
                fout << encoded;
                blkBytesWritten += encoded.size();
                lastRecordOffset = recordOffset;
                lastBlockHash = cib.blockData().hash;
                lastBlockWritten = cib.blockData().blockHeight;

                numTxProcessed += cib.blockData().nTx;

                numWorkersSum += numActiveWorkers;
                numWorkersCount += 1;

                if (throttler() || numTxProcessed >= totalNumTx) {
                    numWorkersExponentialAverage =
                        numWorkersExponentialAverage * 0.95F + (static_cast<float>(numWorkersSum) / numWorkersCount) * 0.05F;
                    pbs->set_progress(numWorkersExponentialAverage,
                                      cib.blockData().blockHeight + 1 - blockOffset,
                                      numTxProcessed);
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
                        buv::serialize(currentBlock, blkBytesWritten, lastRecordOffset, lastBlockHash, *utxo, cfg.checkpointFile);
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

    if (firstError.empty()) {
        for (auto const& resource : resources) {
            if (!resource.error.empty()) {
                firstError = resource.error;
                abortFlag = true;
                break;
            }
        }
    }

    if (abortFlag) {
        throw std::runtime_error(fmt::format("Processing aborted due to worker error: {}", firstError));
    }

    pbs = {};

    // Final checkpoint at the exact tip, so the next run resumes with zero replay.
    if (!cfg.checkpointFile.empty() && lastBlockWritten > lastCheckpointBlock) {
        fout.flush();
        buv::serialize(lastBlockWritten, blkBytesWritten, lastRecordOffset, lastBlockHash, *utxo, cfg.checkpointFile);
        LOG("Final checkpoint written at block {}", lastBlockWritten);
    }

    LOG("Done!");
}

#include <app/Cfg.h>
#include <app/UtxoHistory.h>
#include <app/forEachChange.h>
#include <util/Mmap.h>
#include <util/args.h>
#include <util/log.h>

#include <doctest.h>
#include <fmt/format.h>

#include <cstdio>
#include <filesystem>
#include <fstream>
#include <unordered_map>
#include <vector>

using namespace std::literals;

namespace {

// Key for matching spends back to their creation record: (creationHeight, satoshi).
struct HeightAmount {
    uint32_t height;
    int64_t satoshi;

    [[nodiscard]] auto operator==(HeightAmount const& o) const -> bool {
        return height == o.height && satoshi == o.satoshi;
    }
};

struct HeightAmountHash {
    [[nodiscard]] auto operator()(HeightAmount const& ha) const -> size_t {
        // simple mix; both fields matter
        auto h = static_cast<uint64_t>(ha.height) * 0x9E3779B97F4A7C15ULL;
        h ^= static_cast<uint64_t>(ha.satoshi) + 0x9E3779B97F4A7C15ULL + (h << 6U) + (h >> 2U);
        return static_cast<size_t>(h);
    }
};

} // namespace

// Builds utxo_history.bin from changes.blk1. See UtxoHistory.h for the format.
//
// Usage: ./buv -ns -tc=utxo_history -cfg=path/to/config.json
//   reads cfg.blkFile, writes cfg.historyFile
TEST_CASE("utxo_history" * doctest::skip()) {
    auto cfg = buv::parseCfg(util::args::get("-cfg").value());
    if (cfg.historyFile.empty()) {
        throw std::runtime_error("config needs 'historyFile' for utxo_history");
    }

    LOG("mmapping '{}'...", cfg.blkFile);
    auto file = util::Mmap(cfg.blkFile);
    if (!file.is_open()) {
        throw std::runtime_error(fmt::format("could not open '{}'", cfg.blkFile));
    }

    // In-memory build. Records: 16 bytes each. ~1.4B UTXOs ever created would be
    // ~22GB; this machine has 68GB. Grouped by creation height as we stream.
    auto records = std::vector<buv::UtxoHistoryRecord>();
    records.reserve(3'000'000'000ULL / 16ULL); // ~187M safe starting reserve

    auto blockTimes = std::vector<uint32_t>();
    auto heightIndex = std::vector<uint64_t>(); // heightIndex[h] = first record idx of height h

    // open (unspent-so-far) record indices by (creationHeight, amount)
    auto open = std::unordered_map<HeightAmount, std::vector<uint64_t>, HeightAmountHash>();
    open.reserve(200'000'000U);

    auto numSpends = uint64_t();
    auto numUnmatchedSpends = uint64_t();
    auto lastLoggedHeight = uint32_t();

    buv::forEachChange(file, [&](buv::ChangesInBlock const& cib) {
        auto blockHeight = cib.blockData().blockHeight;

        // maintain per-height grouping invariant
        while (heightIndex.size() <= blockHeight) {
            heightIndex.push_back(records.size());
            blockTimes.push_back(cib.blockData().time);
        }
        blockTimes[blockHeight] = cib.blockData().time;

        // Two passes: creations first, then spends. The change list is sorted by
        // amount (spends negative -> first), but a coin created and spent within
        // the same block must have its creation registered before the spend.
        // Zero-amount changes are skipped: Density::change() ignores them, so
        // they never occupy a pixel in the render.
        for (auto const& change : cib.changeAtBlockheights()) {
            auto sat = change.satoshi();
            if (sat > 0) {
                auto idx = records.size();
                records.push_back(buv::UtxoHistoryRecord{blockHeight, buv::kUnspent, sat});
                open[HeightAmount{blockHeight, sat}].push_back(idx);
            }
        }
        for (auto const& change : cib.changeAtBlockheights()) {
            auto sat = change.satoshi();
            if (sat < 0) {
                // spend of a coin created at change.blockHeight() with amount -sat
                ++numSpends;
                auto key = HeightAmount{change.blockHeight(), -sat};
                auto it = open.find(key);
                if (it == open.end() || it->second.empty()) {
                    ++numUnmatchedSpends;
                    continue;
                }
                auto recIdx = it->second.back();
                it->second.pop_back();
                if (it->second.empty()) {
                    open.erase(it);
                }
                records[recIdx].spendHeight = blockHeight;
            }
        }

        if (blockHeight >= lastLoggedHeight + 50000) {
            lastLoggedHeight = blockHeight;
            LOG("block {}: {} records, {} open keys, {} unmatched spends",
                blockHeight,
                records.size(),
                open.size(),
                numUnmatchedSpends);
        }
        return true;
    });

    auto numBlocks = heightIndex.size();
    heightIndex.push_back(records.size()); // terminator

    LOG("done streaming: {} blocks, {} records, {} spends ({} unmatched)",
        numBlocks,
        records.size(),
        numSpends,
        numUnmatchedSpends);

    // write the file
    auto hdr = buv::UtxoHistoryHeader{};
    std::memcpy(hdr.magic, buv::kUtxoHistoryMagic, sizeof(hdr.magic));
    hdr.numBlocks = numBlocks;
    hdr.numRecords = records.size();
    hdr.blockTimesOff = sizeof(buv::UtxoHistoryHeader);
    hdr.heightIndexOff = hdr.blockTimesOff + blockTimes.size() * sizeof(uint32_t);
    hdr.recordsOff = hdr.heightIndexOff + heightIndex.size() * sizeof(uint64_t);

    auto tmpFile = cfg.historyFile + ".tmp";
    {
        auto fout = std::ofstream(tmpFile, std::ios::binary);
        if (!fout.is_open()) {
            throw std::runtime_error(fmt::format("could not open '{}' for writing", tmpFile));
        }
        fout.write(reinterpret_cast<char const*>(&hdr), sizeof(hdr));
        fout.write(reinterpret_cast<char const*>(blockTimes.data()),
                   static_cast<std::streamsize>(blockTimes.size() * sizeof(uint32_t)));
        fout.write(reinterpret_cast<char const*>(heightIndex.data()),
                   static_cast<std::streamsize>(heightIndex.size() * sizeof(uint64_t)));
        fout.write(reinterpret_cast<char const*>(records.data()),
                   static_cast<std::streamsize>(records.size() * sizeof(buv::UtxoHistoryRecord)));
        if (!fout) {
            throw std::runtime_error(fmt::format("write failed for '{}'", tmpFile));
        }
    }
    std::filesystem::rename(tmpFile, cfg.historyFile);
    LOG("wrote {} ({} bytes)", cfg.historyFile, std::filesystem::file_size(cfg.historyFile));
}

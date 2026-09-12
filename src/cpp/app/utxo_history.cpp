#include <app/Cfg.h>
#include <app/UtxoHistory.h>
#include <app/forEachChange.h>
#include <util/Mmap.h>
#include <util/args.h>
#include <util/log.h>

#include <doctest.h>
#include <fmt/format.h>

#include <cstdio>
#include <algorithm>
#include <fcntl.h>
#include <filesystem>
#include <fstream>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include <unistd.h>

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

// RAII file descriptor for positional read/write on the history file.
class HistoryFd {
    int mFd{-1};

public:
    explicit HistoryFd(std::filesystem::path const& p) {
        mFd = ::open(p.c_str(), O_RDWR);
        if (mFd < 0) {
            throw std::runtime_error(fmt::format("could not open '{}' read-write", p.string()));
        }
    }
    ~HistoryFd() {
        if (mFd >= 0) {
            ::close(mFd);
        }
    }
    HistoryFd(HistoryFd const&) = delete;
    auto operator=(HistoryFd const&) -> HistoryFd& = delete;

    void pwriteAll(void const* data, size_t len, uint64_t offset) const {
        auto const* p = static_cast<char const*>(data);
        while (len > 0) {
            auto n = ::pwrite(mFd, p, len, static_cast<off_t>(offset));
            if (n <= 0) {
                throw std::runtime_error("pwrite failed on history file");
            }
            p += n;
            len -= static_cast<size_t>(n);
            offset += static_cast<uint64_t>(n);
        }
    }
    void preadAll(void* data, size_t len, uint64_t offset) const {
        auto* p = static_cast<char*>(data);
        while (len > 0) {
            auto n = ::pread(mFd, p, len, static_cast<off_t>(offset));
            if (n <= 0) {
                throw std::runtime_error("pread failed on history file");
            }
            p += n;
            len -= static_cast<size_t>(n);
            offset += static_cast<uint64_t>(n);
        }
    }
    void sync() const {
        if (0 != ::fsync(mFd)) {
            throw std::runtime_error("fsync failed on history file");
        }
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

// Incrementally extends an existing utxo_history.bin with blocks that were
// added to changes.blk1 after the file was built. Avoids the full ~10 minute
// / 40GB-RAM rebuild when only the chain tip moved.
//
// Usage: ./buv -ns -tc=utxo_history_update -cfg=path/to/config.json
//   reads cfg.blkFile (full changes file), updates cfg.historyFile in place
//
// Crash safety: new records are appended past the advertised numRecords, spend
// stamps written to old records are semantically true (they only describe
// spends at heights beyond the advertised numBlocks), and the header is
// updated last with a single 64-byte write after fsync. A crash at any point
// leaves a file that is still consistent for the old block range; rerunning
// the updater afterwards is safe because it restarts from the advertised
// header state and re-stamps idempotently.
TEST_CASE("utxo_history_update" * doctest::skip()) {
    auto cfg = buv::parseCfg(util::args::get("-cfg").value());
    if (cfg.historyFile.empty()) {
        throw std::runtime_error("config needs 'historyFile' for utxo_history_update");
    }

    // --- read existing header ---
    auto fd = HistoryFd(cfg.historyFile);
    auto hdr = buv::UtxoHistoryHeader{};
    fd.preadAll(&hdr, sizeof(hdr), 0);
    if (0 != std::memcmp(hdr.magic, buv::kUtxoHistoryMagic, sizeof(hdr.magic))) {
        throw std::runtime_error("bad magic in history file");
    }
    auto oldNumBlocks = hdr.numBlocks;
    auto oldNumRecords = hdr.numRecords;
    LOG("existing history: {} blocks, {} records", oldNumBlocks, oldNumRecords);

    // --- read existing height index (small; ~8 bytes per block) ---
    auto heightIndex = std::vector<uint64_t>(oldNumBlocks + 1);
    fd.preadAll(heightIndex.data(), heightIndex.size() * sizeof(uint64_t), hdr.heightIndexOff);
    if (heightIndex[oldNumBlocks] != oldNumRecords) {
        throw std::runtime_error("history file inconsistent: heightIndex terminator != numRecords");
    }
    auto blockTimes = std::vector<uint32_t>(oldNumBlocks);
    fd.preadAll(blockTimes.data(), blockTimes.size() * sizeof(uint32_t), hdr.blockTimesOff);

    // --- stream the delta from the changes file ---
    LOG("mmapping '{}'...", cfg.blkFile);
    auto file = util::Mmap(cfg.blkFile);
    if (!file.is_open()) {
        throw std::runtime_error(fmt::format("could not open '{}'", cfg.blkFile));
    }

    auto newRecords = std::vector<buv::UtxoHistoryRecord>();
    auto newHeightIndex = std::vector<uint64_t>(); // starts at height oldNumBlocks
    auto newBlockTimes = std::vector<uint32_t>();

    // spends of coins created in the delta itself: match in memory (LIFO, like the builder)
    auto openNew = std::unordered_map<HeightAmount, std::vector<uint64_t>, HeightAmountHash>();
    // spends of coins created before oldNumBlocks: (creationHeight -> list of (satoshi, spendHeight))
    auto oldSpends = std::unordered_map<uint32_t, std::vector<std::pair<int64_t, uint32_t>>>();

    auto numSpends = uint64_t();
    auto numUnmatchedSpends = uint64_t();
    auto maxSeenHeight = uint32_t();
    auto numDeltaBlocks = uint64_t();

    // Fast-skip everything the file already covers, decode only the delta.
    {
        auto const* ptr = file.begin();
        auto const* end = file.end();
        auto cib = buv::ChangesInBlock();
        while (ptr != end) {
            auto peek = buv::ChangesInBlock::skip(ptr);
            maxSeenHeight = std::max(maxSeenHeight, peek.first);
            if (peek.first < oldNumBlocks) {
                ptr = peek.second;
                continue;
            }
            std::tie(cib, ptr) = buv::ChangesInBlock::decode(std::move(cib), ptr);
            auto blockHeight = cib.blockData().blockHeight;
            ++numDeltaBlocks;

            auto expected = oldNumBlocks + newHeightIndex.size();
            while (expected <= blockHeight) {
                newHeightIndex.push_back(oldNumRecords + newRecords.size());
                newBlockTimes.push_back(cib.blockData().time);
                ++expected;
            }
            newBlockTimes.back() = cib.blockData().time;

            for (auto const& change : cib.changeAtBlockheights()) {
                auto sat = change.satoshi();
                if (sat > 0) {
                    auto idx = oldNumRecords + newRecords.size();
                    newRecords.push_back(buv::UtxoHistoryRecord{blockHeight, buv::kUnspent, sat});
                    openNew[HeightAmount{blockHeight, sat}].push_back(idx);
                }
            }
            for (auto const& change : cib.changeAtBlockheights()) {
                auto sat = change.satoshi();
                if (sat >= 0) {
                    continue;
                }
                ++numSpends;
                auto createdAt = change.blockHeight();
                if (createdAt >= oldNumBlocks) {
                    auto it = openNew.find(HeightAmount{createdAt, -sat});
                    if (it == openNew.end() || it->second.empty()) {
                        ++numUnmatchedSpends;
                        continue;
                    }
                    newRecords[it->second.back() - oldNumRecords].spendHeight = blockHeight;
                    it->second.pop_back();
                    if (it->second.empty()) {
                        openNew.erase(it);
                    }
                } else {
                    oldSpends[createdAt].emplace_back(-sat, blockHeight);
                }
            }
        }
    }

    if (numDeltaBlocks == 0) {
        LOG("history already covers all {} blocks in '{}'; nothing to do", maxSeenHeight + 1, cfg.blkFile);
        return;
    }
    auto numBlocks = oldNumBlocks + newHeightIndex.size();
    LOG("delta: {} new blocks ({}..{}), {} new records, {} spends total, {} old heights hit",
        numDeltaBlocks,
        oldNumBlocks,
        numBlocks - 1,
        newRecords.size(),
        numSpends,
        oldSpends.size());

    // --- stamp spends that hit records created before oldNumBlocks ---
    // Sorted by height for sequential disk access. Per height group: read the
    // group once, stamp matching unspent records LIFO, write the group back.
    {
        auto heights = std::vector<uint32_t>();
        heights.reserve(oldSpends.size());
        for (auto const& kv : oldSpends) {
            heights.push_back(kv.first);
        }
        std::sort(heights.begin(), heights.end());

        auto group = std::vector<buv::UtxoHistoryRecord>();
        auto stamped = uint64_t();
        for (auto h : heights) {
            auto begin = heightIndex[h];
            auto end = heightIndex[h + 1];
            group.resize(end - begin);
            fd.preadAll(group.data(), group.size() * sizeof(buv::UtxoHistoryRecord), hdr.recordsOff + begin * sizeof(buv::UtxoHistoryRecord));

            // satoshi -> indices of records still unspent, in file order (take from back = LIFO)
            auto unspentBySat = std::unordered_map<int64_t, std::vector<size_t>>();
            for (auto i = size_t(); i < group.size(); ++i) {
                if (group[i].spendHeight == buv::kUnspent) {
                    unspentBySat[group[i].satoshi].push_back(i);
                }
            }
            for (auto const& [sat, spendHeight] : oldSpends[h]) {
                auto it = unspentBySat.find(sat);
                if (it == unspentBySat.end() || it->second.empty()) {
                    ++numUnmatchedSpends;
                    continue;
                }
                group[it->second.back()].spendHeight = spendHeight;
                it->second.pop_back();
                ++stamped;
            }
            fd.pwriteAll(group.data(), group.size() * sizeof(buv::UtxoHistoryRecord), hdr.recordsOff + begin * sizeof(buv::UtxoHistoryRecord));
        }
        LOG("stamped {} spends across {} old height groups ({} unmatched total)", stamped, heights.size(), numUnmatchedSpends);
    }

    // --- append new records after the existing record array ---
    auto recordsEnd = hdr.recordsOff + oldNumRecords * sizeof(buv::UtxoHistoryRecord);
    fd.pwriteAll(newRecords.data(), newRecords.size() * sizeof(buv::UtxoHistoryRecord), recordsEnd);

    // --- write the grown blockTimes + heightIndex arrays behind the records ---
    // The old copies before the record array are too small to grow in place;
    // they become dead space (~12 bytes per block, negligible).
    blockTimes.insert(blockTimes.end(), newBlockTimes.begin(), newBlockTimes.end());
    heightIndex.pop_back(); // old terminator
    heightIndex.insert(heightIndex.end(), newHeightIndex.begin(), newHeightIndex.end());
    auto numRecords = oldNumRecords + newRecords.size();
    heightIndex.push_back(numRecords); // new terminator

    auto newBlockTimesOff = recordsEnd + newRecords.size() * sizeof(buv::UtxoHistoryRecord);
    auto newHeightIndexOff = newBlockTimesOff + blockTimes.size() * sizeof(uint32_t);
    fd.pwriteAll(blockTimes.data(), blockTimes.size() * sizeof(uint32_t), newBlockTimesOff);
    fd.pwriteAll(heightIndex.data(), heightIndex.size() * sizeof(uint64_t), newHeightIndexOff);
    fd.sync();

    // --- publish: single 64-byte header write, then fsync ---
    hdr.numBlocks = numBlocks;
    hdr.numRecords = numRecords;
    hdr.blockTimesOff = newBlockTimesOff;
    hdr.heightIndexOff = newHeightIndexOff;
    fd.pwriteAll(&hdr, sizeof(hdr), 0);
    fd.sync();

    LOG("updated {}: now {} blocks, {} records ({} bytes)",
        cfg.historyFile,
        numBlocks,
        numRecords,
        std::filesystem::file_size(cfg.historyFile));
}

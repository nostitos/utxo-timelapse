#include <app/BlockIndex.h>
#include <app/Cfg.h>
#include <app/HistoryDelta.h>
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
#include <random>
#include <sys/file.h>

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
        if (::flock(mFd, LOCK_EX | LOCK_NB) != 0) {
            ::close(mFd);
            throw std::runtime_error("history updater already running");
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
            if (n < 0 && errno == EINTR) continue;
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
            if (n < 0 && errno == EINTR) continue;
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

void applyHistoryDelta(HistoryFd const& fd, std::string const& bytes) {
    auto h = buv::historyDeltaHeader(bytes);
    auto current = buv::UtxoHistoryHeader{};
    fd.preadAll(&current, sizeof(current), 0);
    buv::deltaRequire(std::memcmp(&current, &h.before, sizeof(current)) == 0 ||
                      std::memcmp(&current, &h.after, sizeof(current)) == 0,
                      "history does not match journal source or target");
    auto off = sizeof(h);
    auto entries = std::vector<buv::HistoryDeltaSpend>(static_cast<size_t>(h.spends));
    if (!entries.empty()) std::memcpy(entries.data(), bytes.data()+off, entries.size()*sizeof(entries[0]));
    off += entries.size()*sizeof(buv::HistoryDeltaSpend);
    std::sort(entries.begin(), entries.end(), [](auto const& a, auto const& b) { return a.recordIndex < b.recordIndex; });
    for (size_t i=0; i<entries.size(); ++i) {
        buv::deltaRequire(i == 0 || entries[i-1].recordIndex != entries[i].recordIndex, "duplicate spend record index");
    }
    // Coalesce writes into <=64 KiB spans. One pwrite per coin would replace
    // the old sort bottleneck with millions of syscalls.
    for (size_t i=0; i<entries.size();) {
        auto end = i+1;
        while (end<entries.size() && entries[end].recordIndex-entries[i].recordIndex < 4096) ++end;
        auto first = entries[i].recordIndex;
        auto count = entries[end-1].recordIndex-first+1;
        buv::deltaRequire(entries[end-1].recordIndex < h.before.numRecords, "spend outside history");
        std::vector<buv::UtxoHistoryRecord> group(static_cast<size_t>(count));
        auto pos = h.before.recordsOff + first*sizeof(group[0]);
        fd.preadAll(group.data(), group.size()*sizeof(group[0]), pos);
        for (auto at=i; at<end; ++at) {
        auto const& spend = entries[at];
        buv::deltaRequire(spend.recordIndex < h.before.numRecords &&
                          spend.record.spendHeight >= h.before.numBlocks &&
                          spend.record.spendHeight < h.after.numBlocks, "invalid journal spend");
        auto& old = group[static_cast<size_t>(spend.recordIndex-first)];
        buv::deltaRequire(old.creationHeight == spend.record.creationHeight && old.satoshi == spend.record.satoshi &&
                          (old.spendHeight == buv::kUnspent || old.spendHeight == spend.record.spendHeight),
                          "spend target differs from journal");
        old.spendHeight = spend.record.spendHeight;
        }
        fd.pwriteAll(group.data(), group.size()*sizeof(group[0]), pos);
        i = end;
    }
    auto recordBytes = (h.after.numRecords-h.before.numRecords)*sizeof(buv::UtxoHistoryRecord);
    fd.pwriteAll(bytes.data()+off, recordBytes, h.after.recordsOff+h.before.numRecords*16); off += recordBytes;
    auto timeBytes = h.after.numBlocks*4;
    fd.pwriteAll(bytes.data()+off, timeBytes, h.after.blockTimesOff); off += timeBytes;
    fd.pwriteAll(bytes.data()+off, (h.after.numBlocks+1)*8, h.after.heightIndexOff);
    fd.sync();
    fd.pwriteAll(&h.after, sizeof(h.after), 0);
    fd.sync();
}

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
// With historyDeltaFile, a durable write-ahead journal records the exact target
// before mutation and makes replay idempotent, including trailing-array repair.
// The legacy empty-path mode does NOT offer that guarantee: appending records
// can overwrite the old trailing arrays before its final header write.
static void updateUtxoHistory(buv::Cfg const& cfg) {
    if (cfg.historyFile.empty()) {
        throw std::runtime_error("config needs 'historyFile' for utxo_history_update");
    }

    // --- read existing header ---
    auto fd = HistoryFd(cfg.historyFile);
    if (!cfg.historyDeltaFile.empty()) {
        auto journal = std::filesystem::weakly_canonical(cfg.historyDeltaFile);
        buv::deltaRequire(journal != std::filesystem::weakly_canonical(cfg.historyFile) &&
                          journal != std::filesystem::weakly_canonical(cfg.blkFile), "journal collides with input");
        if (std::filesystem::exists(journal)) {
            auto bytes = buv::readHistoryDelta(journal);
            auto delta = buv::historyDeltaHeader(bytes);
            auto input = util::Mmap(cfg.blkFile);
            auto index = buv::BlockIndex::loadOrBuild(cfg.blkFile, input.view());
            buv::deltaRequire(index.size() >= delta.after.numBlocks &&
                              index.offset(delta.after.numBlocks) == delta.blkPrefixBytes, "BLK journal boundary mismatch");
            auto start = index.offset(delta.after.numBlocks-1);
            buv::deltaRequire(buv::rendererCheckpointHash(input.view().data()+start, delta.blkPrefixBytes-start) == delta.blkTailHash,
                              "BLK journal tail mismatch");
            applyHistoryDelta(fd, bytes);
            LOG("recovered/verified immutable history journal through {}; use a new journal path for another update", delta.after.numBlocks-1);
            return;
        }
        buv::deltaRequire(!std::filesystem::exists(cfg.historyDeltaFile+".pending"), "incomplete pending journal; inspect before retry");
    }
    auto hdr = buv::UtxoHistoryHeader{};
    fd.preadAll(&hdr, sizeof(hdr), 0);
    if (0 != std::memcmp(hdr.magic, buv::kUtxoHistoryMagic, sizeof(hdr.magic))) {
        throw std::runtime_error("bad magic in history file");
    }
    auto oldNumBlocks = hdr.numBlocks;
    auto oldNumRecords = hdr.numRecords;
    auto originalHeader = hdr;
    auto deltaSpends = std::vector<buv::HistoryDeltaSpend>();
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
        auto index = buv::BlockIndex::loadOrBuild(cfg.blkFile, file.view());
        if (oldNumBlocks > index.size()) throw std::runtime_error("history exceeds BLK index");
        if (index.size()) maxSeenHeight = static_cast<uint32_t>(index.size() - 1);
        for (size_t height = static_cast<size_t>(oldNumBlocks); height < index.size(); ++height) {
            auto cib = index.read(file.view(), height);
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
                auto localIndex = it->second.back();
                group[localIndex].spendHeight = spendHeight;
                if (!cfg.historyDeltaFile.empty()) deltaSpends.push_back({begin+localIndex, group[localIndex]});
                it->second.pop_back();
                ++stamped;
            }
            if (cfg.historyDeltaFile.empty()) fd.pwriteAll(group.data(), group.size() * sizeof(buv::UtxoHistoryRecord), hdr.recordsOff + begin * sizeof(buv::UtxoHistoryRecord));
        }
        LOG("stamped {} spends across {} old height groups ({} unmatched total)", stamped, heights.size(), numUnmatchedSpends);
    }

    // --- append new records after the existing record array ---
    auto recordsEnd = hdr.recordsOff + oldNumRecords * sizeof(buv::UtxoHistoryRecord);
    if (cfg.historyDeltaFile.empty()) fd.pwriteAll(newRecords.data(), newRecords.size() * sizeof(buv::UtxoHistoryRecord), recordsEnd);

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
    if (!cfg.historyDeltaFile.empty()) {
        buv::deltaRequire(numUnmatchedSpends == 0, "unmatched spends; history was not changed");
        hdr.numBlocks = numBlocks; hdr.numRecords = numRecords;
        hdr.blockTimesOff = newBlockTimesOff; hdr.heightIndexOff = newHeightIndexOff;
        auto random = std::random_device{};
        for (auto& byte : hdr.reserved) byte = static_cast<uint8_t>(random());
        auto index = buv::BlockIndex::loadOrBuild(cfg.blkFile, file.view());
        buv::HistoryDeltaHeader journal;
        journal.before = originalHeader; journal.after = hdr; journal.spends = deltaSpends.size();
        journal.blkPrefixBytes = index.offset(numBlocks);
        auto last = index.offset(numBlocks-1);
        journal.blkTailHash = buv::rendererCheckpointHash(file.view().data()+last, journal.blkPrefixBytes-last);
        auto bytes = std::string{};
        buv::deltaAppend(bytes, &journal, 1);
        buv::deltaAppend(bytes, deltaSpends.data(), deltaSpends.size());
        buv::deltaAppend(bytes, newRecords.data(), newRecords.size());
        buv::deltaAppend(bytes, blockTimes.data(), blockTimes.size());
        buv::deltaAppend(bytes, heightIndex.data(), heightIndex.size());
        buv::writeHistoryDelta(cfg.historyDeltaFile, std::move(bytes));
        applyHistoryDelta(fd, buv::readHistoryDelta(cfg.historyDeltaFile));
        LOG("history delta journal: {} old spend records, {} new records; committed '{}'", deltaSpends.size(), newRecords.size(), cfg.historyDeltaFile);
        return;
    }
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

TEST_CASE("utxo_history_update" * doctest::skip()) {
    updateUtxoHistory(buv::parseCfg(util::args::get("-cfg").value()));
}

TEST_CASE("history_delta_journal" * doctest::skip()) {
    auto name = (std::filesystem::temp_directory_path()/"buv-history-delta-XXXXXX").string();
    std::vector<char> temp(name.begin(),name.end()); temp.push_back('\0');
    auto dirName = ::mkdtemp(temp.data()); REQUIRE(dirName != nullptr);
    auto dir = std::filesystem::path(dirName);
    struct Cleanup { std::filesystem::path dir; ~Cleanup(){ std::filesystem::remove_all(dir); } } cleanup{dir};
    buv::Cfg cfg;
    cfg.historyFile = (dir/"history.bin").string(); cfg.blkFile = (dir/"changes.blk").string();
    cfg.historyDeltaFile = (dir/"delta.bin").string();
    std::ofstream blk(cfg.blkFile, std::ios::binary);
    for (uint32_t h=0; h<4; ++h) {
        buv::ChangesInBlock b; b.beginBlock(h).time = 100+h;
        if (h==0) { b.addChange(10,0); b.addChange(10,0); }
        if (h==1) b.addChange(20,1);
        if (h==2) { b.addChange(30,2); b.addChange(-30,2); b.addChange(-10,0); }
        if (h==3) { b.addChange(40,3); b.addChange(-10,0); }
        b.finalizeBlock(); blk << b.encode();
    }
    blk.close();
    buv::UtxoHistoryHeader before{};
    std::memcpy(before.magic,buv::kUtxoHistoryMagic,8);
    before.numBlocks=2; before.numRecords=3; before.recordsOff=64;
    before.blockTimesOff=112; before.heightIndexOff=120;
    std::vector<buv::UtxoHistoryRecord> records{{0,buv::kUnspent,10},{0,buv::kUnspent,10},{1,buv::kUnspent,20}};
    std::vector<uint32_t> times{100,101}; std::vector<uint64_t> index{0,2,3};
    std::string original; buv::deltaAppend(original,&before,1); buv::deltaAppend(original,records.data(),records.size());
    buv::deltaAppend(original,times.data(),times.size()); buv::deltaAppend(original,index.data(),index.size());
    { std::ofstream f(cfg.historyFile,std::ios::binary); f << original; }
    updateUtxoHistory(cfg);
    auto bytes = buv::readHistoryDelta(cfg.historyDeltaFile);
    auto header = buv::historyDeltaHeader(bytes);
    CHECK(header.spends == 2); CHECK(header.after.numBlocks == 4); CHECK(header.after.numRecords == 5);
    auto read = [&] { std::ifstream f(cfg.historyFile,std::ios::binary); return std::string(std::istreambuf_iterator<char>(f),{}); };
    auto complete = read();
    std::vector<buv::UtxoHistoryRecord> actual(5); std::memcpy(actual.data(),complete.data()+64,80);
    CHECK(actual[0].spendHeight == 3); CHECK(actual[1].spendHeight == 2); // duplicate amounts keep LIFO identity
    CHECK(actual[2].spendHeight == buv::kUnspent); CHECK(actual[3].spendHeight == 2); // same-block creation/spend
    CHECK(actual[4].satoshi == 40); CHECK(actual[4].spendHeight == buv::kUnspent);
    updateUtxoHistory(cfg); CHECK(read() == complete); // idempotent journal retry
    // Simulate interruption after new records overwrote the old trailing arrays
    // but before the target header was published. Recovery needs NO old arrays.
    { std::fstream f(cfg.historyFile,std::ios::binary|std::ios::in|std::ios::out);
      f.write(reinterpret_cast<char*>(&before),sizeof(before)); f.seekp(112); f << "damaged index"; }
    updateUtxoHistory(cfg); CHECK(read() == complete);
    // A wrong source lineage must fail without changing history.
    auto wrong=complete; wrong[48]^=1;
    { std::ofstream f(cfg.historyFile,std::ios::binary); f << wrong; }
    CHECK_THROWS(updateUtxoHistory(cfg)); CHECK(read() == wrong);
    { std::ofstream f(cfg.historyFile,std::ios::binary); f << complete; }
    auto damaged=bytes; damaged.back()^=1;
    { std::ofstream f(cfg.historyDeltaFile,std::ios::binary); f << damaged; }
    CHECK_THROWS(updateUtxoHistory(cfg)); CHECK(read() == complete);
}

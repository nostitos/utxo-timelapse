#include <app/BlockIndex.h>
#include <app/forEachChange.h>
#include <doctest.h>
#include <unistd.h>

TEST_CASE("block_index" * doctest::skip()) {
    auto block = [](uint32_t h) {
        buv::ChangesInBlock b;
        b.beginBlock(h).time = 100 + h;
        b.addChange(50, h);
        b.finalizeBlock();
        return b.encode();
    };
    auto a = block(0), b = block(1);
    auto index = buv::BlockIndex::build(a);
    CHECK(index.size() == 1);
    CHECK(index.offset(1) == a.size());
    CHECK(index.read(a, 0).blockData().time == 100);
    CHECK_THROWS(index.read(a, 1));
    CHECK_THROWS(index.extend(a + b.substr(0, b.size() - 1)));
    CHECK(index.size() == 1);
    auto stale = a; stale[20] ^= 1;
    CHECK_THROWS(index.extend(stale));
    CHECK_THROWS(index.extend(""));
    CHECK_THROWS(index.extend(a + block(3)));
    index.extend(a + b);
    CHECK(index.size() == 2);
    CHECK(index.recordSpan(a + b, 1) == b);
    CHECK_THROWS(index.recordSpan(a + b, 2));
    CHECK(index.read(a + b, 1).blockData().time == 101);
    auto bad = a; bad[8] = 0;
    CHECK_THROWS(buv::BlockIndex::build(bad));
    CHECK_THROWS(buv::BlockIndex::build(a.substr(0, 11)));
    CHECK(buv::BlockIndex::build("").size() == 0);
    auto path = std::filesystem::temp_directory_path() / ("buv-index-test-" + std::to_string(::getpid()));
    struct Cleanup { std::filesystem::path p; ~Cleanup() { std::filesystem::remove(p); } } cleanup{path};
    auto first = buv::BlockIndex::build(a);
    first.save(path);
    CHECK(buv::BlockIndex::load(path, a + b).size() == 2);
    CHECK_THROWS(buv::BlockIndex::load(path, stale));
    { std::fstream f(path, std::ios::binary | std::ios::in | std::ios::out); f.seekp(32); f.put(1); }
    CHECK_THROWS(buv::BlockIndex::load(path, a));
    first.save(path);
    { std::ofstream f(path, std::ios::binary | std::ios::app); f.put(0); }
    CHECK_THROWS(buv::BlockIndex::load(path, a));
    size_t visits = 0;
    index.forEachChange(a + b, 1, [&](buv::ChangesInBlock const& c) {
        CHECK(c.blockData().blockHeight == 1);
        ++visits;
    });
    CHECK(visits == 1);
    index.forEachChange(a + b, 2, [&](buv::ChangesInBlock const&) { ++visits; });
    CHECK(visits == 1);
    CHECK_THROWS(index.forEachChange(a + b, 3, [](buv::ChangesInBlock const&) {}));
    auto sourcePath = std::filesystem::path(path.string() + ".blk");
    Cleanup sourceCleanup{sourcePath};
    Cleanup sidecarCleanup{sourcePath.string() + ".idx"};
    { std::ofstream f(sourcePath, std::ios::binary); f << a; }
    CHECK(buv::BlockIndex::loadOrBuild(sourcePath, a).size() == 1);
    CHECK(buv::BlockIndex::loadOrBuild(sourcePath, a).size() == 1);
    { std::ofstream f(sourcePath, std::ios::binary | std::ios::app); f << b; }
    CHECK(buv::BlockIndex::loadOrBuild(sourcePath, a + b).size() == 2);
    { std::ofstream f(sourcePath, std::ios::binary); f << stale << b; }
    CHECK(buv::BlockIndex::loadOrBuild(sourcePath, stale + b).read(stale + b, 0).blockData().hash[8] !=
          index.read(a + b, 0).blockData().hash[8]);
    // A valid sidecar checksum must not bypass offset/count validation.
    auto three = a + b + block(2);
    auto threeIndex = buv::BlockIndex::build(three);
    threeIndex.save(path);
    auto readSidecar = [&] {
        std::ifstream f(path, std::ios::binary);
        return std::string(std::istreambuf_iterator<char>(f), {});
    };
    auto goodSidecar = readSidecar();
    auto put64 = [](std::string& bytes, size_t at, uint64_t value) {
        for (size_t i = 0; i < 8; ++i) bytes[at + i] = static_cast<char>(value >> (8 * i));
    };
    auto rejectResealed = [&](size_t at, uint64_t value) {
        auto bytes = goodSidecar;
        put64(bytes, at, value);
        uint64_t checksum = 14695981039346656037ULL;
        for (size_t i = 0; i < bytes.size() - 8; ++i)
            checksum = (checksum ^ static_cast<unsigned char>(bytes[i])) * 1099511628211ULL;
        put64(bytes, bytes.size() - 8, checksum);
        { std::ofstream f(path, std::ios::binary); f << bytes; }
        CHECK_THROWS(buv::BlockIndex::load(path, three));
    };
    rejectResealed(16, 4); // wrong count
    rejectResealed(40 + 16, a.size()); // duplicate/nonmonotone offset
    rejectResealed(40 + 16, a.size() + 1); // span too small
    rejectResealed(40 + 24, three.size() + 1); // invalid EOF

    // Same-size interior header edit leaves both boundary fingerprints intact.
    // Filesystem-stamped reuse must invalidate the cache and reject the source.
    { std::ofstream f(sourcePath, std::ios::binary); f << three; }
    CHECK(buv::BlockIndex::loadOrBuild(sourcePath, three).size() == 3);
    auto interior = three;
    interior[a.size()] = 'X';
    { std::ofstream f(sourcePath, std::ios::binary); f << interior; }
    CHECK_THROWS(buv::BlockIndex::loadOrBuild(sourcePath, interior));

    // Bounded replay returns the final processed block, never end+1 for fade/HUD.
    { std::ofstream f(sourcePath, std::ios::binary); f << three; }
    {
        auto mapped = util::Mmap(sourcePath);
        std::vector<uint32_t> seen;
        auto collect = [&](buv::ChangesInBlock const& c) { seen.push_back(c.blockData().blockHeight); return true; };
        auto last = buv::forEachChange(mapped, collect, threeIndex.offset(1), threeIndex.offset(2));
        CHECK(seen == std::vector<uint32_t>{1});
        CHECK(last.blockData().blockHeight == 1);
        seen.clear();
        last = buv::forEachChange(mapped, collect, threeIndex.offset(1));
        CHECK(seen == std::vector<uint32_t>{1, 2});
        CHECK(last.blockData().blockHeight == 2);
        CHECK_THROWS(buv::forEachChange(mapped, collect, three.size() + 1));
        CHECK_THROWS(buv::forEachChange(mapped, collect, 0, three.size() + 1));
        CHECK_THROWS(buv::forEachChange(mapped, collect, threeIndex.offset(2), threeIndex.offset(1)));
        CHECK_THROWS(buv::forEachChange(mapped, collect, threeIndex.offset(1), threeIndex.offset(2) - 1));
        CHECK_THROWS(buv::forEachChange(mapped, collect, threeIndex.offset(1), threeIndex.offset(1) + 11));
        seen.clear();
        buv::forEachChange(mapped, collect, three.size(), three.size());
        CHECK(seen.empty());
        last = buv::forEachChange(mapped, [](buv::ChangesInBlock const&) { return false; }, threeIndex.offset(1));
        CHECK(last.blockData().blockHeight == 1);
    }
    auto malformed = a;
    malformed.back() = static_cast<char>(128);
    auto malformedIndex = buv::BlockIndex::build(malformed);
    CHECK_THROWS(malformedIndex.read(malformed, 0));
}

#ifndef BLOCK_INDEX_STANDALONE_TEST
#include <app/Cfg.h>
#include <util/Mmap.h>
#include <util/args.h>
#include <util/log.h>

// Explicit bootstrap only; normal sidecar writes remain best-effort.
TEST_CASE("block_index_build" * doctest::skip()) {
    auto cfg = buv::parseCfg(util::args::get("-cfg").value());
    auto source = util::Mmap(cfg.blkFile);
    if (!source.is_open()) throw std::runtime_error("cannot open BLK source");
    auto index = buv::BlockIndex::loadOrBuild(cfg.blkFile, source.view());
    index.save(cfg.blkFile + ".idx"); // report write failures in explicit bootstrap
    LOG("BLK offset index: {} blocks, {} bytes", index.size(), index.sourceSize());
}
#endif

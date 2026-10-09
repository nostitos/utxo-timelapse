#include <app/Landscape.h>

#include <app/BlockEncoder.h>
#include <app/BlockIndex.h>
#include <app/RendererCheckpoint.h>
#include <app/UtxoHistory.h>
#include <util/Mmap.h>
#include <util/hex.h>
#include <util/log.h>

#include <fmt/format.h>
#include <simdjson.h>

#ifdef __APPLE__
#include <CommonCrypto/CommonDigest.h>
#endif
#if defined(__ARM_FEATURE_CRC32)
#include <arm_acle.h>
#endif

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <deque>
#include <exception>
#include <limits>
#include <map>
#include <memory>
#include <mutex>
#include <random>
#include <set>
#include <stdexcept>
#include <thread>
#include <tuple>

#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

namespace buv::landscape {

using Clock = std::chrono::steady_clock;

void fail(std::string const& what) {
    throw std::runtime_error("landscape: " + what);
}

namespace {

auto seconds(Clock::time_point a, Clock::time_point b) -> double {
    return std::chrono::duration<double>(b - a).count();
}

auto ceilDiv(uint64_t a, uint64_t b) -> uint64_t {
    return (a + b - 1) / b;
}

void put32(uint8_t* p, uint32_t v) {
    for (unsigned i = 0; i < 4; ++i) {
        p[i] = static_cast<uint8_t>(v >> (8U * i));
    }
}

void put64(uint8_t* p, uint64_t v) {
    for (unsigned i = 0; i < 8; ++i) {
        p[i] = static_cast<uint8_t>(v >> (8U * i));
    }
}

auto get32(uint8_t const* p) -> uint32_t {
    uint32_t v = 0;
    for (unsigned i = 0; i < 4; ++i) {
        v |= uint32_t(p[i]) << (8U * i);
    }
    return v;
}

auto get64(uint8_t const* p) -> uint64_t {
    uint64_t v = 0;
    for (unsigned i = 0; i < 8; ++i) {
        v |= uint64_t(p[i]) << (8U * i);
    }
    return v;
}

auto putVarint(uint8_t* p, uint64_t v) -> uint8_t* {
    while (v >= 0x80U) {
        *p++ = static_cast<uint8_t>(v) | 0x80U;
        v >>= 7U;
    }
    *p++ = static_cast<uint8_t>(v);
    return p;
}

auto crcTable() -> std::array<uint32_t, 256> const& {
    static auto const table = [] {
        auto t = std::array<uint32_t, 256>();
        for (uint32_t i = 0; i < 256; ++i) {
            auto c = i;
            for (int k = 0; k < 8; ++k) {
                c = (c & 1U) != 0 ? 0xEDB88320U ^ (c >> 1U) : c >> 1U;
            }
            t[i] = c;
        }
        return t;
    }();
    return table;
}

auto cellText(Cell const& c) -> std::string {
    return fmt::format("[cs {} cl {} ss {} sl {}]", c.countSmall, c.countLarge, c.satsSmall, c.satsLarge);
}

auto totalsText(Totals const& t) -> std::string {
    return fmt::format("[cs {} cl {} ss {} sl {}]", t.countSmall, t.countLarge, t.satsSmall, t.satsLarge);
}

void addTo(Totals& t, Cell const& c) {
    t.countSmall += c.countSmall;
    t.countLarge += c.countLarge;
    t.satsSmall += c.satsSmall;
    t.satsLarge += c.satsLarge;
}

auto validCell(Cell const& c) -> bool {
    if (c.countSmall < 0 || c.countLarge < 0 || c.satsSmall < 0 || c.satsLarge < 0) {
        return false;
    }
    if (c.countSmall > (int64_t(1) << 34) || c.countLarge > (int64_t(1) << 34)) {
        return false;
    }
    if ((c.countSmall == 0) != (c.satsSmall == 0) || (c.countLarge == 0) != (c.satsLarge == 0)) {
        return false;
    }
    return c.satsSmall >= c.countSmall && c.satsSmall <= c.countSmall * kSmallMaxSatoshi &&
           c.satsLarge >= c.countLarge * (kSmallMaxSatoshi + 1);
}

auto jsonString(std::string const& s) -> std::string {
    auto out = std::string("\"");
    for (char ch : s) {
        auto const u = static_cast<unsigned char>(ch);
        if (ch == '"' || ch == '\\') {
            out += '\\';
            out += ch;
        } else if (u < 0x20) {
            out += fmt::format("\\u{:04x}", u);
        } else {
            out += ch;
        }
    }
    return out + "\"";
}

auto utcNow() -> std::string {
    auto const t = std::time(nullptr);
    auto tm = std::tm();
    gmtime_r(&t, &tm);
    char buf[32];
    std::strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &tm);
    return buf;
}

// Simple blocking FIFO; pop returns nullopt once closed and drained.
template <typename T>
class Queue {
    std::mutex mMutex;
    std::condition_variable mCv;
    std::deque<T> mItems;
    bool mClosed = false;

public:
    void push(T v) {
        {
            auto lock = std::lock_guard<std::mutex>(mMutex);
            mItems.push_back(std::move(v));
        }
        mCv.notify_one();
    }
    auto pop() -> std::optional<T> {
        auto lock = std::unique_lock<std::mutex>(mMutex);
        mCv.wait(lock, [&] { return mClosed || !mItems.empty(); });
        if (mItems.empty()) {
            return std::nullopt;
        }
        auto v = std::move(mItems.front());
        mItems.pop_front();
        return v;
    }
    void close() {
        {
            auto lock = std::lock_guard<std::mutex>(mMutex);
            mClosed = true;
        }
        mCv.notify_all();
    }
};

// First error wins; later work is skipped.
class Failure {
    std::mutex mMutex;
    std::exception_ptr mError;
    std::atomic<bool> mFailed{false};

public:
    void set(std::exception_ptr e) {
        auto lock = std::lock_guard<std::mutex>(mMutex);
        if (!mError) {
            mError = std::move(e);
        }
        mFailed = true;
    }
    [[nodiscard]] auto failed() const -> bool {
        return mFailed.load();
    }
    void rethrow() {
        auto lock = std::lock_guard<std::mutex>(mMutex);
        if (mError) {
            std::rethrow_exception(mError);
        }
    }
};

// An L0 copy handed to a snapshot worker. Columns at and beyond 'used' are zero.
struct L0Buffer {
    std::vector<Cell> cells;
    uint32_t used = 0;
};

void copyPrefix(Cell const* l0, uint32_t usedColumns, L0Buffer& buffer) {
    auto const n = size_t(usedColumns) * kRows;
    std::memcpy(buffer.cells.data(), l0, n * sizeof(Cell));
    if (buffer.used > usedColumns) {
        std::fill(buffer.cells.begin() + static_cast<std::ptrdiff_t>(n),
                  buffer.cells.begin() + static_cast<std::ptrdiff_t>(size_t(buffer.used) * kRows), Cell{});
    }
    buffer.used = usedColumns;
}

auto loadIndex(std::string const& blkFile, std::string_view view) -> BlockIndex {
    auto const sidecar = std::filesystem::path(blkFile + ".idx");
    try {
        // Read-only: BlockIndex::load never writes; loadOrBuild could.
        auto index = BlockIndex::load(sidecar, view);
        LOG("BLK index: {} blocks from {}", index.size(), sidecar.string());
        return index;
    } catch (std::exception const& e) {
        LOG("BLK index sidecar unusable ({}); building it in memory (the sidecar is not written)", e.what());
        return BlockIndex::build(view);
    }
}

struct History {
    util::Mmap map;
    UtxoHistoryHeader header{};

    explicit History(std::string const& path)
        : map(path) {
        if (!map.is_open() || map.size() < sizeof(UtxoHistoryHeader)) {
            fail("cannot open history file " + path);
        }
        std::memcpy(&header, map.data(), sizeof(header));
        if (std::memcmp(header.magic, kUtxoHistoryMagic, 8) != 0) {
            fail("history file is not BUVHIST1");
        }
        auto const size = uint64_t(map.size());
        auto within = [&](uint64_t off, uint64_t count, uint64_t width) {
            return off <= size && count <= (size - off) / width;
        };
        if (header.numBlocks == 0 || header.numBlocks > std::numeric_limits<uint32_t>::max() ||
            !within(header.blockTimesOff, header.numBlocks, 4) || !within(header.heightIndexOff, header.numBlocks + 1, 8) ||
            !within(header.recordsOff, header.numRecords, 16)) {
            fail("history header offsets outside the file");
        }
    }
    [[nodiscard]] auto numBlocks() const -> uint32_t {
        return static_cast<uint32_t>(header.numBlocks);
    }
    [[nodiscard]] auto time(uint32_t h) const -> uint32_t {
        uint32_t v = 0;
        std::memcpy(&v, map.data() + header.blockTimesOff + uint64_t(4) * h, 4);
        return v;
    }
    [[nodiscard]] auto heightIndex(uint64_t h) const -> uint64_t {
        uint64_t v = 0;
        std::memcpy(&v, map.data() + header.heightIndexOff + uint64_t(8) * h, 8);
        return v;
    }
    [[nodiscard]] auto record(uint64_t i) const -> UtxoHistoryRecord {
        auto r = UtxoHistoryRecord();
        std::memcpy(&r, map.data() + header.recordsOff + uint64_t(16) * i, 16);
        return r;
    }
};

struct ChunkEntry {
    uint32_t index{};
    uint32_t firstBlock{};
    uint32_t lastBlock{};
    uint64_t offset{};
    uint64_t bytes{};
    Hash sha{};
};

// Asks the OS not to keep this stream in the page cache: these files are read
// or written once, and caching them displaces everything else on this Mac.
void noCache(int fd) {
#ifdef F_NOCACHE
    ::fcntl(fd, F_NOCACHE, 1);
#else
    (void)fd;
#endif
}

// Read-only descriptor for large sequential pread calls (uncached).
class Fd {
    int mFd = -1;

public:
    explicit Fd(std::string const& path)
        : mFd(::open(path.c_str(), O_RDONLY | O_CLOEXEC)) {
        if (mFd < 0) {
            fail("cannot open " + path + ": " + std::strerror(errno));
        }
        noCache(mFd);
    }
    Fd(Fd const&) = delete;
    auto operator=(Fd const&) -> Fd& = delete;
    ~Fd() {
        ::close(mFd);
    }
    [[nodiscard]] auto size() const -> uint64_t {
        struct stat st {};
        if (::fstat(mFd, &st) != 0) {
            fail("cannot stat an open file");
        }
        return static_cast<uint64_t>(st.st_size);
    }
    void read(void* buffer, size_t n, uint64_t offset) const {
        auto* p = static_cast<char*>(buffer);
        while (n > 0) {
            auto const got = ::pread(mFd, p, std::min<size_t>(n, size_t(1) << 30U), static_cast<off_t>(offset));
            if (got < 0 && errno == EINTR) {
                continue;
            }
            if (got <= 0) {
                fail(fmt::format("read error at offset {}", offset));
            }
            p += got;
            n -= static_cast<size_t>(got);
            offset += static_cast<uint64_t>(got);
        }
    }
};

// Whole BLK records [first, last] read sequentially into heap segments by a
// reader thread with large uncached preads. Decoding from an mmap instead
// stalls on page faults (about 20-35 MB/s from the external SSD under memory
// pressure, even with read-ahead, because cached pages get evicted).
class BlockStream {
public:
    struct Segment {
        uint32_t first = 0;
        uint32_t last = 0;
        uint64_t offset = 0; // source offset of bytes[0]
        std::vector<char> bytes;
    };

private:
    Fd mFd;
    Queue<std::unique_ptr<Segment>> mFull;
    Queue<std::unique_ptr<Segment>> mFree;
    std::unique_ptr<Segment> mHeld;
    std::atomic<bool> mStop{false};
    std::mutex mErrorMutex;
    std::exception_ptr mError;
    std::thread mThread;

public:
    BlockStream(std::string const& path, std::vector<uint64_t> const& offs, uint32_t first, uint32_t last,
                uint64_t segmentBytes = uint64_t(64) << 20U, size_t depth = 3)
        : mFd(path) {
        for (size_t i = 0; i < depth; ++i) {
            mFree.push(std::make_unique<Segment>());
        }
        mThread = std::thread([this, &offs, first, last, segmentBytes] {
            try {
                auto h = first;
                while (h <= last && !mStop.load()) {
                    auto end = h;
                    while (end < last && offs[end + 2] - offs[h] <= segmentBytes) {
                        ++end;
                    }
                    auto segment = mFree.pop();
                    if (!segment || mStop.load()) {
                        break;
                    }
                    auto& s = **segment;
                    s.first = h;
                    s.last = end;
                    s.offset = offs[h];
                    s.bytes.resize(offs[end + 1] - offs[h]);
                    mFd.read(s.bytes.data(), s.bytes.size(), s.offset);
                    mFull.push(std::move(*segment));
                    if (end == last) {
                        break;
                    }
                    h = end + 1;
                }
            } catch (...) {
                auto lock = std::lock_guard<std::mutex>(mErrorMutex);
                mError = std::current_exception();
            }
            mFull.close();
        });
    }
    BlockStream(BlockStream const&) = delete;
    auto operator=(BlockStream const&) -> BlockStream& = delete;
    ~BlockStream() {
        mStop = true;
        mFree.close();
        if (mThread.joinable()) {
            mThread.join();
        }
    }
    // The next segment, or nullptr at the end. The previous one is recycled.
    auto next() -> Segment const* {
        if (mHeld) {
            mFree.push(std::move(mHeld));
        }
        auto s = mFull.pop();
        if (!s) {
            auto lock = std::lock_guard<std::mutex>(mErrorMutex);
            if (mError) {
                std::rethrow_exception(mError);
            }
            return nullptr;
        }
        mHeld = std::move(*s);
        return mHeld.get();
    }
};

auto planChunks(std::vector<uint64_t> const& offs, uint32_t end, uint64_t target) -> std::vector<ChunkEntry> {
    auto chunks = std::vector<ChunkEntry>();
    uint32_t first = 0;
    while (first <= end) {
        auto last = first;
        auto bytes = offs[first + 1] - offs[first];
        while (last < end && bytes + (offs[last + 2] - offs[last + 1]) <= target) {
            ++last;
            bytes += offs[last + 1] - offs[last];
        }
        chunks.push_back({static_cast<uint32_t>(chunks.size()), first, last, offs[first], bytes, {}});
        first = last + 1;
    }
    return chunks;
}

auto chunkName(uint32_t index) -> std::string {
    return fmt::format("chunks/{:05}.bin", index);
}

auto snapshotName(uint32_t block) -> std::string {
    return fmt::format("snapshots/{:07}.bin", block);
}

// Snapshot schedule: after block 0, whenever >= interval BLK bytes were applied
// since the previous snapshot, and after the tip.
auto snapshotSchedule(std::vector<uint64_t> const& offs, uint32_t end, uint64_t interval) -> std::vector<uint32_t> {
    auto blocks = std::vector<uint32_t>();
    uint64_t since = 0;
    for (uint32_t h = 0; h <= end; ++h) {
        since += offs[h + 1] - offs[h];
        if (h == 0 || since >= interval || h == end) {
            blocks.push_back(h);
            since = 0;
        }
    }
    return blocks;
}

struct EraStats {
    uint64_t blocks = 0;
    uint64_t changes = 0;
    uint64_t bytes = 0;
    double seconds = 0;
};
inline constexpr uint32_t kEraBlocks = 50'000;

auto eraJson(std::vector<EraStats> const& eras, uint32_t end) -> std::string {
    auto s = std::string("[");
    for (size_t i = 0; i < eras.size(); ++i) {
        auto const& e = eras[i];
        auto const first = uint32_t(i) * kEraBlocks;
        auto const last = std::min<uint32_t>(first + kEraBlocks - 1, end);
        s += fmt::format(
            "{}\n      {{\"firstBlock\": {}, \"lastBlock\": {}, \"changes\": {}, \"blkBytes\": {}, \"applySeconds\": {:.3f}, "
            "\"blocksPerSecond\": {:.0f}, \"changesPerSecond\": {:.0f}}}",
            i == 0 ? "" : ",", first, last, e.changes, e.bytes, e.seconds, e.seconds > 0 ? double(e.blocks) / e.seconds : 0.0,
            e.seconds > 0 ? double(e.changes) / e.seconds : 0.0);
    }
    return s + "\n    ]";
}

void logEras(std::vector<EraStats> const& eras, uint32_t end) {
    for (size_t i = 0; i < eras.size(); ++i) {
        auto const& e = eras[i];
        auto const first = uint32_t(i) * kEraBlocks;
        LOG("  replay {:>7}-{:>7}: {:>12} changes {:>8.1f} MB {:>7.2f} s {:>8.0f} blocks/s {:>6.1f} M changes/s", first,
            std::min<uint32_t>(first + kEraBlocks - 1, end), e.changes, double(e.bytes) / 1e6, e.seconds,
            e.seconds > 0 ? double(e.blocks) / e.seconds : 0.0, e.seconds > 0 ? double(e.changes) / e.seconds / 1e6 : 0.0);
    }
}

void prepareOutput(std::filesystem::path const& out) {
    auto ec = std::error_code();
    if (std::filesystem::exists(out, ec)) {
        if (!std::filesystem::is_directory(out) || !std::filesystem::is_empty(out)) {
            fail("output " + out.string() + " exists and is not an empty directory; refusing to write");
        }
    } else if (!std::filesystem::create_directory(out)) {
        fail("cannot create " + out.string());
    }
    std::filesystem::create_directory(out / "chunks");
    std::filesystem::create_directory(out / "snapshots");
}

} // namespace

auto sha256(void const* data, size_t size) -> Hash {
#ifdef __APPLE__
    auto out = Hash();
    auto ctx = CC_SHA256_CTX();
    CC_SHA256_Init(&ctx);
    auto const* p = static_cast<uint8_t const*>(data);
    while (size > 0) {
        auto const n = std::min<size_t>(size, size_t(1) << 30U);
        CC_SHA256_Update(&ctx, p, static_cast<CC_LONG>(n));
        p += n;
        size -= n;
    }
    CC_SHA256_Final(out.data(), &ctx);
    return out;
#else
    return rendererCheckpointHash(data, size);
#endif
}

auto hex(Hash const& hash) -> std::string {
    static constexpr char digits[] = "0123456789abcdef";
    auto s = std::string();
    s.reserve(64);
    for (auto b : hash) {
        s += digits[b >> 4U];
        s += digits[b & 15U];
    }
    return s;
}

auto crc32Portable(void const* data, size_t size) -> uint32_t {
    auto const& t = crcTable();
    auto c = 0xFFFFFFFFU;
    auto const* p = static_cast<uint8_t const*>(data);
    for (size_t i = 0; i < size; ++i) {
        c = t[(c ^ p[i]) & 0xFFU] ^ (c >> 8U);
    }
    return c ^ 0xFFFFFFFFU;
}

auto crc32(void const* data, size_t size) -> uint32_t {
#if defined(__ARM_FEATURE_CRC32)
    auto c = 0xFFFFFFFFU;
    auto const* p = static_cast<uint8_t const*>(data);
    while (size >= 8) {
        uint64_t v = 0;
        std::memcpy(&v, p, 8);
        c = __crc32d(c, v);
        p += 8;
        size -= 8;
    }
    while (size > 0) {
        c = __crc32b(c, *p++);
        --size;
    }
    return c ^ 0xFFFFFFFFU;
#else
    return crc32Portable(data, size);
#endif
}

auto Grid::make(uint32_t numBlocks) -> Grid {
    if (numBlocks == 0) {
        fail("the grid needs at least one block");
    }
    auto g = Grid();
    g.numBlocks = numBlocks;
    g.l0Columns = static_cast<uint32_t>(ceilDiv(numBlocks, kBlocksPerColumn));
    uint32_t first = 0;
    for (uint32_t l = 0; l < kLevels; ++l) {
        auto& li = g.levels[l];
        li.level = l;
        li.columnShift = l;
        li.rowShift = std::min<uint32_t>(l, 4);
        li.columns = static_cast<uint32_t>(ceilDiv(g.l0Columns, uint64_t(1) << l));
        li.rows = static_cast<uint32_t>(ceilDiv(kRows, uint64_t(1) << li.rowShift));
        li.tilesX = static_cast<uint32_t>(ceilDiv(li.columns, kTileSize));
        li.tilesY = static_cast<uint32_t>(ceilDiv(li.rows, kTileSize));
        li.firstTile = first;
        first += li.tilesX * li.tilesY;
    }
    g.tiles = first;
    return g;
}

auto Grid::tileId(uint32_t level, uint32_t tx, uint32_t ty) const -> uint32_t {
    if (level >= kLevels || tx >= levels[level].tilesX || ty >= levels[level].tilesY) {
        fail("tile coordinates outside the grid");
    }
    auto const& li = levels[level];
    return li.firstTile + ty * li.tilesX + tx;
}

auto Grid::tileInfo(uint32_t id) const -> TileInfo {
    if (id >= tiles) {
        fail("tile id outside the grid");
    }
    auto l = kLevels - 1;
    while (levels[l].firstTile > id) {
        --l;
    }
    auto const& li = levels[l];
    auto t = TileInfo();
    t.id = id;
    t.level = l;
    auto const local = id - li.firstTile;
    t.tx = local % li.tilesX;
    t.ty = local / li.tilesX;
    t.col0 = t.tx * kTileSize;
    t.row0 = t.ty * kTileSize;
    t.cols = std::min(kTileSize, li.columns - t.col0);
    t.rows = std::min(kTileSize, li.rows - t.row0);
    return t;
}

auto Grid::cellArea(uint32_t level, uint32_t col, uint32_t row) const -> uint64_t {
    if (level >= kLevels || col >= levels[level].columns || row >= levels[level].rows) {
        fail("cell outside the grid");
    }
    auto const& li = levels[level];
    auto const w = std::min<uint64_t>(uint64_t(1) << li.columnShift, l0Columns - (uint64_t(col) << li.columnShift));
    auto const h = std::min<uint64_t>(uint64_t(1) << li.rowShift, kRows - (uint64_t(row) << li.rowShift));
    return w * h;
}

void aggregate(Grid const& grid, Cell const* l0, uint32_t usedColumns, Levels& out) {
    out.cells[0] = l0;
    out.extent[0] = std::min(usedColumns, grid.levels[0].columns);
    for (uint32_t l = 1; l < kLevels; ++l) {
        auto const& prev = grid.levels[l - 1];
        auto const& cur = grid.levels[l];
        auto& dst = out.owned[l];
        if (dst.size() != cur.cells()) {
            dst.assign(cur.cells(), Cell{});
            out.extent[l] = 0;
        }
        auto const* src = out.cells[l - 1];
        auto const halveRows = cur.rowShift > prev.rowShift;
        auto const need = std::min<uint32_t>(cur.columns, static_cast<uint32_t>(ceilDiv(out.extent[l - 1], 2)));
        for (uint32_t c = 0; c < need; ++c) {
            auto* d = dst.data() + size_t(c) * cur.rows;
            std::fill(d, d + cur.rows, Cell{});
            for (uint32_t dc = 0; dc < 2; ++dc) {
                auto const sc = 2 * c + dc;
                if (sc >= prev.columns) {
                    break;
                }
                auto const* s = src + size_t(sc) * prev.rows;
                if (halveRows) {
                    for (uint32_t r = 0; r < cur.rows; ++r) {
                        d[r].add(s[2 * r]);
                        if (2 * r + 1 < prev.rows) {
                            d[r].add(s[2 * r + 1]);
                        }
                    }
                } else {
                    for (uint32_t r = 0; r < cur.rows; ++r) {
                        d[r].add(s[r]);
                    }
                }
            }
        }
        if (out.extent[l] > need) {
            std::fill(dst.begin() + static_cast<std::ptrdiff_t>(size_t(need) * cur.rows),
                      dst.begin() + static_cast<std::ptrdiff_t>(size_t(out.extent[l]) * cur.rows), Cell{});
        }
        out.extent[l] = need;
        out.cells[l] = dst.data();
    }
}

void requireFilmAxis(Cfg const& c) {
    auto const& r = c.graphRect;
    if (r.x != 0 || r.y != 10 || r.w != 3720 || r.h != kRows || c.minSatoshi != 1 ||
        c.maxSatoshi != 10'000'000'000'000LL || !c.compressLowSatoshi || !c.compressTopSatoshi) {
        fail("only the published film amount axis is supported: graphRect [0,10,3720,2072], minSatoshi 1, "
             "maxSatoshi 10000000000000, compressLowSatoshi and compressTopSatoshi true");
    }
}

auto filmAxisCfg() -> Cfg {
    auto c = Cfg();
    c.imageWidth = 3840;
    c.imageHeight = 2160;
    c.graphRect = {0, 10, 3720, kRows};
    c.minSatoshi = 1;
    c.maxSatoshi = 10'000'000'000'000LL;
    c.compressLowSatoshi = true;
    c.compressTopSatoshi = true;
    c.xAxisMode = "normalizedGeometric";
    c.epochBlocks = 105'000;
    c.epochRatio = 0.5;
    c.epochTransitionBlocks = 120;
    c.whiteHotTail = true;
    c.whiteHotTailMinSatoshi = 1'000'000'000;
    c.amountWeightedDensity = true;
    return c;
}

FilmRows::FilmRows(Cfg const& cfg)
    : mCfg((requireFilmAxis(cfg), cfg))
    , mMapper(mCfg, 2) {}

auto FilmRows::row(int64_t amount) const -> uint32_t {
    if (amount <= 0) {
        fail("film row of a non-positive amount");
    }
    return static_cast<uint32_t>(mMapper.satoshiToPixelHeight(amount) - mCfg.graphRect.y);
}

auto RowTable::fromFilm(FilmRows const& film) -> RowTable {
    constexpr int64_t top = 10'000'000'000'000LL;
    if (film.row(top) != 0 || film.row(1) != kRows - 1) {
        fail("film axis endpoints do not map to rows 0 and 2071");
    }
    auto t = RowTable();
    for (uint32_t r = 0; r < kRows; ++r) {
        int64_t lo = 1;
        int64_t hi = top;
        while (lo < hi) {
            auto const mid = lo + (hi - lo) / 2;
            if (film.row(mid) <= r) {
                hi = mid;
            } else {
                lo = mid + 1;
            }
        }
        t.mMinAmt[r] = lo;
    }
    for (uint32_t r = 0; r < kRows; ++r) {
        auto const m = t.mMinAmt[r];
        if (film.row(m) > r || (m > 1 && film.row(m - 1) <= r) || (r > 0 && t.mMinAmt[r - 1] < m)) {
            fail(fmt::format("film axis is not monotone around row {}", r));
        }
    }
    if (t.mMinAmt[kRows - 1] != 1) {
        fail("minAmt[2071] must be 1");
    }
    return t;
}

auto RowTable::row(int64_t amount) const -> uint32_t {
    // Precondition: amount >= 1 (minAmt[2071] == 1 bounds the search).
    uint32_t lo = 0;
    uint32_t hi = kRows - 1;
    while (lo < hi) {
        auto const mid = (lo + hi) / 2;
        if (mMinAmt[mid] <= amount) {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    return lo;
}

auto RowTable::bytes() const -> std::string {
    auto s = std::string(size_t(kRows) * 8, '\0');
    for (uint32_t r = 0; r < kRows; ++r) {
        auto const d = static_cast<double>(mMinAmt[r]);
        uint64_t bits = 0;
        std::memcpy(&bits, &d, 8);
        put64(reinterpret_cast<uint8_t*>(s.data()) + size_t(r) * 8, bits);
    }
    return s;
}

State::State(Grid const& grid)
    : mGrid(grid)
    , mL0(grid.levels[0].cells()) {}

void State::clear() {
    std::fill(mL0.begin(), mL0.end(), Cell{});
}

auto State::applyBlock(ChangesInBlock const& block, RowTable const& rows, int sign) -> uint64_t {
    auto const& changes = block.changeAtBlockheights();
    auto const current = block.blockData().blockHeight;
    auto const columns = mGrid.l0Columns;
    mIndex.clear();
    mAmount.clear();
    // Changes are sorted by amount, so consecutive amounts usually share a row.
    int64_t lo = rows.minAmt(0);
    int64_t hi = std::numeric_limits<int64_t>::max();
    uint32_t row = 0;
    for (auto const& c : changes) {
        auto const s = c.satoshi();
        if (s == 0) {
            continue;
        }
        auto const h = c.blockHeight();
        if (h > current || (s > 0 && h != current)) {
            fail(fmt::format("block {}: change of {} sat refers to height {}", current, s, h));
        }
        auto const col = h / kBlocksPerColumn;
        if (col >= columns) {
            fail(fmt::format("block {}: creation height {} outside the grid", current, h));
        }
        auto const a = s > 0 ? s : -s;
        if (a < lo || a >= hi) {
            row = rows.row(a);
            lo = rows.minAmt(row);
            hi = row == 0 ? std::numeric_limits<int64_t>::max() : rows.minAmt(row - 1);
        }
        mIndex.push_back(col * kRows + row);
        mAmount.push_back(sign > 0 ? s : -s);
    }
    auto const n = mIndex.size();
    constexpr size_t ahead = 16;
    auto* cells = mL0.data();
    for (size_t i = 0; i < n; ++i) {
        if (i + ahead < n) {
            __builtin_prefetch(cells + mIndex[i + ahead], 1, 1);
        }
        auto const v = mAmount[i];
        auto& cell = cells[mIndex[i]];
        auto const one = v > 0 ? int64_t(1) : int64_t(-1);
        if ((v > 0 ? v : -v) <= kSmallMaxSatoshi) {
            cell.countSmall += one;
            cell.satsSmall += v;
        } else {
            cell.countLarge += one;
            cell.satsLarge += v;
        }
    }
    return n;
}

void decodeRecord(char const* base, uint64_t begin, uint64_t end, uint32_t height, ChangesInBlock& cib) {
    if (end < begin + 12) {
        fail(fmt::format("BLK record {} shorter than its header", height));
    }
    uint32_t magic = 0;
    uint32_t h = 0;
    uint32_t payload = 0;
    std::memcpy(&magic, base + begin, 4);
    std::memcpy(&h, base + begin + 4, 4);
    std::memcpy(&payload, base + begin + 8, 4);
    if (magic != 0x024b4c42U || h != height || payload < 130 || uint64_t(payload) + 12 != end - begin) {
        fail(fmt::format("BLK record framing mismatch at height {}", height));
    }
    char const* next = nullptr;
    std::tie(cib, next) = ChangesInBlock::decode(std::move(cib), base + begin);
    // NOLINTNEXTLINE(bugprone-use-after-move)
    if (next != base + end || cib.blockData().blockHeight != height) {
        fail(fmt::format("BLK record {} decoded length mismatch", height));
    }
}

namespace {

void encodeTile(Cell const* cells, uint32_t levelRows, TileInfo const& t, std::vector<uint8_t>& out, size_t& pos,
                Totals& totals) {
    constexpr size_t worstPerCell = 3 + 4 * 9;
    auto const worst = size_t(t.cols) * t.rows * worstPerCell;
    if (out.size() < pos + worst) {
        out.resize(std::max(pos + worst, out.size() + out.size() / 2));
    }
    auto* const begin = out.data();
    auto* p = begin + pos;
    int64_t previous = -1;
    for (uint32_t lr = 0; lr < t.rows; ++lr) {
        for (uint32_t lc = 0; lc < t.cols; ++lc) {
            auto const& c = cells[size_t(t.col0 + lc) * levelRows + t.row0 + lr];
            if (!c.occupied()) {
                if (c.countSmall != 0 || c.countLarge != 0 || c.satsSmall != 0 || c.satsLarge != 0) {
                    fail(fmt::format("invalid empty cell at level {} col {} row {}: {}", t.level, t.col0 + lc, t.row0 + lr,
                                     cellText(c)));
                }
                continue;
            }
            if (!validCell(c)) {
                fail(fmt::format("cell violates class invariants at level {} col {} row {}: {}", t.level, t.col0 + lc,
                                 t.row0 + lr, cellText(c)));
            }
            auto const index = int64_t(lr) * kTileSize + lc;
            p = putVarint(p, uint64_t(index - previous - 1));
            p = putVarint(p, uint64_t(c.countSmall) * 2 + (c.countLarge > 0 ? 1U : 0U));
            if (c.countSmall > 0) {
                p = putVarint(p, uint64_t(c.satsSmall));
            }
            if (c.countLarge > 0) {
                p = putVarint(p, uint64_t(c.countLarge));
                p = putVarint(p, uint64_t(c.satsLarge));
            }
            addTo(totals, c);
            previous = index;
        }
    }
    pos = static_cast<size_t>(p - begin);
}

} // namespace

auto encodeSnapshot(Grid const& grid, std::array<Cell const*, kLevels> const& levels, uint32_t block, uint64_t blkEnd,
                    std::vector<uint8_t>& out) -> SnapshotHeader {
    if (block >= grid.numBlocks) {
        fail("snapshot block outside the grid");
    }
    auto const dirEnd = size_t(kHeaderBytes) + size_t(grid.tiles) * kDirectoryEntryBytes;
    if (out.size() < dirEnd) {
        out.resize(dirEnd);
    }
    std::fill(out.begin(), out.begin() + static_cast<std::ptrdiff_t>(dirEnd), uint8_t(0));
    auto pos = dirEnd;
    auto totals = std::array<Totals, kLevels>();
    auto dir = std::vector<DirEntry>(grid.tiles);
    for (uint32_t id = 0; id < grid.tiles; ++id) {
        auto const t = grid.tileInfo(id);
        auto const start = pos;
        encodeTile(levels[t.level], grid.levels[t.level].rows, t, out, pos, totals[t.level]);
        if (pos > start) {
            dir[id] = {start, static_cast<uint32_t>(pos - start), crc32(out.data() + start, pos - start)};
        }
    }
    for (uint32_t l = 1; l < kLevels; ++l) {
        if (totals[l] != totals[0]) {
            fail(fmt::format("level {} totals {} differ from L0 {}", l, totalsText(totals[l]), totalsText(totals[0])));
        }
    }
    out.resize(pos);
    auto* h = out.data();
    std::memcpy(h, "BUVLSN1", 8);
    put32(h + 8, 1);
    put32(h + 12, kHeaderBytes);
    put32(h + 16, block);
    put32(h + 20, grid.numBlocks);
    put32(h + 24, kLevels);
    put32(h + 28, kTileSize);
    put32(h + 32, kRows);
    put32(h + 36, grid.l0Columns);
    put32(h + 40, kBlocksPerColumn);
    put32(h + 44, grid.tiles);
    put64(h + 48, blkEnd);
    put64(h + 56, uint64_t(totals[0].countSmall));
    put64(h + 64, uint64_t(totals[0].countLarge));
    put64(h + 72, uint64_t(totals[0].satsSmall));
    put64(h + 80, uint64_t(totals[0].satsLarge));
    for (uint32_t id = 0; id < grid.tiles; ++id) {
        auto* e = h + kHeaderBytes + size_t(id) * kDirectoryEntryBytes;
        put64(e, dir[id].offset);
        put32(e + 8, dir[id].bytes);
        put32(e + 12, dir[id].crc);
    }
    auto header = SnapshotHeader();
    header.block = block;
    header.numBlocks = grid.numBlocks;
    header.blkEnd = blkEnd;
    header.totals = totals[0];
    header.sha256 = sha256(out.data() + kHeaderBytes, out.size() - kHeaderBytes);
    std::memcpy(h + 88, header.sha256.data(), 32);
    return header;
}

auto openSnapshot(Grid const& grid, uint8_t const* data, size_t size) -> SnapshotView {
    auto v = SnapshotView();
    v.data = data;
    v.size = size;
    auto const dirEnd = size_t(kHeaderBytes) + size_t(grid.tiles) * kDirectoryEntryBytes;
    if (size < dirEnd) {
        fail("snapshot shorter than its directory");
    }
    if (std::memcmp(data, "BUVLSN1", 8) != 0) {
        fail("snapshot magic is not BUVLSN1");
    }
    if (get32(data + 8) != 1 || get32(data + 12) != kHeaderBytes || get32(data + 20) != grid.numBlocks ||
        get32(data + 24) != kLevels || get32(data + 28) != kTileSize || get32(data + 32) != kRows ||
        get32(data + 36) != grid.l0Columns || get32(data + 40) != kBlocksPerColumn || get32(data + 44) != grid.tiles) {
        fail("snapshot header does not match the grid");
    }
    for (size_t i = 120; i < kHeaderBytes; ++i) {
        if (data[i] != 0) {
            fail("snapshot header padding is not zero");
        }
    }
    auto& h = v.header;
    h.block = get32(data + 16);
    h.numBlocks = get32(data + 20);
    h.blkEnd = get64(data + 48);
    h.totals.countSmall = static_cast<int64_t>(get64(data + 56));
    h.totals.countLarge = static_cast<int64_t>(get64(data + 64));
    h.totals.satsSmall = static_cast<int64_t>(get64(data + 72));
    h.totals.satsLarge = static_cast<int64_t>(get64(data + 80));
    std::memcpy(h.sha256.data(), data + 88, 32);
    if (h.block >= grid.numBlocks) {
        fail("snapshot block outside the grid");
    }
    if (sha256(data + kHeaderBytes, size - kHeaderBytes) != h.sha256) {
        fail("snapshot SHA-256 mismatch");
    }
    v.dir.resize(grid.tiles);
    auto next = uint64_t(dirEnd);
    for (uint32_t id = 0; id < grid.tiles; ++id) {
        auto const* e = data + kHeaderBytes + size_t(id) * kDirectoryEntryBytes;
        auto& d = v.dir[id];
        d.offset = get64(e);
        d.bytes = get32(e + 8);
        d.crc = get32(e + 12);
        if (d.bytes == 0) {
            if (d.offset != 0 || d.crc != 0) {
                fail(fmt::format("snapshot tile {}: empty entry with offset or crc", id));
            }
            continue;
        }
        if (d.offset != next || d.bytes > size - d.offset) {
            fail(fmt::format("snapshot tile {}: blob not contiguous in tile order", id));
        }
        if (crc32(data + d.offset, d.bytes) != d.crc) {
            fail(fmt::format("snapshot tile {}: CRC-32 mismatch", id));
        }
        next += d.bytes;
    }
    if (next != size) {
        fail("snapshot has bytes after the last blob");
    }
    return v;
}

auto decodeSnapshot(Grid const& grid, uint8_t const* data, size_t size, Levels& out) -> SnapshotHeader {
    auto const v = openSnapshot(grid, data, size);
    auto totals = std::array<Totals, kLevels>();
    for (uint32_t l = 0; l < kLevels; ++l) {
        out.owned[l].assign(grid.levels[l].cells(), Cell{});
        out.cells[l] = out.owned[l].data();
        out.extent[l] = grid.levels[l].columns;
    }
    for (uint32_t id = 0; id < grid.tiles; ++id) {
        auto const& e = v.dir[id];
        if (e.bytes == 0) {
            continue;
        }
        auto const t = grid.tileInfo(id);
        auto const rows = grid.levels[t.level].rows;
        auto* dst = out.owned[t.level].data();
        auto& sum = totals[t.level];
        decodeTileBlob(t, data + e.offset, e.bytes, [&](uint32_t, uint32_t lr, uint32_t lc, Cell const& c) {
            dst[size_t(t.col0 + lc) * rows + t.row0 + lr] = c;
            addTo(sum, c);
        });
    }
    for (uint32_t l = 0; l < kLevels; ++l) {
        if (totals[l] != v.header.totals) {
            fail(fmt::format("snapshot level {} sums {} differ from header totals {}", l, totalsText(totals[l]),
                             totalsText(v.header.totals)));
        }
    }
    return v.header;
}

auto compareSnapshot(Grid const& grid, SnapshotView const& view, std::array<Cell const*, kLevels> const& expected,
                     size_t maxReports, std::vector<std::string>& reports) -> uint64_t {
    uint64_t mismatches = 0;
    auto seen = std::array<uint64_t, kLevels>();
    auto report = [&](std::string line) {
        if (reports.size() < maxReports) {
            reports.push_back(std::move(line));
        }
    };
    for (uint32_t id = 0; id < grid.tiles; ++id) {
        auto const& e = view.dir[id];
        if (e.bytes == 0) {
            continue;
        }
        auto const t = grid.tileInfo(id);
        auto const rows = grid.levels[t.level].rows;
        auto const* x = expected[t.level];
        decodeTileBlob(t, view.data + e.offset, e.bytes, [&](uint32_t, uint32_t lr, uint32_t lc, Cell const& c) {
            ++seen[t.level];
            auto const& want = x[size_t(t.col0 + lc) * rows + t.row0 + lr];
            if (want != c) {
                ++mismatches;
                report(fmt::format("L{} col {} row {}: file {} replay {}", t.level, t.col0 + lc, t.row0 + lr, cellText(c),
                                   cellText(want)));
            }
        });
    }
    for (uint32_t l = 0; l < kLevels; ++l) {
        uint64_t occupied = 0;
        auto totals = Totals();
        auto const* x = expected[l];
        auto const n = grid.levels[l].cells();
        for (size_t i = 0; i < n; ++i) {
            if (x[i].occupied()) {
                ++occupied;
                addTo(totals, x[i]);
            } else if (x[i] != Cell{}) {
                ++mismatches;
                report(fmt::format("L{} replay cell {} is not a valid empty cell: {}", l, i, cellText(x[i])));
            }
        }
        if (occupied != seen[l]) {
            mismatches += occupied > seen[l] ? occupied - seen[l] : seen[l] - occupied;
            report(fmt::format("L{}: file has {} occupied cells, replay has {}", l, seen[l], occupied));
        }
        if (l == 0 && totals != view.header.totals) {
            ++mismatches;
            report(fmt::format("header totals {} differ from replay {}", totalsText(view.header.totals), totalsText(totals)));
        }
    }
    return mismatches;
}

auto readFileBytes(std::filesystem::path const& path) -> std::vector<uint8_t> {
    auto const file = Fd(path.string());
    auto data = std::vector<uint8_t>(static_cast<size_t>(file.size()));
    file.read(data.data(), data.size(), 0);
    return data;
}

void writeFileDurable(std::filesystem::path const& path, void const* data, size_t size) {
    auto const fd = ::open(path.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0644);
    if (fd < 0) {
        fail("cannot create " + path.string() + ": " + std::strerror(errno));
    }
    noCache(fd);
    auto const* p = static_cast<char const*>(data);
    auto left = size;
    while (left > 0) {
        auto const n = ::write(fd, p, std::min<size_t>(left, size_t(1) << 30U));
        if (n < 0 && errno == EINTR) {
            continue;
        }
        if (n <= 0) {
            ::close(fd);
            fail("cannot write " + path.string() + ": " + std::strerror(errno));
        }
        p += n;
        left -= static_cast<size_t>(n);
    }
    if (::fsync(fd) != 0 || ::close(fd) != 0) {
        fail("cannot sync " + path.string());
    }
}

namespace {

void writeText(std::filesystem::path const& path, std::string const& text) {
    writeFileDurable(path, text.data(), text.size());
}

auto gridJson(Grid const& g) -> std::string {
    auto s = fmt::format("{{\"blocksPerColumn\": {}, \"rows\": {}, \"l0Columns\": {}, \"tileSize\": {}, \"border\": 1, "
                         "\"tiles\": {},\n    \"levels\": [",
                         kBlocksPerColumn, kRows, g.l0Columns, kTileSize, g.tiles);
    for (uint32_t l = 0; l < kLevels; ++l) {
        auto const& li = g.levels[l];
        s += fmt::format("{}\n      {{\"level\": {}, \"columnShift\": {}, \"rowShift\": {}, \"columns\": {}, \"rows\": {}, "
                         "\"tilesX\": {}, \"tilesY\": {}, \"firstTile\": {}}}",
                         l == 0 ? "" : ",", li.level, li.columnShift, li.rowShift, li.columns, li.rows, li.tilesX, li.tilesY,
                         li.firstTile);
    }
    return s + "\n    ]}";
}

auto defaultThreads(unsigned requested) -> unsigned {
    if (requested > 0) {
        return requested;
    }
    auto const hw = std::max(2U, std::thread::hardware_concurrency());
    return std::max(2U, std::min(4U, hw / 2));
}

} // namespace

void buildDataset(BuildOptions const& o) {
    auto const started = Clock::now();
    requireFilmAxis(o.cfg);
    if (o.snapshotIntervalBytes == 0 || o.chunkBytes == 0) {
        fail("snapshot interval and chunk size must be positive");
    }
    if (o.cfg.blkFile.empty() || o.cfg.historyFile.empty()) {
        fail("the config needs blkFile and historyFile");
    }
    prepareOutput(o.out);
    LOG("landscape_build: output {}", o.out.string());

    auto const blk = util::Mmap(o.cfg.blkFile);
    if (!blk.is_open()) {
        fail("cannot open BLK source " + o.cfg.blkFile);
    }
    auto const index = loadIndex(o.cfg.blkFile, blk.view());
    if (index.size() == 0) {
        fail("BLK source has no blocks");
    }
    auto const end = o.end ? *o.end : static_cast<uint32_t>(index.size() - 1);
    if (end >= index.size()) {
        fail(fmt::format("-end={} is beyond the BLK source tip {}", end, index.size() - 1));
    }
    auto const numBlocks = end + 1;
    auto const grid = Grid::make(numBlocks);
    auto offs = std::vector<uint64_t>(size_t(numBlocks) + 1);
    for (uint32_t h = 0; h <= numBlocks; ++h) {
        offs[h] = index.offset(h);
    }
    auto const film = FilmRows(o.cfg);
    auto const rows = RowTable::fromFilm(film);
    auto const history = History(o.cfg.historyFile);
    auto const fromHistory = std::min(numBlocks, history.numBlocks());
    auto times = std::vector<uint32_t>(numBlocks);
    for (uint32_t h = 0; h < fromHistory; ++h) {
        times[h] = history.time(h);
    }
    auto const threads = defaultThreads(o.threads);
    LOG("landscape_build: blocks 0..{} ({} tiles, {} L0 columns), BLK bytes {}, history blocks {}, {} snapshot workers", end,
        grid.tiles, grid.l0Columns, offs[numBlocks], history.numBlocks(), threads);

    auto failure = Failure();

    // Chunks: exact byte copies of whole consecutive BLK records.
    auto chunks = planChunks(offs, end, o.chunkBytes);
    auto const source = Fd(o.cfg.blkFile);
    auto nextChunk = std::atomic<size_t>(0);
    auto chunksDone = std::atomic<size_t>(0);
    auto chunkThreads = std::vector<std::thread>();
    for (unsigned i = 0; i < 2; ++i) {
        chunkThreads.emplace_back([&] {
            try {
                auto buffer = std::vector<char>();
                for (auto c = nextChunk++; c < chunks.size() && !failure.failed(); c = nextChunk++) {
                    auto& e = chunks[c];
                    buffer.resize(e.bytes);
                    source.read(buffer.data(), e.bytes, e.offset);
                    writeFileDurable(o.out / chunkName(e.index), buffer.data(), e.bytes);
                    e.sha = sha256(buffer.data(), e.bytes);
                    ++chunksDone;
                }
            } catch (...) {
                failure.set(std::current_exception());
            }
        });
    }

    // Snapshot workers encode/hash/write from L0 copies while replay continues.
    struct Job {
        uint32_t block;
        uint64_t blkEnd;
        std::unique_ptr<L0Buffer> buffer;
    };
    struct Written {
        uint32_t block;
        uint64_t blkEnd;
        uint64_t bytes;
        Hash fileSha;
        Totals totals;
    };
    auto jobs = Queue<Job>();
    auto pool = Queue<std::unique_ptr<L0Buffer>>();
    for (unsigned i = 0; i < threads + 2; ++i) {
        auto b = std::make_unique<L0Buffer>();
        b->cells.resize(grid.levels[0].cells());
        pool.push(std::move(b));
    }
    auto writtenMutex = std::mutex();
    auto written = std::vector<Written>();
    auto writtenCount = std::atomic<size_t>(0);
    auto snapshotBytes = std::atomic<uint64_t>(0);
    auto workers = std::vector<std::thread>();
    for (unsigned i = 0; i < threads; ++i) {
        workers.emplace_back([&] {
            auto levels = Levels();
            auto out = std::vector<uint8_t>();
            while (auto job = jobs.pop()) {
                if (!failure.failed()) {
                    try {
                        aggregate(grid, job->buffer->cells.data(), job->buffer->used, levels);
                        auto const header = encodeSnapshot(grid, levels.cells, job->block, job->blkEnd, out);
                        writeFileDurable(o.out / snapshotName(job->block), out.data(), out.size());
                        auto const fileSha = sha256(out.data(), out.size());
                        snapshotBytes += out.size();
                        auto lock = std::lock_guard<std::mutex>(writtenMutex);
                        written.push_back({job->block, job->blkEnd, out.size(), fileSha, header.totals});
                        ++writtenCount;
                    } catch (...) {
                        failure.set(std::current_exception());
                    }
                }
                pool.push(std::move(job->buffer));
            }
        });
    }

    auto const schedule = snapshotSchedule(offs, end, o.snapshotIntervalBytes);
    auto eras = std::vector<EraStats>(end / kEraBlocks + 1);
    auto state = State(grid);
    auto cib = ChangesInBlock();
    uint64_t changes = 0;
    double waitSeconds = 0;
    double copySeconds = 0;
    size_t nextSnapshot = 0;
    auto const replayStarted = Clock::now();
    auto lastLog = replayStarted;
    uint32_t lastLogBlock = 0;
    auto tipHash = std::string();
    double streamSeconds = 0;
    try {
        auto stream = BlockStream(o.cfg.blkFile, offs, 0, end);
        for (;;) {
            auto const waitStart = Clock::now();
            auto const* segment = stream.next();
            streamSeconds += seconds(waitStart, Clock::now());
            if (segment == nullptr || failure.failed()) {
                break;
            }
            for (auto h = segment->first; h <= segment->last && !failure.failed(); ++h) {
                auto const t0 = Clock::now();
                decodeRecord(segment->bytes.data(), offs[h] - segment->offset, offs[h + 1] - segment->offset, h, cib);
                auto const time = cib.blockData().time;
                if (h < fromHistory) {
                    if (time != times[h]) {
                        fail(fmt::format("block {}: BLK time {} differs from history time {}", h, time, times[h]));
                    }
                } else {
                    times[h] = time;
                }
                auto const n = state.applyBlock(cib, rows, +1);
                auto const t1 = Clock::now();
                changes += n;
                auto& era = eras[h / kEraBlocks];
                ++era.blocks;
                era.changes += n;
                era.bytes += offs[h + 1] - offs[h];
                era.seconds += seconds(t0, t1);
                if (h == end) {
                    tipHash = util::toHex(cib.blockData().hash);
                }
                if (nextSnapshot < schedule.size() && schedule[nextSnapshot] == h) {
                    ++nextSnapshot;
                    auto buffer = pool.pop();
                    auto const t2 = Clock::now();
                    copyPrefix(state.l0(), h / kBlocksPerColumn + 1, **buffer);
                    auto const t3 = Clock::now();
                    waitSeconds += seconds(t1, t2);
                    copySeconds += seconds(t2, t3);
                    jobs.push({h, offs[h + 1], std::move(*buffer)});
                }
                if (auto const now = Clock::now(); seconds(lastLog, now) >= 15.0) {
                    LOG("landscape_build: block {} / {} ({:.1f}% of BLK bytes), {:.0f} blocks/s, snapshots {}/{} queued {} "
                        "written, chunks {}/{}",
                        h, end, 100.0 * double(offs[h + 1]) / double(offs[numBlocks]),
                        double(h - lastLogBlock) / seconds(lastLog, now), nextSnapshot, schedule.size(), writtenCount.load(),
                        chunksDone.load(), chunks.size());
                    lastLog = now;
                    lastLogBlock = h;
                }
            }
        }
    } catch (...) {
        failure.set(std::current_exception());
    }
    auto const replaySeconds = seconds(replayStarted, Clock::now());
    jobs.close();
    for (auto& t : workers) {
        t.join();
    }
    for (auto& t : chunkThreads) {
        t.join();
    }
    failure.rethrow();
    if (written.size() != schedule.size() || chunksDone.load() != chunks.size()) {
        fail("not every snapshot or chunk was written");
    }
    std::sort(written.begin(), written.end(), [](Written const& a, Written const& b) { return a.block < b.block; });

    writeText(o.out / "rows.bin", rows.bytes());
    auto timeBytes = std::string(size_t(numBlocks) * 4, '\0');
    for (uint32_t h = 0; h < numBlocks; ++h) {
        put32(reinterpret_cast<uint8_t*>(timeBytes.data()) + size_t(h) * 4, times[h]);
    }
    writeText(o.out / "blocktimes.bin", timeBytes);

    uint64_t chunkBytes = 0;
    auto cj = std::string("{\"format\": \"utxo-landscape-chunks-1\", \"chunks\": [");
    for (auto const& e : chunks) {
        chunkBytes += e.bytes;
        cj += fmt::format("{}\n  {{\"index\": {}, \"file\": \"{}\", \"firstBlock\": {}, \"lastBlock\": {}, \"blkOffset\": {}, "
                          "\"bytes\": {}, \"sha256\": \"{}\"}}",
                          e.index == 0 ? "" : ",", e.index, chunkName(e.index), e.firstBlock, e.lastBlock, e.offset, e.bytes,
                          hex(e.sha));
    }
    cj += "\n]}\n";
    writeText(o.out / "chunks.json", cj);

    auto sj = std::string("[");
    for (size_t i = 0; i < written.size(); ++i) {
        auto const& w = written[i];
        sj += fmt::format("{}\n    {{\"block\": {}, \"file\": \"{}\", \"bytes\": {}, \"sha256\": \"{}\", \"blkEnd\": {}}}",
                          i == 0 ? "" : ",", w.block, snapshotName(w.block), w.bytes, hex(w.fileSha), w.blkEnd);
    }
    sj += "\n  ]";

    auto const& c = o.cfg;
    auto const totalSeconds = seconds(started, Clock::now());
    auto const& tipTotals = written.back().totals;
    auto m = std::string("{\n");
    m += "  \"format\": \"utxo-landscape-1\",\n";
    m += fmt::format("  \"createdUtc\": \"{}\",\n", utcNow());
    m += fmt::format("  \"numBlocks\": {}, \"tip\": {}, \"tipTime\": {}, \"tipHash\": \"{}\",\n", numBlocks, end, times[end],
                     tipHash);
    m += "  \"grid\": " + gridJson(grid) + ",\n";
    m += fmt::format("  \"axis\": {{\"graphRect\": [{},{},{},{}], \"minSatoshi\": {}, \"maxSatoshi\": {}, "
                     "\"compressLowSatoshi\": true, \"compressTopSatoshi\": true, \"whiteHotTailMinSatoshi\": {}, "
                     "\"epochBlocks\": {}, \"epochRatio\": {}, \"epochTransitionBlocks\": {}}},\n",
                     c.graphRect.x, c.graphRect.y, c.graphRect.w, c.graphRect.h, c.minSatoshi, c.maxSatoshi,
                     c.whiteHotTailMinSatoshi, c.epochBlocks, c.epochRatio, c.epochTransitionBlocks);
    m += fmt::format("  \"weightThresholdSatoshi\": {},\n", kSmallMaxSatoshi);
    m += "  \"files\": {\"rows\": \"rows.bin\", \"blocktimes\": \"blocktimes.bin\", \"chunks\": \"chunks.json\"},\n";
    m += fmt::format("  \"chunkBytesTarget\": {},\n", o.chunkBytes);
    m += fmt::format("  \"snapshotIntervalBytes\": {},\n", o.snapshotIntervalBytes);
    m += "  \"snapshots\": " + sj + ",\n";
    m += fmt::format("  \"tipTotals\": {{\"countSmall\": {}, \"countLarge\": {}, \"satsSmall\": {}, \"satsLarge\": {}}},\n",
                     tipTotals.countSmall, tipTotals.countLarge, tipTotals.satsSmall, tipTotals.satsLarge);
    m += fmt::format("  \"source\": {{\"blk\": {}, \"blkBytes\": {}, \"blkEnd\": {}, \"history\": {}, \"historyNumBlocks\": {}, "
                     "\"historyNumRecords\": {}, \"blockTimesFromHistory\": {}}},\n",
                     jsonString(c.blkFile), blk.size(), offs[numBlocks], jsonString(c.historyFile), history.header.numBlocks,
                     history.header.numRecords, fromHistory);
    m += fmt::format("  \"build\": {{\"seconds\": {:.1f}, \"replaySeconds\": {:.1f}, \"snapshotWaitSeconds\": {:.1f}, "
                     "\"snapshotCopySeconds\": {:.1f}, \"changes\": {}, \"snapshotCount\": {}, \"snapshotBytes\": {}, "
                     "\"chunkCount\": {}, \"chunkBytes\": {}, \"threads\": {},\n    \"eras\": {}}}\n",
                     totalSeconds, replaySeconds, waitSeconds, copySeconds, changes, written.size(), snapshotBytes.load(),
                     chunks.size(), chunkBytes, threads, eraJson(eras, end));
    m += "}\n";
    auto const tmp = o.out / "manifest.json.tmp";
    writeText(tmp, m);
    std::filesystem::rename(tmp, o.out / "manifest.json");

    LOG("landscape_build: done in {:.1f} s (replay {:.1f} s, waiting for workers {:.1f} s, copies {:.1f} s, waiting for "
        "reads {:.1f} s)",
        totalSeconds, replaySeconds, waitSeconds, copySeconds, streamSeconds);
    LOG("landscape_build: {} changes, {} snapshots ({} bytes), {} chunks ({} bytes)", changes, written.size(),
        snapshotBytes.load(), chunks.size(), chunkBytes);
    logEras(eras, end);
}

// ---------------------------------------------------------------------------
// Verification

namespace {

struct Checks {
    struct Entry {
        std::string name;
        bool ok;
        std::string detail;
    };
    std::mutex mutex;
    std::vector<Entry> entries;

    void add(std::string name, bool ok, std::string detail) {
        auto lock = std::lock_guard<std::mutex>(mutex);
        LOG("verify {}: {} {}", name, ok ? "OK" : "FAIL", detail);
        entries.push_back({std::move(name), ok, std::move(detail)});
    }
};

auto u64(simdjson::dom::element const& e, char const* key) -> uint64_t {
    return e[key].get_uint64().value();
}

auto str(simdjson::dom::element const& e, char const* key) -> std::string {
    return std::string(e[key].get_string().value());
}

struct ManifestSnapshot {
    uint32_t block{};
    std::string file;
    uint64_t bytes{};
    std::string sha;
    uint64_t blkEnd{};
};

struct HistoryTarget {
    uint32_t block{};
    uint32_t columns{};
    std::vector<Cell> cells; // dense, columns [0, columns)
};

} // namespace

auto verifyDataset(VerifyOptions const& o) -> bool {
    auto const started = Clock::now();
    auto checks = Checks();
    auto const threads = defaultThreads(o.threads);
    try {
        requireFilmAxis(o.cfg);
        auto const film = FilmRows(o.cfg);
        auto const rows = RowTable::fromFilm(film);

        // Manifest and grid.
        auto parser = simdjson::dom::parser();
        auto const manifest = parser.load((o.data / "manifest.json").string()).value();
        if (str(manifest, "format") != "utxo-landscape-1") {
            fail("manifest format is not utxo-landscape-1");
        }
        auto const numBlocks = static_cast<uint32_t>(u64(manifest, "numBlocks"));
        auto const tip = static_cast<uint32_t>(u64(manifest, "tip"));
        if (numBlocks == 0 || tip + 1 != numBlocks) {
            fail("manifest numBlocks/tip inconsistent");
        }
        auto const grid = Grid::make(numBlocks);
        {
            auto const g = manifest["grid"].value();
            auto ok = u64(g, "blocksPerColumn") == kBlocksPerColumn && u64(g, "rows") == kRows &&
                      u64(g, "l0Columns") == grid.l0Columns && u64(g, "tileSize") == kTileSize && u64(g, "border") == 1 &&
                      u64(g, "tiles") == grid.tiles;
            uint32_t l = 0;
            for (auto lv : g["levels"].get_array().value()) {
                if (l >= kLevels) {
                    ok = false;
                    break;
                }
                auto const& li = grid.levels[l];
                ok = ok && u64(lv, "level") == li.level && u64(lv, "columnShift") == li.columnShift &&
                     u64(lv, "rowShift") == li.rowShift && u64(lv, "columns") == li.columns && u64(lv, "rows") == li.rows &&
                     u64(lv, "tilesX") == li.tilesX && u64(lv, "tilesY") == li.tilesY && u64(lv, "firstTile") == li.firstTile;
                ++l;
            }
            auto const a = manifest["axis"].value();
            auto rect = std::vector<uint64_t>();
            for (auto v : a["graphRect"].get_array().value()) {
                rect.push_back(v.get_uint64().value());
            }
            ok = ok && l == kLevels && rect == std::vector<uint64_t>{0, 10, 3720, kRows} && u64(a, "minSatoshi") == 1 &&
                 u64(a, "maxSatoshi") == 10'000'000'000'000ULL && a["compressLowSatoshi"].get_bool().value() &&
                 a["compressTopSatoshi"].get_bool().value() &&
                 u64(manifest, "weightThresholdSatoshi") == uint64_t(kSmallMaxSatoshi);
            checks.add("manifest", ok,
                       fmt::format("blocks 0..{}, {} tiles, {} L0 columns", tip, grid.tiles, grid.l0Columns));
        }
        auto const interval = u64(manifest, "snapshotIntervalBytes");
        auto const chunkTarget = u64(manifest, "chunkBytesTarget");
        auto snapshots = std::vector<ManifestSnapshot>();
        for (auto s : manifest["snapshots"].get_array().value()) {
            snapshots.push_back({static_cast<uint32_t>(u64(s, "block")), str(s, "file"), u64(s, "bytes"), str(s, "sha256"),
                                 u64(s, "blkEnd")});
        }

        // rows.bin
        {
            auto const bytes = readFileBytes(o.data / "rows.bin");
            auto const expected = rows.bytes();
            checks.add("rows.bin", bytes.size() == expected.size() && std::memcmp(bytes.data(), expected.data(), bytes.size()) == 0,
                       "equals the film axis table");
        }

        // Sources.
        auto const blk = util::Mmap(o.cfg.blkFile);
        if (!blk.is_open()) {
            fail("cannot open BLK source " + o.cfg.blkFile);
        }
        auto const index = loadIndex(o.cfg.blkFile, blk.view());
        if (index.size() < numBlocks) {
            fail("BLK source has fewer blocks than the dataset");
        }
        auto offs = std::vector<uint64_t>(size_t(numBlocks) + 1);
        for (uint32_t h = 0; h <= numBlocks; ++h) {
            offs[h] = index.offset(h);
        }
        auto const history = History(o.cfg.historyFile);

        // blocktimes.bin: history times where covered; BLK times checked during replay.
        auto const timesFile = readFileBytes(o.data / "blocktimes.bin");
        if (timesFile.size() != size_t(numBlocks) * 4) {
            fail("blocktimes.bin has the wrong size");
        }
        {
            auto const covered = std::min(numBlocks, history.numBlocks());
            uint64_t bad = 0;
            for (uint32_t h = 0; h < covered; ++h) {
                bad += get32(timesFile.data() + size_t(h) * 4) != history.time(h) ? 1 : 0;
            }
            checks.add("blocktimes.bin vs history", bad == 0,
                       fmt::format("{} blocks compared, {} mismatches", covered, bad));
        }

        // Chunks.
        {
            auto chunkParser = simdjson::dom::parser();
            auto const cj = chunkParser.load((o.data / "chunks.json").string()).value();
            if (str(cj, "format") != "utxo-landscape-chunks-1") {
                fail("chunks.json format");
            }
            struct C {
                uint32_t index, first, last;
                uint64_t offset, bytes;
                std::string file, sha;
            };
            auto list = std::vector<C>();
            for (auto e : cj["chunks"].get_array().value()) {
                list.push_back({static_cast<uint32_t>(u64(e, "index")), static_cast<uint32_t>(u64(e, "firstBlock")),
                                static_cast<uint32_t>(u64(e, "lastBlock")), u64(e, "blkOffset"), u64(e, "bytes"), str(e, "file"),
                                str(e, "sha256")});
            }
            uint64_t layoutErrors = 0;
            uint32_t expectFirst = 0;
            for (size_t i = 0; i < list.size(); ++i) {
                auto const& e = list[i];
                auto ok = e.index == i && e.file == chunkName(e.index) && e.first == expectFirst && e.last >= e.first &&
                          e.last <= tip && e.offset == offs[e.first] && e.bytes == offs[e.last + 1] - offs[e.first] &&
                          (e.bytes <= chunkTarget || e.first == e.last);
                // greedy packing: the next block would not have fit
                if (ok && e.last < tip) {
                    ok = e.bytes + (offs[e.last + 2] - offs[e.last + 1]) > chunkTarget;
                }
                layoutErrors += ok ? 0 : 1;
                expectFirst = e.last + 1;
            }
            if (expectFirst != numBlocks) {
                ++layoutErrors;
            }
            auto next = std::atomic<size_t>(0);
            auto contentErrors = std::atomic<uint64_t>(0);
            auto bytes = std::atomic<uint64_t>(0);
            auto const source = Fd(o.cfg.blkFile);
            auto pool = std::vector<std::thread>();
            for (unsigned t = 0; t < threads; ++t) {
                pool.emplace_back([&] {
                    auto expected = std::vector<uint8_t>();
                    for (auto i = next++; i < list.size(); i = next++) {
                        auto const& e = list[i];
                        try {
                            auto const data = readFileBytes(o.data / e.file);
                            auto same = data.size() == e.bytes && e.offset + e.bytes <= blk.size();
                            if (same) {
                                expected.resize(e.bytes);
                                source.read(expected.data(), e.bytes, e.offset);
                                same = std::memcmp(data.data(), expected.data(), data.size()) == 0 &&
                                       hex(sha256(data.data(), data.size())) == e.sha;
                            }
                            contentErrors += same ? 0 : 1;
                            bytes += data.size();
                        } catch (std::exception const&) {
                            ++contentErrors;
                        }
                    }
                });
            }
            for (auto& t : pool) {
                t.join();
            }
            checks.add("chunks", layoutErrors == 0 && contentErrors == 0,
                       fmt::format("{} chunks, {} bytes, layout errors {}, content/sha mismatches {}", list.size(),
                                   bytes.load(), layoutErrors, contentErrors.load()));
        }

        // Snapshot schedule and files.
        auto const schedule = snapshotSchedule(offs, tip, interval);
        {
            auto ok = schedule.size() == snapshots.size();
            for (size_t i = 0; ok && i < schedule.size(); ++i) {
                ok = snapshots[i].block == schedule[i] && snapshots[i].blkEnd == offs[schedule[i] + 1] &&
                     snapshots[i].file == snapshotName(schedule[i]);
            }
            checks.add("snapshot schedule", ok,
                       fmt::format("{} snapshots in the manifest, {} expected", snapshots.size(), schedule.size()));
        }

        // History accumulation runs alongside the forward replay.
        auto historyBlocks = std::set<uint32_t>(o.historyBlocks.begin(), o.historyBlocks.end());
        historyBlocks.insert(tip);
        auto targets = std::vector<HistoryTarget>();
        for (auto b : historyBlocks) {
            if (b > tip || b >= history.numBlocks()) {
                checks.add(fmt::format("history at {}", b), true, "skipped: outside the dataset or history range");
                continue;
            }
            auto t = HistoryTarget();
            t.block = b;
            t.columns = b / kBlocksPerColumn + 1;
            t.cells.assign(size_t(t.columns) * kRows, Cell{});
            targets.push_back(std::move(t));
        }
        auto historyError = std::string();
        auto historyRecords = std::atomic<uint64_t>(0);
        auto historyZero = std::atomic<uint64_t>(0);
        auto historyStructure = std::atomic<uint64_t>(0);
        auto historyMutex = std::mutex();
        auto historyThread = std::thread([&] {
            if (targets.empty()) {
                return;
            }
            auto const maxBlock = targets.back().block;
            auto const columns = maxBlock / kBlocksPerColumn + 1;
            constexpr uint32_t step = 16;
            auto next = std::atomic<uint32_t>(0);
            auto const records = Fd(o.cfg.historyFile);
            auto pool = std::vector<std::thread>();
            for (unsigned t = 0; t < threads + 2; ++t) {
                pool.emplace_back([&] {
                    try {
                        auto buffer = std::vector<UtxoHistoryRecord>();
                        for (auto c0 = next.fetch_add(step); c0 < columns; c0 = next.fetch_add(step)) {
                            auto const c1 = std::min(columns, c0 + step);
                            auto const h0 = uint64_t(c0) * kBlocksPerColumn;
                            auto const h1 = std::min<uint64_t>(uint64_t(c1) * kBlocksPerColumn, uint64_t(maxBlock) + 1);
                            auto const first = history.heightIndex(h0);
                            auto const last = history.heightIndex(h1);
                            if (last < first || last > history.header.numRecords) {
                                fail(fmt::format("history height index not monotone at heights {}..{}", h0, h1));
                            }
                            buffer.resize(last - first);
                            records.read(buffer.data(), buffer.size() * sizeof(UtxoHistoryRecord),
                                         history.header.recordsOff + first * sizeof(UtxoHistoryRecord));
                            uint64_t seen = 0;
                            uint64_t zero = 0;
                            uint64_t bad = 0;
                            for (auto h = h0; h < h1; ++h) {
                                auto const i0 = history.heightIndex(h);
                                auto const i1 = history.heightIndex(h + 1);
                                if (i1 < i0 || i0 < first || i1 > last) {
                                    ++bad;
                                    continue;
                                }
                                auto const col = static_cast<uint32_t>(h / kBlocksPerColumn);
                                for (auto i = i0; i < i1; ++i) {
                                    auto const& r = buffer[i - first];
                                    ++seen;
                                    if (r.creationHeight != h || r.satoshi < 0 ||
                                        (r.spendHeight != kUnspent && r.spendHeight < r.creationHeight)) {
                                        ++bad;
                                        continue;
                                    }
                                    if (r.satoshi == 0) {
                                        ++zero;
                                        continue;
                                    }
                                    auto const row = film.row(r.satoshi);
                                    for (auto& t : targets) {
                                        if (h > t.block || r.spendHeight <= t.block) {
                                            continue;
                                        }
                                        auto& cell = t.cells[size_t(col) * kRows + row];
                                        if (r.satoshi <= kSmallMaxSatoshi) {
                                            ++cell.countSmall;
                                            cell.satsSmall += r.satoshi;
                                        } else {
                                            ++cell.countLarge;
                                            cell.satsLarge += r.satoshi;
                                        }
                                    }
                                }
                            }
                            historyRecords += seen;
                            historyZero += zero;
                            historyStructure += bad;
                        }
                    } catch (std::exception const& e) {
                        auto lock = std::lock_guard<std::mutex>(historyMutex);
                        historyError = e.what();
                    }
                });
            }
            for (auto& t : pool) {
                t.join();
            }
        });

        // Optional renderer checkpoint: capture the state at nextHeight - 1.
        auto checkpointBlock = std::optional<uint32_t>();
        auto checkpointMap = std::unique_ptr<util::Mmap>();
        if (o.checkpoint) {
            checkpointMap = std::make_unique<util::Mmap>(*o.checkpoint);
            if (!checkpointMap->is_open() || checkpointMap->size() < 184 ||
                std::memcmp(checkpointMap->data(), "BUVRCP01", 8) != 0) {
                fail("cannot read renderer checkpoint " + o.checkpoint->string());
            }
            auto const next = get64(reinterpret_cast<uint8_t const*>(checkpointMap->data()) + 24);
            if (next == 0 || next - 1 > tip) {
                checks.add("renderer checkpoint", true,
                           fmt::format("skipped: its block {} is outside the dataset", next == 0 ? 0 : next - 1));
            } else {
                checkpointBlock = static_cast<uint32_t>(next - 1);
            }
        }

        // Forward replay from genesis, comparing every snapshot.
        auto captures = std::map<uint32_t, std::vector<Cell>>();
        {
            struct Job {
                size_t snapshot;
                std::unique_ptr<L0Buffer> buffer;
            };
            auto jobs = Queue<Job>();
            auto pool = Queue<std::unique_ptr<L0Buffer>>();
            for (unsigned i = 0; i < threads + 1; ++i) {
                auto b = std::make_unique<L0Buffer>();
                b->cells.resize(grid.levels[0].cells());
                pool.push(std::move(b));
            }
            auto failure = Failure();
            auto mismatchedSnapshots = std::atomic<uint64_t>(0);
            auto mismatchedCells = std::atomic<uint64_t>(0);
            auto checkedBytes = std::atomic<uint64_t>(0);
            auto reportsMutex = std::mutex();
            auto reports = std::vector<std::string>();
            auto workers = std::vector<std::thread>();
            for (unsigned i = 0; i < threads; ++i) {
                workers.emplace_back([&] {
                    auto levels = Levels();
                    while (auto job = jobs.pop()) {
                        auto const& s = snapshots[job->snapshot];
                        try {
                            auto const data = readFileBytes(o.data / s.file);
                            auto local = std::vector<std::string>();
                            uint64_t bad = 0;
                            if (data.size() != s.bytes || hex(sha256(data.data(), data.size())) != s.sha) {
                                ++bad;
                                local.push_back("size or file SHA-256 differs from the manifest");
                            }
                            auto const view = openSnapshot(grid, data.data(), data.size());
                            if (view.header.block != s.block || view.header.blkEnd != s.blkEnd) {
                                ++bad;
                                local.push_back("header block/blkEnd mismatch");
                            }
                            aggregate(grid, job->buffer->cells.data(), job->buffer->used, levels);
                            bad += compareSnapshot(grid, view, levels.cells, 5, local);
                            checkedBytes += data.size();
                            if (bad > 0) {
                                ++mismatchedSnapshots;
                                mismatchedCells += bad;
                                auto lock = std::lock_guard<std::mutex>(reportsMutex);
                                for (auto& line : local) {
                                    if (reports.size() < 20) {
                                        reports.push_back(fmt::format("snapshot {}: {}", s.block, line));
                                    }
                                }
                            }
                        } catch (std::exception const& e) {
                            ++mismatchedSnapshots;
                            auto lock = std::lock_guard<std::mutex>(reportsMutex);
                            if (reports.size() < 20) {
                                reports.push_back(fmt::format("snapshot {}: {}", s.block, e.what()));
                            }
                        }
                        pool.push(std::move(job->buffer));
                    }
                });
            }
            auto captureBlocks = std::set<uint32_t>();
            for (auto const& t : targets) {
                captureBlocks.insert(t.block);
            }
            if (checkpointBlock) {
                captureBlocks.insert(*checkpointBlock);
            }
            auto state = State(grid);
            auto cib = ChangesInBlock();
            size_t next = 0;
            uint64_t timeMismatches = 0;
            auto lastLog = Clock::now();
            auto eras = std::vector<EraStats>(tip / kEraBlocks + 1);
            auto const replayStarted = Clock::now();
            try {
                auto stream = BlockStream(o.cfg.blkFile, offs, 0, tip);
                while (auto const* segment = stream.next()) {
                    for (auto h = segment->first; h <= segment->last; ++h) {
                        auto const t0 = Clock::now();
                        decodeRecord(segment->bytes.data(), offs[h] - segment->offset, offs[h + 1] - segment->offset, h, cib);
                        timeMismatches += cib.blockData().time != get32(timesFile.data() + size_t(h) * 4) ? 1 : 0;
                        auto const n = state.applyBlock(cib, rows, +1);
                        auto& era = eras[h / kEraBlocks];
                        ++era.blocks;
                        era.changes += n;
                        era.bytes += offs[h + 1] - offs[h];
                        era.seconds += seconds(t0, Clock::now());
                        auto const used = h / kBlocksPerColumn + 1;
                        if (captureBlocks.count(h) != 0) {
                            captures[h].assign(state.l0(), state.l0() + size_t(used) * kRows);
                        }
                        if (next < snapshots.size() && snapshots[next].block == h) {
                            auto buffer = pool.pop();
                            copyPrefix(state.l0(), used, **buffer);
                            jobs.push({next, std::move(*buffer)});
                            ++next;
                        }
                        if (auto const now = Clock::now(); seconds(lastLog, now) >= 15.0) {
                            LOG("landscape_verify: forward replay at block {} / {}, {} snapshots queued", h, tip, next);
                            lastLog = now;
                        }
                    }
                }
            } catch (...) {
                failure.set(std::current_exception());
            }
            LOG("landscape_verify: forward replay finished in {:.1f} s (decode+apply per era below)",
                seconds(replayStarted, Clock::now()));
            logEras(eras, tip);
            jobs.close();
            for (auto& t : workers) {
                t.join();
            }
            failure.rethrow();
            checks.add("blocktimes.bin vs BLK", timeMismatches == 0,
                       fmt::format("{} blocks compared, {} mismatches", numBlocks, timeMismatches));
            auto detail = fmt::format("{} of {} snapshots compared ({} bytes), {} mismatching snapshots, {} mismatching cells",
                                      next, snapshots.size(), checkedBytes.load(), mismatchedSnapshots.load(),
                                      mismatchedCells.load());
            for (auto const& line : reports) {
                detail += "\n    " + line;
            }
            checks.add("forward replay vs every snapshot",
                       next == snapshots.size() && mismatchedSnapshots == 0 && mismatchedCells == 0, detail);
        }

        // Backward replays: snapshot k+1 undone to snapshot k's block.
        if (snapshots.size() >= 2 && o.samples > 0) {
            auto rng = std::mt19937_64(o.seed);
            auto candidates = std::vector<size_t>(snapshots.size() - 1);
            for (size_t i = 0; i < candidates.size(); ++i) {
                candidates[i] = i;
            }
            std::shuffle(candidates.begin(), candidates.end(), rng);
            candidates.resize(std::min<size_t>(candidates.size(), o.samples));
            std::sort(candidates.begin(), candidates.end());
            auto next = std::atomic<size_t>(0);
            auto bad = std::atomic<uint64_t>(0);
            auto undone = std::atomic<uint64_t>(0);
            auto reportsMutex = std::mutex();
            auto reports = std::vector<std::string>();
            auto const source = Fd(o.cfg.blkFile);
            auto pool = std::vector<std::thread>();
            for (unsigned t = 0; t < std::min(threads, 4U); ++t) {
                pool.emplace_back([&] {
                    auto state = State(grid);
                    auto levels = Levels();
                    auto cib = ChangesInBlock();
                    auto range = std::vector<char>();
                    for (auto i = next++; i < candidates.size(); i = next++) {
                        auto const k = candidates[i];
                        auto const& lower = snapshots[k];
                        auto const& upper = snapshots[k + 1];
                        try {
                            {
                                auto const data = readFileBytes(o.data / upper.file);
                                auto const view = openSnapshot(grid, data.data(), data.size());
                                state.clear();
                                auto* l0 = state.l0();
                                for (uint32_t id = 0; id < grid.levels[1].firstTile; ++id) {
                                    auto const& e = view.dir[id];
                                    if (e.bytes == 0) {
                                        continue;
                                    }
                                    auto const t = grid.tileInfo(id);
                                    decodeTileBlob(t, data.data() + e.offset, e.bytes,
                                                   [&](uint32_t, uint32_t lr, uint32_t lc, Cell const& c) {
                                                       l0[size_t(t.col0 + lc) * kRows + t.row0 + lr] = c;
                                                   });
                                }
                            }
                            auto const base = offs[lower.block + 1];
                            range.resize(offs[upper.block + 1] - base);
                            source.read(range.data(), range.size(), base);
                            for (auto h = upper.block; h > lower.block; --h) {
                                decodeRecord(range.data(), offs[h] - base, offs[h + 1] - base, h, cib);
                                state.applyBlock(cib, rows, -1);
                                ++undone;
                            }
                            aggregate(grid, state.l0(), upper.block / kBlocksPerColumn + 1, levels);
                            auto const data = readFileBytes(o.data / lower.file);
                            auto const view = openSnapshot(grid, data.data(), data.size());
                            auto local = std::vector<std::string>();
                            auto const n = compareSnapshot(grid, view, levels.cells, 3, local);
                            if (n > 0) {
                                ++bad;
                                auto lock = std::lock_guard<std::mutex>(reportsMutex);
                                for (auto& line : local) {
                                    reports.push_back(fmt::format("{} -> {}: {}", upper.block, lower.block, line));
                                }
                            }
                        } catch (std::exception const& e) {
                            ++bad;
                            auto lock = std::lock_guard<std::mutex>(reportsMutex);
                            reports.push_back(fmt::format("{} -> {}: {}", upper.block, lower.block, e.what()));
                        }
                    }
                });
            }
            for (auto& t : pool) {
                t.join();
            }
            auto pairs = std::string();
            for (auto k : candidates) {
                pairs += fmt::format(" {}->{}", snapshots[k + 1].block, snapshots[k].block);
            }
            auto detail = fmt::format("{} backward replays ({} blocks undone), {} mismatching; pairs:{}", candidates.size(),
                                      undone.load(), bad.load(), pairs);
            for (auto const& line : reports) {
                detail += "\n    " + line;
            }
            checks.add("backward replays", bad == 0, detail);
        }

        // History cross-check.
        historyThread.join();
        if (!historyError.empty()) {
            fail("history pass: " + historyError);
        }
        for (auto const& t : targets) {
            auto const& replay = captures.at(t.block);
            uint64_t mismatches = 0;
            uint64_t occupied = 0;
            auto lines = std::string();
            for (size_t i = 0; i < t.cells.size(); ++i) {
                occupied += t.cells[i].occupied() ? 1 : 0;
                if (t.cells[i] != replay[i]) {
                    if (++mismatches <= 5) {
                        lines += fmt::format("\n    col {} row {}: history {} replay {}", i / kRows, i % kRows,
                                             cellText(t.cells[i]), cellText(replay[i]));
                    }
                }
            }
            checks.add(fmt::format("history at {}", t.block), mismatches == 0 && historyStructure == 0,
                       fmt::format("{} L0 cells compared ({} occupied), {} mismatches; {} records read, {} zero-amount "
                                   "skipped, {} structural errors{}",
                                   t.cells.size(), occupied, mismatches, historyRecords.load(), historyZero.load(),
                                   historyStructure.load(), lines));
        }

        // Renderer checkpoint: amount-weighted alive ledger per (height, absolute y).
        if (checkpointBlock) {
            auto const* d = reinterpret_cast<uint8_t const*>(checkpointMap->data());
            auto const size = uint64_t(checkpointMap->size());
            auto const next = get64(d + 24);
            auto const count = get64(d + 48);
            auto const ok = get64(d + 8) == 1 && get64(d + 16) == 152 && count <= (size - 184) / 16 &&
                            size == 152 + count * 16 + 32;
            if (!ok) {
                fail("renderer checkpoint header/length invalid");
            }
            auto const headerOk = sha256(d, 120) == *reinterpret_cast<Hash const*>(d + 120);
            auto const fileOk = sha256(d, size - 32) == *reinterpret_cast<Hash const*>(d + size - 32);
            auto const bindingOk = get64(d + 32) == offs[next];
            auto const columns = *checkpointBlock / kBlocksPerColumn + 1;
            auto weights = std::vector<double>(size_t(columns) * kRows, 0.0);
            uint64_t badKeys = 0;
            for (uint64_t i = 0; i < count; ++i) {
                auto const key = get64(d + 152 + i * 16);
                auto const bits = get64(d + 152 + i * 16 + 8);
                double w = 0;
                std::memcpy(&w, &bits, 8);
                auto const height = key >> 16U;
                auto const y = key & 0xFFFFU;
                if (height >= next || y < 10 || y >= 10 + kRows) {
                    ++badKeys;
                    continue;
                }
                weights[size_t(height / kBlocksPerColumn) * kRows + (y - 10)] += w;
            }
            auto const& replay = captures.at(*checkpointBlock);
            uint64_t mismatches = 0;
            uint64_t occupied = 0;
            double maxAbs = 0;
            double maxRel = 0;
            auto lines = std::string();
            for (size_t i = 0; i < weights.size(); ++i) {
                auto const& c = replay[i];
                auto const expected = double(c.countSmall) + double(c.satsLarge) / double(kSmallMaxSatoshi);
                occupied += c.occupied() ? 1 : 0;
                auto const diff = std::fabs(expected - weights[i]);
                maxAbs = std::max(maxAbs, diff);
                if (expected > 0) {
                    maxRel = std::max(maxRel, diff / expected);
                }
                if (diff > 1e-6) {
                    if (++mismatches <= 5) {
                        lines += fmt::format("\n    col {} row {}: ledger {:.9f} replay {:.9f} {}", i / kRows, i % kRows,
                                             weights[i], expected, cellText(c));
                    }
                }
            }
            checks.add(fmt::format("renderer checkpoint at {}", *checkpointBlock),
                       headerOk && fileOk && bindingOk && badKeys == 0 && mismatches == 0,
                       fmt::format("{} ledger entries, {} cells compared ({} occupied), {} mismatches > 1e-6, max abs diff "
                                   "{:.3g}, max rel diff {:.3g}; header sha {}, file sha {}, BLK binding {}, bad keys {}{}",
                                   count, weights.size(), occupied, mismatches, maxAbs, maxRel, headerOk ? "ok" : "BAD",
                                   fileOk ? "ok" : "BAD", bindingOk ? "ok" : "BAD", badKeys, lines));
        }
    } catch (std::exception const& e) {
        checks.add("fatal", false, e.what());
    }

    auto ok = !checks.entries.empty();
    fmt::print("\nlandscape_verify summary ({}, {:.1f} s)\n", o.data.string(), seconds(started, Clock::now()));
    for (auto const& e : checks.entries) {
        fmt::print("  [{}] {}: {}\n", e.ok ? "PASS" : "FAIL", e.name, e.detail);
        ok = ok && e.ok;
    }
    fmt::print("RESULT: {}\n", ok ? "PASS" : "FAIL");
    std::fflush(stdout);
    return ok;
}

} // namespace buv::landscape

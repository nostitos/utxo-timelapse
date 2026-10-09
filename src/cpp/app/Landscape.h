#pragma once

// UTXO Timelapse landscape data (contract: landscape/SPEC.md sections 2-4).
//
// Exact per-cell UTXO state on the landscape grid. An L0 cell is 64 creation
// blocks x one film amount row; seven levels; 256x256 tiles. While replaying,
// the C++ tools keep only L0 (column-major, so the columns created so far form
// a prefix) and derive the coarser levels by exact aggregation whenever a
// snapshot is written or verified.

#include <app/Cfg.h>
#include <buv/SatoshiBlockheightToPixel.h>

#include <array>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <optional>
#include <string>
#include <vector>

namespace buv {
class ChangesInBlock;
}

namespace buv::landscape {

inline constexpr uint32_t kBlocksPerColumn = 64;
inline constexpr uint32_t kRows = 2072;
inline constexpr uint32_t kTileSize = 256;
inline constexpr uint32_t kLevels = 7;
// Small: 1 <= amount <= 5 BTC (exactly 5 BTC is small). Large: amount > 5 BTC.
inline constexpr int64_t kSmallMaxSatoshi = 500'000'000;
inline constexpr uint32_t kHeaderBytes = 128;
inline constexpr uint32_t kDirectoryEntryBytes = 16;
inline constexpr uint64_t kDefaultChunkBytes = uint64_t(4) << 20U;
inline constexpr uint64_t kDefaultSnapshotIntervalBytes = uint64_t(16) << 20U;

using Hash = std::array<uint8_t, 32>;

// SHA-256 (CommonCrypto on Apple, the repository's portable FIPS 180-4
// implementation elsewhere) and CRC-32 (IEEE, as zlib).
[[nodiscard]] auto sha256(void const* data, size_t size) -> Hash;
[[nodiscard]] auto hex(Hash const& hash) -> std::string;
[[nodiscard]] auto crc32(void const* data, size_t size) -> uint32_t;
[[nodiscard]] auto crc32Portable(void const* data, size_t size) -> uint32_t;

[[noreturn]] void fail(std::string const& what);

struct LevelInfo {
    uint32_t level{};
    uint32_t columnShift{};
    uint32_t rowShift{};
    uint32_t columns{};
    uint32_t rows{};
    uint32_t tilesX{};
    uint32_t tilesY{};
    uint32_t firstTile{};
    [[nodiscard]] auto cells() const -> size_t {
        return size_t(columns) * rows;
    }
};

struct TileInfo {
    uint32_t id{};
    uint32_t level{};
    uint32_t tx{};
    uint32_t ty{};
    uint32_t col0{}; // first cell column at this level
    uint32_t row0{}; // first cell row at this level
    uint32_t cols{}; // cells inside the grid (<= 256)
    uint32_t rows{};
};

struct Grid {
    uint32_t numBlocks{};
    uint32_t l0Columns{};
    uint32_t tiles{};
    std::array<LevelInfo, kLevels> levels{};

    [[nodiscard]] static auto make(uint32_t numBlocks) -> Grid;
    [[nodiscard]] auto tileId(uint32_t level, uint32_t tx, uint32_t ty) const -> uint32_t;
    [[nodiscard]] auto tileInfo(uint32_t id) const -> TileInfo;
    // Number of L0 cells covered inside the grid.
    [[nodiscard]] auto cellArea(uint32_t level, uint32_t col, uint32_t row) const -> uint64_t;
};

struct Cell {
    int64_t countSmall{};
    int64_t countLarge{};
    int64_t satsSmall{};
    int64_t satsLarge{};

    [[nodiscard]] auto occupied() const -> bool {
        return countSmall + countLarge > 0;
    }
    void add(Cell const& o) {
        countSmall += o.countSmall;
        countLarge += o.countLarge;
        satsSmall += o.satsSmall;
        satsLarge += o.satsLarge;
    }
    [[nodiscard]] auto operator==(Cell const& o) const -> bool {
        return countSmall == o.countSmall && countLarge == o.countLarge && satsSmall == o.satsSmall &&
               satsLarge == o.satsLarge;
    }
    [[nodiscard]] auto operator!=(Cell const& o) const -> bool {
        return !(*this == o);
    }
};
static_assert(sizeof(Cell) == 32);

// Seven dense column-major levels (index = col * levelRows + row). Level 0 may
// be borrowed (cells[0] points into a replay buffer, owned[0] stays empty).
struct Levels {
    std::array<std::vector<Cell>, kLevels> owned{};
    std::array<Cell const*, kLevels> cells{};
    std::array<uint32_t, kLevels> extent{}; // columns that may be non-zero
};

// Sets out.cells[0] = l0 and aggregates levels 1..6 exactly. Columns of l0 at
// and beyond usedColumns must be zero.
void aggregate(Grid const& grid, Cell const* l0, uint32_t usedColumns, Levels& out);

// The published film amount axis (SPEC section 2); throws on any other axis.
void requireFilmAxis(Cfg const& cfg);
[[nodiscard]] auto filmAxisCfg() -> Cfg;

// The film's graph row: SatoshiBlockheightToPixel::satoshiToPixelHeight(a) - graphRect.y.
class FilmRows {
    Cfg mCfg;
    SatoshiBlockheightToPixel mMapper;

public:
    explicit FilmRows(Cfg const& cfg);
    FilmRows(FilmRows const&) = delete;
    auto operator=(FilmRows const&) -> FilmRows& = delete;
    [[nodiscard]] auto row(int64_t amount) const -> uint32_t;
};

// Exact amount -> row through the published table (rows.bin):
// minAmt[r] = smallest amount a >= 1 with row(a) <= r; row(a) = min{r : a >= minAmt[r]}.
class RowTable {
    std::array<int64_t, kRows> mMinAmt{};

public:
    [[nodiscard]] static auto fromFilm(FilmRows const& film) -> RowTable;
    [[nodiscard]] auto minAmt(uint32_t row) const -> int64_t {
        return mMinAmt[row];
    }
    [[nodiscard]] auto row(int64_t amount) const -> uint32_t;
    [[nodiscard]] auto bytes() const -> std::string; // 2072 x float64 LE
};

// Exact L0 state, column-major (index = col * kRows + row).
class State {
    Grid mGrid;
    std::vector<Cell> mL0;
    std::vector<uint32_t> mIndex;
    std::vector<int64_t> mAmount;

public:
    explicit State(Grid const& grid);
    [[nodiscard]] auto grid() const -> Grid const& {
        return mGrid;
    }
    [[nodiscard]] auto l0() const -> Cell const* {
        return mL0.data();
    }
    [[nodiscard]] auto l0() -> Cell* {
        return mL0.data();
    }
    [[nodiscard]] auto at(uint32_t col, uint32_t row) const -> Cell const& {
        return mL0[size_t(col) * kRows + row];
    }
    // Applies (sign +1) or undoes (sign -1) one decoded block. Zero amounts are
    // skipped. Returns the number of applied changes.
    auto applyBlock(ChangesInBlock const& block, RowTable const& rows, int sign) -> uint64_t;
    void clear();
};

// Decodes the BLK2 record of 'height' spanning [begin, end) of base with the
// repository decoder, checking framing, height and decoded length.
void decodeRecord(char const* base, uint64_t begin, uint64_t end, uint32_t height, ChangesInBlock& cib);

struct Totals {
    int64_t countSmall{};
    int64_t countLarge{};
    int64_t satsSmall{};
    int64_t satsLarge{};
    [[nodiscard]] auto operator==(Totals const& o) const -> bool {
        return countSmall == o.countSmall && countLarge == o.countLarge && satsSmall == o.satsSmall &&
               satsLarge == o.satsLarge;
    }
    [[nodiscard]] auto operator!=(Totals const& o) const -> bool {
        return !(*this == o);
    }
};

struct SnapshotHeader {
    uint32_t block{};
    uint32_t numBlocks{};
    uint64_t blkEnd{};
    Totals totals{};
    Hash sha256{}; // of bytes [128, EOF)
};

struct DirEntry {
    uint64_t offset{};
    uint32_t bytes{};
    uint32_t crc{};
};

// Encodes all seven levels as BUVLSN1 into out (replacing its contents). Checks
// state invariants (non-negative, class ranges, equal totals on every level).
auto encodeSnapshot(Grid const& grid, std::array<Cell const*, kLevels> const& levels, uint32_t block, uint64_t blkEnd,
                    std::vector<uint8_t>& out) -> SnapshotHeader;

// Validates header, layout, SHA-256 and every CRC. Blobs are parsed separately.
struct SnapshotView {
    SnapshotHeader header{};
    std::vector<DirEntry> dir{};
    uint8_t const* data{};
    size_t size{};
};
auto openSnapshot(Grid const& grid, uint8_t const* data, size_t size) -> SnapshotView;

// Strict LEB128 (minimal, <= 63 bits). Returns false on any violation.
inline auto readVarint(uint8_t const*& p, uint8_t const* end, uint64_t& value) -> bool {
    value = 0;
    for (unsigned shift = 0; shift <= 56; shift += 7) {
        if (p == end) {
            return false;
        }
        auto const b = *p++;
        value |= uint64_t(b & 0x7FU) << shift;
        if ((b & 0x80U) == 0) {
            return (b != 0 || shift == 0) && value <= uint64_t(INT64_MAX);
        }
    }
    return false;
}

// Parses one tile blob, calling f(localIndex, localRow, localCol, cell) for each
// occupied cell in file order. Throws on any format or invariant violation.
template <typename F>
void decodeTileBlob(TileInfo const& t, uint8_t const* p, size_t size, F&& f) {
    auto const* end = p + size;
    int64_t previous = -1;
    while (p < end) {
        uint64_t gap = 0;
        uint64_t head = 0;
        Cell c{};
        if (!readVarint(p, end, gap) || gap >= uint64_t(kTileSize) * kTileSize) {
            fail("tile blob: bad gap");
        }
        auto const index = uint64_t(previous + 1) + gap;
        auto const localRow = static_cast<uint32_t>(index / kTileSize);
        auto const localCol = static_cast<uint32_t>(index % kTileSize);
        if (localRow >= t.rows || localCol >= t.cols) {
            fail("tile blob: cell outside the tile");
        }
        if (!readVarint(p, end, head)) {
            fail("tile blob: bad count");
        }
        c.countSmall = static_cast<int64_t>(head >> 1U);
        auto const hasLarge = (head & 1U) != 0;
        uint64_t v = 0;
        if (c.countSmall > 0) {
            if (!readVarint(p, end, v)) {
                fail("tile blob: bad satsSmall");
            }
            c.satsSmall = static_cast<int64_t>(v);
        }
        if (hasLarge) {
            if (!readVarint(p, end, v) || v == 0) {
                fail("tile blob: bad countLarge");
            }
            c.countLarge = static_cast<int64_t>(v);
            if (!readVarint(p, end, v)) {
                fail("tile blob: bad satsLarge");
            }
            c.satsLarge = static_cast<int64_t>(v);
        }
        if (!c.occupied() || c.countSmall > (int64_t(1) << 34) || c.countLarge > (int64_t(1) << 34) ||
            c.satsSmall < c.countSmall || c.satsSmall > c.countSmall * kSmallMaxSatoshi ||
            c.satsLarge < c.countLarge * (kSmallMaxSatoshi + 1)) {
            fail("tile blob: cell violates class invariants");
        }
        f(static_cast<uint32_t>(index), localRow, localCol, c);
        previous = static_cast<int64_t>(index);
    }
}

// Dense decode of every level into out.owned (cells/extent set accordingly).
auto decodeSnapshot(Grid const& grid, uint8_t const* data, size_t size, Levels& out) -> SnapshotHeader;

// Compares a snapshot file's cells with expected dense levels. Returns the
// number of mismatching cells (0 = identical) and appends up to maxReports
// human-readable lines to reports.
auto compareSnapshot(Grid const& grid, SnapshotView const& view, std::array<Cell const*, kLevels> const& expected,
                     size_t maxReports, std::vector<std::string>& reports) -> uint64_t;

[[nodiscard]] auto readFileBytes(std::filesystem::path const& path) -> std::vector<uint8_t>;
void writeFileDurable(std::filesystem::path const& path, void const* data, size_t size);

struct BuildOptions {
    Cfg cfg{};
    std::filesystem::path out{};
    std::optional<uint32_t> end{};
    uint64_t snapshotIntervalBytes = kDefaultSnapshotIntervalBytes;
    uint64_t chunkBytes = kDefaultChunkBytes;
    unsigned threads = 0; // 0 = automatic
};
void buildDataset(BuildOptions const& options);

struct VerifyOptions {
    Cfg cfg{};
    std::filesystem::path data{};
    std::optional<std::filesystem::path> checkpoint{};
    uint32_t samples = 20;
    uint64_t seed = 1;
    unsigned threads = 0;
    // History cross-check blocks; the dataset tip is always added. Blocks outside
    // the dataset or the history file are skipped (and reported).
    std::vector<uint32_t> historyBlocks{210'000, 630'000};
};
// Prints a summary; returns true when every check passed.
auto verifyDataset(VerifyOptions const& options) -> bool;

} // namespace buv::landscape

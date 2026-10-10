// Landscape data tasks (contract: landscape/SPEC.md):
//   landscape_state   data-free unit case (runs by default)
//   landscape_build   -cfg=CONFIG -outDir=NEW_DIR [-end=BLOCK] [-snapshotBytes=N] [-chunkBytes=N] [-threads=N]
//   landscape_verify  -cfg=CONFIG -data=DIR [-checkpoint=renderer_before_N.bin] [-samples=20] [-seed=1]
//                     [-threads=N] [-historyBlocks=210000,630000]
//
// Never pass -out= or -o=: doctest owns those (its report file) and opens that
// path for writing before any task runs.

#include <app/BlockEncoder.h>
#include <app/Cfg.h>
#include <app/Landscape.h>
#include <app/UtxoHistory.h>
#include <util/args.h>
#include <util/log.h>

#include <doctest.h>
#include <fmt/format.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <map>
#include <optional>
#include <random>
#include <sstream>
#include <string>
#include <vector>

#include <unistd.h>

namespace lsc = buv::landscape;

namespace {

struct TempDir {
    std::filesystem::path path;
    TempDir() {
        auto s = (std::filesystem::temp_directory_path() / "buv-landscape-test-XXXXXX").string();
        auto p = std::vector<char>(s.begin(), s.end());
        p.push_back('\0');
        auto* r = ::mkdtemp(p.data());
        if (r == nullptr) {
            throw std::runtime_error("mkdtemp failed");
        }
        path = r;
    }
    TempDir(TempDir const&) = delete;
    auto operator=(TempDir const&) -> TempDir& = delete;
    ~TempDir() {
        auto ec = std::error_code();
        std::filesystem::remove_all(path, ec);
    }
};

void writeBytes(std::filesystem::path const& p, void const* data, size_t n) {
    auto f = std::ofstream(p, std::ios::binary | std::ios::trunc);
    f.write(static_cast<char const*>(data), static_cast<std::streamsize>(n));
    if (!f) {
        throw std::runtime_error("write failed: " + p.string());
    }
}

void put64(uint8_t* p, uint64_t v) {
    for (unsigned i = 0; i < 8; ++i) {
        p[i] = static_cast<uint8_t>(v >> (8U * i));
    }
}

auto get64(uint8_t const* p) -> uint64_t {
    uint64_t v = 0;
    for (unsigned i = 0; i < 8; ++i) {
        v |= uint64_t(p[i]) << (8U * i);
    }
    return v;
}

auto get32(uint8_t const* p) -> uint32_t {
    uint32_t v = 0;
    for (unsigned i = 0; i < 4; ++i) {
        v |= uint32_t(p[i]) << (8U * i);
    }
    return v;
}

struct Output {
    uint32_t height;
    int64_t amount;
    uint32_t spend;
};

struct Chain {
    std::string blk;
    std::vector<uint64_t> offsets;
    std::vector<Output> outputs;
    std::vector<uint32_t> times;
};

auto interestingAmount(std::mt19937_64& rng, lsc::RowTable const& rows) -> int64_t {
    static constexpr int64_t fixed[] = {0,
                                        1,
                                        2,
                                        99,
                                        100,
                                        101,
                                        546,
                                        10'000,
                                        499'999'999,
                                        500'000'000,
                                        500'000'001,
                                        1'000'000'000,
                                        5'000'000'000,
                                        779'521'282'186,
                                        999'999'999'999,
                                        1'000'000'000'000,
                                        10'000'000'000'000,
                                        50'000'000'000'000};
    switch (rng() % 4) {
    case 0:
        return fixed[rng() % std::size(fixed)];
    case 1: {
        auto const r = static_cast<uint32_t>(rng() % lsc::kRows);
        return std::max<int64_t>(1, rows.minAmt(r) + static_cast<int64_t>(rng() % 3) - 1);
    }
    default: {
        auto u = std::uniform_real_distribution<double>(0.0, std::log(1e14));
        return std::max<int64_t>(1, static_cast<int64_t>(std::exp(u(rng))));
    }
    }
}

// Random chain encoded with the repository's ChangesInBlock encoder: zero
// amounts, class boundaries, row boundaries, same-block create+spend.
auto makeChain(uint32_t numBlocks, uint64_t seed, lsc::RowTable const& rows) -> Chain {
    auto rng = std::mt19937_64(seed);
    auto chain = Chain();
    auto alive = std::vector<size_t>();
    chain.offsets.push_back(0);
    for (uint32_t h = 0; h < numBlocks; ++h) {
        auto cib = buv::ChangesInBlock();
        auto& bd = cib.beginBlock(h);
        bd.time = 1231006505U + h * 600U;
        bd.nTx = 1 + h % 7;
        chain.times.push_back(bd.time);
        auto const spends = alive.empty() ? 0 : rng() % std::min<size_t>(alive.size(), 9);
        for (size_t i = 0; i < spends; ++i) {
            auto const pick = rng() % alive.size();
            auto& o = chain.outputs[alive[pick]];
            o.spend = h;
            cib.addChange(-o.amount, o.height);
            alive[pick] = alive.back();
            alive.pop_back();
        }
        auto const creates = 1 + rng() % 10;
        for (size_t i = 0; i < creates; ++i) {
            auto const a = interestingAmount(rng, rows);
            chain.outputs.push_back({h, a, UINT32_MAX});
            cib.addChange(a, h);
            if (rng() % 5 == 0) {
                chain.outputs.back().spend = h;
                cib.addChange(-a, h);
            } else {
                alive.push_back(chain.outputs.size() - 1);
            }
        }
        cib.finalizeBlock();
        chain.blk += cib.encode();
        chain.offsets.push_back(chain.blk.size());
    }
    return chain;
}

// Brute-force L0 state from the output list, using the film formula.
auto modelAt(Chain const& chain, lsc::Grid const& grid, lsc::FilmRows const& film, uint32_t block) -> std::vector<lsc::Cell> {
    auto cells = std::vector<lsc::Cell>(grid.levels[0].cells());
    for (auto const& o : chain.outputs) {
        if (o.amount == 0 || o.height > block || o.spend <= block) {
            continue;
        }
        auto& c = cells[size_t(o.height / lsc::kBlocksPerColumn) * lsc::kRows + film.row(o.amount)];
        if (o.amount <= lsc::kSmallMaxSatoshi) {
            ++c.countSmall;
            c.satsSmall += o.amount;
        } else {
            ++c.countLarge;
            c.satsLarge += o.amount;
        }
    }
    return cells;
}

// BUVHIST1 with the arrays behind the records (as after an incremental update).
void writeHistory(std::filesystem::path const& path, Chain const& chain, uint32_t numBlocks) {
    auto rng = std::mt19937_64(9);
    auto byHeight = std::vector<std::vector<buv::UtxoHistoryRecord>>(numBlocks);
    for (auto const& o : chain.outputs) {
        byHeight[o.height].push_back({o.height, o.spend, o.amount});
    }
    auto bytes = std::vector<uint8_t>(64);
    auto heightIndex = std::vector<uint64_t>();
    uint64_t records = 0;
    for (auto& group : byHeight) {
        std::shuffle(group.begin(), group.end(), rng);
        heightIndex.push_back(records);
        for (auto const& r : group) {
            auto const at = bytes.size();
            bytes.resize(at + 16);
            std::memcpy(bytes.data() + at, &r, 16);
            ++records;
        }
    }
    heightIndex.push_back(records);
    auto const timesOff = bytes.size();
    for (uint32_t h = 0; h < numBlocks; ++h) {
        auto const at = bytes.size();
        bytes.resize(at + 4);
        std::memcpy(bytes.data() + at, &chain.times[h], 4);
    }
    auto const indexOff = bytes.size();
    for (auto v : heightIndex) {
        auto const at = bytes.size();
        bytes.resize(at + 8);
        put64(bytes.data() + at, v);
    }
    std::memcpy(bytes.data(), "BUVHIST1", 8);
    put64(bytes.data() + 8, numBlocks);
    put64(bytes.data() + 16, records);
    put64(bytes.data() + 24, timesOff);
    put64(bytes.data() + 32, indexOff);
    put64(bytes.data() + 40, 64);
    writeBytes(path, bytes.data(), bytes.size());
}

// BUVRCP01 renderer checkpoint whose ledger holds the alive state at 'block'.
void writeCheckpoint(std::filesystem::path const& path, Chain const& chain, lsc::FilmRows const& film, uint32_t block) {
    auto ledger = std::map<uint64_t, double>();
    for (auto const& o : chain.outputs) {
        if (o.amount == 0 || o.height > block || o.spend <= block) {
            continue;
        }
        auto const key = (uint64_t(o.height) << 16U) | (film.row(o.amount) + 10);
        ledger[key] += o.amount <= lsc::kSmallMaxSatoshi ? 1.0 : double(o.amount) / double(lsc::kSmallMaxSatoshi);
    }
    auto bytes = std::vector<uint8_t>(152, 0);
    std::memcpy(bytes.data(), "BUVRCP01", 8);
    put64(bytes.data() + 8, 1);
    put64(bytes.data() + 16, 152);
    put64(bytes.data() + 24, block + 1);
    put64(bytes.data() + 32, chain.offsets[block + 1]);
    put64(bytes.data() + 40, 0);
    put64(bytes.data() + 48, ledger.size());
    std::fill(bytes.begin() + 56, bytes.begin() + 120, uint8_t(7));
    auto const headerDigest = lsc::sha256(bytes.data(), 120);
    std::copy(headerDigest.begin(), headerDigest.end(), bytes.begin() + 120);
    for (auto const& [key, weight] : ledger) {
        auto const at = bytes.size();
        bytes.resize(at + 16);
        uint64_t bits = 0;
        std::memcpy(&bits, &weight, 8);
        put64(bytes.data() + at, key);
        put64(bytes.data() + at + 8, bits);
    }
    auto const digest = lsc::sha256(bytes.data(), bytes.size());
    bytes.insert(bytes.end(), digest.begin(), digest.end());
    writeBytes(path, bytes.data(), bytes.size());
}

// Changes one cell value inside the first non-empty blob and re-signs the CRC,
// the inner SHA-256 and the manifest's whole-file SHA-256, so that only the
// replay comparison can notice.
void tamperSnapshot(std::filesystem::path const& data, std::string const& file, lsc::Grid const& grid) {
    auto bytes = lsc::readFileBytes(data / file);
    auto const oldSha = lsc::hex(lsc::sha256(bytes.data(), bytes.size()));
    for (uint32_t id = 0; id < grid.tiles; ++id) {
        auto* e = bytes.data() + 128 + size_t(id) * 16;
        auto const offset = get64(e);
        auto const n = get32(e + 8);
        if (n == 0) {
            continue;
        }
        auto& last = bytes[offset + n - 1];
        last = last < 0x7F ? last + 1 : last - 1;
        auto const crc = lsc::crc32(bytes.data() + offset, n);
        for (unsigned i = 0; i < 4; ++i) {
            e[12 + i] = static_cast<uint8_t>(crc >> (8U * i));
        }
        break;
    }
    auto const inner = lsc::sha256(bytes.data() + 128, bytes.size() - 128);
    std::copy(inner.begin(), inner.end(), bytes.begin() + 88);
    writeBytes(data / file, bytes.data(), bytes.size());
    auto const newSha = lsc::hex(lsc::sha256(bytes.data(), bytes.size()));
    auto in = std::ifstream(data / "manifest.json");
    auto text = std::string(std::istreambuf_iterator<char>(in), {});
    auto const at = text.find(oldSha);
    REQUIRE(at != std::string::npos);
    text.replace(at, oldSha.size(), newSha);
    writeBytes(data / "manifest.json", text.data(), text.size());
}

auto requiredArg(char const* name) -> std::string {
    auto v = util::args::get(name);
    if (!v || v->empty()) {
        LOG("missing required argument {}=...", name);
        std::fflush(nullptr);
        std::exit(2);
    }
    return *v;
}

auto optionalUint(char const* name) -> std::optional<uint64_t> {
    auto const v = util::args::get(name);
    if (!v) {
        return std::nullopt;
    }
    auto used = size_t(0);
    auto value = uint64_t(0);
    try {
        value = std::stoull(*v, &used);
    } catch (std::exception const&) {
        used = 0;
    }
    if (v->empty() || used != v->size()) {
        LOG("invalid {}={}", name, *v);
        std::fflush(nullptr);
        std::exit(2);
    }
    return value;
}

} // namespace

TEST_CASE("landscape_state") {
    // CRC-32 (IEEE) and SHA-256 vectors.
    auto const nine = std::string("123456789");
    CHECK(lsc::crc32(nine.data(), nine.size()) == 0xCBF43926U);
    CHECK(lsc::crc32Portable(nine.data(), nine.size()) == 0xCBF43926U);
    {
        auto rng = std::mt19937_64(5);
        auto buf = std::vector<uint8_t>(100'003);
        for (auto& b : buf) {
            b = static_cast<uint8_t>(rng());
        }
        for (size_t n : {size_t(0), size_t(1), size_t(7), size_t(8), size_t(9), size_t(4096), buf.size()}) {
            CHECK(lsc::crc32(buf.data(), n) == lsc::crc32Portable(buf.data(), n));
        }
    }
    CHECK(lsc::hex(lsc::sha256("", 0)) == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    CHECK(lsc::hex(lsc::sha256("abc", 3)) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");

    // Grid and tile ids (SPEC section 2).
    auto const g = lsc::Grid::make(966'828);
    CHECK(g.l0Columns == 15107);
    CHECK(g.tiles == 758);
    struct Expected {
        uint32_t columns, rows, tilesX, tilesY, firstTile;
    };
    constexpr Expected table[lsc::kLevels] = {{15107, 2072, 60, 9, 0}, {7554, 1036, 30, 5, 540}, {3777, 518, 15, 3, 690},
                                              {1889, 259, 8, 2, 735},  {945, 130, 4, 1, 751},    {473, 130, 2, 1, 755},
                                              {237, 130, 1, 1, 757}};
    for (uint32_t l = 0; l < lsc::kLevels; ++l) {
        CHECK(g.levels[l].columns == table[l].columns);
        CHECK(g.levels[l].rows == table[l].rows);
        CHECK(g.levels[l].tilesX == table[l].tilesX);
        CHECK(g.levels[l].tilesY == table[l].tilesY);
        CHECK(g.levels[l].firstTile == table[l].firstTile);
        CHECK(g.levels[l].rowShift == std::min<uint32_t>(l, 4));
    }
    auto const edge = g.tileInfo(539);
    CHECK(edge.level == 0);
    CHECK(edge.tx == 59);
    CHECK(edge.ty == 8);
    CHECK(edge.col0 == 15104);
    CHECK(edge.cols == 3);
    CHECK(edge.row0 == 2048);
    CHECK(edge.rows == 24);
    CHECK(g.tileId(0, 59, 8) == 539);
    CHECK(g.tileInfo(59).cols == 3);
    CHECK(g.tileInfo(59).rows == 256);
    CHECK(g.tileInfo(754).level == 4);
    CHECK(g.tileInfo(754).cols == 945 - 768);
    CHECK(g.tileInfo(754).rows == 130);
    CHECK(g.tileInfo(757).level == 6);
    CHECK(g.tileInfo(757).cols == 237);
    CHECK(g.tileId(6, 0, 0) == 757);
    CHECK_THROWS(static_cast<void>(g.tileInfo(758)));
    CHECK_THROWS(static_cast<void>(g.tileId(0, 60, 0)));
    CHECK(g.cellArea(0, 15106, 2071) == 1);
    CHECK(g.cellArea(6, 0, 0) == 64 * 16);
    CHECK(g.cellArea(6, 236, 129) == 3 * 8);
    CHECK(g.cellArea(4, 944, 129) == 3 * 8);
    CHECK(g.cellArea(5, 472, 0) == 3 * 16);
    CHECK(g.cellArea(1, 7553, 1035) == 1 * 2);
    CHECK(lsc::Grid::make(1).tiles == 9 + 5 + 3 + 2 + 1 + 1 + 1);
    CHECK_THROWS(static_cast<void>(lsc::Grid::make(0)));

    // Row table (rows.bin) against the film formula, at every boundary +-1,
    // exhaustively for small amounts and at random log-spaced amounts.
    auto other = lsc::filmAxisCfg();
    other.maxSatoshi = 1'000'000'000'000LL;
    CHECK_THROWS(lsc::requireFilmAxis(other));
    auto const film = lsc::FilmRows(lsc::filmAxisCfg());
    auto const rows = lsc::RowTable::fromFilm(film);
    CHECK(rows.minAmt(lsc::kRows - 1) == 1);
    CHECK(rows.minAmt(0) <= 10'000'000'000'000LL);
    uint64_t rowMismatches = 0;
    uint64_t boundaryErrors = 0;
    for (uint32_t r = 0; r < lsc::kRows; ++r) {
        auto const m = rows.minAmt(r);
        boundaryErrors += film.row(m) > r ? 1 : 0;
        boundaryErrors += (m > 1 && film.row(m - 1) <= r) ? 1 : 0;
        boundaryErrors += (r > 0 && rows.minAmt(r - 1) < m) ? 1 : 0;
        for (auto a = std::max<int64_t>(1, m - 1); a <= m + 1; ++a) {
            rowMismatches += rows.row(a) != film.row(a) ? 1 : 0;
        }
    }
    for (int64_t a = 1; a <= 2'000'000; ++a) {
        rowMismatches += rows.row(a) != film.row(a) ? 1 : 0;
    }
    {
        auto rng = std::mt19937_64(11);
        auto u = std::uniform_real_distribution<double>(0.0, std::log(1e16));
        for (int i = 0; i < 1'000'000; ++i) {
            auto const a = std::max<int64_t>(1, static_cast<int64_t>(std::exp(u(rng))));
            rowMismatches += rows.row(a) != film.row(a) ? 1 : 0;
        }
    }
    CHECK(boundaryErrors == 0);
    CHECK(rowMismatches == 0);
    CHECK(rows.row(1) == lsc::kRows - 1);
    CHECK(rows.row(INT64_MAX) == 0);
    for (int64_t a : {int64_t(500'000'000), int64_t(500'000'001), int64_t(1'000'000'000), int64_t(5'000'000'000)}) {
        CHECK(rows.row(a) == film.row(a));
    }
    {
        auto const bytes = rows.bytes();
        CHECK(bytes.size() == size_t(lsc::kRows) * 8);
        double last = 0;
        std::memcpy(&last, bytes.data() + size_t(lsc::kRows - 1) * 8, 8);
        CHECK(last == 1.0);
    }

    // Replay a synthetic chain and compare with the brute-force model; undo.
    constexpr uint32_t numBlocks = 300;
    auto const chain = makeChain(numBlocks, 42, rows);
    auto const grid = lsc::Grid::make(numBlocks);
    auto state = lsc::State(grid);
    auto cib = buv::ChangesInBlock();
    auto const l0Cells = grid.levels[0].cells();
    auto equalsModel = [&](uint32_t block) {
        auto const m = modelAt(chain, grid, film, block);
        return std::equal(m.begin(), m.end(), state.l0());
    };
    auto decode = [&](uint32_t h) { lsc::decodeRecord(chain.blk.data(), chain.offsets[h], chain.offsets[h + 1], h, cib); };
    uint64_t zeroOutputs = 0;
    uint64_t sameBlock = 0;
    for (auto const& o : chain.outputs) {
        zeroOutputs += o.amount == 0 ? 1 : 0;
        sameBlock += o.spend == o.height ? 1 : 0;
    }
    CHECK(zeroOutputs > 0);
    CHECK(sameBlock > 0);
    for (uint32_t h = 0; h < numBlocks; ++h) {
        decode(h);
        CHECK(cib.blockData().time == chain.times[h]);
        state.applyBlock(cib, rows, +1);
        if (h % 37 == 0 || h == numBlocks - 1) {
            CHECK(equalsModel(h));
        }
    }
    CHECK_THROWS(lsc::decodeRecord(chain.blk.data(), chain.offsets[5], chain.offsets[6], 6, cib));
    CHECK_THROWS(lsc::decodeRecord(chain.blk.data(), chain.offsets[5], chain.offsets[7], 5, cib));
    for (auto h = numBlocks - 1; h > 150; --h) {
        decode(h);
        state.applyBlock(cib, rows, -1);
    }
    CHECK(equalsModel(150));
    for (uint32_t h = 150;; --h) {
        decode(h);
        state.applyBlock(cib, rows, -1);
        if (h == 0) {
            break;
        }
    }
    CHECK(std::all_of(state.l0(), state.l0() + l0Cells, [](lsc::Cell const& c) { return c == lsc::Cell{}; }));
    for (uint32_t h = 0; h < numBlocks; ++h) {
        decode(h);
        state.applyBlock(cib, rows, +1);
    }
    CHECK(equalsModel(numBlocks - 1));

    // Every level equals a direct aggregation of L0; stale extents are cleared.
    auto levels = lsc::Levels();
    lsc::aggregate(grid, state.l0(), grid.l0Columns, levels);
    for (uint32_t l = 0; l < lsc::kLevels; ++l) {
        auto const& li = grid.levels[l];
        auto naive = std::vector<lsc::Cell>(li.cells());
        for (uint32_t c = 0; c < grid.l0Columns; ++c) {
            for (uint32_t r = 0; r < lsc::kRows; ++r) {
                naive[size_t(c >> l) * li.rows + (r >> li.rowShift)].add(state.at(c, r));
            }
        }
        CHECK(std::equal(naive.begin(), naive.end(), levels.cells[l]));
    }
    {
        auto zeros = std::vector<lsc::Cell>(l0Cells);
        auto reused = lsc::Levels();
        lsc::aggregate(grid, state.l0(), grid.l0Columns, reused);
        lsc::aggregate(grid, zeros.data(), 1, reused);
        auto allZero = true;
        for (uint32_t l = 1; l < lsc::kLevels; ++l) {
            allZero = allZero && std::all_of(reused.cells[l], reused.cells[l] + grid.levels[l].cells(),
                                             [](lsc::Cell const& c) { return c == lsc::Cell{}; });
        }
        CHECK(allZero);
    }

    // BUVLSN1 round trip, integrity checks and comparison.
    auto file = std::vector<uint8_t>();
    auto const header = lsc::encodeSnapshot(grid, levels.cells, numBlocks - 1, chain.offsets[numBlocks], file);
    CHECK(header.sha256 == lsc::sha256(file.data() + 128, file.size() - 128));
    {
        auto decoded = lsc::Levels();
        auto const back = lsc::decodeSnapshot(grid, file.data(), file.size(), decoded);
        CHECK(back.block == numBlocks - 1);
        CHECK(back.blkEnd == chain.offsets[numBlocks]);
        CHECK(back.totals == header.totals);
        for (uint32_t l = 0; l < lsc::kLevels; ++l) {
            CHECK(std::equal(decoded.cells[l], decoded.cells[l] + grid.levels[l].cells(), levels.cells[l]));
        }
        auto reports = std::vector<std::string>();
        CHECK(lsc::compareSnapshot(grid, lsc::openSnapshot(grid, file.data(), file.size()), levels.cells, 5, reports) == 0);
        auto* cell = std::find_if(state.l0(), state.l0() + l0Cells, [](lsc::Cell const& c) { return c.countSmall > 0; });
        REQUIRE(cell != state.l0() + l0Cells);
        cell->satsSmall += 1;
        lsc::aggregate(grid, state.l0(), grid.l0Columns, levels);
        CHECK(lsc::compareSnapshot(grid, lsc::openSnapshot(grid, file.data(), file.size()), levels.cells, 5, reports) > 0);
        cell->satsSmall -= 1;
        lsc::aggregate(grid, state.l0(), grid.l0Columns, levels);
        auto bad = file;
        bad.back() ^= 1U;
        CHECK_THROWS(lsc::openSnapshot(grid, bad.data(), bad.size()));
        bad = file;
        bad[20] ^= 1U; // numBlocks 301: beyond this dataset
        CHECK_THROWS(lsc::openSnapshot(grid, bad.data(), bad.size()));
        bad = file;
        bad[20] = static_cast<uint8_t>(numBlocks - 1); // numBlocks == block
        CHECK_THROWS(lsc::openSnapshot(grid, bad.data(), bad.size()));
        bad = file;
        bad[36] ^= 1U; // l0Columns no longer derived from numBlocks
        CHECK_THROWS(lsc::openSnapshot(grid, bad.data(), bad.size()));
        bad = file;
        bad.push_back(0);
        CHECK_THROWS(lsc::openSnapshot(grid, bad.data(), bad.size()));
        // The tip state has cells in columns an earlier block cannot reach.
        auto earlier = std::vector<uint8_t>();
        CHECK_THROWS(lsc::encodeSnapshot(grid, levels.cells, 150, 0, earlier));
        // A negative count can never be encoded.
        auto broken = std::vector<lsc::Cell>(state.l0(), state.l0() + l0Cells);
        broken[0].countSmall -= 1;
        broken[1].countSmall += 1;
        auto brokenLevels = lsc::Levels();
        lsc::aggregate(grid, broken.data(), grid.l0Columns, brokenLevels);
        auto scratch = std::vector<uint8_t>();
        CHECK_THROWS(lsc::encodeSnapshot(grid, brokenLevels.cells, 0, 0, scratch));
    }

    // Self-describing snapshots: a block encodes to the same bytes whatever the
    // dataset's tip, also when the tip adds an L0 tile column, and every dataset
    // grid at least as large reads it.
    {
        constexpr uint32_t block = 16'000; // L0 column 250, inside the first tile column
        auto const tight = lsc::Grid::make(block + 1);
        auto const exact = lsc::Grid::make(256 * lsc::kBlocksPerColumn);
        auto const wide = lsc::Grid::make(256 * lsc::kBlocksPerColumn + 3 * lsc::kBlocksPerColumn);
        REQUIRE(exact.levels[0].tilesX == 1);
        REQUIRE(wide.levels[0].tilesX == 2);
        REQUIRE(wide.tiles > exact.tiles);
        struct Placed {
            uint32_t col;
            uint32_t row;
            lsc::Cell cell;
        };
        auto placed = std::vector<Placed>();
        placed.push_back({0, 0, {1, 0, 1000, 0}});
        placed.push_back({17, 2071, {3, 0, 3 * 500'000'000LL, 0}});
        placed.push_back({128, 900, {0, 1, 0, 600'000'000}});
        placed.push_back({250, 1500, {2, 4, 7, 4'000'000'000LL}});
        for (auto& p : placed) {
            REQUIRE(p.cell.occupied());
        }
        auto encodeIn = [&](lsc::Grid const& g, lsc::Levels& lv) {
            auto& l0 = lv.owned[0]; // aggregate() leaves owned[0] alone and points cells[0] at it
            l0.assign(g.levels[0].cells(), lsc::Cell{});
            for (auto const& p : placed) {
                l0[size_t(p.col) * lsc::kRows + p.row] = p.cell;
            }
            lsc::aggregate(g, l0.data(), block / lsc::kBlocksPerColumn + 1, lv);
            auto bytes = std::vector<uint8_t>();
            auto const h = lsc::encodeSnapshot(g, lv.cells, block, 4242, bytes);
            CHECK(h.numBlocks == block + 1);
            return bytes;
        };
        auto tightLevels = lsc::Levels();
        auto exactLevels = lsc::Levels();
        auto wideLevels = lsc::Levels();
        auto const a = encodeIn(tight, tightLevels);
        auto const b = encodeIn(exact, exactLevels);
        auto const c = encodeIn(wide, wideLevels);
        CHECK(a == b);
        CHECK(a == c);
        auto const view = lsc::openSnapshot(wide, c.data(), c.size());
        CHECK(view.header.numBlocks == block + 1);
        CHECK(view.grid.tiles == tight.tiles);
        CHECK(view.grid.tiles < wide.tiles);
        auto decoded = lsc::Levels();
        auto const back = lsc::decodeSnapshot(wide, c.data(), c.size(), decoded);
        CHECK(back.block == block);
        CHECK(back.blkEnd == 4242);
        for (uint32_t l = 0; l < lsc::kLevels; ++l) {
            CHECK(std::equal(decoded.cells[l], decoded.cells[l] + wide.levels[l].cells(), wideLevels.cells[l]));
        }
        auto reports = std::vector<std::string>();
        CHECK(lsc::compareSnapshot(wide, view, wideLevels.cells, 5, reports) == 0);
        CHECK(lsc::compareSnapshot(exact, lsc::openSnapshot(exact, a.data(), a.size()), exactLevels.cells, 5, reports) == 0);
        // A grid smaller than the snapshot's own cannot hold it.
        auto const shorter = lsc::Grid::make(block);
        CHECK_THROWS(lsc::openSnapshot(shorter, a.data(), a.size()));
    }

    // End to end on synthetic sources: build, verify, refuse reuse, detect a
    // re-signed altered snapshot, and a shorter -end dataset.
    {
        auto const dir = TempDir();
        auto cfg = lsc::filmAxisCfg();
        cfg.blkFile = (dir.path / "changes.blk").string();
        cfg.historyFile = (dir.path / "history.bin").string();
        writeBytes(cfg.blkFile, chain.blk.data(), chain.blk.size());
        writeHistory(cfg.historyFile, chain, numBlocks);
        writeCheckpoint(dir.path / "checkpoint.bin", chain, film, 200);

        auto build = lsc::BuildOptions();
        build.cfg = cfg;
        build.out = dir.path / "out";
        build.snapshotIntervalBytes = 4000;
        build.chunkBytes = 2500;
        build.threads = 2;
        lsc::buildDataset(build);
        CHECK(std::filesystem::exists(build.out / "manifest.json"));
        CHECK(!std::filesystem::exists(cfg.blkFile + ".idx"));

        auto verify = lsc::VerifyOptions();
        verify.cfg = cfg;
        verify.data = build.out;
        verify.checkpoint = dir.path / "checkpoint.bin";
        verify.samples = 6;
        verify.seed = 3;
        verify.threads = 2;
        verify.historyBlocks = {50, 150, 200};
        CHECK(lsc::verifyDataset(verify));
        CHECK(!std::filesystem::exists(cfg.blkFile + ".idx"));
        CHECK_THROWS(lsc::buildDataset(build));

        auto shorter = build;
        shorter.out = dir.path / "short";
        shorter.end = 120;
        lsc::buildDataset(shorter);
        auto verifyShort = verify;
        verifyShort.data = shorter.out;
        verifyShort.checkpoint.reset();
        CHECK(lsc::verifyDataset(verifyShort));

        tamperSnapshot(build.out, "snapshots/0000299.bin", grid);
        CHECK(!lsc::verifyDataset(verify));
    }
}

TEST_CASE("landscape_build" * doctest::skip()) {
    try {
        if (util::args::get("-out") || util::args::get("-o")) {
            throw std::runtime_error("-out=/-o= is doctest's report-file option (doctest has already opened that path); "
                                     "use -outDir= for the dataset directory");
        }
        auto o = lsc::BuildOptions();
        o.cfg = buv::parseCfg(requiredArg("-cfg"));
        o.out = requiredArg("-outDir");
        if (auto const e = optionalUint("-end")) {
            if (*e > UINT32_MAX) {
                throw std::runtime_error("-end exceeds uint32");
            }
            o.end = static_cast<uint32_t>(*e);
        }
        if (auto const s = optionalUint("-snapshotBytes")) {
            o.snapshotIntervalBytes = *s;
        }
        if (auto const c = optionalUint("-chunkBytes")) {
            o.chunkBytes = *c;
        }
        if (auto const t = optionalUint("-threads")) {
            o.threads = static_cast<unsigned>(*t);
        }
        lsc::buildDataset(o);
    } catch (std::exception const& e) {
        LOG("landscape_build FAILED: {}", e.what());
        std::fflush(nullptr);
        std::exit(1);
    }
}

TEST_CASE("landscape_verify" * doctest::skip()) {
    auto ok = false;
    try {
        auto o = lsc::VerifyOptions();
        o.cfg = buv::parseCfg(requiredArg("-cfg"));
        o.data = requiredArg("-data");
        if (auto const c = util::args::get("-checkpoint"); c && !c->empty()) {
            o.checkpoint = *c;
        }
        if (auto const s = optionalUint("-samples")) {
            o.samples = static_cast<uint32_t>(*s);
        }
        if (auto const s = optionalUint("-seed")) {
            o.seed = *s;
        }
        if (auto const t = optionalUint("-threads")) {
            o.threads = static_cast<unsigned>(*t);
        }
        if (auto const list = util::args::get("-historyBlocks")) {
            o.historyBlocks.clear();
            auto in = std::stringstream(*list);
            for (std::string item; std::getline(in, item, ',');) {
                if (!item.empty()) {
                    o.historyBlocks.push_back(static_cast<uint32_t>(std::stoul(item)));
                }
            }
        }
        LOG("landscape_verify: data {}, seed {}, samples {}", o.data.string(), o.seed, o.samples);
        ok = lsc::verifyDataset(o);
    } catch (std::exception const& e) {
        LOG("landscape_verify FAILED: {}", e.what());
    }
    if (!ok) {
        std::fflush(nullptr);
        std::exit(1);
    }
}

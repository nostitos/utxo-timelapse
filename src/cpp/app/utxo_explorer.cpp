#include <app/Cfg.h>
#include <app/UtxoHistory.h>
#include <buv/SatoshiBlockheightToPixel.h>
#include <util/Mmap.h>
#include <util/args.h>
#include <util/log.h>

#include <doctest.h>
#include <fmt/format.h>
#include <httplib.h>

#include <algorithm>
#include <array>
#include <charconv>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <ctime>
#include <deque>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <list>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace {

// --- public-exposure hardening helpers ---

// Safe unsigned/signed parse; returns std::nullopt on missing/malformed/overflow.
template <typename T>
[[nodiscard]] auto parseParam(httplib::Request const& req, char const* name) -> std::optional<T> {
    if (!req.has_param(name)) {
        return std::nullopt;
    }
    auto const& s = req.get_param_value(name);
    if (s.empty() || s.size() > 20) {
        return std::nullopt;
    }
    auto value = T{};
    auto const* first = s.data();
    auto const* last = s.data() + s.size();
    auto [ptr, ec] = std::from_chars(first, last, value);
    if (ec != std::errc() || ptr != last) {
        return std::nullopt;
    }
    return value;
}

void sendBadRequest(httplib::Response& res, char const* what) {
    res.status = 400;
    res.set_content(fmt::format(R"({{"error":"{}"}})", what), "application/json");
}

// Per-IP token bucket rate limiter. Mutex-guarded; fine for <10 concurrent users.
class RateLimiter {
    struct Bucket {
        double tokens;
        std::chrono::steady_clock::time_point last;
    };
    double mRate;
    double mBurst;
    std::mutex mMutex;
    std::unordered_map<std::string, Bucket> mBuckets;

public:
    RateLimiter(double ratePerSec, double burst)
        : mRate(ratePerSec)
        , mBurst(burst) {}

    // returns true if the request is allowed
    [[nodiscard]] auto allow(std::string const& key) -> bool {
        auto now = std::chrono::steady_clock::now();
        auto lock = std::scoped_lock(mMutex);
        if (mBuckets.size() > 10000) {
            mBuckets.clear(); // crude pruning; acceptable at this scale
        }
        auto it = mBuckets.find(key);
        if (it == mBuckets.end()) {
            it = mBuckets.emplace(key, Bucket{mBurst, now}).first;
        }
        auto& b = it->second;
        auto elapsed = std::chrono::duration<double>(now - b.last).count();
        b.last = now;
        b.tokens = std::min(mBurst, b.tokens + elapsed * mRate);
        if (b.tokens >= 1.0) {
            b.tokens -= 1.0;
            return true;
        }
        return false;
    }
};

// LRU cache for txid lookups (key: "height:satoshi" -> JSON body).
class TxidCache {
    size_t mCap;
    std::mutex mMutex;
    std::list<std::pair<std::string, std::string>> mList; // front = most recent
    std::unordered_map<std::string, std::list<std::pair<std::string, std::string>>::iterator> mMap;

public:
    explicit TxidCache(size_t cap)
        : mCap(cap) {}

    [[nodiscard]] auto get(std::string const& key) -> std::optional<std::string> {
        auto lock = std::scoped_lock(mMutex);
        auto it = mMap.find(key);
        if (it == mMap.end()) {
            return std::nullopt;
        }
        mList.splice(mList.begin(), mList, it->second);
        return it->second->second;
    }

    void put(std::string const& key, std::string body) {
        auto lock = std::scoped_lock(mMutex);
        auto it = mMap.find(key);
        if (it != mMap.end()) {
            it->second->second = std::move(body);
            mList.splice(mList.begin(), mList, it->second);
            return;
        }
        mList.emplace_front(key, std::move(body));
        mMap[key] = mList.begin();
        if (mMap.size() > mCap) {
            mMap.erase(mList.back().first);
            mList.pop_back();
        }
    }
};

// Client IP: trust CF-Connecting-IP (tunnel traffic arrives via loopback), else socket addr.
[[nodiscard]] auto clientIp(httplib::Request const& req) -> std::string {
    if (req.has_header("CF-Connecting-IP")) {
        return req.get_header_value("CF-Connecting-IP");
    }
    return req.remote_addr;
}

// Mmapped view of utxo_history.bin (see UtxoHistory.h)
class HistoryView {
    util::Mmap mMmap;
    buv::UtxoHistoryHeader const* mHdr{};
    uint32_t const* mBlockTimes{};
    uint64_t const* mHeightIndex{};
    buv::UtxoHistoryRecord const* mRecords{};

public:
    explicit HistoryView(std::filesystem::path const& file)
        : mMmap(file) {
        if (!mMmap.is_open()) {
            throw std::runtime_error(fmt::format("could not open '{}'", file.string()));
        }
        if (mMmap.size() < sizeof(buv::UtxoHistoryHeader)) {
            throw std::runtime_error("history file too small");
        }
        mHdr = reinterpret_cast<buv::UtxoHistoryHeader const*>(mMmap.data());
        if (0 != std::memcmp(mHdr->magic, buv::kUtxoHistoryMagic, sizeof(mHdr->magic))) {
            throw std::runtime_error("bad magic in history file");
        }
        mBlockTimes = reinterpret_cast<uint32_t const*>(mMmap.data() + mHdr->blockTimesOff);
        mHeightIndex = reinterpret_cast<uint64_t const*>(mMmap.data() + mHdr->heightIndexOff);
        mRecords = reinterpret_cast<buv::UtxoHistoryRecord const*>(mMmap.data() + mHdr->recordsOff);
    }

    [[nodiscard]] auto numBlocks() const -> uint64_t {
        return mHdr->numBlocks;
    }
    [[nodiscard]] auto numRecords() const -> uint64_t {
        return mHdr->numRecords;
    }
    [[nodiscard]] auto blockTime(uint32_t h) const -> uint32_t {
        return h < mHdr->numBlocks ? mBlockTimes[h] : 0;
    }
    // record range [begin, end) for creation height h
    [[nodiscard]] auto recordRange(uint32_t h) const -> std::pair<uint64_t, uint64_t> {
        if (h >= mHdr->numBlocks) {
            return {0, 0};
        }
        return {mHeightIndex[h], mHeightIndex[h + 1]};
    }
    [[nodiscard]] auto record(uint64_t i) const -> buv::UtxoHistoryRecord const& {
        return mRecords[i];
    }
};

auto isoDate(uint32_t unixTime) -> std::string {
    auto t = static_cast<std::time_t>(unixTime);
    auto tm = std::tm{};
    gmtime_r(&t, &tm);
    auto buf = std::array<char, 24>{};
    std::strftime(buf.data(), buf.size(), "%Y-%m-%d", &tm);
    return std::string(buf.data());
}

auto jsonEscape(std::string const& s) -> std::string {
    auto out = std::string();
    out.reserve(s.size() + 8);
    for (auto c : s) {
        if (c == '"' || c == '\\') {
            out += '\\';
            out += c;
        } else if (static_cast<unsigned char>(c) < 0x20) {
            out += fmt::format("\\u{:04x}", static_cast<unsigned char>(c));
        } else {
            out += c;
        }
    }
    return out;
}

// Inverse mappings around SatoshiBlockheightToPixel's forward maps.
// All mappings are monotonic, so binary search suffices and stays exactly
// consistent with the render.
//
// THREAD SAFETY: setContext() mutates the wrapped mapper, so each concurrent
// request must use its own PixelInverter instance. Constructing one is cheap
// (no allocation beyond the mapper itself); do not share one across handlers.
class PixelInverter {
    buv::SatoshiBlockheightToPixel mMapper;
    buv::Cfg const& mCfg;

public:
    PixelInverter(buv::Cfg const& cfg, uint32_t numBlocks)
        : mMapper(cfg, numBlocks)
        , mCfg(cfg) {}

    // set epoch context for block N (normalizedGeometric / epochLog)
    void setContext(uint32_t blockHeight) {
        if (mMapper.useEpochCompression()) {
            mMapper.setCurrentEpoch(blockHeight / mMapper.getEpochBlocks());
        }
        if (mMapper.useContinuousLogCompression()) {
            mMapper.setTotalBlocks(blockHeight + 1);
        }
    }

    // absolute image x/y -> graph-local; false if outside graphRect
    [[nodiscard]] auto toGraphLocal(size_t imgX, size_t imgY, size_t& gx, size_t& gy) const -> bool {
        auto const& rect = mCfg.graphRect;
        if (imgX < rect.x || imgX >= rect.x + rect.w || imgY < rect.y || imgY >= rect.y + rect.h) {
            return false;
        }
        gx = imgX - rect.x;
        gy = imgY - rect.y;
        return true;
    }

    // forward: block height -> absolute pixel x
    [[nodiscard]] auto blockToX(uint32_t h) const -> size_t {
        return mMapper.blockheightToPixelWidth(h);
    }

    // block range [first, last] of blocks mapping to graph-local column gx at
    // context block N. May be empty (returns false) for future columns.
    [[nodiscard]] auto columnBlockRange(size_t gx, uint32_t contextBlock, uint32_t& first, uint32_t& last) const
        -> bool {
        auto const& rect = mCfg.graphRect;
        auto absTarget = rect.x + gx;
        // find first block with x >= absTarget, then scan the exact column edges
        // via two binary searches (x is monotonic nondecreasing in h).
        auto maxH = contextBlock;
        auto xOf = [&](uint32_t h) -> size_t { return mMapper.blockheightToPixelWidth(h); };

        // lower bound: first h with xOf(h) >= absTarget
        auto lo = uint32_t(0);
        auto hi = maxH;
        while (lo < hi) {
            auto mid = lo + (hi - lo) / 2;
            if (xOf(mid) < absTarget) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        if (lo > maxH || xOf(lo) != absTarget) {
            // no block maps exactly here; the nearest column to the left owns
            // this x. Treat as the containing column: find last h with x <= absTarget.
            auto lo2 = uint32_t(0);
            auto hi2 = maxH;
            while (lo2 < hi2) {
                auto mid = lo2 + (hi2 - lo2 + 1) / 2;
                if (xOf(mid) <= absTarget) {
                    lo2 = mid;
                } else {
                    hi2 = mid - 1;
                }
            }
            if (xOf(lo2) > absTarget) {
                return false;
            }
            // expand to the whole column of lo2's x
            auto colX = xOf(lo2);
            return columnBlockRange(colX - rect.x, contextBlock, first, last);
        }
        first = lo;
        // upper bound: last h with xOf(h) == absTarget
        auto lo3 = lo;
        auto hi3 = maxH;
        while (lo3 < hi3) {
            auto mid = lo3 + (hi3 - lo3 + 1) / 2;
            if (xOf(mid) == absTarget) {
                lo3 = mid;
            } else {
                hi3 = mid - 1;
            }
        }
        last = lo3;
        return true;
    }

    // satoshi range [minSat, maxSat] of amounts mapping to graph-local row gy.
    // Y decreases as satoshi increases; the map is monotonic in log(satoshi).
    // The render CLAMPS out-of-range values into the edge rows (truncate<size_t>),
    // so the top row also owns every amount above cfg.maxSatoshi. Mirror that.
    [[nodiscard]] auto rowSatoshiRange(size_t gy, int64_t& minSat, int64_t& maxSat) const -> bool {
        auto const& rect = mCfg.graphRect;
        auto absTarget = rect.y + gy;
        auto yOf = [&](int64_t sat) -> size_t { return mMapper.satoshiToPixelHeight(sat); };

        auto loSat = mCfg.minSatoshi;  // maps to bottom (large y)
        auto hiSat = mCfg.maxSatoshi;  // maps to top (small y)
        if (yOf(loSat) < absTarget || yOf(hiSat) > absTarget) {
            return false;
        }
        // find smallest satoshi with yOf(sat) <= absTarget  (upper edge of row)
        {
            auto lo = loSat;
            auto hi = hiSat;
            while (lo < hi) {
                auto mid = lo + (hi - lo) / 2;
                if (yOf(mid) > absTarget) {
                    lo = mid + 1;
                } else {
                    hi = mid;
                }
            }
            minSat = lo;
        }
        // find largest satoshi with yOf(sat) >= absTarget (still in this row)
        {
            auto lo = minSat;
            auto hi = hiSat;
            while (lo < hi) {
                auto mid = lo + (hi - lo + 1) / 2;
                if (yOf(mid) < absTarget) {
                    hi = mid - 1;
                } else {
                    lo = mid;
                }
            }
            maxSat = lo;
        }
        // Clamp semantics: the top graph row (gy==0) owns all amounts >= its lower
        // edge, because satoshiToPixelHeight truncates larger values into it.
        if (gy == 0) {
            maxSat = INT64_MAX;
        }
        return yOf(minSat) == absTarget || yOf(maxSat) == absTarget;
    }
};

} // namespace

// Explorer web server. Serves the UI, the MP4 (with Range support), and the
// per-pixel UTXO lookup API backed by utxo_history.bin.
//
// Usage: ./buv -ns -tc=utxo_explorer -cfg=path/to/config.json
TEST_CASE("utxo_explorer" * doctest::skip()) {
    auto cfg = buv::parseCfg(util::args::get("-cfg").value());
    if (cfg.historyFile.empty()) {
        throw std::runtime_error("config needs 'historyFile'");
    }

    LOG("loading history '{}'...", cfg.historyFile);
    auto hist = HistoryView(cfg.historyFile);
    LOG("history: {} blocks, {} records", hist.numBlocks(), hist.numRecords());

    auto numBlocks = static_cast<uint32_t>(hist.numBlocks());
    auto inverter = PixelInverter(cfg, numBlocks);

    auto server = httplib::Server();

    // --- public-exposure hardening ---
    server.set_read_timeout(5, 0);
    server.set_payload_max_length(16 * 1024);
    server.set_keep_alive_max_count(64);

    // Video scrubbing opens bursts of connections, each holding a worker while
    // streaming. The default pool (hardware_concurrency-1 = ~15) starves under
    // a single scrubbing user; queued sockets then get RST and the server looks
    // dead. Threads here are cheap (blocked on disk/net I/O), so use plenty.
    server.new_task_queue = [] { return new httplib::ThreadPool(64); };

    // Generic 500 for handler exceptions; never leak internals. httplib's
    // dispatcher catches throws and stashes ex.what() in an EXCEPTION_WHAT
    // header - strip it and emit a clean JSON body via the error handler.
    server.set_error_handler(httplib::Server::HandlerWithResponse(
        [](httplib::Request const&, httplib::Response& res) -> httplib::Server::HandlerResponse {
            if (res.status == 500) {
                res.headers.erase("EXCEPTION_WHAT");
                res.set_content(R"({"error":"internal error"})", "application/json");
                return httplib::Server::HandlerResponse::Handled;
            }
            return httplib::Server::HandlerResponse::Unhandled;
        }));

    // Per-IP rate limits (token buckets). Pixel limit is generous because the
    // arrow-key nudge feature legitimately fires many requests in a row.
    auto pixelLimiter = RateLimiter(15.0, 40.0);
    auto txidLimiter = RateLimiter(1.0, 3.0);
    auto pageLimiter = RateLimiter(30.0, 60.0);

    server.set_pre_routing_handler([&](httplib::Request const& req, httplib::Response& res) {
        RateLimiter* limiter = nullptr;
        if (req.path == "/api/pixel") {
            limiter = &pixelLimiter;
        } else if (req.path == "/api/txid") {
            limiter = &txidLimiter;
        } else if (req.path == "/video.mp4") {
            limiter = nullptr; // Range streaming makes many requests; bounded by keep-alive caps
        } else {
            limiter = &pageLimiter;
        }
        if (limiter != nullptr && !limiter->allow(clientIp(req))) {
            res.status = 429;
            res.set_header("Retry-After", "1");
            res.set_content(R"({"error":"rate limited"})", "application/json");
            return httplib::Server::HandlerResponse::Handled;
        }
        return httplib::Server::HandlerResponse::Unhandled;
    });

    // Security headers on every response + per-path cache policy + request log
    server.set_post_routing_handler([](httplib::Request const& req, httplib::Response& res) {
        res.set_header("X-Content-Type-Options", "nosniff");
        res.set_header("X-Frame-Options", "DENY");
        res.set_header("Referrer-Policy", "no-referrer");
        res.set_header("Content-Security-Policy",
                       "default-src 'self'; style-src 'self' 'unsafe-inline'; "
                       "script-src 'self' 'unsafe-inline'; media-src 'self'; connect-src 'self'");
        if (req.path == "/video.mp4") {
            res.set_header("Cache-Control", "public, max-age=31536000, immutable");
        } else if (req.path.rfind("/api/", 0) == 0) {
            res.set_header("Cache-Control", "no-store");
        }
    });

    // Request log: timestamp, ip, method, path, status (stderr via LOG)
    server.set_logger([](httplib::Request const& req, httplib::Response const& res) {
        LOG("{} {} {} {} from {}", res.status, req.method, req.path,
            req.params.empty() ? "" : "?", clientIp(req));
    });

    // Crawler control: the video alone is ~49GB, keep bots away
    server.Get("/robots.txt", [](httplib::Request const&, httplib::Response& res) {
        res.set_content("User-agent: *\nDisallow: /\n", "text/plain");
    });

    auto txidCache = TxidCache(10000);

    // --- static UI ---
    auto uiDir = std::filesystem::path(util::args::get("-ui").value_or("src/cpp/app/explorer_ui"));
    auto indexPath = uiDir / "explorer.html";
    if (!std::filesystem::exists(indexPath)) {
        throw std::runtime_error(fmt::format("UI file not found: {}", indexPath.string()));
    }
    server.Get("/", [indexPath](httplib::Request const&, httplib::Response& res) {
        auto f = std::ifstream(indexPath, std::ios::binary);
        auto body = std::string(std::istreambuf_iterator<char>(f), std::istreambuf_iterator<char>());
        res.set_content(body, "text/html; charset=utf-8");
    });

    // --- video with Range support (httplib handles ranges for content providers) ---
    // Browsers send open-ended ranges (bytes=N-) and abandon them on every seek.
    // Serve in small chunks so sink.is_writable() notices abandoned connections
    // quickly. Do not stop a response after an arbitrary byte count: httplib has
    // already advertised the full requested Content-Length/Content-Range, so an
    // early return makes the browser treat the response as truncated and stalls
    // playback after that amount of data.
    if (!cfg.explorerVideoFile.empty()) {
        auto videoPath = cfg.explorerVideoFile;
        auto videoSize = std::filesystem::file_size(videoPath);
        server.Get("/video.mp4", [videoPath, videoSize](httplib::Request const&, httplib::Response& res) {
            auto stream = std::make_shared<std::ifstream>(videoPath, std::ios::binary);
            constexpr size_t kChunk = 256 * 1024;           // small writes -> fast abandonment detection
            res.set_content_provider(
                videoSize,
                "video/mp4",
                [stream](size_t offset, size_t length, httplib::DataSink& sink) {
                    auto buf = std::array<char, kChunk>();
                    stream->clear();
                    stream->seekg(static_cast<std::streamoff>(offset));
                    auto toRead = std::min(length, buf.size());
                    stream->read(buf.data(), static_cast<std::streamsize>(toRead));
                    auto got = static_cast<size_t>(stream->gcount());
                    if (got == 0) {
                        return false;
                    }
                    if (!sink.is_writable()) {
                        return false; // client hung up (seek/abandon) - free the thread now
                    }
                    sink.write(buf.data(), got);
                    return true;
                });
        });
    }

    // --- config info for the UI ---
    server.Get("/api/info", [&](httplib::Request const&, httplib::Response& res) {
        auto json = fmt::format(
            R"({{"imageWidth":{},"imageHeight":{},"graphRect":[{},{},{},{}],"numBlocks":{},"fps":60,"videoAvailable":{}}})",
            cfg.imageWidth,
            cfg.imageHeight,
            cfg.graphRect.x,
            cfg.graphRect.y,
            cfg.graphRect.w,
            cfg.graphRect.h,
            numBlocks,
            cfg.explorerVideoFile.empty() ? "false" : "true");
        res.set_content(json, "application/json");
    });

    // --- per-pixel lookup ---
    server.Get("/api/pixel", [&](httplib::Request const& req, httplib::Response& res) {
        auto blockOpt = parseParam<uint32_t>(req, "block");
        auto xOpt = parseParam<uint32_t>(req, "x");
        auto yOpt = parseParam<uint32_t>(req, "y");
        if (!blockOpt || !xOpt || !yOpt) {
            sendBadRequest(res, "block, x, y must be non-negative integers");
            return;
        }
        auto block = *blockOpt;
        auto x = static_cast<size_t>(*xOpt);
        auto y = static_cast<size_t>(*yOpt);
        if (block >= numBlocks) {
            block = numBlocks - 1;
        }
        if (x >= cfg.imageWidth || y >= cfg.imageHeight) {
            sendBadRequest(res, "x/y outside image");
            return;
        }

        auto gx = size_t(0);
        auto gy = size_t(0);
        if (!inverter.toGraphLocal(x, y, gx, gy)) {
            res.status = 400;
            res.set_content(R"({"error":"outside graphRect"})", "application/json");
            return;
        }

        inverter.setContext(block);

        // Right of the current block's cursor nothing is rendered except the
        // orange flow-line overlay. Say so instead of returning a misleading
        // "containing column" result.
        auto cursorX = inverter.blockToX(block);
        if (x > cursorX) {
            res.set_content(
                fmt::format(
                    R"j({{"blockRange":null,"satRange":null,"count":0,"utxos":[],"pastCount":0,"pastUtxos":[],"overlay":"flowline","cursorX":{}}})j",
                    cursorX),
                "application/json");
            return;
        }

        auto h1 = uint32_t(0);
        auto h2 = uint32_t(0);
        if (!inverter.columnBlockRange(gx, block, h1, h2)) {
            res.set_content(R"({"blockRange":null,"satRange":null,"count":0,"utxos":[]})", "application/json");
            return;
        }
        auto s1 = int64_t(0);
        auto s2 = int64_t(0);
        if (!inverter.rowSatoshiRange(gy, s1, s2)) {
            res.set_content(R"({"blockRange":null,"satRange":null,"count":0,"utxos":[]})", "application/json");
            return;
        }

        // gather matching records: created in [h1,h2], amount in [s1,s2].
        // "live" = alive at 'block' (created <= block < spent).
        // "past" = spent by 'block' - these explain residual color in the video
        // (fractional density ghosts) where no coin is currently alive.
        auto count = uint64_t(0);
        auto liveStillUnspent = uint64_t(0);
        struct Hit {
            int64_t satoshi;
            uint32_t created;
            uint32_t spent;
        };
        auto hits = std::vector<Hit>();
        auto const maxHits = size_t(500);
        auto truncated = false;
        auto pastCount = uint64_t(0);
        auto pastHits = std::vector<Hit>();
        auto const maxPastHits = size_t(100);
        auto pastTruncated = false;

        // aggregates for the panel
        auto liveSat = int64_t(0);          // sum alive at view
        auto liveUnspentSat = int64_t(0);   // subset still unspent at tip
        auto pastSat = int64_t(0);          // sum of already-departed coins
        auto stays = std::vector<uint32_t>(); // lifespans of departed coins (past + spent-later)

        // population-over-time curve: kBins samples from h1 to tip
        constexpr size_t kBins = 48;
        auto tip = numBlocks - 1;
        auto binDelta = std::array<int64_t, kBins + 1>{};
        auto binOf = [&](uint32_t h) -> size_t {
            if (h <= h1) {
                return 0;
            }
            if (h >= tip) {
                return kBins - 1;
            }
            auto span = static_cast<double>(tip - h1 + 1);
            return std::min(kBins - 1, static_cast<size_t>(static_cast<double>(h - h1) / span * kBins));
        };

        auto scanLast = std::min(h2, block);
        for (auto h = h1; h <= scanLast; ++h) {
            auto [rb, re] = hist.recordRange(h);
            for (auto i = rb; i < re; ++i) {
                auto const& rec = hist.record(i);
                if (rec.satoshi < s1 || rec.satoshi > s2) {
                    continue;
                }
                // population curve counts every coin that ever lived here
                binDelta[binOf(rec.creationHeight)] += 1;
                if (rec.spendHeight != buv::kUnspent) {
                    binDelta[binOf(rec.spendHeight)] -= 1;
                    stays.push_back(rec.spendHeight - rec.creationHeight);
                }
                if (rec.spendHeight != buv::kUnspent && rec.spendHeight <= block) {
                    // already spent at this time -> past occupant
                    ++pastCount;
                    pastSat += rec.satoshi;
                    pastHits.push_back(Hit{rec.satoshi, rec.creationHeight, rec.spendHeight});
                    continue;
                }
                ++count;
                liveSat += rec.satoshi;
                if (rec.spendHeight == buv::kUnspent) {
                    ++liveStillUnspent;
                    liveUnspentSat += rec.satoshi;
                }
                hits.push_back(Hit{rec.satoshi, rec.creationHeight, rec.spendHeight});
            }
        }

        // Fate-ordered: still-unspent first (by born), then leavers by leaving date.
        // Amounts within a pixel row are nearly identical by construction, so
        // amount ordering carries no information here.
        std::sort(hits.begin(), hits.end(), [](Hit const& a, Hit const& b) {
            auto aUn = a.spent == buv::kUnspent;
            auto bUn = b.spent == buv::kUnspent;
            if (aUn != bUn) {
                return aUn;
            }
            if (!aUn && a.spent != b.spent) {
                return a.spent < b.spent;
            }
            if (a.created != b.created) {
                return a.created < b.created;
            }
            return a.satoshi > b.satoshi;
        });
        if (hits.size() > maxHits) {
            hits.resize(maxHits);
            truncated = true;
        }
        std::sort(pastHits.begin(), pastHits.end(), [](Hit const& a, Hit const& b) {
            if (a.spent != b.spent) {
                return a.spent < b.spent; // earliest leavers first
            }
            return a.created < b.created;
        });
        if (pastHits.size() > maxPastHits) {
            pastHits.resize(maxPastHits);
            pastTruncated = true;
        }

        // median stay of departed coins
        auto medianStay = int64_t(-1);
        if (!stays.empty()) {
            auto mid = stays.begin() + static_cast<std::ptrdiff_t>(stays.size() / 2);
            std::nth_element(stays.begin(), mid, stays.end());
            medianStay = static_cast<int64_t>(*mid);
        }

        // prefix-sum the curve
        auto pop = std::array<int64_t, kBins>{};
        {
            auto running = int64_t(0);
            for (size_t b = 0; b < kBins; ++b) {
                running += binDelta[b];
                pop[b] = running;
            }
        }
        auto viewBin = binOf(block);

        auto json = std::string();
        json.reserve(hits.size() * 96 + 256);
        json += fmt::format(
            R"({{"blockRange":[{},{}],"blockDates":["{}","{}"],"satRange":[{},{}],"count":{},"stillUnspent":{},"liveSat":{},"liveUnspentSat":{},"pastSat":{},"medianStay":{},"viewBin":{},"pop":[)",
            h1,
            h2,
            isoDate(hist.blockTime(h1)),
            isoDate(hist.blockTime(std::min(h2, numBlocks - 1))),
            s1,
            s2,
            count,
            liveStillUnspent,
            liveSat,
            liveUnspentSat,
            pastSat,
            medianStay,
            viewBin);
        for (size_t b = 0; b < kBins; ++b) {
            if (b != 0) {
                json += ',';
            }
            json += fmt::format("{}", pop[b]);
        }
        json += fmt::format(
            R"j(],"truncated":{},"utxos":[)j",
            truncated ? "true" : "false");
        auto firstItem = true;
        for (auto const& hit : hits) {
            if (!firstItem) {
                json += ',';
            }
            firstItem = false;
            auto age = block - hit.created;
            if (hit.spent == buv::kUnspent) {
                json += fmt::format(
                    R"({{"sat":{},"created":{},"createdDate":"{}","age":{},"spent":null}})",
                    hit.satoshi,
                    hit.created,
                    isoDate(hist.blockTime(hit.created)),
                    age);
            } else {
                json += fmt::format(
                    R"({{"sat":{},"created":{},"createdDate":"{}","age":{},"spent":{},"spentDate":"{}"}})",
                    hit.satoshi,
                    hit.created,
                    isoDate(hist.blockTime(hit.created)),
                    age,
                    hit.spent,
                    isoDate(hist.blockTime(hit.spent)));
            }
        }
        json += "],";
        json += fmt::format(R"("pastCount":{},"pastTruncated":{},"pastUtxos":[)",
                            pastCount,
                            pastTruncated ? "true" : "false");
        firstItem = true;
        for (auto const& hit : pastHits) {
            if (!firstItem) {
                json += ',';
            }
            firstItem = false;
            json += fmt::format(
                R"({{"sat":{},"created":{},"createdDate":"{}","spent":{},"spentDate":"{}"}})",
                hit.satoshi,
                hit.created,
                isoDate(hist.blockTime(hit.created)),
                hit.spent,
                isoDate(hist.blockTime(hit.spent)));
        }
        json += "]}";
        res.set_content(json, "application/json");
    });

    // --- txid resolution via Bitcoin Core REST (through SSH tunnel) ---
    server.Get("/api/txid", [&](httplib::Request const& req, httplib::Response& res) {
        auto heightOpt = parseParam<uint32_t>(req, "height");
        auto satoshiOpt = parseParam<int64_t>(req, "satoshi");
        if (!heightOpt || !satoshiOpt) {
            sendBadRequest(res, "height and satoshi must be integers");
            return;
        }
        auto height = *heightOpt;
        auto satoshi = *satoshiOpt;
        if (height >= numBlocks) {
            sendBadRequest(res, "height beyond known chain");
            return;
        }
        if (satoshi < 1 || satoshi > cfg.maxSatoshi) {
            sendBadRequest(res, "satoshi out of range");
            return;
        }

        // cache: popular coins never hit the node twice
        auto cacheKey = fmt::format("{}:{}", height, satoshi);
        if (auto cached = txidCache.get(cacheKey)) {
            res.set_content(*cached, "application/json");
            return;
        }

        auto node = httplib::Client(cfg.bitcoinRpcUrl.c_str());
        node.set_connection_timeout(5);
        node.set_read_timeout(30);

        auto hashRes = node.Get(fmt::format("/rest/blockhashbyheight/{}.json", height).c_str());
        if (!hashRes || hashRes->status != 200) {
            res.status = 503;
            res.set_content(R"j({"error":"node unreachable (is the SSH tunnel up?)"})j", "application/json");
            return;
        }
        // parse {"blockhash":"..."} without a json lib: find the hex
        auto const& hb = hashRes->body;
        auto p = hb.find("\"blockhash\"");
        if (p == std::string::npos) {
            res.status = 502;
            res.set_content(R"({"error":"unexpected node reply"})", "application/json");
            return;
        }
        p = hb.find(':', p);
        auto q1 = hb.find('"', p);
        auto q2 = hb.find('"', q1 + 1);
        auto blockhash = hb.substr(q1 + 1, q2 - q1 - 1);

        auto blockRes = node.Get(fmt::format("/rest/block/{}.json", blockhash).c_str());
        if (!blockRes || blockRes->status != 200) {
            res.status = 503;
            res.set_content(R"({"error":"node unreachable fetching block"})", "application/json");
            return;
        }

        // scan tx outputs for exact amount matches. value is in BTC in REST JSON.
        // compare in satoshi via rounded parse.
        auto const& body = blockRes->body;
        auto matches = std::vector<std::pair<std::string, int>>();
        auto txPos = size_t(0);
        while (true) {
            auto txidPos = body.find("\"txid\"", txPos);
            if (txidPos == std::string::npos) {
                break;
            }
            auto tq1 = body.find('"', body.find(':', txidPos));
            auto tq2 = body.find('"', tq1 + 1);
            auto txid = body.substr(tq1 + 1, tq2 - tq1 - 1);

            auto nextTxid = body.find("\"txid\"", tq2);
            auto voutPos = body.find("\"vout\"", tq2);
            if (voutPos != std::string::npos && (nextTxid == std::string::npos || voutPos < nextTxid)) {
                // scan values within this tx's vout array
                auto scanEnd = nextTxid == std::string::npos ? body.size() : nextTxid;
                auto vPos = voutPos;
                auto voutIdx = 0;
                while (true) {
                    auto valPos = body.find("\"value\"", vPos);
                    if (valPos == std::string::npos || valPos >= scanEnd) {
                        break;
                    }
                    auto colon = body.find(':', valPos);
                    auto valEnd = body.find_first_of(",}", colon);
                    auto valStr = body.substr(colon + 1, valEnd - colon - 1);
                    auto btc = std::stod(valStr);
                    auto sats = static_cast<int64_t>(std::llround(btc * 1e8));
                    if (sats == satoshi) {
                        matches.emplace_back(txid, voutIdx);
                    }
                    ++voutIdx;
                    vPos = valEnd;
                }
            }
            txPos = tq2;
        }

        auto json = std::string("{\"matches\":[");
        auto firstItem = true;
        for (auto const& [txid, vout] : matches) {
            if (!firstItem) {
                json += ',';
            }
            firstItem = false;
            json += fmt::format(R"({{"txid":"{}","vout":{}}})", jsonEscape(txid), vout);
        }
        json += "]}";
        txidCache.put(cacheKey, json);
        res.set_content(json, "application/json");
    });

    LOG("UTXO explorer listening on http://127.0.0.1:{}", cfg.explorerPort);
    server.listen("127.0.0.1", cfg.explorerPort);
}

#pragma once

#include <app/BlockEncoder.h>
#include <filesystem>
#include <fstream>
#include <limits>
#include <stdexcept>
#include <string_view>
#include <unistd.h>
#include <sys/stat.h>

namespace buv {

// Optional, disposable BLK2 acceleration cache. The source must remain immutable
// while this object is used (as with the renderer's mmap). No source writes.
// Boundary fingerprints detect accidental corruption, not adversarial edits.
// Cached reuse additionally requires the source filesystem identity/stamp.
class BlockIndex {
    std::vector<uint64_t> mOffsets{0}; // includes EOF sentinel
    uint64_t mIdentity = 14695981039346656037ULL;
    uint64_t mStamp = 0;
    uint64_t mStoredSize = 0;
    static uint64_t stamp(std::filesystem::path const& path) {
        struct stat st {};
        require(::stat(path.c_str(), &st) == 0);
        std::string data;
        put(data, static_cast<uint64_t>(st.st_dev));
        put(data, static_cast<uint64_t>(st.st_ino));
        put(data, static_cast<uint64_t>(st.st_size));
#ifdef __APPLE__
        put(data, static_cast<uint64_t>(st.st_mtimespec.tv_sec));
        put(data, static_cast<uint64_t>(st.st_mtimespec.tv_nsec));
        put(data, static_cast<uint64_t>(st.st_ctimespec.tv_sec));
        put(data, static_cast<uint64_t>(st.st_ctimespec.tv_nsec));
#else
        put(data, static_cast<uint64_t>(st.st_mtim.tv_sec));
        put(data, static_cast<uint64_t>(st.st_mtim.tv_nsec));
        put(data, static_cast<uint64_t>(st.st_ctim.tv_sec));
        put(data, static_cast<uint64_t>(st.st_ctim.tv_nsec));
#endif
        return hash(data);
    }
    uint64_t boundaries(std::string_view s) const {
        if (!size()) return hash("");
        return hash(s.substr(offset(size()-1), sourceSize()-offset(size()-1)), hash(s.substr(0, offset(1))));
    }
    static void require(bool ok) {
        if (!ok) throw std::runtime_error("invalid or stale BLK offset index/source");
    }
    static uint64_t hash(std::string_view s, uint64_t h = 14695981039346656037ULL) {
        for (unsigned char c : s) h = (h ^ c) * 1099511628211ULL;
        return h;
    }
    static uint64_t integer(std::string_view s, size_t off, size_t n) {
        require(off <= s.size() && n <= s.size() - off);
        uint64_t v = 0;
        for (size_t i = 0; i < n; ++i) v |= uint64_t(static_cast<unsigned char>(s[off + i])) << (8 * i);
        return v;
    }
    static void put(std::string& s, uint64_t v) {
        for (unsigned i = 0; i < 8; ++i) s.push_back(static_cast<char>(v >> (8 * i)));
    }
    static uint64_t next(std::string_view s, uint64_t off, uint64_t height) {
        require(off <= s.size() && s.size() - off >= 12);
        require(s.substr(off, 4) == std::string_view("BLK\2", 4));
        require(integer(s, off + 4, 4) == height);
        auto n = integer(s, off + 8, 4);
        require(n >= 130 && n <= s.size() - off - 12);
        return off + 12 + n;
    }
    // Bound all LEB128 reads before calling the legacy unbounded decoder.
    static void payload(std::string_view s) {
        size_t p = 12 + 124;
        auto var = [&](unsigned bits) {
            uint64_t v = 0;
            for (unsigned shift = 0; shift < bits; shift += 7) {
                require(p < s.size());
                auto b = static_cast<unsigned char>(s[p++]);
                if (bits - shift < 7) require((b & 127U) < (1U << (bits - shift)));
                v |= uint64_t(b & 127U) << shift;
                if (!(b & 128U)) return v;
            }
            require(false);
            return uint64_t(0);
        };
        for (int i = 0; i < 4; ++i) var(32);
        auto z = var(64);
        auto amount = static_cast<int64_t>(z >> 1) ^ -static_cast<int64_t>(z & 1);
        var(64);
        while (p < s.size()) {
            auto d = var(64);
            // Match the decoder's modulo unsigned addition without signed overflow.
            amount = static_cast<int64_t>(static_cast<uint64_t>(amount) + d);
            if (amount <= 0) var(64);
        }
    }
public:
    size_t size() const { return mOffsets.size() - 1; }
    uint64_t sourceSize() const { return mOffsets.back(); }
    // height == size() returns EOF, useful for no-op append ranges.
    uint64_t offset(size_t height) const { return mOffsets.at(height); }
    static BlockIndex build(std::string_view source) {
        BlockIndex result;
        result.extend(source);
        return result;
    }
    // Strong exception guarantee. Boundary rewrites and truncation are rejected.
    // Interior edits require filesystem stamp checking through loadOrBuild.
    void extend(std::string_view source) {
        require(source.size() >= sourceSize());
        require(boundaries(source) == mIdentity);
        auto offsets = mOffsets;
        while (offsets.back() < source.size()) {
            require(offsets.size() - 1 <= std::numeric_limits<uint32_t>::max());
            offsets.push_back(next(source, offsets.back(), offsets.size() - 1));
        }
        mOffsets.swap(offsets);
        mIdentity = boundaries(source);
    }
    // Framing-checked span for trusted legacy decoding without the bounded
    // payload pre-pass. It does NOT validate varints; use read for untrusted data.
    std::string_view recordSpan(std::string_view source, size_t height) const {
        require(source.size() == sourceSize() && height < size());
        auto begin = offset(height);
        require(next(source, begin, height) == offset(height + 1));
        return source.substr(begin, offset(height + 1) - begin);
    }
    ChangesInBlock read(std::string_view source, size_t height, ChangesInBlock&& reusable = ChangesInBlock()) const {
        require(source.size() == sourceSize() && height < size());
        auto begin = offset(height);
        require(next(source, begin, height) == offset(height + 1));
        payload(source.substr(begin, offset(height + 1) - begin));
        auto result = ChangesInBlock::decode(std::move(reusable), source.data() + begin);
        require(result.second == source.data() + offset(height + 1));
        return std::move(result.first);
    }
    template <typename Callback>
    void forEachChange(std::string_view source, size_t startHeight, Callback&& callback) const {
        require(startHeight <= size());
        auto reusable = ChangesInBlock();
        for (size_t height = startHeight; height < size(); ++height) {
            reusable = read(source, height, std::move(reusable));
            callback(reusable);
        }
    }
    // Adjacent optional cache. A changed stamp at unchanged size invalidates it.
    // Growth can validate boundary records but cannot prove unchanged interior;
    // callers must supply append-only source files, never concurrently modified.
    static BlockIndex loadOrBuild(std::filesystem::path const& path, std::string_view source) {
        auto before = stamp(path);
        require(std::filesystem::file_size(path) == source.size());
        auto sidecar = std::filesystem::path(path.string() + ".idx");
        BlockIndex result;
        try {
            result = load(sidecar, source);
            require(result.mStoredSize < source.size() || result.mStamp == before);
        } catch (std::exception const&) {
            result = build(source);
        }
        require(stamp(path) == before);
        if (result.mStamp != before) {
            result.mStamp = before;
            try { result.save(sidecar); } catch (std::exception const&) { /* optional cache */ }
        }
        return result;
    }
    // Little-endian BUVBIDX1: source size, count, boundary identity, filesystem stamp, count+1 offsets,
    // checksum of all preceding bytes. Exact length required; no native structs.
    void save(std::filesystem::path const& path) const {
        std::string data("BUVBIDX1", 8);
        put(data, sourceSize()); put(data, size()); put(data, mIdentity); put(data, mStamp);
        for (auto off : mOffsets) put(data, off);
        put(data, hash(data));
        auto temp = path.string() + ".tmp.XXXXXX";
        std::vector<char> name(temp.begin(), temp.end()); name.push_back(0);
        int fd = ::mkstemp(name.data());
        if (fd < 0) throw std::runtime_error("cannot create BLK index sidecar");
        try {
            size_t done = 0;
            while (done < data.size()) {
                auto n = ::write(fd, data.data() + done, data.size() - done);
                if (n <= 0) throw std::runtime_error("cannot write BLK index sidecar");
                done += static_cast<size_t>(n);
            }
            require(::fsync(fd) == 0);
            ::close(fd); fd = -1;
            std::filesystem::rename(name.data(), path);
        } catch (...) {
            if (fd >= 0) ::close(fd);
            ::unlink(name.data());
            throw;
        }
    }
    static BlockIndex load(std::filesystem::path const& path, std::string_view source) {
        // Bound allocation by the minimum possible BLK record size.
        auto bytes = std::filesystem::file_size(path);
        require(bytes >= 56 && bytes <= 56 + (source.size() / 142) * 8);
        std::string data(static_cast<size_t>(bytes), '\0');
        std::ifstream in(path, std::ios::binary);
        require(bool(in.read(data.data(), static_cast<std::streamsize>(data.size()))));
        require(data.compare(0, 8, "BUVBIDX1") == 0);
        auto count = integer(data, 16, 8);
        require(count == (bytes - 56) / 8 && bytes == 56 + count * 8);
        require(integer(data, bytes - 8, 8) == hash(std::string_view(data).substr(0, bytes - 8)));
        BlockIndex result;
        result.mIdentity = integer(data, 24, 8);
        result.mStamp = integer(data, 32, 8);
        result.mOffsets.resize(static_cast<size_t>(count + 1));
        for (size_t i = 0; i <= count; ++i) result.mOffsets[i] = integer(data, 40 + i * 8, 8);
        require(result.offset(0) == 0 && result.sourceSize() == integer(data, 8, 8));
        require(result.sourceSize() <= source.size());
        for (size_t i = 0; i < count; ++i) {
            require(result.offset(i) < result.offset(i + 1));
            require(result.offset(i + 1) - result.offset(i) >= 142);
            require(result.offset(i + 1) <= result.sourceSize());
        }
        // Do not fault every historical BLK page on cache reuse.
        if (count) {
            require(next(source, 0, 0) == result.offset(1));
            require(next(source, result.offset(count - 1), count - 1) == result.sourceSize());
        }
        result.mStoredSize = result.sourceSize();
        result.extend(source); // verifies old boundary records, then indexes new framing
        return result;
    }
};
} // namespace buv

#pragma once

#include <app/RendererCheckpoint.h>
#include <app/UtxoHistory.h>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <string>
#include <vector>
#include <fcntl.h>
#include <unistd.h>

namespace buv {
// Immutable write-ahead journal. All integers are little endian, like BUVHIST1.
// Payload: old-spend entries, new records, full target times and height index,
// then SHA256 of every preceding byte. Publication requires the target history
// header, not merely the existence of this file. A durable journal also allows
// replay after interruption while replacing the old trailing index arrays.
#pragma pack(push, 1)
struct HistoryDeltaHeader {
    char magic[8]{'B','U','V','D','L','T','0','1'};
    UtxoHistoryHeader before{};
    UtxoHistoryHeader after{};
    uint64_t spends{};
    uint64_t blkPrefixBytes{};
    RendererCheckpointHash blkTailHash{};
};
struct HistoryDeltaSpend {
    uint64_t recordIndex{};
    UtxoHistoryRecord record{};
};
#pragma pack(pop)
static_assert(sizeof(HistoryDeltaHeader) == 184);
static_assert(sizeof(HistoryDeltaSpend) == 24);

inline void deltaRequire(bool ok, char const* message) {
    if (!ok) throw std::runtime_error(std::string("history delta: ") + message);
}
template<class T> void deltaAppend(std::string& out, T const* data, size_t count) {
    if (count) out.append(reinterpret_cast<char const*>(data), count * sizeof(T));
}
inline auto readHistoryDelta(std::filesystem::path const& path) -> std::string {
    auto size = std::filesystem::file_size(path);
    deltaRequire(size >= sizeof(HistoryDeltaHeader) + 32 && size < (uint64_t(1) << 34), "invalid journal size");
    std::string bytes(static_cast<size_t>(size), '\0');
    std::ifstream input(path, std::ios::binary);
    input.read(bytes.data(), static_cast<std::streamsize>(size));
    deltaRequire(bool(input), "cannot read journal");
    auto hash = rendererCheckpointHash(bytes.data(), bytes.size() - 32);
    deltaRequire(std::memcmp(hash.data(), bytes.data() + bytes.size() - 32, 32) == 0, "journal checksum mismatch");
    return bytes;
}
inline auto historyDeltaHeader(std::string const& bytes) -> HistoryDeltaHeader {
    deltaRequire(bytes.size() >= sizeof(HistoryDeltaHeader) + 32, "truncated journal");
    HistoryDeltaHeader h;
    std::memcpy(&h, bytes.data(), sizeof(h));
    deltaRequire(std::memcmp(h.magic, "BUVDLT01", 8) == 0, "bad journal magic");
    deltaRequire(std::memcmp(h.before.magic, kUtxoHistoryMagic, 8) == 0 &&
                 std::memcmp(h.after.magic, kUtxoHistoryMagic, 8) == 0, "bad history magic");
    deltaRequire(h.after.numBlocks > h.before.numBlocks && h.after.numBlocks < UINT32_MAX &&
                 h.after.numRecords >= h.before.numRecords && h.spends <= h.before.numRecords,
                 "invalid journal counts");
    // Divide-based bounds before arithmetic; no allocation from untrusted counts.
    auto n = h.after.numRecords - h.before.numRecords;
    deltaRequire(n <= bytes.size()/16 && h.spends <= bytes.size()/24 && h.after.numBlocks <= bytes.size()/12,
                 "oversized journal counts");
    auto expected = sizeof(h) + h.spends*24 + n*16 + h.after.numBlocks*4 + (h.after.numBlocks+1)*8 + 32;
    deltaRequire(expected == bytes.size(), "journal length mismatch");
    deltaRequire(h.after.recordsOff == h.before.recordsOff &&
                 h.after.blockTimesOff == h.after.recordsOff + h.after.numRecords*16 &&
                 h.after.heightIndexOff == h.after.blockTimesOff + h.after.numBlocks*4,
                 "invalid target offsets");
    return h;
}
inline void writeHistoryDelta(std::filesystem::path const& path, std::string bytes) {
    deltaRequire(!std::filesystem::exists(path), "journal path already exists");
    auto hash = rendererCheckpointHash(bytes.data(), bytes.size());
    bytes.append(reinterpret_cast<char const*>(hash.data()), hash.size());
    auto tmp = path.string() + ".pending";
    auto fd = ::open(tmp.c_str(), O_WRONLY | O_CREAT | O_EXCL, 0600);
    deltaRequire(fd >= 0, "cannot create exclusive pending journal");
    size_t offset = 0;
    while (offset < bytes.size()) {
        auto n = ::write(fd, bytes.data()+offset, bytes.size()-offset);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) { ::close(fd); throw std::runtime_error("history delta: journal write failed"); }
        offset += static_cast<size_t>(n);
    }
    auto synced = ::fsync(fd); ::close(fd);
    deltaRequire(synced == 0, "journal fsync failed");
    // link refuses to replace any existing artifact, then remove the temporary name.
    deltaRequire(::link(tmp.c_str(), path.c_str()) == 0, "cannot commit journal without overwrite");
    ::unlink(tmp.c_str());
    auto parent = path.parent_path().empty() ? std::filesystem::path(".") : path.parent_path();
    auto dir = ::open(parent.c_str(), O_RDONLY);
    deltaRequire(dir >= 0, "cannot open journal directory");
    auto result = ::fsync(dir); ::close(dir);
    deltaRequire(result == 0, "journal directory fsync failed");
}
} // namespace buv

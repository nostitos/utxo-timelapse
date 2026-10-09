#pragma once

#include <app/BlockEncoder.h>
#include <util/Mmap.h>

#include <filesystem>
#include <optional>

namespace buv {

template <typename Op>
auto forEachChange(util::Mmap const& mmappedFile, Op op, uint64_t startOffset = 0,
                   std::optional<uint64_t> endOffset = std::nullopt) -> buv::ChangesInBlock {
    if (!mmappedFile.is_open()) {
        throw std::runtime_error("file not open");
    }

    auto const stop = endOffset.value_or(mmappedFile.size());
    if (startOffset > stop || stop > mmappedFile.size())
        throw std::runtime_error("BLK offsets outside input or reversed");
    auto const* ptr = mmappedFile.begin() + startOffset;
    auto const* end = mmappedFile.begin() + stop;

    auto cib = buv::ChangesInBlock();
    while (ptr != end) {
        // Reject a partial boundary before the legacy decoder touches its payload.
        // Payload varints are still trusted, as in the original replay path.
        if (end - ptr < 12) throw std::runtime_error("Truncated BLK header in replay range");
        uint32_t payloadBytes{};
        std::memcpy(&payloadBytes, ptr + 8, sizeof(payloadBytes));
        if (payloadBytes < 130 || uint64_t(payloadBytes) > static_cast<uint64_t>(end - ptr - 12))
            throw std::runtime_error("BLK record crosses replay end offset");
        auto const* expectedEnd = ptr + 12 + payloadBytes;
        std::tie(cib, ptr) = buv::ChangesInBlock::decode(std::move(cib), ptr);
        if (ptr != expectedEnd) throw std::runtime_error("BLK decoded length mismatch");
        // NOLINTNEXTLINE(bugprone-use-after-move,hicpp-invalid-access-moved)
        if (!op(cib)) {
            return cib;
        }
    }

    return cib;
}

[[nodiscard]] inline auto numBlocks(util::Mmap const& mmappedFile) -> size_t {
    if (!mmappedFile.is_open()) {
        throw std::runtime_error("file not open");
    }

    auto const* ptr = mmappedFile.begin();
    auto const* end = mmappedFile.end();

    auto blockHeight = uint32_t();
    while (ptr != end) {
        std::tie(blockHeight, ptr) = buv::ChangesInBlock::skip(ptr);
    }

    return blockHeight + 1;
}

} // namespace buv

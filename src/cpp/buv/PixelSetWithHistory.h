#pragma once

#include <algorithm>
#include <cstdint>
#include <functional>
#include <limits>
#include <vector>

namespace buv {

// Basically a set for pixels. Fast if the number of changed pixels is small.
//
// Quick O(1) to set a pixel
// Quick O(n) to iterate all set n pixel.
// Quick O(n) to clear all set pixels.
class PixelSetWithHistory {
public:
    struct BlockheightPixelidx {
        uint32_t block_height{};
        size_t pixel_idx{};
        uint16_t pixel_distance{};  // Distance from origin block to current block (for variable fade)
        uint16_t min_fade_duration{}; // Amount-scaled lower bound; 0 keeps the distance-only behavior.
        // Anchor for smooth epoch slides: the creation height whose column this
        // flash belongs to, and this pixel's offset from that column. Lets the
        // flash follow its column when the X mapping is re-blended each frame.
        uint32_t anchor_height{};
        int16_t anchor_dx{};
        bool anchored{false};
    };
    using BlockheightPixelCollection = std::vector<BlockheightPixelidx>;

    PixelSetWithHistory(size_t size, size_t max_history)
        : m_max_history(max_history)
        , m_pixel(size, sentinel) {}

    // Assumes that idx < size. O(1) operation.
    void insert(uint32_t block_height,
                size_t pixel_idx,
                uint16_t pixel_distance = 0,
                uint16_t min_fade_duration = 0,
                bool anchored = false,
                uint32_t anchor_height = 0,
                int16_t anchor_dx = 0) {
        if (sentinel == m_pixel[pixel_idx]) {
            // not set: create entry
            m_pixel[pixel_idx] = m_blockheight_pixelidx.size();
            m_blockheight_pixelidx.emplace_back(
                BlockheightPixelidx{block_height, pixel_idx, pixel_distance, min_fade_duration,
                                    anchor_height, anchor_dx, anchored});
        } else {
            // Pixel already set: keep the brightest (youngest) overlay while
            // retaining the longest fade requested by overlapping flashes.
            auto& pos = m_blockheight_pixelidx[m_pixel[pixel_idx]];
            if (block_height > pos.block_height) {
                pos.block_height = block_height;
                if (anchored) {
                    pos.anchored = true;
                    pos.anchor_height = anchor_height;
                    pos.anchor_dx = anchor_dx;
                }
            }
            pos.pixel_distance = std::max(pos.pixel_distance, pixel_distance);
            pos.min_fade_duration = std::max(pos.min_fade_duration, min_fade_duration);
        }
    }

    // Move every anchored entry to the column its anchor height maps to now.
    // columnOf(height) returns the absolute image x for a creation height.
    // Unanchored entries are dropped (they cannot be placed under a new map).
    // Collisions keep the youngest entry; off-image results are dropped.
    void remap(size_t imageWidth, size_t imageHeight, std::function<size_t(uint32_t)> const& columnOf) {
        auto old = std::move(m_blockheight_pixelidx);
        m_blockheight_pixelidx.clear();
        std::fill(m_pixel.begin(), m_pixel.end(), sentinel);
        for (auto const& e : old) {
            if (!e.anchored) {
                continue;
            }
            auto const y = e.pixel_idx / imageWidth;
            auto const x = static_cast<long>(columnOf(e.anchor_height)) + e.anchor_dx;
            if (x < 0 || x >= static_cast<long>(imageWidth) || y >= imageHeight) {
                continue;
            }
            auto const idx = y * imageWidth + static_cast<size_t>(x);
            insert(e.block_height, idx, e.pixel_distance, e.min_fade_duration, true, e.anchor_height, e.anchor_dx);
        }
    }

    // remove all pixels older than their individual fade duration
    void age(uint32_t const current_block_height) {
        size_t idx = m_blockheight_pixelidx.size();
        while (0U != idx--) {
            auto& pos_at_idx = m_blockheight_pixelidx[idx];

            // Calculate per-pixel fade duration: 10 blocks (near) to 300 blocks (far)
            uint32_t fade_duration = std::max(
                getFadeDuration(pos_at_idx.pixel_distance),
                static_cast<uint32_t>(pos_at_idx.min_fade_duration));

            if (pos_at_idx.block_height + fade_duration < current_block_height) {
                // clear that pixel
                m_pixel[pos_at_idx.pixel_idx] = sentinel;

                // move last entry to the now vacant position (if we are not at the end)
                if (idx != m_blockheight_pixelidx.size() - 1) {
                    pos_at_idx = m_blockheight_pixelidx.back();
                    m_pixel[pos_at_idx.pixel_idx] = idx;
                }

                // get rid of moved entry
                m_blockheight_pixelidx.pop_back();
            }
        }
    }

    [[nodiscard]] auto begin() const -> BlockheightPixelCollection::const_iterator {
        return m_blockheight_pixelidx.begin();
    }
    [[nodiscard]] auto end() const -> BlockheightPixelCollection::const_iterator {
        return m_blockheight_pixelidx.end();
    }

    [[nodiscard]] auto size() const -> size_t {
        return m_blockheight_pixelidx.size();
    }

    void clear() {
        std::fill(m_pixel.begin(), m_pixel.end(), sentinel);
        m_blockheight_pixelidx.clear();
    }

    [[nodiscard]] auto max_history() const -> size_t {
        return m_max_history;
    }

    // Calculate fade duration based on pixel distance: 10 blocks (near) to 300 blocks (far)
    [[nodiscard]] static auto getFadeDuration(uint16_t pixel_distance) -> uint32_t {
        // Linear interpolation: distance 0 -> 10 blocks, distance 3720 -> 300 blocks
        return 10 + (static_cast<uint32_t>(pixel_distance) * 290 / 3720);
    }

private:
    static constexpr size_t sentinel = std::numeric_limits<size_t>::max();
    size_t const m_max_history;

    std::vector<size_t> m_pixel;
    BlockheightPixelCollection m_blockheight_pixelidx;
};

} // namespace buv

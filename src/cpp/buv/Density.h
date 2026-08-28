#pragma once

#include <app/Cfg.h>
#include <buv/ColorMap.h>
#include <buv/DensityToImage.h>
#include <buv/PixelSet.h>
#include <buv/PixelSetWithHistory.h>
#include <buv/SatoshiBlockheightToPixel.h>
#include <buv/truncate.h>
#include <util/log.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <fstream>
#include <iostream>
#include <robin_hood.h>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

namespace buv {

namespace {

// Coinjoin denomination values (powers of 2, powers of 3, round decimal amounts)
inline const std::unordered_set<int64_t>& coinjoinDenominations() {
    static const std::unordered_set<int64_t> s = {
        5000, 6561, 8192, 10000, 13122, 16384, 19683, 20000, 32768, 39366,
        50000, 59049, 65536, 100000, 118098, 131072, 177147, 200000, 262144,
        354294, 500000, 524288, 531441, 1000000, 1048576, 1062882, 1594323,
        2000000, 2097152, 3188646, 4194304, 4782969, 5000000, 8388608,
        9565938, 10000000, 14348907, 16777216, 20000000, 28697814, 33554432,
        43046721, 50000000, 67108864, 86093442, 100000000, 129140163,
        134217728, 200000000, 258280326, 268435456, 387420489, 500000000,
        536870912, 774840978, 1000000000, 1073741824, 1162261467, 2000000000,
        2147483648, 2324522934, 3486784401, 4294967296, 5000000000,
        6973568802, 8589934592, 10000000000, 10460353203, 17179869184,
        20000000000, 20920706406, 31381059609, 34359738368, 50000000000,
        62762119218, 68719476736, 94143178827, 100000000000, 137438953472
    };
    return s;
}

inline bool isCoinjoinAmount(int64_t amount) {
    int64_t abs_amount = amount < 0 ? -amount : amount;
    // Range check: 9,500,000 to 10,000,000 sats
    if (abs_amount >= 9500000 && abs_amount <= 10000000) {
        return true;
    }
    return coinjoinDenominations().count(abs_amount) > 0;
}

} // anonymous namespace

// Integrates change data into an density image.
class Density {
public:
    explicit Density(Cfg const& cfg, uint32_t numBlocks)
        : mCfg(cfg)
        , mSatoshiBlockheightToPixel(cfg, numBlocks)
        , m_data(cfg.imageWidth * cfg.imageHeight, 0)
        , m_last_data(nullptr)
        , m_pixel_set_with_history(cfg.imageWidth * cfg.imageHeight, 300)
        , m_current_block_pixels(cfg.imageWidth * cfg.imageHeight)
        , m_density_to_image(
              cfg.imageWidth, cfg.imageHeight, cfg.colorUpperValueLimit, ColorMap::create(cfg.colorMap), cfg.colorBackgroundRGB)
        , m_current_block_height(0)
        , m_prev_block_height(-1)
        , m_prev_amount(-1) {
        LOG("Image {}x{}", cfg.imageWidth, cfg.imageHeight);
        if (mSatoshiBlockheightToPixel.useEpochCompression()) {
            // One entry represents every alive UTXO sharing a creation-height/Y
            // pair. Reserving up front avoids repeated multi-gigabyte rehashes on
            // a full-chain render.
            m_alive.reserve(64'000'000);
        }
        if (cfg.amountColorFloor) {
            m_density_to_image.setRowColorFloor(buildAmountColorFloor());
        }
    }

    void begin_block(uint32_t block_height) {
        m_current_block_height = block_height;

        // Check for epoch transition (in epochLog or normalizedGeometric mode)
        if (mSatoshiBlockheightToPixel.useEpochCompression()) {
            uint32_t epochBlocks = mSatoshiBlockheightToPixel.getEpochBlocks();
            uint32_t newEpoch = block_height / epochBlocks;
            uint32_t currentEpoch = mSatoshiBlockheightToPixel.getCurrentEpoch();

            if (newEpoch > currentEpoch) {
                resampleForNewEpoch(newEpoch);
            }
        }

        // Check for continuous log resampling
        if (mSatoshiBlockheightToPixel.useContinuousLogCompression()) {
            // Save old total BEFORE updating
            uint32_t oldTotal = mSatoshiBlockheightToPixel.getTotalBlocks();

            // Update total blocks and check if resampling is needed
            bool needsResample = mSatoshiBlockheightToPixel.setTotalBlocks(block_height + 1);
            if (needsResample && block_height > 0) {
                resampleForContinuousLog(oldTotal, block_height + 1);
            }
        }
    }

    // Get the current epoch (for syncing with HUD)
    [[nodiscard]] auto getCurrentEpoch() const -> uint32_t {
        return mSatoshiBlockheightToPixel.getCurrentEpoch();
    }

    // Get the current total blocks (for syncing with HUD in continuous log mode)
    [[nodiscard]] auto getTotalBlocks() const -> uint32_t {
        return mSatoshiBlockheightToPixel.getTotalBlocks();
    }

    // adds/removes 1 at the correct density. Insert that pixel into m_current_block_pixels for quick processing in end_block.
    void change(uint32_t block_height, int64_t amount) {
        if (amount == 0) {
            return;
        }
        if (mCfg.coinjoinFilter && !isCoinjoinAmount(amount)) {
            return;
        }
        if (amount == m_prev_amount) {
            if (block_height == m_prev_block_height) {
                updateAliveLedger(block_height, mPixelY, amount);
                applyDelta(*m_last_data, amount);
                return;
            }
        } else {
            // relatively slow due to std::log
            mPixelY = mSatoshiBlockheightToPixel.satoshiToPixelHeight(amount);
        }
        mPixelX = mSatoshiBlockheightToPixel.blockheightToPixelWidth(block_height);
        updateAliveLedger(block_height, mPixelY, amount);

        auto pixel_idx = mPixelY * mCfg.imageWidth + mPixelX;
        static size_t max_pixel_idx = 0;
        if (pixel_idx > max_pixel_idx) {
            max_pixel_idx = pixel_idx;
        }
        m_last_data = &m_data[pixel_idx];
        applyDelta(*m_last_data, amount);

        // integrate density into image
        // m_density_image.update(pixel_idx, pixel);
        m_current_block_pixels.insert(pixel_idx);

        // Track UTXO creations for flow lines (only positive amounts = new UTXOs)
        if (amount > 0) {
            m_current_block_utxo_counts[mPixelY]++;
        }

        m_prev_amount = amount;
        m_prev_block_height = block_height;
    }

    template <typename Op>
    void end_block(uint32_t block_height, Op op) {
        if (block_height < mCfg.startShowAtBlockHeight) {
            return;
        }

        if (mCfg.skipBlocks > 1 && (block_height % mCfg.skipBlocks != 0)) {
            return;
        }

        // update only the colors of the pixels that actually need updating
        for (auto const pixel_idx : m_current_block_pixels) {
            m_density_to_image.update(pixel_idx, m_data[pixel_idx]);
        }

        // Get current block's X position for distance calculation
        size_t current_block_x = mSatoshiBlockheightToPixel.blockheightToPixelWidth(m_current_block_height);

        for (auto const pixel_idx : m_current_block_pixels) {
            size_t const y = pixel_idx / mCfg.imageWidth;
            size_t const x = pixel_idx - y * mCfg.imageWidth;

            if (m_current_block_height >= 15) {
                // Calculate pixel distance from this UTXO's X position to current block's X position
                size_t pixel_distance = (current_block_x > x) ? (current_block_x - x) : 0;

                // Flash size based on pixel distance (approximate block equivalents):
                // - < 100 pixels (~5000 blocks): 1px (center only)
                // - 100-250 pixels (~5000-12000 blocks): 4px (center + above + left + top-left)
                // - > 250 pixels (~12000+ blocks): 9px (full 3x3 pattern)

                uint16_t dist16 = static_cast<uint16_t>(pixel_distance > 65535 ? 65535 : pixel_distance);

                if (pixel_distance < 100) {
                    // 1px flash - center only
                    m_pixel_set_with_history.insert(m_current_block_height, pixel_idx, dist16);
                } else if (pixel_distance < 250) {
                    // 4px flash - center, above, left, top-left
                    m_pixel_set_with_history.insert(m_current_block_height, pixel_idx, dist16);
                    if (x > 0) {
                        m_pixel_set_with_history.insert(m_current_block_height - 7, (y + 0) * mCfg.imageWidth + (x - 1), dist16);
                        if (y > 0) {
                            m_pixel_set_with_history.insert(m_current_block_height - 15, (y - 1) * mCfg.imageWidth + (x - 1), dist16);
                        }
                    }
                    if (y > 0) {
                        m_pixel_set_with_history.insert(m_current_block_height - 7, (y - 1) * mCfg.imageWidth + (x + 0), dist16);
                    }
                } else {
                    // 9px flash - full 3x3 pattern (original behavior)
                    // upper row
                    if (x > 0) {
                        if (y > 0) {
                            m_pixel_set_with_history.insert(m_current_block_height - 15, (y - 1) * mCfg.imageWidth + (x - 1), dist16);
                        }
                        m_pixel_set_with_history.insert(m_current_block_height - 7, (y + 0) * mCfg.imageWidth + (x - 1), dist16);
                        if (y + 1 < mCfg.imageHeight) {
                            m_pixel_set_with_history.insert(m_current_block_height - 15, (y + 1) * mCfg.imageWidth + (x - 1), dist16);
                        }
                    }

                    // middle row
                    if (y > 0) {
                        m_pixel_set_with_history.insert(m_current_block_height - 7, (y - 1) * mCfg.imageWidth + (x + 0), dist16);
                    }
                    m_pixel_set_with_history.insert(m_current_block_height, pixel_idx, dist16);
                    if (y + 1 < mCfg.imageHeight) {
                        m_pixel_set_with_history.insert(m_current_block_height - 7, (y + 1) * mCfg.imageWidth + (x + 0), dist16);
                    }

                    // lower row
                    if (x + 1 < mCfg.imageWidth) {
                        if (y > 0) {
                            m_pixel_set_with_history.insert(m_current_block_height - 15, (y - 1) * mCfg.imageWidth + (x + 1), dist16);
                        }
                        m_pixel_set_with_history.insert(m_current_block_height - 7, (y + 0) * mCfg.imageWidth + (x + 1), dist16);
                        if (y + 1 < mCfg.imageHeight) {
                            m_pixel_set_with_history.insert(m_current_block_height - 15, (y + 1) * mCfg.imageWidth + (x + 1), dist16);
                        }
                    }
                }
            }
        }

        // Finalize UTXO flow counts for this block
        finalizeUtxoFlowCounts(block_height);

        fadeOut(block_height, op);

        // save_image_ppm(toi, fname);
        // m_pixel_set.clear();
        //}

        m_current_block_pixels.clear();
    }

    // Finalize UTXO flow tracking for the current block
    void finalizeUtxoFlowCounts(uint32_t block_height) {
        // Store current block's counts in the flow history
        for (auto const& [y_pos, count] : m_current_block_utxo_counts) {
            if (count > 0) {
                m_utxo_flow_per_y[y_pos].push_back({block_height, count});
            }
        }

        // Age out blocks older than FLOW_WINDOW_BLOCKS
        uint32_t min_block = (block_height >= FLOW_WINDOW_BLOCKS) ? (block_height - FLOW_WINDOW_BLOCKS + 1) : 0;

        for (auto it = m_utxo_flow_per_y.begin(); it != m_utxo_flow_per_y.end(); ) {
            auto& deque = it->second;
            // Remove entries older than the window
            while (!deque.empty() && deque.front().first < min_block) {
                deque.pop_front();
            }
            // Remove empty entries from the map
            if (deque.empty()) {
                it = m_utxo_flow_per_y.erase(it);
            } else {
                ++it;
            }
        }

        // Clear current block counts for next block
        m_current_block_utxo_counts.clear();
    }

    // saves current status of the image as a PPM file
    void save_image_ppm(std::string const& filename) const {
        // see http://netpbm.sourceforge.net/doc/ppm.html
        std::ofstream fout(filename, std::ios::binary);
        fout << "P6\n" << mCfg.imageWidth << " " << mCfg.imageHeight << "\n" << 255 << "\n" << m_density_to_image;
    }

    template <typename Op>
    void fadeOut(uint32_t block_height, Op op) {
        // remove all pixels older than max age
        m_pixel_set_with_history.age(block_height);

        // temporarily set all updated pixels to white
        std::vector<uint8_t> previous_rgb_values(3 * m_pixel_set_with_history.size());
        auto* rgb_data = previous_rgb_values.data();

        for (auto const& blockheight_pixelidx : m_pixel_set_with_history) {
            auto* rgb = m_density_to_image.rgb(blockheight_pixelidx.pixel_idx);

            rgb_data[0] = rgb[0];
            rgb_data[1] = rgb[1];
            rgb_data[2] = rgb[2];
            rgb_data += 3;
            int const age = block_height - blockheight_pixelidx.block_height;

            // Use per-pixel fade duration based on distance (10-300 blocks)
            int const fade_duration = static_cast<int>(
                PixelSetWithHistory::getFadeDuration(blockheight_pixelidx.pixel_distance));

            // linear interpolate between colorHighlightRGB (0 age), and original color (fade_duration age)
            rgb[0] = (rgb[0] * age + mCfg.colorHighlightRGB[0] * (fade_duration - age)) / fade_duration;
            rgb[1] = (rgb[1] * age + mCfg.colorHighlightRGB[1] * (fade_duration - age)) / fade_duration;
            rgb[2] = (rgb[2] * age + mCfg.colorHighlightRGB[2] * (fade_duration - age)) / fade_duration;
        }

        // Draw UTXO flow lines and save affected pixels for restoration
        std::vector<std::pair<size_t, std::array<uint8_t, 3>>> flowLinePixels;
        drawUtxoFlowLines(block_height, flowLinePixels);

        op(m_density_to_image.data());

        // Restore flow line pixels
        for (auto const& [pixel_idx, savedRgb] : flowLinePixels) {
            m_density_to_image.rgb(pixel_idx, savedRgb.data());
        }

        // now re-update all the updated pixels that have changed since the last update
        rgb_data = previous_rgb_values.data();
        for (auto const& blockheight_pixelidx : m_pixel_set_with_history) {
            m_density_to_image.rgb(blockheight_pixelidx.pixel_idx, rgb_data);
            rgb_data += 3;
        }
    }

    ~Density() {
        // sort & print pixel densities
        m_data.erase(std::remove(m_data.begin(), m_data.end(), 0), m_data.end());
        std::sort(m_data.begin(), m_data.end());

        // print 100 values
        LOG("100 density values, starting from 0 (min) to max", m_data.size());
        auto numValues = size_t(100);
        for (size_t i = 0; i < numValues; ++i) {
            fmt::print("{}, ", m_data[(m_data.size() - 1) * i / (numValues - 1)]);
        }
        LOG("Density diagnostics: ledger misses={}, dropped decrements={}",
            m_ledger_misses, m_dropped_decrements);
    }

private:
    static constexpr uint64_t LEDGER_Y_MASK = 0xffffU;

    // Build the per-row minimum color index for the amount color floor.
    // The floor is derived from the BTC amount each screen row represents:
    //   < 0.1 BTC            -> 0 (unchanged)
    //   0.1 BTC .. 1 BTC     -> 0 .. 45, log-linear fade-in (avoids a hard seam)
    //   1 BTC .. maxSatoshi  -> 45 .. 255, log-linear (top of the axis = peak red)
    // Rows are resolved by sampling the exact forward satoshi->pixel mapping, so
    // any Y-axis mode (including compressLowSatoshi) stays consistent.
    [[nodiscard]] auto buildAmountColorFloor() const -> std::vector<uint8_t> {
        auto rowFloor = std::vector<uint8_t>(mCfg.imageHeight, 0);
        auto rowMaxSatoshi = std::vector<double>(mCfg.imageHeight, 0.0);

        auto const logMin = std::log(static_cast<double>(std::max<int64_t>(mCfg.minSatoshi, 1)));
        auto const logMax = std::log(static_cast<double>(mCfg.maxSatoshi));
        constexpr size_t numSamples = 20000;
        for (size_t i = 0; i <= numSamples; ++i) {
            auto const logS = logMin + (logMax - logMin) * static_cast<double>(i) / numSamples;
            auto const satoshi = static_cast<int64_t>(std::exp(logS));
            auto const row = mSatoshiBlockheightToPixel.satoshiToPixelHeight(satoshi);
            if (row < rowMaxSatoshi.size()) {
                rowMaxSatoshi[row] = std::max(rowMaxSatoshi[row], static_cast<double>(satoshi));
            }
        }

        constexpr double satTenthBtc = 1e7;
        constexpr double satOneBtc = 1e8;
        constexpr double floorAtOneBtc = 45.0;
        auto const logOne = std::log(satOneBtc);
        auto const logTenth = std::log(satTenthBtc);
        for (size_t row = 0; row < rowMaxSatoshi.size(); ++row) {
            auto const sat = rowMaxSatoshi[row];
            if (sat < satTenthBtc) {
                continue;
            }
            double floorIdx = 0.0;
            if (sat < satOneBtc) {
                floorIdx = floorAtOneBtc * (std::log(sat) - logTenth) / (logOne - logTenth);
            } else {
                auto const t = std::min(1.0, (std::log(sat) - logOne) / (logMax - logOne));
                floorIdx = floorAtOneBtc + (255.0 - floorAtOneBtc) * t;
            }
            rowFloor[row] = static_cast<uint8_t>(truncate<int>(0, static_cast<int>(floorIdx + 0.5), 255));
        }
        return rowFloor;
    }

    [[nodiscard]] static auto aliveKey(uint32_t creationHeight, size_t pixelY) -> uint64_t {
        return (static_cast<uint64_t>(creationHeight) << 16U)
            | (static_cast<uint64_t>(pixelY) & LEDGER_Y_MASK);
    }

    // Epoch compression needs the exact set of still-unspent creation points.
    // Density alone is not reversible after several creation columns merge.
    void updateAliveLedger(uint32_t creationHeight, size_t pixelY, int64_t amount) {
        if (!mSatoshiBlockheightToPixel.useEpochCompression()) {
            return;
        }

        auto const key = aliveKey(creationHeight, pixelY);
        if (amount > 0) {
            auto [it, inserted] = m_alive.emplace(key, 1U);
            if (!inserted) {
                ++it->second;
            }
            return;
        }

        auto it = m_alive.find(key);
        if (it == m_alive.end()) {
            ++m_ledger_misses;
            return;
        }
        if (--it->second == 0) {
            m_alive.erase(it);
        }
    }

    // Apply +1/-1 to a density cell. Density is stored as double so resampling can
    // preserve fractional mass; a spend removes up to 1.0, clamped at 0.
    void applyDelta(double& cell, int64_t amount) {
        if (amount >= 0) {
            cell += 1.0;
            return;
        }
        if (cell >= 1.0) {
            cell -= 1.0;
            return;
        }
        if (cell > 0.0) {
            cell = 0.0;
            return;
        }
        ++m_dropped_decrements;
    }

    // Resample all density data for continuous log mode
    // This is called every N blocks to smoothly compress older data
    void resampleForContinuousLog(uint32_t oldTotalBlocks, uint32_t newTotalBlocks) {
        // Only log occasionally to avoid spam
        if (newTotalBlocks % 1000 == 0) {
            LOG("Continuous log resample at block {} (old={}, new={})",
                newTotalBlocks, oldTotalBlocks, newTotalBlocks);
        }

        size_t graphWidth = mSatoshiBlockheightToPixel.getPixelWidth();
        size_t graphHeight = mSatoshiBlockheightToPixel.getPixelHeight();
        auto const& rect = mSatoshiBlockheightToPixel.getRect();

        // Create buffers for new density and merge counts (for averaging)
        std::vector<double> newData(mCfg.imageWidth * mCfg.imageHeight, 0.0);
        std::vector<size_t> mergeCounts(mCfg.imageWidth * mCfg.imageHeight, 0);

        // For each pixel in old buffer, calculate its new position
        for (size_t y = rect.y; y < rect.y + graphHeight; ++y) {
            for (size_t oldX = rect.x; oldX < rect.x + graphWidth; ++oldX) {
                size_t oldIdx = y * mCfg.imageWidth + oldX;
                if (m_data[oldIdx] == 0) continue;

                // Convert old pixel X to approximate blockHeight using old total
                uint32_t blockHeight = pixelToBlockHeightContinuousLog(oldX - rect.x, oldTotalBlocks);

                // Only process blocks that exist
                if (blockHeight >= m_current_block_height) continue;

                // Calculate new pixel X under new total blocks
                size_t newX = rect.x + mSatoshiBlockheightToPixel.blockheightToPixelWidthContinuousLog(blockHeight, newTotalBlocks);
                if (newX >= rect.x + graphWidth) {
                    newX = rect.x + graphWidth - 1;
                }
                size_t newIdx = y * mCfg.imageWidth + newX;

                // Accumulate density at new position
                newData[newIdx] += m_data[oldIdx];
                mergeCounts[newIdx]++;
            }
        }

        // Compute averages where multiple pixels merged (prevents color blowup)
        for (size_t i = 0; i < newData.size(); ++i) {
            if (mergeCounts[i] > 1) {
                newData[i] = newData[i] / static_cast<double>(mergeCounts[i]);
            }
        }

        // Replace old data with new
        m_data = std::move(newData);

        // Regenerate the image from the resampled density data
        regenerateImageFromDensity();

        // Clear pixel history since positions have changed
        m_pixel_set_with_history.clear();

        // Reset caching
        m_last_data = nullptr;
        m_prev_block_height = -1;
        m_prev_amount = -1;
    }

    // Convert pixel X back to approximate block height for continuous log mode
    [[nodiscard]] auto pixelToBlockHeightContinuousLog(size_t pixelX, uint32_t totalBlocks) const -> uint32_t {
        if (totalBlocks <= 1) return 0;

        double pixelWidth = static_cast<double>(mSatoshiBlockheightToPixel.getPixelWidth());
        double k = mSatoshiBlockheightToPixel.getLogCompressionFactor();

        // Forward mapping: x = ((h+1)/N)^k * W
        // Inverse: h = N * (x/W)^(1/k) - 1
        double xNorm = static_cast<double>(pixelX) / pixelWidth;
        double t = std::pow(xNorm, 1.0 / k);
        uint32_t blockHeight = static_cast<uint32_t>(t * totalBlocks);

        if (blockHeight > 0) blockHeight--;  // Adjust for the +1 in forward mapping
        if (blockHeight >= totalBlocks) blockHeight = totalBlocks - 1;

        return blockHeight;
    }

    // Rebuild all epoch-compressed density from the exact alive-coin ledger. A density
    // column cannot be redistributed exactly after multiple creation heights merge:
    // later spends still point to one precise creation height. Replaying the ledger
    // through the same forward mapping as change() keeps additions and spends aligned.
    void resampleForNewEpoch(uint32_t newEpoch) {
        uint32_t oldEpoch = mSatoshiBlockheightToPixel.getCurrentEpoch();
        LOG("Resampling for epoch transition: {} -> {}", oldEpoch, newEpoch);

        size_t graphHeight = mSatoshiBlockheightToPixel.getPixelHeight();
        auto const& rect = mSatoshiBlockheightToPixel.getRect();

        mSatoshiBlockheightToPixel.setCurrentEpoch(newEpoch);

        for (size_t y = rect.y; y < rect.y + graphHeight; ++y) {
            auto first = m_data.begin() + static_cast<std::ptrdiff_t>(y * mCfg.imageWidth + rect.x);
            std::fill_n(first, rect.w, 0.0);
        }

        uint64_t aliveCoins = 0;
        for (auto const& [key, count] : m_alive) {
            auto const creationHeight = static_cast<uint32_t>(key >> 16U);
            auto const pixelY = static_cast<size_t>(key & LEDGER_Y_MASK);
            auto const pixelX = mSatoshiBlockheightToPixel.blockheightToPixelWidth(creationHeight);
            m_data[pixelY * mCfg.imageWidth + pixelX] += static_cast<double>(count);
            aliveCoins += count;
        }

        regenerateImageFromDensity();
        m_pixel_set_with_history.clear();
        m_last_data = nullptr;
        m_prev_block_height = -1;
        m_prev_amount = -1;

        LOG("Exact epoch rebuild complete for epoch {}: {} ledger entries, {} alive coins",
            newEpoch, m_alive.size(), aliveCoins);
    }

    // Regenerate the entire image from the density data
    void regenerateImageFromDensity() {
        for (size_t i = 0; i < m_data.size(); ++i) {
            m_density_to_image.update(i, m_data[i]);
        }
    }

    // Draw UTXO flow lines to the right of the current block position
    // Saves affected pixels to flowLinePixels for later restoration
    void drawUtxoFlowLines(uint32_t block_height,
                           std::vector<std::pair<size_t, std::array<uint8_t, 3>>>& flowLinePixels) {
        flowLinePixels.clear();

        // Get the current block's X position
        size_t currentX = mSatoshiBlockheightToPixel.blockheightToPixelWidth(block_height);
        auto const& rect = mSatoshiBlockheightToPixel.getRect();

        // Starting X position for flow lines (after 60px gap)
        size_t flowStartX = rect.x + currentX + FLOW_GAP_PIXELS;

        // Don't draw if we're off-screen
        if (flowStartX >= mCfg.imageWidth) {
            return;
        }

        // Flow line color (orange for visibility, contrasts with cyan BTC legend)
        static constexpr uint8_t flowColor[3] = {255, 140, 0};

        // For each Y position with UTXO activity in the last 10 blocks
        for (auto const& [y_pos, block_counts] : m_utxo_flow_per_y) {
            // Sum up all UTXOs at this Y level in the window
            size_t totalCount = 0;
            for (auto const& [bh, count] : block_counts) {
                totalCount += count;
            }

            if (totalCount == 0) continue;

            // Draw a horizontal line of length = totalCount pixels
            // Starting at flowStartX, extending to the right
            size_t lineEndX = flowStartX + totalCount;
            if (lineEndX > mCfg.imageWidth) {
                lineEndX = mCfg.imageWidth;
            }

            // Draw the line at this Y position
            for (size_t x = flowStartX; x < lineEndX; ++x) {
                size_t pixel_idx = y_pos * mCfg.imageWidth + x;
                if (pixel_idx < mCfg.imageWidth * mCfg.imageHeight) {
                    // Save the original pixel color
                    uint8_t* rgb = m_density_to_image.rgb(pixel_idx);
                    flowLinePixels.push_back({pixel_idx, {rgb[0], rgb[1], rgb[2]}});
                    // Draw the flow line pixel
                    m_density_to_image.rgb(pixel_idx, flowColor);
                }
            }
        }
    }

    Cfg const mCfg;
    mutable SatoshiBlockheightToPixel mSatoshiBlockheightToPixel;  // mutable for epoch updates
    // Double remains necessary for the legacy continuous-log resampler. Epoch modes
    // rebuild integer counts exactly from m_alive.
    std::vector<double> m_data;
    double* m_last_data;
    size_t m_dropped_decrements{};
    robin_hood::unordered_flat_map<uint64_t, uint32_t> m_alive;
    size_t m_ledger_misses{};
    size_t mPixelX{};
    size_t mPixelY{};
    PixelSetWithHistory m_pixel_set_with_history;
    PixelSet m_current_block_pixels;
    DensityToImage m_density_to_image;
    uint32_t m_current_block_height;

    uint32_t m_prev_block_height;
    int64_t m_prev_amount;

    // UTXO Flow Lines feature: track UTXO creations per satoshi level (Y position) for last 10 blocks
    static constexpr size_t FLOW_WINDOW_BLOCKS = 10;
    static constexpr size_t FLOW_GAP_PIXELS = 15;

    // For each Y pixel position, store a deque of (block_height, count) pairs
    // This tracks how many UTXOs were created at each satoshi level per block
    std::unordered_map<size_t, std::deque<std::pair<uint32_t, size_t>>> m_utxo_flow_per_y;

    // Current block's UTXO creation counts per Y position (accumulated during change() calls)
    std::unordered_map<size_t, size_t> m_current_block_utxo_counts;
};

} // namespace buv

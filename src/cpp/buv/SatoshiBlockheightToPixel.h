#pragma once

#include <app/Cfg.h>
#include <buv/LinearFunction.h>
#include <buv/truncate.h>
#include <util/log.h>

#include <algorithm>
#include <cmath>

namespace buv {

class SatoshiBlockheightToPixel {
    LinearFunction mFnSatoshi;
    LinearFunction mFnBlock;
    Rect<size_t> mRect{};
    Cfg const& mCfg;

    // Epoch-based compression settings
    std::string mXAxisMode{"linear"};
    uint32_t mEpochBlocks{25000};
    uint32_t mCurrentEpoch{0};
    double mPixelWidth{0};
    double mEpochRatio{0.5};  // Geometric series ratio

    // Smooth epoch transition (normalizedGeometric only). While active, the
    // layout is a smoothstep blend between the layout for mTransitionFrom and
    // the layout for mCurrentEpoch. t == 1 (or inactive) is exactly the plain
    // mCurrentEpoch layout, so the end state of a slide equals a hard cut.
    bool mTransitionActive{false};
    uint32_t mTransitionFrom{0};
    double mTransitionEase{1.0};  // smoothstep(t), cached

    // Continuous log mode settings
    double mLogCompressionFactor{4.85};   // Power-law exponent k: x = (h/N)^k
    uint32_t mResampleEveryNBlocks{100};  // Resample every N blocks
    uint32_t mTotalBlocks{1};             // Current total blocks (updated dynamically)
    uint32_t mLastResampleBlock{0};       // Block at last resample

    // Y-axis compression settings
    bool mCompressLowSatoshi{false};
    bool mCompressTopSatoshi{false};

public:
    inline explicit SatoshiBlockheightToPixel(Cfg const& cfg, uint32_t numBlocks)
        : mFnSatoshi(std::log(static_cast<double>(cfg.maxSatoshi)),
                     0,
                     std::log(static_cast<double>(cfg.minSatoshi)),
                     static_cast<double>(cfg.graphRect.h))
        , mFnBlock(0, 0, static_cast<double>(numBlocks - 1), static_cast<double>(cfg.graphRect.w))
        , mRect(cfg.graphRect)
        , mCfg(cfg)
        , mXAxisMode(cfg.xAxisMode)
        , mEpochBlocks(cfg.epochBlocks)
        , mCurrentEpoch(0)
        , mPixelWidth(static_cast<double>(cfg.graphRect.w))
        , mEpochRatio(cfg.epochRatio)
        , mLogCompressionFactor(cfg.logCompressionFactor)
        , mResampleEveryNBlocks(cfg.resampleEveryNBlocks)
        , mTotalBlocks(numBlocks)
        , mLastResampleBlock(0)
        , mCompressLowSatoshi(cfg.compressLowSatoshi)
        , mCompressTopSatoshi(cfg.compressTopSatoshi) {

        // The slim 10kBTC-100kBTC top band needs the three-zone mapping (which
        // builds on the compressed low zone) and an axis that actually reaches
        // 100 kBTC. Fall back to the legacy behavior otherwise.
        if (mCompressTopSatoshi && (!mCompressLowSatoshi || cfg.maxSatoshi < 10'000'000'000'000LL)) {
            LOG("WARNING: compressTopSatoshi requires compressLowSatoshi=true and maxSatoshi >= 1e13; disabling top band");
            mCompressTopSatoshi = false;
        }

        // For continuous log mode, start with mTotalBlocks = 1 so blocks expand to fill screen
        // initially, then compress left as more blocks are added
        if (mXAxisMode == "continuousLog") {
            mTotalBlocks = 1;
            mLastResampleBlock = 0;
        }

        LOG("Satoshi from {}-{} -> {}-{}", cfg.maxSatoshi, cfg.minSatoshi, 0.0, static_cast<double>(cfg.graphRect.h));
        LOG("Height from {}-{} -> {}-{}", 0, numBlocks - 1, 0, static_cast<double>(cfg.graphRect.w));
        if (mXAxisMode == "continuousLog") {
            LOG("X-axis mode: continuousLog, compressionFactor={}, resampleEvery={} blocks",
                mLogCompressionFactor, mResampleEveryNBlocks);
        } else {
            LOG("X-axis mode: {}, epochBlocks={}, currentEpochWidth={}%", mXAxisMode, mEpochBlocks, mEpochRatio * 100);
        }
        if (mCompressLowSatoshi) {
            LOG("Y-axis compression enabled: 1-100 sat range compressed to 1/3 height");
        }
        if (mCompressTopSatoshi) {
            LOG("Y-axis top band enabled: 10kBTC-100kBTC compressed to 15% of a decade");
        }
    }

    [[nodiscard]] inline auto satoshiToPixelHeight(int64_t satoshi) const -> size_t {
        auto const famount = satoshi >= 0 ? satoshi : -satoshi;

        if (!mCompressLowSatoshi) {
            // Original linear log scale
            return mRect.y + truncate<size_t>(0, static_cast<size_t>(mFnSatoshi(std::log(famount))), mRect.h - 1);
        }

        if (mCompressTopSatoshi) {
            // Three-zone mapping (top of screen first):
            //   top:  1e12 - 1e13 sat (10kBTC-100kBTC), 15% of a normal decade
            //   mid:  100 sat - 1e12, log-linear, fills the remainder
            //   low:  1 - 100 sat, compressed to 1/3 (existing rule)
            // Amounts >= 1e13 truncate to y = 0: the 100 kBTC line doubles as
            // the ">= 100 kBTC" line.
            double const logValue = std::log(static_cast<double>(famount));
            double const log100 = std::log(100.0);
            double const logTop = std::log(1e12);   // 10 kBTC
            double const logMax = std::log(1e13);   // 100 kBTC
            double const totalHeight = static_cast<double>(mRect.h);

            // Low zone keeps the 1/3 rule against the 13-decade total.
            double const lowHeight = ((log100 / logMax) * totalHeight) / 3.0;
            // Remainder splits as 10 decade-units (mid) + 0.15 decade-units (top).
            double const decadeUnit = (totalHeight - lowHeight) / 10.15;
            double const midHeight = 10.0 * decadeUnit;
            double const topHeight = 0.15 * decadeUnit;

            double pixelY;
            if (logValue >= logMax) {
                pixelY = 0.0;
            } else if (logValue >= logTop) {
                double const t = (logValue - logTop) / (logMax - logTop);
                pixelY = topHeight * (1.0 - t);
            } else if (logValue > log100) {
                double const t = (logValue - log100) / (logTop - log100);
                pixelY = topHeight + midHeight * (1.0 - t);
            } else {
                double const t = logValue / log100; // log(1) == 0
                pixelY = totalHeight - lowHeight * t;
            }
            return mRect.y + truncate<size_t>(0, static_cast<size_t>(pixelY), mRect.h - 1);
        }

        // Compressed Y-axis: 1-100 sat takes 1/3 of normal space (redistributed to higher values)
        // Screen coords: Y=0 is TOP (high satoshi), Y=height is BOTTOM (low satoshi)
        double logValue = std::log(static_cast<double>(famount));
        double logMin = std::log(1.0);        // log(1 sat) = 0
        double log100 = std::log(100.0);      // log(100 sat) ≈ 4.6
        double logMax = std::log(static_cast<double>(mCfg.maxSatoshi));

        // Total height in pixels
        double totalHeight = static_cast<double>(mRect.h);

        // Normal log range: logMax - logMin (total decades)
        // 1-100 sat = 2 decades, normally would get 2/(total decades) of height
        // With 1/3 compression: 1-100 sat gets (2/3) * normal = about 4.7% of height
        double totalLogRange = logMax - logMin;
        double lowLogRange = log100 - logMin;  // 2 decades (1-100 sat)
        double highLogRange = logMax - log100; // Remaining decades (100+ sat)

        // Compression factor: 1/3 means low range gets 1/3 of what it normally would
        double compressionFactor = 1.0 / 3.0;

        // Calculate pixel heights
        double normalLowHeight = (lowLogRange / totalLogRange) * totalHeight;
        double compressedLowHeight = normalLowHeight * compressionFactor;
        double expandedHighHeight = totalHeight - compressedLowHeight;

        double pixelY;
        if (logValue <= log100) {
            // 1-100 sat: compressed region at BOTTOM of screen (high Y values)
            // t=0 at 1 sat (should be at bottom, Y = totalHeight)
            // t=1 at 100 sat (should be at top of compressed region)
            double t = (logValue - logMin) / lowLogRange;
            pixelY = totalHeight - compressedLowHeight * t;
        } else {
            // 100+ sat: expanded region at TOP of screen (low Y values)
            // t=0 at 100 sat (should be at bottom of this region, just above compressed)
            // t=1 at maxSatoshi (should be at Y = 0, top of screen)
            double t = (logValue - log100) / highLogRange;
            pixelY = expandedHighHeight * (1.0 - t);
        }

        return mRect.y + truncate<size_t>(0, static_cast<size_t>(pixelY), mRect.h - 1);
    }

    [[nodiscard]] inline auto blockheightToPixelWidth(uint32_t blockHeight) const -> size_t {
        if (mXAxisMode == "linear") {
            // Original linear behavior
            auto pixel_x = static_cast<size_t>(mFnBlock(blockHeight));
            if (pixel_x > mRect.w - 1) {
                pixel_x = mRect.w - 1;
            }
            return mRect.x + pixel_x;
        }

        if (mXAxisMode == "continuousLog") {
            // Continuous logarithmic compression (power-law)
            return mRect.x + blockheightToPixelWidthContinuousLog(blockHeight, mTotalBlocks);
        }

        if (mXAxisMode == "normalizedGeometric") {
            // Normalized geometric distribution (blended during a transition)
            if (mTransitionActive) {
                auto const xOld = blockheightToPixelWidthNormalizedDouble(blockHeight, mTransitionFrom);
                auto const xNew = blockheightToPixelWidthNormalizedDouble(blockHeight, mCurrentEpoch);
                auto const x = xOld + (xNew - xOld) * mTransitionEase;
                auto pixel_x = static_cast<size_t>(x);
                if (pixel_x > mRect.w - 1) {
                    pixel_x = mRect.w - 1;
                }
                return mRect.x + pixel_x;
            }
            return mRect.x + blockheightToPixelWidthNormalized(blockHeight, mCurrentEpoch);
        }

        // Epoch-based logarithmic mapping (epochLog mode)
        return mRect.x + blockheightToPixelWidthEpochLog(blockHeight, mCurrentEpoch);
    }

    // Continuous logarithmic compression using power-law: x = (h/N)^k * W
    // This gives smooth compression where older blocks (smaller h) get less space
    // k = logCompressionFactor controls intensity (higher = more compression of old)
    [[nodiscard]] inline auto blockheightToPixelWidthContinuousLog(uint32_t blockHeight, uint32_t totalBlocks) const -> size_t {
        if (totalBlocks <= 1) {
            return 0;
        }

        // Normalize block height to range [0, 1]
        // Use blockHeight+1 to avoid log(0) issues and ensure block 0 gets some space
        double t = static_cast<double>(blockHeight + 1) / static_cast<double>(totalBlocks);

        // Apply power-law compression: x = t^k
        // Higher k = more compression of older blocks
        double x = std::pow(t, mLogCompressionFactor);

        // Scale to pixel width
        auto pixel_x = static_cast<size_t>(x * mPixelWidth);
        if (pixel_x > mRect.w - 1) {
            pixel_x = mRect.w - 1;
        }
        return pixel_x;
    }

    // Calculate pixel X for a blockHeight given a specific epoch context
    // This is used both for normal rendering and for resampling during epoch transitions
    [[nodiscard]] inline auto blockheightToPixelWidthEpochLog(uint32_t blockHeight, uint32_t currentEpoch) const -> size_t {
        uint32_t blockEpoch = blockHeight / mEpochBlocks;

        // Calculate epoch start X and width
        double epochStartX = getEpochStartX(blockEpoch, currentEpoch);
        double epochWidth = getEpochWidth(blockEpoch, currentEpoch);

        // Position within epoch (0.0 to 1.0)
        double posInEpoch = static_cast<double>(blockHeight % mEpochBlocks) / static_cast<double>(mEpochBlocks);

        auto pixel_x = static_cast<size_t>(epochStartX + posInEpoch * epochWidth);
        if (pixel_x > mRect.w - 1) {
            pixel_x = mRect.w - 1;
        }
        return pixel_x;
    }

    // Normalized Geometric Distribution with fixed current epoch percentage
    // epochRatio = percentage of screen for current epoch (e.g., 0.33 = 33%)
    // Remaining (1 - epochRatio) is distributed among older epochs with halving
    [[nodiscard]] inline auto blockheightToPixelWidthNormalized(uint32_t blockHeight, uint32_t currentEpoch) const -> size_t {
        uint32_t blockEpoch = blockHeight / mEpochBlocks;

        double epochStartX = getEpochStartXNormalized(blockEpoch, currentEpoch);
        double epochWidth = getEpochWidthNormalized(blockEpoch, currentEpoch);

        // Position within epoch (0.0 to 1.0)
        double posInEpoch = static_cast<double>(blockHeight % mEpochBlocks) / static_cast<double>(mEpochBlocks);

        auto pixel_x = static_cast<size_t>(epochStartX + posInEpoch * epochWidth);
        if (pixel_x > mRect.w - 1) {
            pixel_x = mRect.w - 1;
        }
        return pixel_x;
    }

    // Double-precision version for resampling - preserves sub-pixel accuracy
    // Used during epoch transitions to avoid banding artifacts from integer truncation
    [[nodiscard]] inline auto blockheightToPixelWidthNormalizedDouble(uint32_t blockHeight, uint32_t currentEpoch) const -> double {
        uint32_t blockEpoch = blockHeight / mEpochBlocks;

        double epochStartX = getEpochStartXNormalized(blockEpoch, currentEpoch);
        double epochWidth = getEpochWidthNormalized(blockEpoch, currentEpoch);

        // Position within epoch (0.0 to 1.0) with full precision
        double posInEpoch = static_cast<double>(blockHeight % mEpochBlocks) / static_cast<double>(mEpochBlocks);

        double pixel_x = epochStartX + posInEpoch * epochWidth;
        if (pixel_x > mRect.w - 1) {
            pixel_x = mRect.w - 1;
        }
        return pixel_x;
    }

    // Get width of a specific epoch using fixed current epoch percentage
    // Current epoch gets epochRatio (e.g., 33%) of screen
    // Older epochs share remaining (1 - epochRatio) with halving distribution
    // BUT: No compression until epochs exceed available space!
    [[nodiscard]] inline auto getEpochWidthNormalized(uint32_t epoch, uint32_t currentEpoch) const -> double {
        if (epoch > currentEpoch) {
            return 0.0;  // Future epochs have no width
        }

        uint32_t numEpochs = currentEpoch + 1;
        double totalNeededSpace = numEpochs * mEpochRatio;

        // If all epochs fit without compression, each gets its full allocation
        if (totalNeededSpace <= 1.0) {
            return mPixelWidth * mEpochRatio;
        }

        // Compression needed: current epoch gets epochRatio, older epochs share the rest
        double currentEpochWidth = mPixelWidth * mEpochRatio;

        if (epoch == currentEpoch) {
            return currentEpochWidth;
        }

        // Older epochs share the remaining space with halving
        double olderEpochsSpace = mPixelWidth * (1.0 - mEpochRatio);

        // Calculate geometric series sum for normalization
        // Each older epoch gets half the width of the next newer one
        // So epoch (current-1) gets base, (current-2) gets base/2, etc.
        uint32_t numOlderEpochs = currentEpoch;
        if (numOlderEpochs == 0) {
            return 0.0;
        }

        // Sum of geometric series: 1 + 0.5 + 0.25 + ... = 2 * (1 - 0.5^N)
        double geoSum = 2.0 * (1.0 - std::pow(0.5, static_cast<double>(numOlderEpochs)));

        // Base width (for epoch current-1, the newest of the older epochs)
        double baseWidth = olderEpochsSpace / geoSum;

        // Distance from current epoch (1 = newest older, 2 = next older, etc.)
        uint32_t distFromCurrent = currentEpoch - epoch;

        // Width halves for each step back
        double width = baseWidth * std::pow(0.5, static_cast<double>(distFromCurrent - 1));

        return width;
    }

    // Get start X position of a specific epoch using normalized geometric distribution
    [[nodiscard]] inline auto getEpochStartXNormalized(uint32_t epoch, uint32_t currentEpoch) const -> double {
        if (epoch > currentEpoch) {
            return mPixelWidth;  // Future epochs off screen
        }

        uint32_t numEpochs = currentEpoch + 1;
        double totalNeededSpace = numEpochs * mEpochRatio;

        // If all epochs fit without compression, simple linear positioning
        if (totalNeededSpace <= 1.0) {
            return epoch * mPixelWidth * mEpochRatio;
        }

        // Compression needed: sum widths of all epochs before this one
        double startX = 0.0;
        for (uint32_t e = 0; e < epoch; ++e) {
            startX += getEpochWidthNormalized(e, currentEpoch);
        }
        return startX;
    }

    // Get the pixel X position where an epoch starts
    [[nodiscard]] inline auto getEpochStartX(uint32_t epoch, uint32_t currentEpoch) const -> double {
        if (epoch > currentEpoch) {
            return mPixelWidth;  // Future epochs off screen
        }
        if (epoch == currentEpoch) {
            // Current epoch starts at 50% of screen
            return mPixelWidth * 0.5;
        }

        // Older epochs: calculate cumulative start position
        // Each older epoch gets half the width of the next newer epoch
        // Epoch N-1 gets 25%, N-2 gets 12.5%, etc.
        double startX = 0.0;
        for (uint32_t e = 0; e < epoch; ++e) {
            startX += getEpochWidth(e, currentEpoch);
        }
        return startX;
    }

    // Get the pixel width allocated to an epoch
    [[nodiscard]] inline auto getEpochWidth(uint32_t epoch, uint32_t currentEpoch) const -> double {
        if (epoch > currentEpoch) {
            return 0.0;  // Future epochs have no width
        }
        if (epoch == currentEpoch) {
            // Current epoch gets 50% of screen
            return mPixelWidth * 0.5;
        }

        // Older epochs: halve width for each epoch further back
        // Current = 50%, Previous = 25%, Before that = 12.5%, etc.
        double width = mPixelWidth * 0.5;  // Start with current epoch's width
        for (uint32_t i = currentEpoch; i > epoch; --i) {
            width *= 0.5;
        }

        // But we need to distribute the left 50% among all older epochs
        // Total left half = sum of geometric series: 0.25 + 0.125 + 0.0625 + ... = 0.5 (approaches)
        // For finite epochs, we need to scale to fit
        if (currentEpoch > 0) {
            // Calculate total width needed for all older epochs
            double totalOlderWidth = 0.0;
            for (uint32_t e = 0; e < currentEpoch; ++e) {
                double w = mPixelWidth * 0.5;
                for (uint32_t i = currentEpoch; i > e; --i) {
                    w *= 0.5;
                }
                totalOlderWidth += w;
            }
            // Scale to fit in left 50%
            double scale = (mPixelWidth * 0.5) / totalOlderWidth;
            width *= scale;
        }

        return width;
    }

    // Update the current epoch (called when epoch transitions)
    inline void setCurrentEpoch(uint32_t epoch) {
        if (epoch != mCurrentEpoch) {
            LOG("Epoch transition: {} -> {}", mCurrentEpoch, epoch);
            mCurrentEpoch = epoch;
        }
        mTransitionActive = false;
        mTransitionEase = 1.0;
    }

    // Put the mapper mid-slide between two epoch layouts. t in [0,1] is the
    // linear progress; the blend uses smoothstep(t) so both ends are gentle.
    // Only normalizedGeometric blends; other modes ignore the transition state
    // and simply adopt toEpoch.
    inline void setEpochTransition(uint32_t fromEpoch, uint32_t toEpoch, double t) {
        if (mCurrentEpoch != toEpoch) {
            LOG("Epoch transition: {} -> {}", mCurrentEpoch, toEpoch);
            mCurrentEpoch = toEpoch;
        }
        if (mXAxisMode != "normalizedGeometric" || t >= 1.0) {
            mTransitionActive = false;
            mTransitionEase = 1.0;
            return;
        }
        t = std::max(0.0, t);
        mTransitionActive = true;
        mTransitionFrom = fromEpoch;
        mTransitionEase = t * t * (3.0 - 2.0 * t);
    }

    [[nodiscard]] inline auto transitionActive() const -> bool { return mTransitionActive; }
    [[nodiscard]] inline auto transitionFrom() const -> uint32_t { return mTransitionFrom; }
    // Returns the linear progress t (inverse of the cached smoothstep) only for
    // syncing another mapper; callers should copy state via copyTransitionFrom.
    inline void copyTransitionFrom(SatoshiBlockheightToPixel const& other) {
        mCurrentEpoch = other.mCurrentEpoch;
        mTransitionActive = other.mTransitionActive;
        mTransitionFrom = other.mTransitionFrom;
        mTransitionEase = other.mTransitionEase;
    }

    [[nodiscard]] inline auto getCurrentEpoch() const -> uint32_t {
        return mCurrentEpoch;
    }

    [[nodiscard]] inline auto getEpochBlocks() const -> uint32_t {
        return mEpochBlocks;
    }

    [[nodiscard]] inline auto useEpochCompression() const -> bool {
        return mXAxisMode == "epochLog" || mXAxisMode == "normalizedGeometric";
    }

    [[nodiscard]] inline auto useContinuousLogCompression() const -> bool {
        return mXAxisMode == "continuousLog";
    }

    // Update total blocks for continuous log mode
    // Returns true if resampling is needed
    inline auto setTotalBlocks(uint32_t totalBlocks) -> bool {
        mTotalBlocks = totalBlocks;

        // Check if we need to resample
        if (mXAxisMode == "continuousLog") {
            if (totalBlocks - mLastResampleBlock >= mResampleEveryNBlocks) {
                mLastResampleBlock = totalBlocks;
                return true;  // Trigger resample
            }
        }
        return false;
    }

    [[nodiscard]] inline auto getTotalBlocks() const -> uint32_t {
        return mTotalBlocks;
    }

    [[nodiscard]] inline auto getResampleEveryNBlocks() const -> uint32_t {
        return mResampleEveryNBlocks;
    }

    [[nodiscard]] inline auto getLogCompressionFactor() const -> double {
        return mLogCompressionFactor;
    }

    [[nodiscard]] inline auto getXAxisMode() const -> std::string const& {
        return mXAxisMode;
    }

    [[nodiscard]] inline auto getPixelWidth() const -> size_t {
        return mRect.w;
    }

    [[nodiscard]] inline auto getPixelHeight() const -> size_t {
        return mRect.h;
    }

    [[nodiscard]] inline auto getRect() const -> Rect<size_t> const& {
        return mRect;
    }
};

} // namespace buv

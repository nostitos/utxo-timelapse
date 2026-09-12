#pragma once

#include <buv/ColorMap.h>
#include <buv/LinearFunction.h>
#include <buv/truncate.h>
#include <util/log.h>

#include <array>
#include <cmath>
#include <cstdint>
#include <optional>
#include <ostream>
#include <stdexcept>
#include <utility>
#include <vector>

namespace buv {

// maps density data to image data. It does so continously, so we don't have to iterate
// the whole density map each time we want to extract the image.
class DensityToImage {
    // density 1 should map to 0, NEVER below 0.
    [[nodiscard]] static auto scaleDensityToColor(double density) -> double {
        // log scales not so well, because for small numbers it has huge color jumps
        // return std::log(density);
        // return std::tanh(2.0 * (static_cast<double>(density) - 1.0) / m_max_included_value);
        // return std::pow(density, 1 / 3.0);

        return std::log(density + 30);
    }

public:
    // initialize with background color
    // calculates the factor so that max_value is the last integer value that mapps to 255.
    DensityToImage(
        size_t width, size_t height, size_t max_included_value, ColorMap colormap, std::array<uint8_t, 3> colorBackground)
        : m_colormap(std::move(colormap))
        , m_rgb(3 * width * height, 0)
        , mDensityScaler(scaleDensityToColor(1), 0, scaleDensityToColor(max_included_value), 255)
        , m_max_included_value(max_included_value)
        , mWidth(width)
        , mHeight(height)
        , mColorBackground(colorBackground) {

        LOG("Creating density image {}x{}", width, height);
        // fill with lowest colormap's value
        for (size_t i = 0; i < width * height; ++i) {
            rgb(i, mColorBackground.data());
        }
    }

    void update(size_t pixel_idx, double density) {
        // static constexpr auto black = std::array<uint8_t, 3>();
        uint8_t const* rgb_source = nullptr;
        auto const& colormap = colorMapForPixel(pixel_idx);
        if (density <= 0.0) {
            rgb_source = mColorBackground.data();
        } else if (density >= static_cast<double>(m_max_included_value)) {
            rgb_source = colormap.rgb(255);
        } else {
            auto val = mDensityScaler(scaleDensityToColor(density));
            auto colIdx = truncate<int>(0, val, 255);
            if (!mRowColorFloor.empty()) {
                auto const row = pixel_idx / mWidth;
                auto const floorIdx = static_cast<int>(mRowColorFloor[row]);
                if (colIdx < floorIdx) {
                    colIdx = floorIdx;
                }
            }
            rgb_source = colormap.rgb(colIdx);
        }
        rgb(pixel_idx, rgb_source);
    }

    // Use an alternate colormap for one contiguous range of image rows. Density
    // scaling is shared, so palettes that have identical low entries transition
    // without a visible amount-boundary seam.
    void setRowColorMapOverride(ColorMap colormap, size_t firstRow, size_t lastRowInclusive) {
        if (firstRow > lastRowInclusive || lastRowInclusive >= mHeight) {
            throw std::out_of_range("DensityToImage row colormap override is outside the image");
        }
        mRowColorMapOverride = std::move(colormap);
        mOverrideFirstRow = firstRow;
        mOverrideLastRow = lastRowInclusive;
    }

    // Optional per-row minimum color index ("amount color floor"). When set, any
    // occupied pixel in row r renders at least at colormap index rowFloor[r], so
    // sparse high-amount rows stay visible. Empty vector disables the feature.
    void setRowColorFloor(std::vector<uint8_t> rowFloor) {
        mRowColorFloor = std::move(rowFloor);
    }

    void rgb(size_t pixel_idx, uint8_t const* rgb_data) {
        m_rgb[pixel_idx * 3] = rgb_data[0];
        m_rgb[pixel_idx * 3 + 1] = rgb_data[1];
        m_rgb[pixel_idx * 3 + 2] = rgb_data[2];
    }

    auto rgb(size_t pixel_idx) -> uint8_t* {
        return m_rgb.data() + (pixel_idx * 3);
    }

    [[nodiscard]] auto data() const -> uint8_t const* {
        return m_rgb.data();
    }

    // size in bytes
    [[nodiscard]] auto size() const -> size_t {
        return m_rgb.size();
    }

    [[nodiscard]] auto width() const -> size_t {
        return mWidth;
    }

    [[nodiscard]] auto height() const -> size_t {
        return mHeight;
    }

private:
    friend auto operator<<(std::ostream&, DensityToImage const&) -> std::ostream&;

    [[nodiscard]] auto colorMapForPixel(size_t pixel_idx) const -> ColorMap const& {
        auto const row = pixel_idx / mWidth;
        if (mRowColorMapOverride && row >= mOverrideFirstRow && row <= mOverrideLastRow) {
            return *mRowColorMapOverride;
        }
        return m_colormap;
    }

    ColorMap const m_colormap;
    std::optional<ColorMap> mRowColorMapOverride{};
    size_t mOverrideFirstRow{};
    size_t mOverrideLastRow{};
    std::vector<uint8_t> m_rgb;
    std::vector<uint8_t> mRowColorFloor{};
    LinearFunction mDensityScaler;
    size_t const m_max_included_value;
    size_t mWidth{};
    size_t mHeight{};
    std::array<uint8_t, 3> mColorBackground{};
};

inline auto operator<<(std::ostream& os, DensityToImage const& dti) -> std::ostream& {
    os.write(reinterpret_cast<const char*>(dti.m_rgb.data()), dti.m_rgb.size());
    return os;
}

} // namespace buv

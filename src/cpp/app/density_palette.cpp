#include <app/Cfg.h>
#include <buv/ColorMap.h>
#include <buv/Density.h>
#include <buv/DensityToImage.h>
#include <buv/SatoshiBlockheightToPixel.h>

#include <array>
#include <cstdint>

#include <doctest.h>

namespace {

void checkRgb(uint8_t const* actual, std::array<uint8_t, 3> const& expected) {
    CHECK(actual[0] == expected[0]);
    CHECK(actual[1] == expected[1]);
    CHECK(actual[2] == expected[2]);
}

} // namespace

TEST_CASE("density_palette" * doctest::skip()) {
    auto turbo = buv::ColorMap::create("turbo");
    auto whiteHot = turbo;
    whiteHot.applyWhiteHotTail();

    // The two palettes are byte-identical through the shared pivot. This is the
    // seam-prevention invariant for ordinary densities around the amount split.
    for (int idx = 0; idx <= buv::ColorMap::WHITE_HOT_START_INDEX; ++idx) {
        CHECK(turbo.color(idx) == whiteHot.color(idx));
    }
    CHECK(turbo.color(255) != whiteHot.color(255));
    CHECK(whiteHot.color(255) == std::array<uint8_t, 3>{255, 245, 224});

    // Configuration compatibility: a missing/zero threshold keeps the prior
    // global white-hot behavior, while disabling whiteHotTail or supplying a
    // positive split threshold leaves the base palette untouched here (the
    // latter receives its row override in Density's constructor).
    auto paletteCfg = buv::Cfg{};
    paletteCfg.colorMap = "turbo";
    paletteCfg.whiteHotTail = true;
    paletteCfg.whiteHotTailMinSatoshi = 0;
    CHECK(buv::Density::makeColorMap(paletteCfg).color(255) == whiteHot.color(255));
    paletteCfg.whiteHotTail = false;
    CHECK(buv::Density::makeColorMap(paletteCfg).color(255) == turbo.color(255));
    paletteCfg.whiteHotTail = true;
    paletteCfg.whiteHotTailMinSatoshi = 1'000'000'000;
    CHECK(buv::Density::makeColorMap(paletteCfg).color(255) == turbo.color(255));

    auto cfg = buv::Cfg{};
    cfg.imageWidth = 1;
    cfg.imageHeight = 2160;
    cfg.graphRect = {0, 10, 1, 2072};
    cfg.minSatoshi = 1;
    cfg.maxSatoshi = 10'000'000'000'000;
    cfg.compressLowSatoshi = true;
    cfg.compressTopSatoshi = true;
    cfg.xAxisMode = "normalizedGeometric";
    cfg.epochBlocks = 105'000;
    cfg.epochRatio = 0.5;

    auto const mapper = buv::SatoshiBlockheightToPixel(cfg, 964'389);
    constexpr int64_t tenBtc = 1'000'000'000;
    auto const thresholdRow = mapper.satoshiToPixelHeight(tenBtc);
    CHECK(mapper.satoshiToPixelHeight(11 * 100'000'000LL) <= thresholdRow);
    CHECK(mapper.satoshiToPixelHeight(9 * 100'000'000LL) >= thresholdRow);

    auto image = buv::DensityToImage(
        cfg.imageWidth, cfg.imageHeight, 500, turbo, std::array<uint8_t, 3>{0, 0, 0});
    image.setRowColorMapOverride(whiteHot, cfg.graphRect.y, thresholdRow);

    // Saturated density uses white-hot on the threshold row and Turbo red on
    // the row immediately below it.
    image.update(thresholdRow, 500.0);
    image.update(thresholdRow + 1, 500.0);
    checkRgb(image.rgb(thresholdRow), whiteHot.color(255));
    checkRgb(image.rgb(thresholdRow + 1), turbo.color(255));

    // Ordinary density colors are identical across the amount split.
    image.update(thresholdRow, 100.0);
    image.update(thresholdRow + 1, 100.0);
    CHECK(image.rgb(thresholdRow)[0] == image.rgb(thresholdRow + 1)[0]);
    CHECK(image.rgb(thresholdRow)[1] == image.rgb(thresholdRow + 1)[1]);
    CHECK(image.rgb(thresholdRow)[2] == image.rgb(thresholdRow + 1)[2]);

    // Empty pixels remain the configured background on both sides.
    image.update(thresholdRow, 0.0);
    image.update(thresholdRow + 1, 0.0);
    checkRgb(image.rgb(thresholdRow), {0, 0, 0});
    checkRgb(image.rgb(thresholdRow + 1), {0, 0, 0});
}

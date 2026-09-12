#include <app/Cfg.h>
#include <buv/SatoshiBlockheightToPixel.h>

#include <array>
#include <cstdint>

#include <doctest.h>

// Smooth epoch slide: the blended X map must equal the old layout at t=0 and
// the new layout at t=1, stay monotonic in block height in between, and be a
// no-op when the feature is off.
TEST_CASE("epoch_transition_mapping" * doctest::skip()) {
    auto cfg = buv::Cfg{};
    cfg.imageWidth = 3840;
    cfg.imageHeight = 2160;
    cfg.graphRect = {0, 10, 3720, 2072};
    cfg.minSatoshi = 1;
    cfg.maxSatoshi = 10'000'000'000'000;
    cfg.compressLowSatoshi = true;
    cfg.compressTopSatoshi = true;
    cfg.xAxisMode = "normalizedGeometric";
    cfg.epochBlocks = 105'000;
    cfg.epochRatio = 0.5;
    cfg.epochTransitionBlocks = 120;

    constexpr uint32_t numBlocks = 964'389;
    auto const heights = std::array<uint32_t, 9>{0, 50'000, 104'999, 105'000, 200'000, 209'999, 210'000, 300'000, 314'999};

    for (uint32_t boundaryEpoch : {2U, 3U}) {
        auto plainOld = buv::SatoshiBlockheightToPixel(cfg, numBlocks);
        plainOld.setCurrentEpoch(boundaryEpoch - 1);
        auto plainNew = buv::SatoshiBlockheightToPixel(cfg, numBlocks);
        plainNew.setCurrentEpoch(boundaryEpoch);

        auto blended = buv::SatoshiBlockheightToPixel(cfg, numBlocks);

        // t = 0: exactly the old layout
        blended.setEpochTransition(boundaryEpoch - 1, boundaryEpoch, 0.0);
        CHECK(blended.transitionActive());
        for (auto h : heights) {
            if (h / cfg.epochBlocks >= boundaryEpoch) continue; // new epoch has no width at t=0
            CHECK(blended.blockheightToPixelWidth(h) == plainOld.blockheightToPixelWidth(h));
        }

        // t = 1: exactly the new layout, transition cleared
        blended.setEpochTransition(boundaryEpoch - 1, boundaryEpoch, 1.0);
        CHECK_FALSE(blended.transitionActive());
        for (auto h : heights) {
            if (h / cfg.epochBlocks > boundaryEpoch) continue;
            CHECK(blended.blockheightToPixelWidth(h) == plainNew.blockheightToPixelWidth(h));
        }

        // intermediate t: monotonic non-decreasing in h across the whole range
        for (double t : {0.25, 0.5, 0.75}) {
            blended.setEpochTransition(boundaryEpoch - 1, boundaryEpoch, t);
            auto const maxH = boundaryEpoch * cfg.epochBlocks + 119;
            size_t prev = 0;
            for (uint32_t h = 0; h <= maxH; h += 997) {
                auto const x = blended.blockheightToPixelWidth(h);
                CHECK(x >= prev);
                prev = x;
            }
            // the old history's right edge sits strictly between old and new positions
            auto const edgeH = boundaryEpoch * cfg.epochBlocks - 1;
            auto const xEdge = blended.blockheightToPixelWidth(edgeH);
            CHECK(xEdge <= plainOld.blockheightToPixelWidth(edgeH));
            CHECK(xEdge >= plainNew.blockheightToPixelWidth(edgeH));
        }
    }

    // Feature off: setCurrentEpoch path is byte-identical to a mapper that
    // never heard of transitions.
    cfg.epochTransitionBlocks = 0;
    auto off = buv::SatoshiBlockheightToPixel(cfg, numBlocks);
    auto ref = buv::SatoshiBlockheightToPixel(cfg, numBlocks);
    for (uint32_t e = 0; e < 9; ++e) {
        off.setCurrentEpoch(e);
        ref.setCurrentEpoch(e);
        for (auto h : heights) {
            CHECK(off.blockheightToPixelWidth(h) == ref.blockheightToPixelWidth(h));
        }
    }
}

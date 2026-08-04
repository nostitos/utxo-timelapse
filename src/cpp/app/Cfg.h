#pragma once

#include <cstdint>
#include <filesystem>
#include <string>

namespace buv {
template <typename T>
struct Rect {
    T x{};
    T y{};
    T w{};
    T h{};
};

struct Cfg {
    std::string bitcoinRpcUrl{};

    std::string blkFile{};
    int64_t utxoToChangeNumThreads{};
    int64_t utxoToChangeNumResources{};

    size_t imageWidth{};
    size_t imageHeight{};

    Rect<size_t> graphRect{};
    int64_t minSatoshi{};
    int64_t maxSatoshi{};
    uint32_t startShowAtBlockHeight{};
    uint32_t endShowAtBlockHeight{0};  // 0 = no limit, otherwise stop at this block
    uint32_t skipBlocks{1};
    uint32_t repeatLastBlockTimes{0};
    std::string connectionIpAddr = "127.0.0.1";
    uint16_t connectionSocket = 12987;
    std::string colorMap = "viridis";
    size_t colorUpperValueLimit = 4000U;
    std::array<uint8_t, 3> colorHighlightRGB{};
    std::array<uint8_t, 3> colorBackgroundRGB{};
    std::string checkpointFile{};
    uint32_t checkpointIntervalBlocks{10000};

    // X-axis mode: "linear" (original), "epochLog", "normalizedGeometric", or "continuousLog"
    std::string xAxisMode{"linear"};
    uint32_t epochBlocks{25000};  // Epoch size in blocks (for epochLog/normalizedGeometric modes)
    double epochRatio{0.5};       // Geometric series ratio (0.5 = each older epoch is half width)

    // Continuous log mode settings
    double logCompressionFactor{4.85};  // Power-law exponent: x = (h/N)^k, higher = more compression
    uint32_t resampleEveryNBlocks{100}; // How often to resample pixels for continuous log mode

    // Y-axis compression: compress 1-100 sat range to half height
    bool compressLowSatoshi{false};

    // Coinjoin filter: only show UTXOs with coinjoin-typical denominations
    bool coinjoinFilter{false};

    // Audio generation settings
    bool audioEnabled{false};
    std::string audioOutputFile{};
    float audioSampleRate{48000.0f};
    int audioSamplesPerBlock{800};  // ~48000/60 for 60fps
};

auto parseCfg(std::filesystem::path const& cfgFile) -> Cfg;

} // namespace buv

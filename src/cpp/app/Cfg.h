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
    // When false (default), utxo_to_change refuses to open an existing non-empty
    // blkFile with std::ios::out. A wrong config or a failed checkpoint load
    // used to truncate multi-GB changes.blk1 files on startup.
    bool allowBlkFileTruncate{false};

    // X-axis mode: "linear" (original), "epochLog", "normalizedGeometric", or "continuousLog"
    std::string xAxisMode{"linear"};
    uint32_t epochBlocks{25000};  // Epoch size in blocks (for epochLog/normalizedGeometric modes)
    double epochRatio{0.5};       // Geometric series ratio (0.5 = each older epoch is half width)

    // Smooth epoch transitions (normalizedGeometric only): number of blocks over
    // which the layout slides from the old epoch geometry to the new one, with
    // smoothstep easing. 0 keeps the legacy one-frame cut. Density is rebuilt
    // exactly from the alive ledger on every frame of the slide.
    uint32_t epochTransitionBlocks{0};

    // Continuous log mode settings
    double logCompressionFactor{4.85};  // Power-law exponent: x = (h/N)^k, higher = more compression
    uint32_t resampleEveryNBlocks{100}; // How often to resample pixels for continuous log mode

    // Y-axis compression: compress 1-100 sat range to half height
    bool compressLowSatoshi{false};

    // Y-axis top band: extend the axis to 100 kBTC with a slim compressed band.
    // The 10 kBTC - 100 kBTC decade gets 15% of the height of a normal decade,
    // restoring positional separation among whale coins that would otherwise all
    // share one saturated top row. Requires compressLowSatoshi and maxSatoshi >= 1e13.
    bool compressTopSatoshi{false};

    // Amount color floor: occupied pixels above ~0.1 BTC get a minimum color that
    // rises with the row's BTC amount (log scale), so sparse whale rows stand out.
    // 1 BTC floors at turbo index 45; 100k BTC (top of axis) floors at peak red 255.
    bool amountColorFloor{false};

    // Amount-weighted density: a UTXO above 5 BTC contributes amount/5BTC to its
    // pixel's persistent density instead of 1 (a single 100 BTC coin counts like
    // 20 ordinary coins). Flash size is separate and follows the actual total BTC
    // value changing at that pixel, with no minimum contribution per UTXO.
    bool amountWeightedDensity{false};

    // White-hot colormap tail: blend the top of the colormap toward warm white so
    // perceived brightness rises monotonically with density (the densest pixel is
    // always the brightest; fixes turbo's dark-red endpoint).
    bool whiteHotTail{false};

    // Optional amount threshold for the white-hot palette. Zero preserves the
    // existing behavior and applies white-hot globally. A positive value keeps
    // the base colormap below that satoshi amount and applies white-hot only to
    // the threshold row and higher-amount rows.
    int64_t whiteHotTailMinSatoshi{0};

    // Coinjoin filter: only show UTXOs with coinjoin-typical denominations
    bool coinjoinFilter{false};

    // Audio generation settings
    bool audioEnabled{false};
    std::string audioOutputFile{};
    float audioSampleRate{48000.0f};
    int audioSamplesPerBlock{800};  // ~48000/60 for 60fps

    // UTXO explorer settings (utxo_history builder + utxo_explorer server)
    std::string historyFile{};       // utxo_history.bin path (built by utxo_history, read by utxo_explorer)
    std::string explorerVideoFile{}; // rendered MP4 served as the explorer timeline
    uint16_t explorerPort{12988};    // local port for the explorer web server
};

auto parseCfg(std::filesystem::path const& cfgFile) -> Cfg;

} // namespace buv

#include "Cfg.h"

#include <util/log.h>

#include <fmt/format.h>
#include <simdjson.h>

namespace {

template <typename T>
[[nodiscard]] auto load(simdjson::dom::element const& data, char const* name) -> T {
    try {
        return data[name].get<T>().value();
    } catch (std::exception const& e) {
        throw std::runtime_error(fmt::format("Could not get '{}': {}", name, e.what()));
    }
}

template <typename T, size_t S>
[[nodiscard]] auto loadArray(simdjson::dom::element const& data, char const* name) -> std::array<T, S> {
    auto ary = std::array<T, S>();
    try {
        auto jsonAry = data[name].get_array();
        if (jsonAry.size() != S) {
            throw std::runtime_error(fmt::format("array size is {} but should be {}", jsonAry.size(), S));
        }

        for (size_t i = 0; i < ary.size(); ++i) {
            if constexpr (std::is_unsigned_v<T>) {
                ary[i] = jsonAry.at(i).get_int64();
            } else {
                ary[i] = jsonAry.at(i).get_uint64();
            }
        }
        return ary;
    } catch (std::exception const& e) {
        throw std::runtime_error(fmt::format("Could not get '{}': {}", name, e.what()));
    }
}

} // namespace

namespace buv {

auto parseCfg(std::filesystem::path const& cfgFile) -> Cfg {
    auto jsonParser = simdjson::dom::parser();
    simdjson::dom::element data = jsonParser.load(cfgFile);

    auto cfg = Cfg();
    LOG("Loading config file {}", cfgFile.string());
    cfg.bitcoinRpcUrl = std::string(load<std::string_view>(data, "bitcoinRpcUrl"));
    cfg.blkFile = std::string(load<std::string_view>(data, "blkFile"));
    cfg.utxoToChangeNumThreads = load<int64_t>(data, "utxoToChangeNumThreads");
    cfg.utxoToChangeNumResources = load<int64_t>(data, "utxoToChangeNumResources");
    cfg.imageWidth = load<uint64_t>(data, "imageWidth");
    cfg.imageHeight = load<uint64_t>(data, "imageHeight");

    auto rect = loadArray<size_t, 4>(data, "graphRect");
    cfg.graphRect.x = rect[0];
    cfg.graphRect.y = rect[1];
    cfg.graphRect.w = rect[2];
    cfg.graphRect.h = rect[3];

    cfg.minSatoshi = load<int64_t>(data, "minSatoshi");
    cfg.maxSatoshi = load<int64_t>(data, "maxSatoshi");
    cfg.startShowAtBlockHeight = load<uint64_t>(data, "startShowAtBlockHeight");

    // Optional: end block height (0 = no limit)
    try {
        cfg.endShowAtBlockHeight = load<uint64_t>(data, "endShowAtBlockHeight");
    } catch (...) {
        cfg.endShowAtBlockHeight = 0;  // Default: no limit
    }

    cfg.skipBlocks = load<uint64_t>(data, "skipBlocks");
    cfg.repeatLastBlockTimes = load<uint64_t>(data, "repeatLastBlockTimes");
    cfg.connectionIpAddr = std::string(load<std::string_view>(data, "connectionIpAddr"));
    cfg.connectionSocket = load<uint64_t>(data, "connectionSocket");
    cfg.colorUpperValueLimit = load<uint64_t>(data, "colorUpperValueLimit");
    cfg.colorMap = std::string(load<std::string_view>(data, "colorMap"));
    cfg.colorHighlightRGB = loadArray<uint8_t, 3>(data, "colorHighlightRGB");
    cfg.colorBackgroundRGB = loadArray<uint8_t, 3>(data, "colorBackgroundRGB");

    // Optional checkpoint settings (for resume support)
    try {
        cfg.checkpointFile = std::string(load<std::string_view>(data, "checkpointFile"));
    } catch (...) {
        cfg.checkpointFile = "";
    }
    try {
        cfg.checkpointIntervalBlocks = load<uint64_t>(data, "checkpointIntervalBlocks");
    } catch (...) {
        cfg.checkpointIntervalBlocks = 10000;
    }
    try {
        cfg.allowBlkFileTruncate = load<bool>(data, "allowBlkFileTruncate");
    } catch (...) {
        cfg.allowBlkFileTruncate = false;
    }

    // Optional X-axis mode settings (for logarithmic compression)
    try {
        cfg.xAxisMode = std::string(load<std::string_view>(data, "xAxisMode"));
    } catch (...) {
        cfg.xAxisMode = "linear";  // Default to original behavior
    }
    try {
        cfg.epochBlocks = load<uint64_t>(data, "epochBlocks");
    } catch (...) {
        cfg.epochBlocks = 25000;
    }
    try {
        cfg.epochRatio = load<double>(data, "epochRatio");
    } catch (...) {
        cfg.epochRatio = 0.5;  // Default: each older epoch is half width
    }
    try {
        cfg.epochTransitionBlocks = static_cast<uint32_t>(load<uint64_t>(data, "epochTransitionBlocks"));
    } catch (...) {
        cfg.epochTransitionBlocks = 0;  // Default: one-frame cut
    }
    if (cfg.epochTransitionBlocks >= cfg.epochBlocks) {
        throw std::runtime_error("epochTransitionBlocks must be smaller than epochBlocks");
    }

    // Continuous log mode settings
    try {
        cfg.logCompressionFactor = load<double>(data, "logCompressionFactor");
    } catch (...) {
        cfg.logCompressionFactor = 4.85;  // Default: newest 10% gets 40% of screen
    }
    try {
        cfg.resampleEveryNBlocks = load<uint64_t>(data, "resampleEveryNBlocks");
    } catch (...) {
        cfg.resampleEveryNBlocks = 100;  // Default: resample every 100 blocks
    }

    // Optional Y-axis compression (compress 1-100 sat range)
    try {
        cfg.compressLowSatoshi = load<bool>(data, "compressLowSatoshi");
    } catch (...) {
        cfg.compressLowSatoshi = false;  // Default: no compression
    }

    // Optional Y-axis top band (10 kBTC - 100 kBTC at 15% decade height)
    try {
        cfg.compressTopSatoshi = load<bool>(data, "compressTopSatoshi");
    } catch (...) {
        cfg.compressTopSatoshi = false;
    }

    // Optional amount color floor (whale-band visibility)
    try {
        cfg.amountColorFloor = load<bool>(data, "amountColorFloor");
    } catch (...) {
        cfg.amountColorFloor = false;  // Default: original colors
    }

    // Optional amount-weighted density (whales add amount/5BTC to density)
    try {
        cfg.amountWeightedDensity = load<bool>(data, "amountWeightedDensity");
    } catch (...) {
        cfg.amountWeightedDensity = false;
    }

    // Optional white-hot colormap tail (monotonic perceived brightness)
    try {
        cfg.whiteHotTail = load<bool>(data, "whiteHotTail");
    } catch (...) {
        cfg.whiteHotTail = false;
    }
    try {
        cfg.whiteHotTailMinSatoshi = load<int64_t>(data, "whiteHotTailMinSatoshi");
    } catch (...) {
        cfg.whiteHotTailMinSatoshi = 0;
    }
    if (cfg.whiteHotTailMinSatoshi < 0) {
        throw std::runtime_error("whiteHotTailMinSatoshi must be zero or positive");
    }

    if (cfg.xAxisMode == "continuousLog") {
        LOG("X-axis mode: continuousLog, compressionFactor: {}, resampleEvery: {} blocks",
            cfg.logCompressionFactor, cfg.resampleEveryNBlocks);
    } else {
        LOG("X-axis mode: {}, epochBlocks: {}, epochRatio: {}",
            cfg.xAxisMode, cfg.epochBlocks, cfg.epochRatio);
        if (cfg.epochTransitionBlocks > 0) {
            LOG("Smooth epoch transitions: {} blocks per slide (smoothstep), density rebuilt from ledger each frame",
                cfg.epochTransitionBlocks);
        }
    }
    // Optional coinjoin filter
    try {
        cfg.coinjoinFilter = load<bool>(data, "coinjoinFilter");
    } catch (...) {
        cfg.coinjoinFilter = false;
    }

    LOG("compressLowSatoshi: {}", cfg.compressLowSatoshi);
    if (cfg.compressTopSatoshi) {
        LOG("compressTopSatoshi: ENABLED (10kBTC-100kBTC band at 15% decade height)");
    }
    if (cfg.amountColorFloor) {
        LOG("amountColorFloor: ENABLED (>=0.1 BTC rows get amount-scaled minimum color)");
    }
    if (cfg.amountWeightedDensity) {
        LOG("amountWeightedDensity: ENABLED (UTXOs above 5 BTC add amount/5BTC density; flashes use actual BTC moved)");
    }
    if (cfg.whiteHotTail) {
        if (cfg.whiteHotTailMinSatoshi > 0) {
            LOG("whiteHotTail: ENABLED at and above {} satoshi (lower rows retain the base colormap)",
                cfg.whiteHotTailMinSatoshi);
        } else {
            LOG("whiteHotTail: ENABLED globally (colormap top blends to warm white, monotonic brightness)");
        }
    } else if (cfg.whiteHotTailMinSatoshi > 0) {
        LOG("whiteHotTailMinSatoshi ignored because whiteHotTail is disabled");
    }
    if (cfg.coinjoinFilter) {
        LOG("Coinjoin filter: ENABLED");
    }
    if (cfg.endShowAtBlockHeight > 0) {
        LOG("Block range: {} to {}", cfg.startShowAtBlockHeight, cfg.endShowAtBlockHeight);
    } else {
        LOG("Starting from block {}, no end limit", cfg.startShowAtBlockHeight);
    }

    // Optional audio settings
    try {
        cfg.audioEnabled = load<bool>(data, "audioEnabled");
    } catch (...) {
        cfg.audioEnabled = false;
    }
    try {
        cfg.audioOutputFile = std::string(load<std::string_view>(data, "audioOutputFile"));
    } catch (...) {
        cfg.audioOutputFile = "";
    }
    try {
        cfg.audioSampleRate = static_cast<float>(load<double>(data, "audioSampleRate"));
    } catch (...) {
        cfg.audioSampleRate = 48000.0f;
    }
    try {
        cfg.audioSamplesPerBlock = static_cast<int>(load<int64_t>(data, "audioSamplesPerBlock"));
    } catch (...) {
        cfg.audioSamplesPerBlock = 800;  // ~48000/60 for 60fps
    }

    if (cfg.audioEnabled) {
        LOG("Audio enabled: output={}, sampleRate={}, samplesPerBlock={}",
            cfg.audioOutputFile, cfg.audioSampleRate, cfg.audioSamplesPerBlock);
    }

    // Optional UTXO explorer settings
    try {
        cfg.historyFile = std::string(load<std::string_view>(data, "historyFile"));
    } catch (...) {
        cfg.historyFile = "";
    }
    try {
        cfg.explorerVideoFile = std::string(load<std::string_view>(data, "explorerVideoFile"));
    } catch (...) {
        cfg.explorerVideoFile = "";
    }
    try {
        cfg.explorerPort = load<uint64_t>(data, "explorerPort");
    } catch (...) {
        cfg.explorerPort = 12988;
    }

    return cfg;
}

} // namespace buv

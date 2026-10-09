#include "app/fetchAllBlockHeaders.h"
#include <app/Cfg.h>
#include <app/BlockIndex.h>
#include <app/RendererCheckpoint.h>
#include <app/Hud.h>
#include <app/forEachChange.h>
#include <buv/AudioSynthesizer.h>
#include <buv/Density.h>
#include <buv/SocketStream.h>
#include <util/Throttle.h>
#include <util/args.h>
#include <util/kbhit.h>
#include <util/log.h>

#include <doctest.h>
#include <fmt/chrono.h>
#include <fmt/ranges.h>
#include <simdjson.h>

#include <cmath>
#include <fstream>
#include <memory>

using namespace std::literals;

void saveImagePPM(size_t width, size_t height, uint8_t const* data, std::string const& filename) {
    // see http://netpbm.sourceforge.net/doc/ppm.html
    std::ofstream fout(filename, std::ios::binary);
    fout << "P6\n" << width << " " << height << "\n" << 255 << "\n";
    fout.write(reinterpret_cast<char const*>(data), width * height * 3U);
    if (!fout) throw std::runtime_error("Could not write RGB frame: " + filename);
}

// clang-format off
//
// 1. Start ffmpeg or ffplay (see below)
//    * ffplay -f rawvideo -pixel_format rgb24 -video_size 3840x2160 -framerate 60 -i "tcp://127.0.0.1:12987?listen"
//    * ffmpeg -f rawvideo -pixel_format rgb24 -video_size 3840x2160 -framerate 60 -i "tcp://127.0.0.1:12987?listen" -c:v libx264 -profile:v high -bf 2 -g 30 -preset slower -crf 24 -pix_fmt yuv420p -movflags faststart out.mp4
//        -crf 23: 23GB
//    * recommended settings: https://gist.github.com/mikoim/27e4e0dc64e384adbcb91ff10a2d3678
//
// 2. ninja && ./buv -ns -tc=visualizer
//
// clang-format on
TEST_CASE("visualizer" * doctest::skip()) {
    auto cfg = buv::parseCfg(util::args::get("-cfg").value());

    LOG("mmapping '{}', this could take a while...", cfg.blkFile);
    auto file = util::Mmap(cfg.blkFile);
    auto index = buv::BlockIndex::loadOrBuild(cfg.blkFile, file.view());
    auto numBlocks = index.size();
    if (!numBlocks) throw std::runtime_error("No blocks in render input");
    auto const endHeightExclusive = cfg.endShowAtBlockHeight
        ? std::min<uint64_t>(uint64_t(cfg.endShowAtBlockHeight) + 1, numBlocks)
        : uint64_t(numBlocks);
    if (cfg.startShowAtBlockHeight >= endHeightExclusive)
        throw std::runtime_error("Visible render range is empty or outside input");
    auto const endOffset = index.offset(static_cast<size_t>(endHeightExclusive));
    LOG("{} blocks, overwritting cfg with that setting", numBlocks);

    auto density = buv::Density(cfg, numBlocks);
    uint64_t startOffset = 0;
    auto bindingAt = [&](uint32_t height) {
        if (height == 0 || height >= numBlocks) throw std::runtime_error("Renderer checkpoint boundary outside input");
        auto record = index.recordSpan(file.view(), height - 1);
        return buv::RendererCheckpointBinding{height, index.offset(height),
            buv::rendererCheckpointHash(record.data(), record.size())};
    };
    if (!cfg.rendererCheckpointLoad.empty()) {
        auto saved = buv::readRendererCheckpointBinding(cfg.rendererCheckpointLoad);
        auto expected = bindingAt(saved.nextHeight);
        if (saved.nextBlkOffset != expected.nextBlkOffset || saved.previousRecordHash != expected.previousRecordHash)
            throw std::runtime_error("Renderer checkpoint does not match BLK prefix boundary");
        LOG("Loading renderer checkpoint before block {}", saved.nextHeight);
        buv::loadRendererCheckpoint(cfg.rendererCheckpointLoad, density, expected);
        startOffset = expected.nextBlkOffset;
        LOG("Renderer checkpoint loaded: {} ledger entries; replay starts at block {}",
            density.checkpointLedgerSize(), saved.nextHeight);
    }
    if (startOffset >= endOffset) throw std::runtime_error("Replay range is empty or outside input");
    auto const checkpointSaveHeight = cfg.rendererCheckpointSaveAtBlock ? cfg.rendererCheckpointSaveAtBlock : cfg.startShowAtBlockHeight;
    if (!cfg.rendererCheckpointSave.empty()) {
        if (std::filesystem::exists(cfg.rendererCheckpointSave)) throw std::runtime_error("Refusing to overwrite renderer checkpoint");
        bindingAt(checkpointSaveHeight);
        if (index.offset(checkpointSaveHeight) < startOffset ||
            (cfg.endShowAtBlockHeight && checkpointSaveHeight > cfg.endShowAtBlockHeight))
            throw std::runtime_error("Renderer checkpoint save boundary outside replay range");
    }
    auto throttler = util::ThrottlePeriodic(1000ms);

    auto hud = buv::Hud::create(cfg, numBlocks, file);
    auto socketStream = buv::SocketStream::create(cfg.connectionIpAddr.c_str(), cfg.connectionSocket);

    // Initialize audio synthesizer if enabled
    std::unique_ptr<buv::AudioSynthesizer> audioSynth;
    if (cfg.audioEnabled && !cfg.audioOutputFile.empty()) {
        LOG("Initializing audio synthesizer: {}", cfg.audioOutputFile);
        audioSynth = std::make_unique<buv::AudioSynthesizer>(
            cfg.audioOutputFile, cfg.audioSampleRate, cfg.audioSamplesPerBlock);
    }

    auto lastCib = buv::forEachChange(file, [&](buv::ChangesInBlock const& cib) {
        auto blockHeight = cib.blockData().blockHeight;

        LOGIF(throttler(), "block {}, {} changes", blockHeight, cib.changeAtBlockheights().size());

        if (!cfg.rendererCheckpointSave.empty() && blockHeight == checkpointSaveHeight) {
            LOG("Saving renderer checkpoint before block {}", blockHeight);
            buv::saveRendererCheckpoint(cfg.rendererCheckpointSave, density, bindingAt(blockHeight));
            LOG("Renderer checkpoint saved: {} ledger entries", density.checkpointLedgerSize());
        }
        density.begin_block(blockHeight);

        // Only collect audio events once we're in the visible range
        bool collectAudio = audioSynth && blockHeight >= cfg.startShowAtBlockHeight;

        // Two passes: creations first, then spends. The change list is sorted by
        // amount (spends negative -> first), but a coin created AND spent within
        // the same block must be added before its spend is subtracted. Otherwise
        // the decrement hits an empty cell and is dropped, while the later +1
        // sticks forever - permanent phantom density at exchange-churn pixels.
        for (auto const& change : cib.changeAtBlockheights()) {
            if (change.satoshi() > 0) {
                density.change(change.blockHeight(), change.satoshi());
            }
        }
        for (auto const& change : cib.changeAtBlockheights()) {
            if (change.satoshi() <= 0) {
                density.change(change.blockHeight(), change.satoshi());

                // Collect spending events for audio synthesis
                if (collectAudio && change.satoshi() < 0) {
                    audioSynth->addSpend(blockHeight, change.blockHeight(), change.satoshi());
                }
            }
        }

        // Generate audio for this block (only when outputting video)
        if (collectAudio) {
            audioSynth->endBlock();
        }

        density.end_block(blockHeight, [&](uint8_t const* data) {
            // Sync HUD with Density for correct legend positioning
            hud->syncAxis(density.axisMapper());
            hud->setTotalBlocks(density.getTotalBlocks());
            hud->draw(data, cib);
            if (std::find(cfg.dumpFramesAtBlocks.begin(), cfg.dumpFramesAtBlocks.end(), blockHeight) != cfg.dumpFramesAtBlocks.end()) {
                auto const filename = fmt::format("frame_{:07}.ppm", blockHeight);
                saveImagePPM(cfg.imageWidth, cfg.imageHeight, hud->data(), filename);
                LOG("Dumped exact RGB frame at block {} to {}", blockHeight, filename);
            }
            socketStream->write(hud->data(), hud->size());
        });

        if (util::kbhit()) {
            switch (std::getchar()) {
            case 'q':
                // quit
                return false;

            case 's': {
                auto imgFileName = fmt::format("img_{:07}.ppm", blockHeight);
                LOG("Writing image '{}'", imgFileName);
                saveImagePPM(cfg.imageWidth, cfg.imageHeight, hud->data(), imgFileName);
            }
            }
        }

        return true;
    }, startOffset, endOffset);

    // fade out & keep last image for 1 minute
    for (uint32_t i = 0; i < cfg.repeatLastBlockTimes; ++i) {
        density.fadeOut(lastCib.blockData().blockHeight + i + 1, [&](uint8_t const* data) {
            hud->syncAxis(density.axisMapper());
            hud->setTotalBlocks(density.getTotalBlocks());
            hud->draw(data, lastCib);
            socketStream->write(hud->data(), hud->size());

            if (i == cfg.repeatLastBlockTimes - 1) {
                auto imgFileName = fmt::format("img_{:07}.ppm", lastCib.blockData().blockHeight);
                saveImagePPM(cfg.imageWidth, cfg.imageHeight, hud->data(), imgFileName);
            }
        });
    }
}

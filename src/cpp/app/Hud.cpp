#include "Hud.h"
#include "util/hex.h"

#include <buv/SatoshiBlockheightToPixel.h>
#include <util/date.h>
#include <util/log.h>

#include <fmt/format.h>
#include <opencv2/freetype.hpp>
#include <opencv2/imgproc.hpp>

#include <cstring>
#include <map>

namespace {

using UnixClockSeconds = std::chrono::time_point<std::chrono::system_clock, std::chrono::seconds>;

enum class Origin {
    top_left,
    top_center,
    top_right,
    center_left,
    center,
    center_right,
    bottom_left,
    bottom_center,
    bottom_right,
};

template <typename... Args>
void writeWithScale(cv::Mat& mat, size_t x, size_t y, Origin origin, double fontScale, int thickness, char const* format, Args&&... args) {
    auto color = cv::Scalar(255, 255, 255);
    auto fontFace = cv::FONT_HERSHEY_SIMPLEX;

    auto text = fmt::format(format, std::forward<Args>(args)...);
    auto pos = cv::Point(x, y);

    auto baseline = int();
    auto size = cv::getTextSize(text, fontFace, fontScale, thickness, &baseline);
    baseline += thickness;

    // ignores baseline, so we get consistent alignment regardless of the letters used. I think. Untested.

    switch (origin) {
    case Origin::top_left:
        pos.y += size.height;
        break;
    case Origin::top_center:
        pos.x -= size.width / 2;
        pos.y += size.height;
        break;
    case Origin::top_right:
        pos.x -= size.width;
        pos.y += size.height;
        break;

    case Origin::center_left:
        pos.y += size.height / 2;
        break;
    case Origin::center:
        pos.x -= size.width / 2;
        pos.y += size.height / 2;
        break;
    case Origin::center_right:
        pos.x -= size.width;
        pos.y += size.height / 2;
        break;

    case Origin::bottom_left:
        // nothing to do, that's the default
        break;
    case Origin::bottom_center:
        pos.x -= size.width / 2;
        break;
    case Origin::bottom_right:
        pos.x -= size.width;
        break;
    }
    cv::putText(mat, text, pos, fontFace, fontScale, color, thickness, cv::LINE_AA);
}

template <typename... Args>
void write(cv::Mat& mat, size_t x, size_t y, Origin origin, char const* format, Args&&... args) {
    writeWithScale(mat, x, y, origin, 0.6, 1, format, std::forward<Args>(args)...);
}

// Large text for Height and Timestamp (2x size)
template <typename... Args>
void writeLarge(cv::Mat& mat, size_t x, size_t y, Origin origin, char const* format, Args&&... args) {
    writeWithScale(mat, x, y, origin, 1.2, 2, format, std::forward<Args>(args)...);
}

template <typename... Args>
void writeMono(cv::Mat& mat, size_t x, size_t y, Origin origin, char const* format, Args&&... args) {
    auto color = cv::Scalar(255, 255, 255);
    auto fontFace = cv::FONT_HERSHEY_SIMPLEX;
    auto fontScale = 0.6;
    auto thickness = 1;

    auto text = fmt::format(format, std::forward<Args>(args)...);
    auto pos = cv::Point(x, y);

    auto baseline = int();

    // gets spacing for digit '0' and uses this for the spacing.
    auto letterSize = cv::getTextSize("0", fontFace, fontScale, thickness, &baseline);
    auto size = letterSize;
    size.width *= text.size();

    // ignores baseline, so we get consistent alignment regardless of the letters used. I think. Untested.

    switch (origin) {
    case Origin::top_left:
        pos.y += size.height;
        break;
    case Origin::top_center:
        pos.x -= size.width / 2;
        pos.y += size.height;
        break;
    case Origin::top_right:
        pos.x -= size.width;
        pos.y += size.height;
        break;

    case Origin::center_left:
        pos.y += size.height / 2;
        break;
    case Origin::center:
        pos.x -= size.width / 2;
        pos.y += size.height / 2;
        break;
    case Origin::center_right:
        pos.x -= size.width;
        pos.y += size.height / 2;
        break;

    case Origin::bottom_left:
        // nothing to do, that's the default
        break;
    case Origin::bottom_center:
        pos.x -= size.width / 2;
        break;
    case Origin::bottom_right:
        pos.x -= size.width;
        break;
    }

    for (auto ch : text) {
        auto zeroTerminatedString = std::array<char, 2>();
        zeroTerminatedString[0] = ch;
        // center this letter
        auto thisLetterSize = cv::getTextSize(zeroTerminatedString.data(), fontFace, fontScale, thickness, &baseline);

        auto thisPos = pos;
        thisPos.x += (letterSize.width - thisLetterSize.width) / 2;
        cv::putText(mat, zeroTerminatedString.data(), thisPos, fontFace, fontScale, color, thickness, cv::LINE_AA);
        pos.x += letterSize.width;
    }
}

} // namespace

namespace buv {

Hud::Hud() = default;

Hud::~Hud() = default;

class HudImpl : public Hud {
    Cfg mCfg;
    std::vector<uint8_t> mBuffer;
    cv::Mat mMat;
    SatoshiBlockheightToPixel mSatoshiBlockheightToPixel;
    std::map<uint32_t, std::string> mHeightToTimestring{};
    uint32_t mNumBlocks{};

public:
    explicit HudImpl(Cfg const& cfg, uint32_t numBlocks, util::Mmap const& mmappedFile)
        : mCfg(cfg)
        , mBuffer(cfg.imageWidth * cfg.imageHeight * 3)
        , mMat(cfg.imageHeight, cfg.imageWidth, CV_8UC3, mBuffer.data())
        , mSatoshiBlockheightToPixel(cfg, numBlocks)
        , mNumBlocks(numBlocks) {

        // iterate all blocks until end, store the time of each 100k block.
        if (!mmappedFile.is_open()) {
            throw std::runtime_error("file not open");
        }

        auto const* ptr = mmappedFile.begin();

        auto blockHeight = uint32_t();
        auto nextTargetBlockHeight = uint32_t();
        while (blockHeight < numBlocks) {
            if (blockHeight == nextTargetBlockHeight) {
                auto [cib, newPtr] = buv::ChangesInBlock::decode(ptr);
                nextTargetBlockHeight += 100000;
                if (nextTargetBlockHeight > numBlocks - 1) {
                    nextTargetBlockHeight = numBlocks - 1;
                }
                ptr = newPtr;
                auto formattedTime = date::format("%F", UnixClockSeconds(std::chrono::seconds(cib.blockData().time)));
                mHeightToTimestring[cib.blockData().blockHeight] = formattedTime;
            } else {
                auto tmp = uint32_t();
                std::tie(tmp, ptr) = buv::ChangesInBlock::skip(ptr);
            }
            ++blockHeight;
        };
    }

    void writeAmount(size_t x,
                     size_t y,
                     char const* number,
                     char const* denom,
                     Origin originNumber = Origin::center_right,
                     Origin originDenom = Origin::center_left) {
        auto mid = 60;
        auto offset = 3;
        // Use cyan color for Y-axis BTC legend to contrast with orange flow lines
        auto color = cv::Scalar(255, 255, 0);  // BGR: cyan
        auto fontFace = cv::FONT_HERSHEY_SIMPLEX;
        auto fontScale = 0.6;
        auto thickness = 1;

        auto align = [&](cv::Point pos, cv::Size const& size, Origin origin) {
            switch (origin) {
            case Origin::top_left:
                pos.y += size.height;
                break;
            case Origin::top_center:
                pos.x -= size.width / 2;
                pos.y += size.height;
                break;
            case Origin::top_right:
                pos.x -= size.width;
                pos.y += size.height;
                break;
            case Origin::center_left:
                pos.y += size.height / 2;
                break;
            case Origin::center:
                pos.x -= size.width / 2;
                pos.y += size.height / 2;
                break;
            case Origin::center_right:
                pos.x -= size.width;
                pos.y += size.height / 2;
                break;
            case Origin::bottom_left:
                break;
            case Origin::bottom_center:
                pos.x -= size.width / 2;
                break;
            case Origin::bottom_right:
                pos.x -= size.width;
                break;
            }
            return pos;
        };

        // Draw number
        auto numberText = std::string(number);
        auto numberPos = cv::Point(x + mid - offset, y);
        auto baseline = int();
        auto numberSize = cv::getTextSize(numberText, fontFace, fontScale, thickness, &baseline);
        numberPos = align(numberPos, numberSize, originNumber);
        cv::putText(mMat, numberText, numberPos, fontFace, fontScale, color, thickness, cv::LINE_AA);

        // Draw denomination
        auto denomText = std::string(denom);
        auto denomPos = cv::Point(x + mid, y);
        auto denomSize = cv::getTextSize(denomText, fontFace, fontScale, thickness, &baseline);
        denomPos = align(denomPos, denomSize, originDenom);
        cv::putText(mMat, denomText, denomPos, fontFace, fontScale, color, thickness, cv::LINE_AA);
    }

    // prints current block info - simplified layout
    void writeBlockInfo(ChangesInBlock const& cib) {
        auto const& blockHeader = cib.blockData();

        // Always keep HUD on the left side
        auto column1x = 20;
        auto column2x = column1x + 960;

        auto y = 10;
        auto lineSpacing = 30;
        auto largeLineSpacing = 50;  // Extra spacing for large text

        // 1. Hash (first)
        write(mMat, column1x, y, Origin::top_left, "Hash");
        writeMono(mMat, column2x, y, Origin::top_right, util::toHex(blockHeader.hash).c_str());
        y += lineSpacing;

        // 2. Chainwork (moved to 2nd position)
        write(mMat, column1x, y, Origin::top_left, "Chainwork");
        writeMono(mMat, column2x, y, Origin::top_right, util::toHex(blockHeader.chainWork).c_str());
        y += lineSpacing + 10;  // Extra gap before large text

        // 3. Height (LARGE - 2x font, renamed)
        writeLarge(mMat, column1x, y, Origin::top_left, "HEIGHT (Block #):");
        writeLarge(mMat, column2x, y, Origin::top_right, "{}", blockHeader.blockHeight);
        y += largeLineSpacing;

        // 4. Timestamp (LARGE - 2x font)
        writeLarge(mMat, column1x, y, Origin::top_left, "TIMESTAMP:");
        writeLarge(mMat,
              column2x,
              y,
              Origin::top_right,
              date::format("%F %T %Z", UnixClockSeconds(std::chrono::seconds(blockHeader.time))).c_str());
        y += largeLineSpacing + 10;  // Extra gap after large text

        // 5. Number of Transactions
        write(mMat, column1x, y, Origin::top_left, "Number of Transactions");
        write(mMat, column2x, y, Origin::top_right, "{}", blockHeader.nTx);
        y += lineSpacing;

        // 6. UTXO (combined: created - destroyed = net)
        auto utxoCreated = cib.numUtxoCreated();
        auto utxoDestroyed = cib.numUtxoDestroyed();
        auto utxoNet = static_cast<int64_t>(utxoCreated) - static_cast<int64_t>(utxoDestroyed);
        write(mMat, column1x, y, Origin::top_left, "UTXO");
        write(mMat, column2x, y, Origin::top_right, "+{} -{} = {:+} net", utxoCreated, utxoDestroyed, utxoNet);
        y += lineSpacing;

        // 7. Block Size
        write(mMat, column1x, y, Origin::top_left, "Block Size");
        write(mMat, column2x, y, Origin::top_right, "{} B", blockHeader.size);
        y += lineSpacing;

        // Removed: Merkle Root, Difficulty, Version, Bits, Nonce, Weight Units
    }

    // Copies rgbSource, then draws dat based on the given info.
    void draw(uint8_t const* rgbSource, ChangesInBlock const& cib) override {
        std::memcpy(mMat.ptr(), rgbSource, mMat.total() * mMat.elemSize());

#if 0
        mMat = cv::Scalar(70, 0, 20);
        cv::rectangle(
            mMat, cv::Rect(mCfg.graphRect.x, mCfg.graphRect.y, mCfg.graphRect.w, mCfg.graphRect.h), cv::Scalar(0, 155, 20));
#endif
        writeBlockInfo(cib);

        auto const& blockHeader = cib.blockData();
        auto formattedTime = date::format("%F %T", UnixClockSeconds(std::chrono::seconds(blockHeader.time)));

        // draw satoshi lines
        auto x = mSatoshiBlockheightToPixel.blockheightToPixelWidth(blockHeader.blockHeight);
        auto oneBtc = int64_t(100'000'000);
        auto const topBand = mCfg.compressTopSatoshi && mCfg.maxSatoshi >= 10'000'000'000'000LL;
        auto const maxTickMult = topBand ? oneBtc * 100000 : oneBtc * 10000;
        for (int64_t mult = 1; mult <= maxTickMult; mult *= 10) {
            for (int64_t digit = 1; digit < 10; ++digit) {
                auto y = mSatoshiBlockheightToPixel.satoshiToPixelHeight(digit * mult);
                auto offset = 4;
                auto len = 5;
                if (digit == 1) {
                    len *= 2;
                }
                cv::line(mMat, cv::Point(x + offset, y), cv::Point(x + offset + len, y), cv::Scalar(255, 255, 255));
            }
        }

        // draw block lines
        auto offset = mCfg.graphRect.h + mCfg.graphRect.y + 4;
        for (uint32_t h = 0; h < mNumBlocks; h += 10000) {
            auto legendX = mSatoshiBlockheightToPixel.blockheightToPixelWidth(h);
            auto len = 5;
            if (h % 100000 == 0) {
                len *= 2;
            }
            if (h == mNumBlocks - 1) {
            }
            cv::line(mMat, cv::Point(legendX, offset), cv::Point(legendX, offset + len), cv::Scalar(255, 255, 255));

            // only print text when distance to current line is large enough, so it's not overwritten
        }

        // show X axis text
        for (auto [blockHeight, formattedTime] : mHeightToTimestring) {
            auto legendX = mSatoshiBlockheightToPixel.blockheightToPixelWidth(blockHeight);
            auto distFromMid = std::abs(static_cast<int>(x) - static_cast<int>(legendX));
            auto align = Origin::top_center;
            if (blockHeight == 0) {
                align = Origin::top_left;
            }

            auto len = 10;
            if (distFromMid > 70) {
                write(mMat, legendX, offset + len + 17, align, "{}{}", blockHeight / 1000, blockHeight == 0 ? "" : "k");
            }

            if (distFromMid > 190) {
                write(mMat, legendX, offset + len + 30 + 17, align, formattedTime.c_str());
            }
        }

        // draw current block marker
        cv::line(mMat, cv::Point(x, offset), cv::Point(x, offset + 15), cv::Scalar(255, 255, 255));
        write(mMat, x, offset + 10 + 17, Origin::top_center, "{}", blockHeader.blockHeight);
        write(mMat, x, offset + 40 + 17, Origin::top_center, "{}", formattedTime);

        // draw the legend
        if (topBand) {
            writeAmount(x,
                        mSatoshiBlockheightToPixel.satoshiToPixelHeight(100000 * oneBtc),
                        "100",
                        "kBTC",
                        Origin::top_right,
                        Origin::top_left);
            // Keep the 10 kBTC label below the compressed top band. Centering it
            // on the boundary overlaps the 100 kBTC label at 1080p, where the
            // entire 10k-100k band is only about 15 pixels tall.
            writeAmount(x,
                        mSatoshiBlockheightToPixel.satoshiToPixelHeight(10000 * oneBtc),
                        "10",
                        "kBTC",
                        Origin::top_right,
                        Origin::top_left);
        } else {
            writeAmount(x,
                        mSatoshiBlockheightToPixel.satoshiToPixelHeight(10000 * oneBtc),
                        "10",
                        "kBTC",
                        Origin::top_right,
                        Origin::top_left);
        }
        writeAmount(x, mSatoshiBlockheightToPixel.satoshiToPixelHeight(1000 * oneBtc), "1", "kBTC");
        writeAmount(x, mSatoshiBlockheightToPixel.satoshiToPixelHeight(100 * oneBtc), "100", "BTC");
        writeAmount(x, mSatoshiBlockheightToPixel.satoshiToPixelHeight(10 * oneBtc), "10", "BTC");
        writeAmount(x, mSatoshiBlockheightToPixel.satoshiToPixelHeight(oneBtc), "1", "BTC");
        writeAmount(x, mSatoshiBlockheightToPixel.satoshiToPixelHeight(10000000), "100", "mBTC");
        writeAmount(x, mSatoshiBlockheightToPixel.satoshiToPixelHeight(1000000), "10", "mBTC");
        writeAmount(x, mSatoshiBlockheightToPixel.satoshiToPixelHeight(100000), "1", "mBTC");
        writeAmount(x, mSatoshiBlockheightToPixel.satoshiToPixelHeight(10000), "100", "uBTC");
        writeAmount(x, mSatoshiBlockheightToPixel.satoshiToPixelHeight(1000), "10", "uBTC");
        writeAmount(x, mSatoshiBlockheightToPixel.satoshiToPixelHeight(100), "1", "uBTC");
        writeAmount(x, mSatoshiBlockheightToPixel.satoshiToPixelHeight(10), "10", "sat");
        writeAmount(x, mSatoshiBlockheightToPixel.satoshiToPixelHeight(1), "1", "sat", Origin::bottom_right, Origin::bottom_left);
    }

    // Returns the drawn RGB data.
    [[nodiscard]] auto data() const -> uint8_t const* override {
        return static_cast<uint8_t const*>(mMat.datastart);
    }

    [[nodiscard]] auto size() const -> size_t override {
        return mMat.total() * mMat.elemSize();
    }

    void setCurrentEpoch(uint32_t epoch) override {
        mSatoshiBlockheightToPixel.setCurrentEpoch(epoch);
    }

    void syncAxis(SatoshiBlockheightToPixel const& source) override {
        mSatoshiBlockheightToPixel.copyTransitionFrom(source);
    }

    void setTotalBlocks(uint32_t totalBlocks) override {
        mSatoshiBlockheightToPixel.setTotalBlocks(totalBlocks);
    }
};

auto Hud::create(Cfg const& cfg, uint32_t numBlocks, util::Mmap const& mmappedFile) -> std::unique_ptr<Hud> {
    return std::make_unique<HudImpl>(cfg, numBlocks, mmappedFile);
}

} // namespace buv

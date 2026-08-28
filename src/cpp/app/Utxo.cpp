#include "Utxo.h"
#include "Chunk.h"

#include <util/BinaryStreamReader.h>
#include <util/log.h>
#include <util/writeBinary.h>

#include <fmt/format.h>
#include <robin_hood.h>

#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <string>
#include <string_view>
#include <vector>

namespace buv {

namespace {

// Checkpoint format v2, marker "UTX2":
//   4  | "UTX2"        | magic marker
//   4  | blockHeight   | uint32, last block integrated into this snapshot
//   8  | blkFileSize   | uint64, exact size in bytes of changes.blk1 after blockHeight was appended
//   8  | lastRecOffset | uint64, byte offset of blockHeight's record inside changes.blk1
//  32  | blockHash     | binary, hash of the block at blockHeight (chain identity / reorg check)
//   8  | numEntries    | uint64, number of transaction-prefix map entries
// per entry:
//   8  | txid prefix   | binary
//   4  | creationHeight| uint32, block that created this transaction's outputs
//  8*n | vout/satoshi  | packed VoutSatoshi values, terminated by the empty marker
//
// first creates a .tmp file, then renames when finished.
auto dump(uint32_t blockHeight,
          uint64_t blkFileSize,
          uint64_t lastRecordOffset,
          std::array<uint8_t, 32> const& blockHash,
          Utxo const& utxo,
          std::filesystem::path const& filename) -> size_t {
    auto fout = std::ofstream(filename, std::ios::binary);
    if (!fout.is_open()) {
        throw std::runtime_error("could not open file for writing UTXO");
    }

    fout.write("UTX2", 4);
    util::writeBinary<4>(blockHeight, fout);
    util::writeBinary<8>(blkFileSize, fout);
    util::writeBinary<8>(lastRecordOffset, fout);
    util::writeArray<32>(blockHash, fout);
    util::writeBinary<8>(utxo.map().size(), fout);
    auto numVouts = size_t();
    for (auto const& kv : utxo.map()) {
        // key
        util::writeArray<8>(kv.first, fout);

        // original creation height of this transaction's outputs
        util::writeBinary<4>(kv.second.blockHeight(), fout);

        // value
        if (kv.second.isSmallUtxo()) {
            // Check slot 0 (vout 0)
            auto vs0 = kv.second.peekVoutSatoshi(0);
            if (!vs0.isEmptyMask() && vs0.satoshi() > 0) {
                // Reconstruct with correct vout=0
                util::writeBinary<8>(VoutSatoshi(0, vs0.satoshi()).data(), fout);
                ++numVouts;
            }
            // Check slot 1 (vout 1)
            auto vs1 = kv.second.peekVoutSatoshi(1);
            if (!vs1.isEmptyMask() && vs1.satoshi() > 0) {
                // Reconstruct with correct vout=1
                util::writeBinary<8>(VoutSatoshi(1, vs1.satoshi()).data(), fout);
                ++numVouts;
            }
        } else {
            auto const* chunk = kv.second.chunk();
            while (chunk != nullptr) {
                util::writeBinary<8>(chunk->voutSatoshi().data(), fout);
                chunk = chunk->next();
                ++numVouts;
            }
        }
        util::writeBinary<8>(VoutSatoshi().data(), fout);
    }

    return numVouts;
}

} // namespace

// first creates a .tmp file, then renames when finished.
void serialize(uint32_t blockHeight,
               uint64_t blkFileSize,
               uint64_t lastRecordOffset,
               std::array<uint8_t, 32> const& blockHash,
               Utxo const& utxo,
               std::filesystem::path const& filename) {
    auto tmpFilename = filename;
    tmpFilename += ".tmp";
    LOG("Writing UTXO to {}...", tmpFilename.string());
    auto n = dump(blockHeight, blkFileSize, lastRecordOffset, blockHash, utxo, tmpFilename.string());
    LOG("Wrote {} vouts", n);
    std::filesystem::rename(tmpFilename.string(), filename.string());
    LOG("Renamed {} -> {}", tmpFilename.string(), filename.string());
}

[[nodiscard]] auto load(std::filesystem::path const& filename) -> Checkpoint {
    auto fin = std::ifstream(filename, std::ios::binary);
    if (!fin.is_open()) {
        throw std::runtime_error("could not open file for reading UTXO");
    }

    // Read magic marker
    char header[5] = {0};
    fin.read(header, 4);
    if (std::string(header) == "UTXO") {
        throw std::runtime_error(
            "Legacy v1 checkpoint ('UTXO'): it lacks original creation heights and BLK-tail validation, "
            "so an exact resume is impossible. Delete it and regenerate from a full rebuild.");
    }
    if (std::string(header) != "UTX2") {
        throw std::runtime_error(fmt::format("Invalid checkpoint header: got '{}', expected 'UTX2'", header));
    }

    auto cp = Checkpoint();
    cp.blockHeight = util::readBinary<uint32_t>(fin);
    cp.blkFileSize = util::readBinary<uint64_t>(fin);
    cp.lastRecordOffset = util::readBinary<uint64_t>(fin);
    fin.read(reinterpret_cast<char*>(cp.blockHash.data()), cp.blockHash.size());
    auto mapSize = util::readBinary<uint64_t>(fin);

    LOG("Loading checkpoint: block {}, blk size {}, {} entries", cp.blockHeight, cp.blkFileSize, mapSize);

    for (size_t i = 0; i < mapSize; ++i) {
        // Read key (TxIdPrefix)
        auto txIdPrefix = TxIdPrefix{};
        fin.read(reinterpret_cast<char*>(txIdPrefix.data()), txIdPrefix.size());

        // Original creation height of this transaction's outputs
        auto creationHeight = util::readBinary<uint32_t>(fin);

        // Read vouts until we hit the empty marker. Keep explicit vout numbers: partial
        // spends leave sparse sequences, and slot/chunk placement must match them.
        auto voutSatoshis = std::vector<VoutSatoshi>();
        while (true) {
            auto voutData = util::readBinary<uint64_t>(fin);
            auto satoshi = static_cast<int64_t>(voutData >> 16U);
            auto vout = static_cast<uint16_t>(voutData);
            auto vs = VoutSatoshi(vout, satoshi);

            if (vs.isEmptyMask()) {
                break; // End of vouts for this txid
            }
            voutSatoshis.push_back(vs);
        }

        if (!voutSatoshis.empty()) {
            cp.utxo.insertSparse(txIdPrefix, creationHeight, voutSatoshis);
        }
    }
    if (!fin) {
        throw std::runtime_error("checkpoint file truncated or unreadable");
    }

    LOG("Checkpoint loaded successfully");
    return cp;
}

} // namespace buv

#if 0
namespace fmt {

auto formatter<buv::Utxo>::parse(format_parse_context& ctx) -> format_parse_context::iterator {
    const auto* it = ctx.begin();
    if (it == ctx.end() || *it == '}') {
        return it;
    }

    if (*it == 'd') {
        mIsDetailed = true;
        ++it;
    }

    if (it != ctx.end() && *it != '}') {
        throw format_error("invalid format");
    }

    return it;
}

auto formatter<buv::Utxo>::format(buv::Utxo const& utxo, format_context& ctx) const -> format_context::iterator {
    auto out = ctx.out();
    auto const& cs = utxo.chunkStore();

    format_to(out,
              "({:10} txids, {:10} vout's used, {:10} allocated ({:4} bulk))",
              utxo.map().size(),
              cs.numAllocatedChunks() - cs.numFreeChunks(),
              cs.numAllocatedChunks(),
              cs.numAllocatedBulks());

    if (mIsDetailed) {
        // list counts 1-20
        static constexpr auto maxLen = size_t(20);
        auto numvoutsAndCounts = std::vector<std::pair<size_t, size_t>>(maxLen);
        for (size_t i = 0; i < maxLen; ++i) {
            numvoutsAndCounts[i].first = i + 1;
            numvoutsAndCounts[i].second = 0;
        }
        for (auto const& kv : utxo.map()) {
            auto const* chunk = kv.second.chunk();
            auto len = size_t();
            do {
                ++len;
                chunk = chunk->next();
            } while (chunk != nullptr && len < maxLen);
            ++numvoutsAndCounts[len - 1].second;
        }

        // sort by number of counts
        std::sort(numvoutsAndCounts.begin(), numvoutsAndCounts.end(), [](auto const& a, auto const& b) {
            return a.second < b.second;
        });

        for (auto const& [vouts, count] : numvoutsAndCounts) {
            format_to(out, "\n\t{:10} x {:4} {}", count, vouts, vouts == maxLen ? "or more vouts" : "vouts");
        }
    }
    return out;
}

} // namespace fmt

#endif

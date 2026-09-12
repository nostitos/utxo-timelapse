#pragma once

// Shared binary format for the UTXO full-history table (utxo_history.bin).
//
// Built once by the 'utxo_history' test case from changes.blk1, then mmapped by
// the 'utxo_explorer' server for instant per-pixel lookups at any block height.
//
// Layout (all little-endian, no padding):
//
//   Header (64 bytes):
//     0  magic           char[8]   "BUVHIST1"
//     8  numBlocks       u64       number of blocks (records grouped by creation height 0..numBlocks-1)
//    16  numRecords      u64       total UTXO records
//    24  blockTimesOff   u64       file offset of block timestamp array (u32 * numBlocks)
//    32  heightIndexOff  u64       file offset of per-height record start index (u64 * (numBlocks+1))
//    40  recordsOff      u64       file offset of record array
//    48  reserved        u8[16]
//
//   blockTimes:  u32 unix timestamp per block (BlockData.time)
//   heightIndex: u64 per creation height h: index of first record; records for h
//                are [heightIndex[h], heightIndex[h+1])
//   records:     packed UtxoHistoryRecord, grouped by creation height (ascending),
//                unsorted within a height group
//
// Records store spendHeight = UINT32_MAX when unspent at the end of the data.
//
// Section order is defined ONLY by the header offsets. The full builder writes
// blockTimes/heightIndex before the records; the incremental updater
// ('utxo_history_update') rewrites those small arrays BEHIND the enlarged
// record array. Readers must always go through the offsets.

#include <cstdint>

namespace buv {

inline constexpr char kUtxoHistoryMagic[8] = {'B', 'U', 'V', 'H', 'I', 'S', 'T', '1'};
inline constexpr uint32_t kUnspent = UINT32_MAX;

#pragma pack(push, 1)
struct UtxoHistoryHeader {
    char magic[8];
    uint64_t numBlocks;
    uint64_t numRecords;
    uint64_t blockTimesOff;
    uint64_t heightIndexOff;
    uint64_t recordsOff;
    uint8_t reserved[16];
};

struct UtxoHistoryRecord {
    uint32_t creationHeight;
    uint32_t spendHeight; // kUnspent if never spent
    int64_t satoshi;      // always positive (creation amount)
};
#pragma pack(pop)

static_assert(sizeof(UtxoHistoryHeader) == 64, "header must be 64 bytes");
static_assert(sizeof(UtxoHistoryRecord) == 16, "record must be 16 bytes");

} // namespace buv

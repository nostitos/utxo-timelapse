#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <filesystem>

namespace buv {
class Density;
struct Cfg;
using RendererCheckpointHash = std::array<uint8_t, 32>;

// Inspect a checksummed fixed-size header and exact file length, without
// allocating or reading the ledger. This does NOT verify payload integrity;
// loadRendererCheckpoint does that. Treat the returned binding as untrusted
// until compared against the actual BLK index and hashed previous record.
// Declared below after RendererCheckpointBinding.

// Snapshot boundary: immediately BEFORE begin_block(nextHeight), with all
// changes through nextHeight-1 applied. Caller must bind to its validated BLK
// index: nextBlkOffset=index[nextHeight], previousRecordHash=SHA256 of the
// complete encoded record [index[nextHeight-1], index[nextHeight]). This is an
// append-compatible prefix-tail binding, NOT a hash of the entire input prefix.
struct RendererCheckpointBinding {
    uint32_t nextHeight{};
    uint64_t nextBlkOffset{};
    RendererCheckpointHash previousRecordHash{};
};

auto readRendererCheckpointBinding(std::filesystem::path const& path) -> RendererCheckpointBinding;

// SHA-256 of exactly the supplied bytes/range; range hashing is streaming.
auto rendererCheckpointHash(void const* bytes, size_t size) -> RendererCheckpointHash;
auto rendererCheckpointHashFileRange(std::filesystem::path const& path,
                                    uint64_t offset, uint64_t size) -> RendererCheckpointHash;
auto rendererCheckpointConfigFingerprint(Cfg const& cfg) -> RendererCheckpointHash;

// Throw std::runtime_error on invalid/unsupported config, boundary, corrupt or
// mismatched input. No fallback. Save uses exclusive adjacent temporary file,
// flush/fsync and atomic rename; existing checkpoint survives failed writes.
// Load stages ONE ledger, verifies all bytes before swapping into a fresh
// Density. No density raster/transients are saved: import rebuilds the raster;
// startShowAtBlockHeight >= nextHeight is required, and the visible-start path
// clears warm-up transients as on fresh replay. Save may be at any settled C.
// Ledger payload is sorted little-endian {u64 key, IEEE754 f64 weight}; exact
// weight bits survive. Sorting keys costs 8 bytes/entry on save (not 16).
// IMPORTANT: unordered-map rebuild summation order is not a bitwise RGB
// guarantee. Both paths need an order-independent/deterministic rebuild for
// arbitrary fractional ledgers; do not infer global identity from fixtures.
void saveRendererCheckpoint(std::filesystem::path const& path, Density const& density,
                            RendererCheckpointBinding const& binding);
void loadRendererCheckpoint(std::filesystem::path const& path, Density& density,
                            RendererCheckpointBinding const& expected);
} // namespace buv

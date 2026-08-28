# Updating `changes.blk1`

`buv` does not render directly from Bitcoin Core. Its `utxo_to_change` task first
converts the chain into a compact, sequential file named `changes.blk1`. The
visualizer memory-maps that file and emits one RGB frame for each rendered block.

Neither `changes.blk1` nor checkpoint files are distributed in this repository.
They are large, derived artifacts and must be generated from a fully synchronized
Bitcoin Core node.

## Bitcoin Core requirements

Bitcoin Core must be fully synchronized and configured with:

```ini
server=1
rest=1
txindex=1
rpcthreads=12
rpcworkqueue=24
```

`bitcoinRpcUrl` is currently used as the base URL for Bitcoin Core's REST routes,
including `/rest/chaininfo.json`, block headers, and full block JSON. Keep the
REST service private; do not expose port 8332 to the public internet.

## Initial generation

Edit a configuration such as `configs/buv_update.json` and set:

- `bitcoinRpcUrl`: Bitcoin Core REST base URL.
- `blkFile`: output path for `changes.blk1`.
- `utxoToChangeNumThreads`: concurrent block-processing workers.
- `utxoToChangeNumResources`: reusable HTTP/parser resources; normally at least
  the worker count.
- `checkpointFile`: optional UTXO checkpoint path.
- `checkpointIntervalBlocks`: checkpoint interval; `0` disables periodic writes.

- `allowBlkFileTruncate`: optional. Default `false`. When false, `utxo_to_change`
  refuses to open an existing non-empty `blkFile` with `std::ios::out`. Set
  `true` only when you intentionally want to overwrite the file.

Then run:

```bash
./build/buv -ns -tc=utxo_to_change -cfg=configs/buv_update.json
```

For Docker on Linux, with Bitcoin Core reachable from the host network:

```bash
docker run --rm --name buv-update \
  --network host \
  -v "$PWD/buv_data:/buv_data" \
  -v "$PWD/configs/buv_update.json:/config/buv.json:ro" \
  buv \
  -ns -tc=utxo_to_change -cfg=/config/buv.json
```

Generation is CPU-, RAM-, RPC-, and storage-intensive. The complete chain can
require many hours, and current UTXO checkpoints are several gigabytes. Keep at
least enough free disk for `changes.blk1`, a checkpoint, and temporary checkpoint
output at the same time.

## What is in `changes.blk1`

The file is an ordered stream of encoded `ChangesInBlock` records. Each record
contains block metadata and the UTXOs created or spent in that block. A spending
change references the block height at which that output was created. The renderer
uses that relationship to draw value movement over time.

The visualizer scans the entire file to determine its last block and assumes that
records are contiguous and ordered. Back up a known-good file before replacing or
appending to it.

## Checkpoint implementation

A checkpoint captures the in-memory UTXO map so preprocessing can restart after
an interruption without replaying genesis.

The current checkpoint layout (format v2, marker `UTX2`) is:

1. Four-byte `UTX2` marker.
2. Checkpoint block height (`uint32`).
3. Exact `changes.blk1` size in bytes after that block was appended (`uint64`).
4. Byte offset of that block's record inside `changes.blk1` (`uint64`).
5. Hash of the checkpointed block (32 bytes) for chain-identity/reorg checks.
6. Number of transaction-prefix map entries (`uint64`).
7. For every entry: the compact transaction-ID prefix, the outputs' original
   creation block height (`uint32`), packed vout/satoshi values, and an
   empty-value terminator.

Checkpoint writes use `checkpoint.utxo.tmp` and rename it over the configured
checkpoint only after serialization completes. This avoids treating a partially
written temporary file as a valid checkpoint.

At startup, `utxo_to_change`:

1. Fetches the current block-header list from Bitcoin Core.
2. Loads `checkpointFile` when it exists.
3. Verifies the checkpointed block hash is still in the node's best chain
   (reorg detection).
4. Validates the `changes.blk1` tail byte-exactly: the record at the stored
   offset must be the checkpointed block with the checkpointed hash and must
   end exactly at the stored file size. Bytes written after the checkpoint are
   truncated away and re-appended, so an interrupted run resumes cleanly.
5. Restores the UTXO map, with original creation heights, and resumes at
   `checkpointBlockHeight + 1`.
6. Opens `changes.blk1` in append mode when resuming. If the checkpoint is already
   at chain tip, it exits without opening the file. If the checkpoint cannot be
   loaded, or if a fresh start would overwrite an existing non-empty `blkFile`,
   it refuses unless `allowBlkFileTruncate` is `true`.
7. Flushes `changes.blk1` before each periodic checkpoint write, and writes a
   final checkpoint at the exact tip when processing completes.

### Checkpoint history and caveats

Format v2 fixes the two correctness limitations of the legacy v1 (`UTXO`
marker) format:

- v1 did **not** store each UTXO's original creation block; restored outputs
  were assigned the checkpoint height, corrupting origin/age visuals after a
  resumed update. v2 stores creation heights per entry, so resumed updates are
  exact and the renderer's alive-coin ledger stays consistent
  (`ledger misses=0`).
- v1 did not verify that `changes.blk1` matched the checkpoint. v2 validates
  the tail record (height, hash, exact byte size) before appending and refuses
  mismatched pairs.

Legacy v1 checkpoints are rejected at load with a clear error; delete them and
let one full from-genesis rebuild write fresh v2 checkpoints. After that,
updating to a new chain tip only replays blocks past the last checkpoint
(the final checkpoint is at the exact tip, so a routine update processes just
the new blocks — minutes, not hours).

The round-trip and tail-validation behavior is covered by the `checkpoint_v2`
test case: `./buv -ns -tc=checkpoint_v2`.

Epoch-compressed rendering (`normalizedGeometric` or `epochLog`) also maintains
an exact ledger of alive creation points so it can rebuild the density image at
each epoch transition. That ledger requires a from-genesis, full-rebuild BLK.
A v2 checkpoint-resumed BLK preserves creation heights, so it renders exactly;
a nonzero `ledger misses` diagnostic now indicates a genuinely inconsistent
BLK (for example one produced with legacy v1 resume).

## Memory behavior

Loading a modern checkpoint reconstructs hundreds of millions of UTXO entries.
Peak memory can be much larger than the checkpoint file itself because of hash
map allocation and object overhead. Exit code `137` normally means the operating
system or container runtime killed the process for exceeding available memory.

Before updating:

```bash
free -h
df -h
docker stats --no-stream   # when using Docker
```

Stop nonessential workloads or move generation to a machine with more memory.
Deleting a checkpoint forces a genesis replay and should only be done after
backing it up.

## Safe update procedure

1. Stop any renderer and encoder that are reading the BLK file.
2. Back up `changes.blk1` and `checkpoint.utxo` together.
3. Confirm Bitcoin Core is synchronized:
   `curl -s http://127.0.0.1:8332/rest/chaininfo.json`.
4. Run `utxo_to_change` and monitor logs and memory.
5. Confirm the process exits successfully.
6. Scan or render a short block range before starting a long production render.
7. Keep the old data/checkpoint pair until the new file is verified.

Never publish RPC credentials, the BLK file, or the checkpoint in Git.

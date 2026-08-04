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

The current checkpoint layout is:

1. Four-byte `UTXO` marker.
2. Checkpoint block height (`uint32`).
3. Number of transaction-prefix map entries (`uint64`).
4. For every entry: the compact transaction-ID prefix, packed vout/satoshi
   values, and an empty-value terminator.

Checkpoint writes use `checkpoint.utxo.tmp` and rename it over the configured
checkpoint only after serialization completes. This avoids treating a partially
written temporary file as a valid checkpoint.

At startup, `utxo_to_change`:

1. Fetches the current block-header list from Bitcoin Core.
2. Loads `checkpointFile` when it exists.
3. Restores the UTXO map and resumes at `checkpointBlockHeight + 1`.
4. Opens `changes.blk1` in append mode.
5. Flushes `changes.blk1` before each periodic checkpoint write.

### Important checkpoint caveats

The checkpoint feature is experimental and has two correctness limitations in
this version:

- The checkpoint does **not** store each UTXO's original creation block. During
  restore, every loaded output is assigned the checkpoint block height. A later
  spend can therefore be drawn as if the output was created at the checkpoint,
  making origin/age visualization inaccurate after a resumed update.
- Resume does not verify that the last record already in `changes.blk1` exactly
  matches the checkpoint height. A mismatched data file and checkpoint can create
  gaps or duplicate appended blocks.

For an exact production visualization, regenerate `changes.blk1` from genesis
until checkpoint serialization preserves creation heights and validates the BLK
tail. Use checkpoint resume only when that tradeoff is acceptable.

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

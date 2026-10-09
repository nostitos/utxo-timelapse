#!/usr/bin/env python3
"""Verify all extraction batches before presenting full-window coverage."""
import argparse
import json
from pathlib import Path

from address_coverage_extract import load_expected, validate_existing, atomic_json


def verify(data_dir, expected_blocks, start, end, batch_size=100):
    data_dir = Path(data_dir)
    expected, manifest_sha, fingerprint = load_expected(Path(expected_blocks), start, end)
    summary = json.loads((data_dir/'extraction.json').read_text())
    if not summary.get('complete') or summary.get('requested_start') != start or summary.get('requested_end') != end:
        raise ValueError('extraction has not completed the requested range')
    if summary.get('batch_size') != batch_size or summary.get('expected_blocks_sha256') != manifest_sha:
        raise ValueError('extraction range/source settings mismatch')
    tip = summary.get('active_chain_tip_validation') or {}
    if tip.get('height') != end or tip.get('hash') != expected[end]:
        raise ValueError('extraction lacks final active-chain verification')
    batches = []
    for low in range(start, end+1, batch_size):
        high = min(end, low+batch_size-1)
        batch = validate_existing(data_dir, low, high, expected, fingerprint)
        if batch is None:
            raise ValueError(f'missing batch {low}-{high}')
        batches.append(batch)
    expected_paths = {b['parquet'] for b in batches}
    actual_paths = {str(p.relative_to(data_dir)) for p in (data_dir/'events').rglob('*.parquet')}
    if actual_paths != expected_paths:
        raise ValueError('unexpected/missing Parquet files in analysis input')
    blocks = [b for batch in batches for b in batch['blocks']]
    result = dict(schema_version=1, complete=True, start=start, end=end,
                  expected_blocks_sha256=manifest_sha, source_fingerprint=fingerprint,
                  batches=len(batches), block_count=len(blocks),
                  event_count=sum(b['event_count'] for b in batches),
                  transaction_count=sum(b['transaction_count'] for b in blocks),
                  noncoinbase_transaction_count=sum(b['noncoinbase_transaction_count'] for b in blocks),
                  bytes=sum(b['bytes'] for b in batches),
                  earliest_block_time=min(b['time'] for b in blocks),
                  latest_block_time=max(b['time'] for b in blocks))
    for key in ('event_count','transaction_count','noncoinbase_transaction_count','bytes'):
        if result[key] != summary[key]:
            raise ValueError(f'extraction summary {key} mismatch')
    if result['block_count'] != end-start+1:
        raise ValueError('incomplete block coverage')
    atomic_json(data_dir/'verification.json', result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--expected-blocks', type=Path, required=True)
    parser.add_argument('--start', type=int, default=916828)
    parser.add_argument('--end', type=int, default=966827)
    parser.add_argument('--batch-size', type=int, default=100)
    print(json.dumps(verify(**vars(parser.parse_args())), indent=2))


if __name__ == '__main__':
    main()

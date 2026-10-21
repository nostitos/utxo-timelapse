// Landscape release descriptor (README.md: Publish a dataset, Deploy).
//
// dataset.id names the immutable R2 prefix landscape/<id>/ served at /dataset/<id>/.
// retainedDatasetIds stay servable after a switch (open tabs, rollback). After the retirement
// grace period, remove an old id before pruning its objects; keep the immediate prior edition.
// importMapHash is the CSP hash of index.html's inline import
// map: node landscape/tools/csp-hash.mjs prints it (and --check verifies this file).
export const RELEASE = Object.freeze({
  version: 'landscape-20261020-entry-1',
  dataset: Object.freeze({ id: 'd972052-20261018', tip: 972052 }),
  retainedDatasetIds: Object.freeze(['d971587-20261015']),
  importMapHash: 'sha256-7QdCEdJk1SXe5Rkyh+evXtkiWImVRL5euBmglVKAwTE=',
});

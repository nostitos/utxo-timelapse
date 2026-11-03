// Landscape release descriptor (README.md: Publish a dataset, Publish owner data, Deploy).
//
// dataset.id names the immutable R2 prefix landscape/<id>/ served at /dataset/<id>/.
// retainedDatasetIds stay servable after a switch (open tabs, rollback). After the retirement
// grace period, remove an old id before pruning its objects; keep the immediate prior edition.
// owners names the owner highlight data: null keeps /owners/index.json a 404, which hides the
// app's Owners view. Publishing sets it to Object.freeze({ id: 'o<tip>-<yyyymmdd>', tip }), the
// immutable R2 prefix landscape/owners/<id>/ served at /owners/<id>/. retainedOwnersIds stay
// servable after a switch or a return to null (open tabs, rollback), like retainedDatasetIds.
// importMapHash is the CSP hash of index.html's inline import
// map: node landscape/tools/csp-hash.mjs prints it (and --check verifies this file).
export const RELEASE = Object.freeze({
  version: 'landscape-20261102-1',
  dataset: Object.freeze({ id: 'd974310-20261102', tip: 974310 }),
  retainedDatasetIds: Object.freeze(['d972848-20261023', 'd972052-20261018', 'd971587-20261015']),
  owners: null,
  retainedOwnersIds: Object.freeze([]),
  importMapHash: 'sha256-7QdCEdJk1SXe5Rkyh+evXtkiWImVRL5euBmglVKAwTE=',
});

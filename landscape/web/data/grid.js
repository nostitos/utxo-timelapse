// Grid and tile geometry for the UTXO landscape (landscape/SPEC.md §2).
// Pure ES module: no DOM, no three.js, no Node APIs. Shared by the replay worker,
// the terrain renderer and the app shell.
//
// L0 cell (c0, r0) = (floor(height / blocksPerColumn), graph row of the amount).
// Level l merges 2^l columns and 2^min(l, 4) rows. Tiles are 256 x 256 cells; tile
// ids ascend by level, then row-major (ty, tx) within a level. Local cell index
// inside a tile = localRow * 256 + localCol.

export const BLOCKS_PER_COLUMN = 64;
export const ROWS = 2072;
export const TILE = 256;
export const BORDER = 1;
export const LEVELS = 7;
export const MAX_ROW_SHIFT = 4;
export const SLOT = TILE + 2 * BORDER;          // 258: packed tile side including the border
export const SLOT_CELLS = SLOT * SLOT;          // 66564
export const TILE_CELLS = TILE * TILE;          // 65536
export const BLOCKS_PER_WORLD_UNIT = 1000;      // x = block / 1000
export const ROWS_PER_WORLD_UNIT = 10;          // z = row / 10

function deriveLevels(l0Columns, rows, tileSize, levelCount) {
  const levels = [];
  let first = 0;
  for (let l = 0; l < levelCount; l++) {
    const rowShift = Math.min(l, MAX_ROW_SHIFT);
    const columns = Math.ceil(l0Columns / 2 ** l);
    const lrows = Math.ceil(rows / 2 ** rowShift);
    const tilesX = Math.ceil(columns / tileSize);
    const tilesY = Math.ceil(lrows / tileSize);
    levels.push(Object.freeze({ level: l, columnShift: l, rowShift, columns, rows: lrows, tilesX, tilesY, firstTile: first }));
    first += tilesX * tilesY;
  }
  return { levels, tiles: first };
}

/**
 * Builds the grid description from manifest.json (or any object with numBlocks).
 * Values listed in manifest.grid are checked against the derived ones; a mismatch
 * throws because it means the data and this code disagree about the contract.
 * @returns {{numBlocks:number, tip:number, blocksPerColumn:number, rows:number, l0Columns:number,
 *   tileSize:number, border:number, tiles:number, levels:Array<{level:number, columnShift:number,
 *   rowShift:number, columns:number, rows:number, tilesX:number, tilesY:number, firstTile:number}>}}
 */
export function gridFromManifest(manifest) {
  const numBlocks = manifest && manifest.numBlocks;
  if (!Number.isInteger(numBlocks) || numBlocks < 1) {
    throw new TypeError('gridFromManifest: manifest.numBlocks must be a positive integer');
  }
  const g = (manifest && manifest.grid) || {};
  const blocksPerColumn = g.blocksPerColumn ?? BLOCKS_PER_COLUMN;
  const rows = g.rows ?? ROWS;
  const tileSize = g.tileSize ?? TILE;
  const border = g.border ?? BORDER;
  if (blocksPerColumn !== BLOCKS_PER_COLUMN || tileSize !== TILE || border !== BORDER || rows !== ROWS) {
    throw new Error('gridFromManifest: unsupported grid parameters ' + JSON.stringify({ blocksPerColumn, rows, tileSize, border }));
  }
  const l0Columns = Math.ceil(numBlocks / blocksPerColumn);
  const { levels, tiles } = deriveLevels(l0Columns, rows, tileSize, LEVELS);
  const problems = [];
  if (g.l0Columns !== undefined && g.l0Columns !== l0Columns) problems.push('l0Columns ' + g.l0Columns + ' != ' + l0Columns);
  if (g.tiles !== undefined && g.tiles !== tiles) problems.push('tiles ' + g.tiles + ' != ' + tiles);
  if (Array.isArray(g.levels)) {
    if (g.levels.length !== LEVELS) problems.push('levels.length ' + g.levels.length + ' != ' + LEVELS);
    for (const given of g.levels) {
      const want = levels[given && given.level];
      if (!want) { problems.push('unknown level ' + JSON.stringify(given)); continue; }
      for (const key of Object.keys(want)) {
        if (given[key] !== undefined && given[key] !== want[key]) problems.push('level ' + want.level + ' ' + key + ' ' + given[key] + ' != ' + want[key]);
      }
    }
  }
  if (manifest.tip !== undefined && manifest.tip !== numBlocks - 1) problems.push('tip ' + manifest.tip + ' != ' + (numBlocks - 1));
  if (problems.length) throw new Error('gridFromManifest: manifest disagrees with the grid contract: ' + problems.join('; '));
  return Object.freeze({
    numBlocks, tip: numBlocks - 1, blocksPerColumn, rows, l0Columns, tileSize, border, tiles,
    levels: Object.freeze(levels),
  });
}

/** Tile id of tile (tx, ty) at a level, or -1 when outside that level. */
export function tileId(grid, level, tx, ty) {
  const L = grid.levels[level];
  if (!L || tx < 0 || ty < 0 || tx >= L.tilesX || ty >= L.tilesY) return -1;
  return L.firstTile + ty * L.tilesX + tx;
}

/** Level of a tile id, or -1 when the id is not a tile. */
export function levelOfTile(grid, id) {
  if (!(id >= 0 && id < grid.tiles)) return -1;
  const levels = grid.levels;
  for (let l = levels.length - 1; l >= 0; l--) if (id >= levels[l].firstTile) return l;
  return -1;
}

/**
 * Tile geometry: {id, level, tx, ty, col0, row0, cols, rows}. col0/row0 are the first
 * cell (at that level) and cols/rows the number of cells inside the grid (edge tiles are
 * partial). Returns null for an invalid id.
 */
export function tileInfo(grid, id) {
  const level = levelOfTile(grid, id);
  if (level < 0) return null;
  const L = grid.levels[level];
  const k = id - L.firstTile;
  const tx = k % L.tilesX;
  const ty = (k - tx) / L.tilesX;
  const T = grid.tileSize;
  const col0 = tx * T;
  const row0 = ty * T;
  return { id, level, tx, ty, col0, row0, cols: Math.min(T, L.columns - col0), rows: Math.min(T, L.rows - row0) };
}

/** Tile id holding cell (col, row) at a level, or -1 when the cell is outside the grid. */
export function tileOfCell(grid, level, col, row) {
  const L = grid.levels[level];
  if (!L || col < 0 || row < 0 || col >= L.columns || row >= L.rows) return -1;
  const T = grid.tileSize;
  return L.firstTile + Math.floor(row / T) * L.tilesX + Math.floor(col / T);
}

/** Number of L0 cells covered by cell (col, row) of a level inside the grid (0 outside). */
export function cellArea(grid, level, col, row) {
  const L = grid.levels[level];
  if (!L || col < 0 || row < 0 || col >= L.columns || row >= L.rows) return 0;
  const w = 2 ** L.columnShift;
  const h = 2 ** L.rowShift;
  return Math.min(w, grid.l0Columns - col * w) * Math.min(h, grid.rows - row * h);
}

/** Cell at a level containing L0 cell (c0, r0): {col, row}. */
export function cellOfL0(grid, level, c0, r0) {
  const L = grid.levels[level];
  return { col: Math.floor(c0 / 2 ** L.columnShift), row: Math.floor(r0 / 2 ** L.rowShift) };
}

/** Same-level neighbour of a tile (dx, dy in -1..1), or -1 when outside the level. */
export function neighborTile(grid, id, dx, dy) {
  const t = tileInfo(grid, id);
  if (!t) return -1;
  return tileId(grid, t.level, t.tx + dx, t.ty + dy);
}

/** Child tile ids at level - 1 (row-major); empty for L0 tiles. */
export function childTiles(grid, id) {
  const t = tileInfo(grid, id);
  if (!t || t.level === 0) return [];
  const L = grid.levels[t.level];
  const C = grid.levels[t.level - 1];
  const ys = C.rowShift < L.rowShift ? [2 * t.ty, 2 * t.ty + 1] : [t.ty];
  const out = [];
  for (const y of ys) {
    for (const x of [2 * t.tx, 2 * t.tx + 1]) {
      const c = tileId(grid, C.level, x, y);
      if (c >= 0) out.push(c);
    }
  }
  return out;
}

/** Parent tile id at level + 1, or null for the top level. */
export function parentTile(grid, id) {
  const t = tileInfo(grid, id);
  if (!t) return null;
  if (t.level === grid.levels.length - 1) return null;
  const L = grid.levels[t.level];
  const P = grid.levels[t.level + 1];
  return tileId(grid, P.level, t.tx >> 1, P.rowShift > L.rowShift ? t.ty >> 1 : t.ty);
}

/** L0 column -> [firstBlock, lastBlock] (inclusive, clipped to the chain). */
export function columnBlocks(grid, col) {
  const first = col * grid.blocksPerColumn;
  return [first, Math.min(first + grid.blocksPerColumn - 1, grid.numBlocks - 1)];
}

/** L0 column of a block height. */
export function columnOfBlock(grid, block) {
  return Math.floor(block / grid.blocksPerColumn);
}

/** World x of a block coordinate (x = block / 1000; column c spans [c*0.064, (c+1)*0.064)). */
export function worldX(block) { return block / BLOCKS_PER_WORLD_UNIT; }
/** World z of a graph row coordinate (z = row / 10; row 0 = largest amounts, farthest). */
export function worldZ(row) { return row / ROWS_PER_WORLD_UNIT; }
/** Inverse of worldX; fractional block coordinate (floor it for a height). */
export function blockFromWorldX(x) { return x * BLOCKS_PER_WORLD_UNIT; }
/** Inverse of worldZ; fractional row coordinate (floor it for a row). */
export function rowFromWorldZ(z) { return z * ROWS_PER_WORLD_UNIT; }

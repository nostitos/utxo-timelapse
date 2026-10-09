// GPU tile atlas for the landscape terrain (landscape/SPEC.md §5 frame format, §6).
//
// Each resident tile occupies one slot of 258 x 258 cells (one-cell border) with four floats
// per cell: [heightValue, heat, heatBlock, colorValue], exactly as the worker packs it.
// WebGPU: one storage buffer (slots x 66564 vec4) that is also the CPU copy; full tiles are
// uploaded as buffer ranges and per-cell deltas are scattered by a compute pass.
// WebGL2: a DataArrayTexture (one layer per slot) uploaded per layer.
// A page table texture maps tile id -> slot (or -1) for neighbour lookups in shaders.
import {
  StorageBufferAttribute, DataArrayTexture, DataTexture, RGBAFormat, RedFormat, FloatType,
  NearestFilter, ClampToEdgeWrapping, NoColorSpace,
} from 'three/webgpu';
import { storage, textureLoad, ivec2, int, Fn, instanceIndex, uniform } from 'three/tsl';
import { tileInfo, SLOT, SLOT_CELLS } from '../../data/grid.js';
import { rootTiles, PATCHES_PER_TILE } from './lod.js';
import { bumpPatchMax, recomputePatchMax } from './patchmax.js';

const FLOATS_PER_SLOT = SLOT_CELLS * 4;
const DELTA_CAPACITY = 1 << 17; // cells per scatter dispatch

export class TileAtlas {
  constructor({ renderer, grid, backend, capacity }) {
    this.renderer = renderer;
    this.grid = grid;
    this.webgpu = backend === 'webgpu';
    this.capacity = 0;
    this.slotTile = new Int32Array(0);
    this.tileSlot = new Int32Array(grid.tiles).fill(-1);
    this.tileState = new Uint8Array(grid.tiles); // 0 absent, 1 resident with data, 2 resident and empty
    this.lastUse = new Float64Array(0);
    this.useClock = 0;
    this.roots = new Set(rootTiles(grid));
    // Per patch maxima of the height and colour values (interior plus the +x/+z border
    // row the patch surface reaches); increases on deltas, recomputed on full tiles.
    this.patchMaxValue = new Float32Array(grid.tiles * PATCHES_PER_TILE);
    this.tileMaxValue = new Float32Array(grid.tiles);
    this.version = 0; // bumps on any data change
    this.residencyVersion = 0;
    this.stats = { uploadsFull: 0, uploadsDelta: 0, slotsUsed: 0, evictions: 0, scatterDispatches: 0, layerUploads: 0 };
    this.pendingLayers = new Set();
    this.maxLayerUploadsPerFrame = 24;
    this._pageDirty = true;
    this._createPageTable();
    this._createDeltaStaging();
    this.ensureCapacity(Math.max(1, capacity | 0));
  }

  // ---- storage -------------------------------------------------------------------------

  ensureCapacity(n) {
    if (n <= this.capacity) return false;
    const oldCap = this.capacity;
    const oldData = this.data;
    const data = new Float32Array(n * FLOATS_PER_SLOT);
    if (oldData) data.set(oldData.subarray(0, oldCap * FLOATS_PER_SLOT));
    this.data = data;
    const slotTile = new Int32Array(n).fill(-1);
    slotTile.set(this.slotTile);
    this.slotTile = slotTile;
    const lastUse = new Float64Array(n);
    lastUse.set(this.lastUse);
    this.lastUse = lastUse;
    this.capacity = n;
    if (this.webgpu) {
      if (this.attribute) this.attribute.dispose?.();
      this.attribute = new StorageBufferAttribute(data, 4);
      this.attribute.name = 'terrainAtlas';
      this.readNode = storage(this.attribute, 'vec4', n * SLOT_CELLS).toReadOnly();
      this.writeNode = storage(this.attribute, 'vec4', n * SLOT_CELLS);
      this._buildScatter();
    } else {
      if (this.texture) this.texture.dispose();
      const tex = new DataArrayTexture(data, SLOT, SLOT, n);
      tex.format = RGBAFormat;
      tex.type = FloatType;
      tex.minFilter = tex.magFilter = NearestFilter;
      tex.wrapS = tex.wrapT = ClampToEdgeWrapping;
      tex.generateMipmaps = false;
      tex.colorSpace = NoColorSpace;
      tex.needsUpdate = true;
      this.texture = tex;
      this.pendingLayers.clear();
    }
    this.layoutVersion = (this.layoutVersion || 0) + 1;
    return true;
  }

  _createPageTable() {
    const n = this.grid.tiles;
    this.pageData = new Float32Array(n * 4).fill(-1);
    const tex = new DataTexture(this.pageData, n, 1, RGBAFormat, FloatType);
    tex.minFilter = tex.magFilter = NearestFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = NoColorSpace;
    tex.needsUpdate = true;
    this.pageTexture = tex;
  }

  _createDeltaStaging() {
    if (!this.webgpu) return;
    this.deltaIndex = new StorageBufferAttribute(new Uint32Array(DELTA_CAPACITY), 1);
    this.deltaData = new StorageBufferAttribute(new Float32Array(DELTA_CAPACITY * 4), 4);
    this.deltaCount = 0;
  }

  _buildScatter() {
    const idx = storage(this.deltaIndex, 'uint', DELTA_CAPACITY).toReadOnly();
    const val = storage(this.deltaData, 'vec4', DELTA_CAPACITY).toReadOnly();
    const dst = this.writeNode;
    this.scatter = Fn(() => {
      dst.element(idx.element(instanceIndex)).assign(val.element(instanceIndex));
    })().compute(DELTA_CAPACITY, [128]);
    this.scatter.name = 'terrainAtlasScatter';
  }

  // ---- shader access -------------------------------------------------------------------

  /** vec4 node for slot-local cell (sx, sy) in 0..257 (border included) of a slot. */
  fetch(slotNode, sxNode, syNode) {
    if (this.webgpu) {
      return this.readNode.element(int(slotNode).mul(SLOT_CELLS).add(int(syNode).mul(SLOT)).add(int(sxNode)));
    }
    return textureLoad(this.texture, ivec2(int(sxNode), int(syNode))).depth(int(slotNode));
  }

  /** float node: slot of a tile id (-1 when not resident with data). */
  page(tileIdNode) {
    return textureLoad(this.pageTexture, ivec2(int(tileIdNode), int(0))).x;
  }

  // ---- residency -----------------------------------------------------------------------

  slotOf(id) {
    return this.tileSlot[id];
  }

  isResident(id) {
    return this.tileState[id] !== 0;
  }

  isEmpty(id) {
    return this.tileState[id] === 2;
  }

  touch(id) {
    const s = this.tileSlot[id];
    if (s >= 0) this.lastUse[s] = ++this.useClock;
  }

  _allocSlot(id, protectSet) {
    let s = this.tileSlot[id];
    if (s >= 0) return s;
    let best = -1;
    let bestUse = Infinity;
    for (let i = 0; i < this.capacity; i++) {
      const t = this.slotTile[i];
      if (t < 0) {
        best = i;
        break;
      }
      if (this.roots.has(t) || (protectSet && protectSet.has(t))) continue;
      if (this.lastUse[i] < bestUse) {
        bestUse = this.lastUse[i];
        best = i;
      }
    }
    if (best < 0) {
      // Everything is protected; take the least recently used non-root slot.
      for (let i = 0; i < this.capacity; i++) {
        const t = this.slotTile[i];
        if (this.roots.has(t)) continue;
        if (this.lastUse[i] < bestUse) {
          bestUse = this.lastUse[i];
          best = i;
        }
      }
    }
    if (best < 0) return -1;
    const old = this.slotTile[best];
    if (old >= 0) {
      this.tileSlot[old] = -1;
      this.tileState[old] = 0;
      this.stats.evictions++;
      this._setPage(old, -1);
    }
    this.slotTile[best] = id;
    this.tileSlot[id] = best;
    this.lastUse[best] = ++this.useClock;
    this._setPage(id, best);
    return best;
  }

  _freeTile(id) {
    const s = this.tileSlot[id];
    if (s >= 0) {
      this.slotTile[s] = -1;
      this.tileSlot[id] = -1;
      this._setPage(id, -1);
    }
    this.tileState[id] = 0;
  }

  _setPage(id, slot) {
    this.pageData[id * 4] = slot;
    this._pageDirty = true;
    this.residencyVersion++;
  }

  // ---- frames --------------------------------------------------------------------------

  /** Applies a worker frame. protectSet: tiles that must not be evicted (desired). Returns
   * {changedSlots:Set<number>, fullIds:number[], deltaCells:number, flashes:[{id, local, added}]}. */
  applyFrame(frame, { protectSet = null, onDeltaCell = null } = {}) {
    const out = { fullIds: [], deltaCells: 0 };
    if (frame.evicted) for (const id of frame.evicted) if (!this.roots.has(id)) this._freeTile(id);
    const full = frame.full || [];
    if (full.length && this.webgpu && this.deltaCount) this.flush();
    for (const t of full) {
      if (t.empty || !t.data) {
        // Resident and all zero: release any slot; the floor draws it.
        const s = this.tileSlot[t.id];
        if (s >= 0) {
          this.slotTile[s] = -1;
          this.tileSlot[t.id] = -1;
          this._setPage(t.id, -1);
        }
        this.tileState[t.id] = 2;
        this._resetMaxima(t.id);
        out.fullIds.push(t.id);
        continue;
      }
      const s = this._allocSlot(t.id, protectSet);
      if (s < 0) continue;
      const base = s * FLOATS_PER_SLOT;
      this.data.set(t.data.length === FLOATS_PER_SLOT ? t.data : t.data.subarray(0, FLOATS_PER_SLOT), base);
      this.tileState[t.id] = 1;
      this._markSlotFull(s);
      this._recomputeMaxima(t.id, s);
      out.fullIds.push(t.id);
      this.stats.uploadsFull++;
    }
    const d = frame.deltas;
    if (d && d.ids && d.ids.length) {
      const { ids, offsets, index, data } = d;
      for (let k = 0; k < ids.length; k++) {
        const id = ids[k];
        let s = this.tileSlot[id];
        const a = offsets[k];
        const b = offsets[k + 1];
        if (b <= a) continue;
        if (s < 0) {
          if (this.tileState[id] === 0) continue; // not resident here (raced with eviction)
          // An empty tile gains data: give it a zeroed slot.
          s = this._allocSlot(id, protectSet);
          if (s < 0) continue;
          this.data.fill(0, s * FLOATS_PER_SLOT, (s + 1) * FLOATS_PER_SLOT);
          this.tileState[id] = 1;
          this._markSlotFull(s);
        }
        const base = s * FLOATS_PER_SLOT;
        const pm = this.patchMaxValue;
        const pbase = id * PATCHES_PER_TILE;
        for (let j = a; j < b; j++) {
          const li = index[j];
          const o = base + li * 4;
          const src = j * 4;
          if (onDeltaCell) onDeltaCell(id, li, this.data, o, data, src);
          this.data[o] = data[src];
          this.data[o + 1] = data[src + 1];
          this.data[o + 2] = data[src + 2];
          this.data[o + 3] = data[src + 3];
          const v = data[src];
          if (v > 0) {
            const sy = (li / SLOT) | 0;
            const sx = li - sy * SLOT;
            this._bumpPatches(pm, pbase, sx - 1, sy - 1, v);
            if (v > this.tileMaxValue[id]) this.tileMaxValue[id] = v;
          }
          this._stageDelta(s, li, j, data);
        }
        out.deltaCells += b - a;
      }
      this.stats.uploadsDelta += out.deltaCells;
    }
    if (out.fullIds.length || out.deltaCells) this.version++;
    return out;
  }

  _bumpPatches(pm, pbase, lx, ly, v) {
    bumpPatchMax(pm, pbase, lx, ly, v);
  }

  _resetMaxima(id) {
    this.patchMaxValue.fill(0, id * PATCHES_PER_TILE, (id + 1) * PATCHES_PER_TILE);
    this.tileMaxValue[id] = 0;
  }

  _recomputeMaxima(id, s) {
    const m = this.patchMaxValue.subarray(id * PATCHES_PER_TILE, (id + 1) * PATCHES_PER_TILE);
    this.tileMaxValue[id] = recomputePatchMax(this.data, s * FLOATS_PER_SLOT, m);
  }

  _markSlotFull(s) {
    if (this.webgpu) {
      this.attribute.addUpdateRange(s * FLOATS_PER_SLOT, FLOATS_PER_SLOT);
      this._attrDirty = true;
    } else {
      this.pendingLayers.add(s);
    }
  }

  _stageDelta(s, li, j, data) {
    if (!this.webgpu) {
      this.pendingLayers.add(s);
      return;
    }
    if (this.deltaCount >= DELTA_CAPACITY) this.flush();
    const n = this.deltaCount++;
    this.deltaIndex.array[n] = s * SLOT_CELLS + li;
    const dd = this.deltaData.array;
    dd[n * 4] = data[j * 4];
    dd[n * 4 + 1] = data[j * 4 + 1];
    dd[n * 4 + 2] = data[j * 4 + 2];
    dd[n * 4 + 3] = data[j * 4 + 3];
  }

  /** Pushes pending changes to the GPU. Call once per frame before rendering (and it is
   * called automatically when the delta staging buffer fills). */
  flush() {
    if (this._pageDirty) {
      this.pageTexture.needsUpdate = true;
      this._pageDirty = false;
    }
    if (this.webgpu) {
      if (this.deltaCount) {
        const n = this.deltaCount;
        this.deltaIndex.addUpdateRange(0, n);
        this.deltaIndex.needsUpdate = true;
        this.deltaData.addUpdateRange(0, n * 4);
        this.deltaData.needsUpdate = true;
        if (this._attrDirty) {
          this.attribute.needsUpdate = true;
          this._attrDirty = false;
        }
        this.scatter.count = n;
        this.renderer.compute(this.scatter);
        this.deltaCount = 0;
        this.stats.scatterDispatches++;
      } else if (this._attrDirty) {
        this.attribute.needsUpdate = true;
        this._attrDirty = false;
      }
    } else if (this.pendingLayers.size) {
      let n = 0;
      for (const s of this.pendingLayers) {
        this.texture.addLayerUpdate(s);
        this.pendingLayers.delete(s);
        if (++n >= this.maxLayerUploadsPerFrame) break;
      }
      this.texture.needsUpdate = true;
      this.stats.layerUploads += n;
    }
    let used = 0;
    for (let i = 0; i < this.capacity; i++) if (this.slotTile[i] >= 0) used++;
    this.stats.slotsUsed = used;
  }

  /** Slot-local cell values (Float32Array view of 4) or null. */
  cell(id, lx, ly) {
    const s = this.tileSlot[id];
    if (s < 0) return this.tileState[id] === 2 ? new Float32Array(4) : null;
    const o = s * FLOATS_PER_SLOT + ((ly + 1) * SLOT + (lx + 1)) * 4;
    return this.data.subarray(o, o + 4);
  }

  /** Patch maxima of a tile (Float32Array view of 16). */
  patchMax(id) {
    return this.patchMaxValue.subarray(id * PATCHES_PER_TILE, (id + 1) * PATCHES_PER_TILE);
  }

  get bytes() {
    return this.capacity * FLOATS_PER_SLOT * 4;
  }

  dispose() {
    this.attribute?.dispose?.();
    this.texture?.dispose();
    this.pageTexture.dispose();
  }
}

export { FLOATS_PER_SLOT, DELTA_CAPACITY };

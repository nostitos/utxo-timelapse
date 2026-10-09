// Renderer creation and capability report (render_post).
//
// WebGPU path: the adapter is requested here with high-performance preference and the device
// is created with every adapter feature and every adapter limit at its maximum, so the
// terrain atlas (hundreds of MB in one storage buffer) and timestamp queries are available.
// WebGL2 path (forceWebGL or no navigator.gpu): WebGPURenderer's WebGL2 backend; compute
// features are off and the settings store caps presets at High.
import { WebGPURenderer, HalfFloatType, ColorManagement } from 'three/webgpu';
import {
  DisplayP3ColorSpace, DisplayP3ColorSpaceImpl,
  LinearDisplayP3ColorSpace, LinearDisplayP3ColorSpaceImpl,
} from 'three/addons/math/ColorSpaces.js';

let p3Defined = false;

/** Registers Display P3 with three's ColorManagement (idempotent) and returns its name. */
export function defineDisplayP3() {
  if (!p3Defined) {
    ColorManagement.define({
      [DisplayP3ColorSpace]: DisplayP3ColorSpaceImpl,
      [LinearDisplayP3ColorSpace]: LinearDisplayP3ColorSpaceImpl,
    });
    p3Defined = true;
  }
  return DisplayP3ColorSpace;
}

function plainLimits(limits) {
  const out = {};
  if (!limits) return out;
  for (const key in limits) {
    const v = limits[key];
    if (typeof v === 'number') out[key] = v;
  }
  return out;
}

function adapterInfo(adapter) {
  const info = adapter && adapter.info;
  if (!info) return null;
  return { vendor: info.vendor || '', architecture: info.architecture || '', device: info.device || '', description: info.description || '' };
}

function displaySupportsP3() {
  try { return typeof matchMedia === 'function' && matchMedia('(color-gamut: p3)').matches; } catch { return false; }
}

function glReport(gl) {
  const limits = {
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    maxArrayTextureLayers: gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS),
    max3DTextureSize: gl.getParameter(gl.MAX_3D_TEXTURE_SIZE),
    maxDrawBuffers: gl.getParameter(gl.MAX_DRAW_BUFFERS),
    maxSamples: gl.getParameter(gl.MAX_SAMPLES),
    maxUniformBlockSize: gl.getParameter(gl.MAX_UNIFORM_BLOCK_SIZE),
    maxVertexTextureImageUnits: gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS),
    maxTextureImageUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),
  };
  const extensions = gl.getSupportedExtensions() || [];
  let renderer = '';
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  if (dbg) renderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '');
  return { limits, extensions, renderer };
}

const WEBGL_TILE_CAP = 400;
const WEBGPU_TILE_CAP = 400;

/**
 * Capability guess before the view exists (for the settings store's WebGL2 cap). Requests an
 * adapter or a throwaway WebGL2 context; no device is created.
 */
export async function probeCapabilities({ forceWebGL = false } = {}) {
  if (!forceWebGL && typeof navigator !== 'undefined' && navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (adapter) {
        const limits = plainLimits(adapter.limits);
        return {
          backend: 'webgpu', compute: true, timestamp: adapter.features.has('timestamp-query'),
          maxTileBudget: WEBGPU_TILE_CAP, maxInstances: Math.min(8000000, Math.floor((limits.maxStorageBufferBindingSize || 134217728) / 16)),
          limits, adapter: adapterInfo(adapter), p3: true,
          p3Display: displaySupportsP3(), maxDimension: limits.maxTextureDimension2D || 8192, probe: true,
        };
      }
    } catch { /* fall through to WebGL2 */ }
  }
  let gl = null;
  try {
    const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
    gl = c.getContext('webgl2');
  } catch { gl = null; }
  if (!gl) return { backend: 'none', compute: false, timestamp: false, maxTileBudget: 0, maxInstances: 0, limits: {}, p3: false, p3Display: false, probe: true };
  const rep = glReport(gl);
  const lose = gl.getExtension('WEBGL_lose_context');
  if (lose) lose.loseContext();
  return {
    backend: 'webgl2', compute: false, timestamp: rep.extensions.includes('EXT_disjoint_timer_query_webgl2'),
    maxTileBudget: Math.min(WEBGL_TILE_CAP, rep.limits.maxArrayTextureLayers), maxInstances: 0, limits: rep.limits,
    adapter: { description: rep.renderer }, p3: 'drawingBufferColorSpace' in gl, p3Display: displaySupportsP3(),
    maxDimension: rep.limits.maxTextureSize, probe: true,
  };
}

/**
 * Creates and initialises the renderer.
 * @returns {Promise<{renderer, backend, capabilities, device, setDisplayP3(enabled), dispose()}>}
 */
export async function createRenderContext({ canvas, forceWebGL = false, powerPreference = 'high-performance' } = {}) {
  let adapter = null;
  let device = null;
  let deviceNote = null;
  if (!forceWebGL && typeof navigator !== 'undefined' && navigator.gpu) {
    try {
      adapter = await navigator.gpu.requestAdapter({ powerPreference });
    } catch (e) {
      deviceNote = 'requestAdapter failed: ' + (e && e.message || e);
    }
    if (adapter) {
      const requiredFeatures = [...adapter.features];
      const requiredLimits = plainLimits(adapter.limits);
      try {
        device = await adapter.requestDevice({ requiredFeatures, requiredLimits, label: 'utxo-landscape' });
      } catch (e) {
        // Retry with only the limits the terrain atlas and compute passes depend on.
        deviceNote = 'full-limit device request failed (' + (e && e.message || e) + '); retried with essential limits';
        const keep = ['maxBufferSize', 'maxStorageBufferBindingSize', 'maxStorageBuffersPerShaderStage',
          'maxComputeInvocationsPerWorkgroup', 'maxComputeWorkgroupSizeX', 'maxComputeWorkgroupsPerDimension',
          'maxTextureDimension2D', 'maxColorAttachmentBytesPerSample'];
        const essential = {};
        for (const k of keep) if (k in requiredLimits) essential[k] = requiredLimits[k];
        try {
          device = await adapter.requestDevice({ requiredFeatures, requiredLimits: essential, label: 'utxo-landscape' });
        } catch (e2) {
          deviceNote += '; essential request failed: ' + (e2 && e2.message || e2);
          device = null;
        }
      }
    } else if (!deviceNote) {
      deviceNote = 'no WebGPU adapter';
    }
  } else {
    deviceNote = forceWebGL ? 'WebGL2 forced' : 'navigator.gpu unavailable';
  }

  const webgpu = !!device;
  const renderer = new WebGPURenderer({
    canvas,
    device: device || undefined,
    forceWebGL: !webgpu,
    antialias: false,
    alpha: false,
    // WebGL2 timer queries cannot nest, so three times one context per frame; on this Mac it
    // reported the vsync interval. GPU timing is therefore WebGPU-only.
    trackTimestamp: webgpu,
    powerPreference,
    outputBufferType: HalfFloatType,
  });
  await renderer.init();
  renderer.shadowMap.enabled = true;

  let capabilities;
  let gl = null;
  if (webgpu) {
    const limits = plainLimits(device.limits);
    capabilities = {
      backend: 'webgpu',
      compute: true,
      timestamp: !!renderer.backend.trackTimestamp,
      maxTileBudget: WEBGPU_TILE_CAP,
      maxInstances: Math.min(8000000, Math.floor((limits.maxStorageBufferBindingSize || 134217728) / 16)),
      limits,
      features: [...device.features].sort(),
      adapter: adapterInfo(adapter),
      p3: true,
      p3Display: displaySupportsP3(),
      maxDimension: limits.maxTextureDimension2D || 8192,
      note: deviceNote,
    };
  } else {
    gl = renderer.backend.gl;
    const rep = glReport(gl);
    capabilities = {
      backend: 'webgl2',
      compute: false,
      timestamp: false,
      maxTileBudget: Math.min(WEBGL_TILE_CAP, rep.limits.maxArrayTextureLayers),
      maxInstances: 0,
      limits: rep.limits,
      features: rep.extensions.slice().sort(),
      adapter: { description: rep.renderer },
      p3: 'drawingBufferColorSpace' in gl,
      p3Display: displaySupportsP3(),
      maxDimension: rep.limits.maxTextureSize,
      note: deviceNote,
    };
  }

  let p3Enabled = false;
  function setDisplayP3(enabled) {
    enabled = !!enabled && capabilities.p3;
    if (enabled === p3Enabled) return p3Enabled;
    if (webgpu) {
      // The backend configures the canvas once (sRGB) on first access; reconfigure the same
      // context with the P3 colour space. Rendering keeps using getCurrentTexture().
      const context = renderer.backend.context;
      context.configure({
        device,
        format: renderer.backend.utils.getPreferredCanvasFormat(),
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        alphaMode: 'opaque',
        colorSpace: enabled ? 'display-p3' : 'srgb',
        toneMapping: { mode: 'standard' },
      });
    } else if (gl && 'drawingBufferColorSpace' in gl) {
      gl.drawingBufferColorSpace = enabled ? 'display-p3' : 'srgb';
    }
    if (enabled) defineDisplayP3();
    p3Enabled = enabled;
    return p3Enabled;
  }

  return {
    renderer,
    backend: capabilities.backend,
    capabilities,
    device,
    setDisplayP3,
    get p3() { return p3Enabled; },
    dispose() {
      renderer.dispose();
      if (device && typeof device.destroy === 'function') device.destroy();
    },
  };
}

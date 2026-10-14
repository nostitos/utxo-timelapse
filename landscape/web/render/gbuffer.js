// G-buffer attachments of the scene pass (render/post.js): normal for AO/SSGI/SSR, metalness
// and roughness for SSR, diffuse for SSGI, velocity for TRAA and motion blur.
//
// three gives extra MRT attachments no blending, so a transparent quad (a flash sprite, the
// now plane) would stamp its whole rectangle into them, alpha or not: at Extreme the SSR then
// reflected the sky inside a square around every flash. The scene pass therefore gives these
// attachments alpha blending, which opaque surfaces still overwrite (their outputs convert to
// vec4 with alpha 1), and transparent materials write zero alpha to them, so they leave the
// attachments untouched.
//
// Those zero outputs follow the attachments the pass actually has (post.js reports them with
// setGBufferLayout). Declaring outputs the pass lacks broke two ways in three r186: with no
// G-buffer at all (Performance, BitcoinTimelapse.com) the shader's output struct came out empty and the now
// plane's pipeline failed to compile, so it never drew; and because three keys a render
// pipeline by shader code plus the first colour format only, identical zero outputs let a
// pipeline built for (output, normal, velocity) be reused for (output, normal, metalrough),
// whose third attachment has another format, and the whole frame failed validation and came
// out black (Extreme with motion blur off). Each output also writes its own constant (alpha
// still 0), so the shader code, and with it the pipeline, differs per layout.
import { BlendMode, NormalBlending } from 'three/webgpu';
import { mrt, vec4 } from 'three/tsl';

export const G_BUFFER_OUTPUTS = Object.freeze(['normal', 'metalrough', 'diffuse', 'velocity']);

const materials = new Set();
let layout = null; // G-buffer outputs of the current scene pass; null until post.js reports them

/** Blend mode of every G-buffer attachment: source alpha over, so alpha 0 writes nothing. */
export function gBufferBlend() {
  return new BlendMode(NormalBlending);
}

function zeroWrites(names) {
  if (!names.length) return null;
  return mrt(Object.fromEntries(names.map((name) => [name, vec4((G_BUFFER_OUTPUTS.indexOf(name) + 1) / 8, 0, 0, 0)])));
}

/**
 * Makes a transparent material leave every G-buffer attachment of the scene pass untouched,
 * now and after the pass's attachments change. Returns the material.
 */
export function noGBufferWrites(material) {
  materials.add(material);
  material.mrtNode = zeroWrites(layout ?? G_BUFFER_OUTPUTS);
  return material;
}

/** Called by render/post.js with the G-buffer outputs the scene pass now has. */
export function setGBufferLayout(names) {
  const next = G_BUFFER_OUTPUTS.filter((name) => names.includes(name));
  if (layout && layout.join() === next.join()) return;
  layout = next;
  for (const material of materials) {
    material.mrtNode = zeroWrites(layout);
    material.needsUpdate = true;
  }
}

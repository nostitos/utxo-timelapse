// G-buffer attachments of the scene pass (render/post.js): normal for AO/SSGI/SSR, metalness
// and roughness for SSR, diffuse for SSGI, velocity for TRAA and motion blur.
//
// three gives extra MRT attachments no blending, so a transparent quad (a flash sprite, the
// now plane) would stamp its whole rectangle into them, alpha or not: at Extreme the SSR then
// reflected the sky inside a square around every flash. The scene pass therefore gives these
// attachments alpha blending, which opaque surfaces still overwrite (their outputs convert to
// vec4 with alpha 1), and transparent materials declare zero outputs for them, so they leave
// the attachments untouched. three ignores material outputs the pass does not use.
import { BlendMode, NormalBlending } from 'three/webgpu';
import { mrt, vec4 } from 'three/tsl';

export const G_BUFFER_OUTPUTS = Object.freeze(['normal', 'metalrough', 'diffuse', 'velocity']);

/** Blend mode of every G-buffer attachment: source alpha over, so alpha 0 writes nothing. */
export function gBufferBlend() {
  return new BlendMode(NormalBlending);
}

/** mrtNode for a transparent material: nothing reaches any G-buffer attachment. */
export function noGBufferWrites() {
  return mrt(Object.fromEntries(G_BUFFER_OUTPUTS.map((name) => [name, vec4(0, 0, 0, 0)])));
}

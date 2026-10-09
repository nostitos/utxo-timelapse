# Vendored three.js 0.186.0

Unmodified files from the npm package `three@0.186.0`
(tarball sha256 `61eeff9d7616005c9a481c796f52287d81fbbbc0d55eaca5565322924252c1aa`,
npm integrity `sha512-cr/fIM2ddMSVbYVgkfD4jLJv7Fh/8ZTjvo+7gQeSVGUZHxpx9FDwoL5iC7hUz/LiRA8wMbqfnb90xKfm1/HHkQ==`).

| Path here | Package path |
|---|---|
| `three.core.js`, `three.webgpu.js`, `three.tsl.js` | `build/` |
| `addons/tsl/`, `addons/csm/` | `examples/jsm/tsl/`, `examples/jsm/csm/` |
| `addons/objects/SkyMesh.js`, `addons/math/SimplexNoise.js`, `addons/math/ColorSpaces.js` (Display P3), `addons/utils/CameraUtils.js`, `addons/controls/OrbitControls.js` (terrain dev pages) | `examples/jsm/...` |
| `addons/libs/lil-gui.module.min.js` | `examples/jsm/libs/` (lil-gui 0.17.0, MIT, header retained) |

three.js is MIT licensed; see `LICENSE`. The page import map resolves
`three` and `three/webgpu` to `three.webgpu.js`, `three/tsl` to
`three.tsl.js` and `three/addons/` to `addons/`. Add further addons by
copying the unmodified package file to the same relative path.

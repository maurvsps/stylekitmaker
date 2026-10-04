# Kit Maker (3D football kit creator)

A football kit maker: a Blender pipeline that generates kit meshes, and a three.js web editor that paints them.

| Folder | What it holds |
| --- | --- |
| `blender/make_kit.py` | Mesh generation, UV unwrap, UV layout PNGs, GLB export |
| `assets/uv/` | UV layout guides (`<garment>_uv_1024.png`, `<garment>_uv_2048.png`) and the UV template JSON |
| `public/models/` | `shirt.glb`, `shorts.glb`, `socks.glb` (Draco), each with `<garment>.json` (UV template the editor reads) and `<garment>_uv.png` (editor overlay) |
| `web/` | Vite + React + three.js editor (serves `/public` so the models load from `/models/...`) |

Status: both parts work. Blender builds four shirt templates (crew, V-neck, polo, long sleeve), shorts and socks; the React editor paints and exports them.

## Part 1: Blender pipeline

Needs Blender 4.2 or newer (the glTF exporter ships with it). From the repository root:

```bash
blender --background --python blender/make_kit.py
blender --background --python blender/make_kit.py -- --collar polo --sleeves long --fit loose
```

Options after `--` override the constants at the top of the script:

| Option | Values | Default |
| --- | --- | --- |
| `--collar` | `crew`, `v-neck`, `polo` | `crew` |
| `--sleeves` | `short`, `long`, or a length in metres (`0.4`) | `short` |
| `--fit` | `slim`, `regular`, `loose` | `regular` |
| `--only` | comma-separated templates: `shirt`, `shorts`, `socks` | all three |

With no `--collar`, `--sleeves` or `--name`, `shirt` builds every entry of `SHIRT_VARIANTS` (`shirt`, `shirt_vneck`, `shirt_polo`, `shirt_long`). Every run rewrites `public/models/kits.json`, the list the editor's template selector reads.
| `--name` | output basename | the template name |
| `--no-draco` | export uncompressed | off |

Other constants: `SLEEVE_ANGLE` (sleeve pose, degrees below horizontal), `SUBDIVISION_LEVELS`, `FOLD_STRENGTH`, `UV_SIZES`,
`DRAPE_FRAMES` (cloth simulation length, 0 = off), `AO_SIZE` / `AO_SAMPLES` / `AO_FLOOR` (baked shading).

What it does:

1. Builds each garment as connected meshes, applies a Catmull-Clark subdivision modifier, then adds procedural folds.
   It then drapes the shirt and shorts with Blender's cloth simulation onto an invisible athletic mannequin
   (`TORSO`, `NECK`, `LEG` and arms along the sleeves): the shirt hangs from the collar, the shorts from the
   waistband, and the folds relax into natural shapes. Socks keep their modelled shape.
   Finally Cycles bakes ambient occlusion (garment and mannequin both shade it) into `public/models/<name>_ao.png`,
   which the editor uses for contact shadows and fold depth. A full build takes about 3 minutes.
   - **Shirt** (about 11k triangles): front and back panels, two sleeves bridged to the armholes, a collar band.
     Folds: drag folds from the armpits to the waist, bunching over the hips, a hem wave, creases under the sleeves.
   - **Shorts** (about 8k): front and back panels that split into two legs at the crotch, plus a waistband.
     Folds: hem drape, crotch creases.
   - **Socks** (about 7k, both socks in one file): a tube from below the knee that bends into a foot with a heel and
     a closed toe, plus a top band. Folds: wrinkles at the ankle and under the knee.
2. Unwraps each piece into its own island, laid out like a sewing pattern. Within a garment all islands share one
   scale (texture units per metre), so a 5 cm stripe is 5 cm everywhere, and they never overlap. The script counts
   flipped UV faces and prints the result.
   - Shirt islands: `front`, `back`, `sleeve_left`, `sleeve_right`, `collar`.
   - Shorts islands: `front`, `back`, `waistband`.
   - Socks islands: `sock_left`, `sock_right`, `sock_top_left`, `sock_top_right`.
3. Writes the UV layout guides to `assets/uv/`.
4. Materials (double-sided): `shirt_body`, `shirt_sleeves`, `shirt_collar`; `shorts_body`, `shorts_waistband`; `socks_body`, `socks_top`.
5. Exports `public/models/<garment>.glb` with Draco compression. Each garment has its own texture.

All three share one frame (metres, shirt hem at z = 0, shorts waist under it, socks below the knee), so loading them together shows a full kit. Left and right are the wearer's (+X is the wearer's left).

### Draco

Official Blender builds include the Draco library and the exporter compresses directly. When the library is missing (the `bpy` module from pip), the script exports uncompressed and compresses with `gltf-transform` from `web/node_modules` (run `npm install` in `web/` first). It prints which path it used. The "Draco mesh compression is not available" line in that case comes from the exporter and can be ignored.

### Without Blender on PATH

The `bpy` wheel (Blender as a Python module) runs the same script:

```bash
python3.11 -m venv .bpy && .bpy/bin/pip install bpy==4.2.0
.bpy/bin/python blender/make_kit.py -- --collar v-neck
```

### UV template (`public/models/<name>.json`)

One square texture covers every part. Each island has a local frame in metres, as seen from outside the garment (p to the right, q up):

- front and back: p = across from the centre line, q = up from the hem. On the back, p runs toward the wearer's right, so the back reads correctly from behind.
- sleeves: p = around from the top line (the underarm seam is at both ends), q = minus the distance from the shoulder (the cuff is the last few cm).
- collar, waistband: p = around from the front centre (seam at the back), q = up the band.
- shorts front and back: like the shirt, but q is the straight height above the leg hem (so horizontal designs stay straight across the curved crotch seam).
- socks: p = around from the front of the shin (it becomes the top of the foot; seam at the back and the sole), q = minus the distance along the sock from its top edge.

`rect` is `[x, y, w, h]` in texture units with the origin at the top-left. A local point lands at `x = rect.x + scale * (p - pmin)`, `y = rect.y + scale * (qmax - q)`. Draw the canvas top-down and use it as a `CanvasTexture` with `flipY = false`.

### Adding templates

Write a function that returns a `Part` (vertices, faces with per-corner local UVs, islands, materials) and an optional fold function, then register both in `TEMPLATES`. `shirt_part` is the reference.

## Part 2: Web editor (React)

```bash
cd web
npm install
npm run dev        # http://localhost:5174
npm run dev:phone  # same, also on your network: open the printed Network URL on a phone on the same Wi-Fi
npm run build      # web/dist (with the kit models from /public/models listed in kits.json)
npm run build:artifact  # web/dist-artifact: self-contained copy for a claude.ai artifact (see below)
```

| File | Role |
| --- | --- |
| `src/design.js` | The design state, its defaults, patterns, fonts, and `sanitizeDesign` (used for loaded JSON and the saved draft) |
| `src/kitTexture.js` | Paints one garment's texture from the design and its UV template (plain canvas code, no React) |
| `src/Viewer.jsx` | three.js scene: GLTFLoader + DRACOLoader (decoder served at `/draco/`), OrbitControls, studio lighting, contact shadow; exposes `screenshot()` and camera presets |
| `src/App.jsx` | Holds the state, loads `kits.json` and the templates, repaints the three textures on every change (at most once per frame) |
| `src/Panel.jsx` | The side panel |

The whole design is one object:

```js
{ template: "shirt", colors: ["#c8102e", "#ffffff", "#0b1f3a"], pattern: "stripes",
  logo: null /* or { src: data URL, name, x, y (cm), scale } */, sponsor: "SQUAREGOAL", name: "VEGA", number: "10", font: "Oswald" }
```

- **Textures:** each garment has its own hidden 2048 px canvas, used as a `CanvasTexture` (`flipY = false`). Patterns are drawn in body coordinates (metres), so they line up across the side seams.
- **Colours:** primary and secondary make the shirt pattern. The trim colour paints the collar, cuffs, waistband, sock tops and lettering. Shorts use the secondary colour with a primary hem; socks use the primary colour with two secondary hoops.
- **Patterns:** solid, stripes, hoops, halves, sash, chevron, gradient. Sleeves follow the pattern where it makes sense (hoops and halves); otherwise they're the primary colour.
- **Placement:** the crest (PNG/SVG, up to 1.5 MB) sits on the wearer's left chest, with sliders to move it ±15 cm and scale it. The small number goes opposite the crest, the sponsor across the chest, the name and big number on the back, and the number on the front left leg of the shorts.
- **Fonts:** Oswald, Bebas Neue, Anton, Teko and Saira Condensed, loaded from Google Fonts. Text is repainted when a font arrives; without a connection it falls back to Impact or sans-serif.
- **Export:** a PNG screenshot of the 3D view, and a flat PNG texture per garment.
- **Mobile:** under 760 px wide, the 3D view takes the top of the screen and the panel scrolls below. Drag with one finger to rotate and pinch to zoom.
- **Design file:** Save and Load JSON (`{ version: 1, ...design }`). Anything invalid in a loaded file falls back to the default for that field. The current design is also kept in `localStorage`.

### Phone link (claude.ai artifact)

The editor is also published as a private claude.ai page, so it opens on a phone without a computer running: https://claude.ai/artifact/S7FDdtxhaVkzRXfmd5TmTT

`npm run build:artifact` makes that copy in `web/dist-artifact/`. That host blocks downloads and `.glb` files and may refuse WebAssembly, so this build differs from the normal one in three ways:

- Exports open in a sheet: press and hold an image to save it, or copy the design JSON.
- Models are glTF JSON with the binary embedded (`models/<name>.gltf.json`).
- Draco runs as the plain JS decoder.

Republish after changing the models or the editor.

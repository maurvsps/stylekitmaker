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
`DRAPE_FRAMES` (cloth simulation length, 0 = off), `AO_SIZE` / `AO_SAMPLES` / `AO_FLOOR` (baked shading),
`THICKNESS` (fabric thickness), `JOHNNY` (the polo collar's profile).

What it does:

1. Builds each garment as connected meshes, applies a Catmull-Clark subdivision modifier, then adds procedural folds.
   It then drapes the shirt and shorts with Blender's cloth simulation onto an invisible athletic mannequin
   (`TORSO`, `NECK`, `LEG` and arms along the sleeves): the shirt hangs from the collar, the shorts from the
   waistband, and the folds relax into natural shapes. Socks keep their modelled shape.
   Finally Cycles bakes ambient occlusion (garment and mannequin both shade it) into `public/models/<name>_ao.png`,
   which the editor uses for contact shadows and fold depth. Last, every garment gets a fabric thickness (an inner
   shell joined to the outside by a rim), so hems, cuffs and collar edges look like cloth rather than a sheet.
   A full build takes about 3 minutes.
   - **Shirt** (about 22k triangles with the thickness): front and back panels, two sleeves bridged to the armholes,
     a collar band. The polo is a retro johnny collar: a V opening and a fold-down collar that stands about 3 cm at
     the back and lies on the chest in two points at the front (the cloth under it is held still while it drapes).
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
| `src/project.js` | The project schema (version 4): palette, player, uploaded images and a layer stack per garment; `sanitizeProject` (loaded JSON and the saved draft, migrating version 1 to 3 files) and the layer-tree operations |
| `src/design.js` | The version 1 design (one flat object, files saved before the layer editor), migrated by `project.js`; the font list |
| `src/library.js` | Base designs, trims, patterns, graphics and garment regions (for masks): metadata for the panel plus their canvas painters and shapes |
| `src/kitTexture.js` | The layer compositor: paints one garment's texture from its ordered layers and its UV template, and its material maps (height → normal, roughness / metalness) from the layers' finishes (plain canvas code, no React) |
| `src/kitRenderer.js` | Owns the texture canvases (colour, the collar's own texture, material maps when used) and repaints only what changed |
| `src/Viewer.jsx` | three.js scene: GLTFLoader + DRACOLoader (decoder served at `/draco/`), OrbitControls, studio lighting with soft shadows from the key light, contact shadow, rib knit on the collar, cuffs and sock tops (placed from the UV templates); exposes `screenshot()` and camera presets |
| `src/App.jsx` | Holds the project, loads `kits.json` and the templates, decodes uploaded images and fonts, asks the renderer to repaint (at most once per frame) |
| `src/Panel.jsx`, `src/LayersPanel.jsx` | The side panel: kit colours, the Layers editor, and shortcuts for the player, sponsor and crest |

The project is one object (`project.js` documents every field):

```js
{ version: 4, template: "shirt", palette: ["#c8102e", "#ffffff", "#0b1f3a"], font: "Oswald",
  player: { name: "VEGA", number: "10" }, assets: { /* id: { src: data URL, name } */ },
  garments: { shirt: { layers: [/* bottom to top */] }, shorts: { layers: [] }, socks: { layers: [] } } }
```

- **Layers:** every garment is a stack of non-destructive layers, painted bottom to top: base design, pattern, graphic, image, text, material effect and group. Each layer has visibility, lock, a name, opacity, a blend mode (16 canvas modes), a transform (position, scale X/Y, rotation, horizontal and vertical flip) and a mask. Patterns move, scale and rotate in body coordinates, so they stay continuous across the side seams. Layer colours are either a palette entry (`"@0"` to `"@2"`, so changing a kit colour recolours every layer that uses it) or a fixed `#rrggbb`.
- **Layers panel:** Shirt / Shorts / Socks tabs, the list (top layer first) with drag-and-drop by the ⠿ handle (mouse or finger; drop onto a group to put a layer inside it), show/hide, lock, rename (double-click), duplicate, delete and move up/down, and the selected layer's settings underneath.
- **Textures:** each garment has its own hidden 2048 px canvas, used as a `CanvasTexture` (`flipY = false`). A layer paints island by island, clipped to the island plus 6 px of bleed. Patterns are drawn in body coordinates (metres), so they line up across the side seams; placed layers (text, image, graphic) are positioned in metres in their part's frame ("Placed on": front, back, sleeves, socks). Layers with opacity below 1 or a blend mode are composited from a scratch canvas.
- **Masks and garment regions:** a mask limits a layer to some regions ("Show only on") and hides it on others ("Hide on"). Regions are whole parts (front, back, each sleeve, collar; shorts front, back, waistband; each sock, top bands) and zones inside them (cuffs, side panels, shoulders; shorts hem and side panels), defined in the UV frames in metres. A group's mask applies to every layer inside it. Without a mask, a pattern covers the panels, sleeves and socks.
- **Base designs and trims:** a base design is the opaque ground (body and sleeves, shorts, socks with or without hoops). Trims (collar and cuffs, hem and waistband, sock top band) are their own layer, normally above the patterns.
- **Patterns:** stripes, pinstripes, hoops, halves, quarters, sash, chevron, chest band, checks and gradient, each with its colours and an optional background.
- **Libraries:** 28 patterns (stripes, hoops, diagonals, zigzag, waves, dots, diamonds, argyle, hexagons, camo, gradients and more), base designs per garment (shirt: classic, contrast back, split sleeves, raglan; shorts: plain, side panels; socks: two hoops, calf band, plain) and 15 graphics.
- **Materials (PBR):** every layer has a Finish: relief (raised or pressed in), stitched (embroidery), its own roughness and metalness, with presets (flat print, embroidered, raised, glossy vinyl, debossed, metallic foil). Material effect layers change the fabric over their mask: satin, gloss, matte cotton, metallic, perforated mesh, ribbed knit, embossed pinstripes, quilted diamonds. They paint two extra maps per garment, only while something uses them: a height map turned into a normal map (added on top of the knit in the shader) and a glTF roughness / metalness map. Colour changes never repaint them. Without finishes the kit renders exactly as before.
- **Collar:** the collar mesh gets its own texture (twice the garment width, so about five times the pixels on the thin band), painted from the same layers. Text, images and graphics can be placed on the collar.
- **Editing:** undo / redo (Ctrl+Z, Ctrl+Shift+Z or Ctrl+Y; quick changes such as dragging a slider merge into one step), copy / paste layers between garments (Ctrl+C, Ctrl+V), duplicate (Ctrl+D) and Delete.
- **Stage:** 3D view or Texture view (the flat texture of the garment in the Layers tab, with the UV guide), camera presets (front, 3/4, side, back, chest close-up), lighting presets (studio, daylight, dramatic, flat) and a mannequin on/off switch. The texture resolution (1024, 2048, 4096), lighting, mannequin and transparent-export setting are remembered by the browser, not saved in the design.
- **Shortcuts:** the Player section edits the name and number shown by bound text layers, the kit font, and the sponsor layer; the Crest section uploads or replaces the crest layer's image. Images (PNG, SVG, JPEG, WebP, up to 1.5 MB each) can be added as any number of image layers.
- **Fonts:** Oswald, Bebas Neue, Anton, Teko and Saira Condensed, loaded from Google Fonts. Text is repainted when a font arrives; without a connection it falls back to Impact or sans-serif.
- **Export:** a PNG screenshot of the 3D view, framed 1:1, 16:9 or 9:16 images (2048 px long side), optionally with a transparent background, a flat PNG texture per garment and, when a garment has finishes, its normal map and roughness / metalness map.
- **Mobile:** under 760 px wide, the 3D view takes the top of the screen and the panel scrolls below. Drag with one finger to rotate and pinch to zoom. On touch devices the material maps are painted at half resolution and the 3D view renders at most 1.5 pixels per CSS pixel; small phones start at 1024 px textures.
- **Design file:** Save and Load JSON (the version 4 project; images that no layer uses are dropped). Version 1 to 3 files (and drafts saved by older versions) are migrated on load and paint exactly as before. Anything invalid in a loaded file falls back to the default for that field. The current project is also kept in `localStorage`.

### Phone link (claude.ai artifact)

The editor is also published as a private claude.ai page, so it opens on a phone without a computer running: https://claude.ai/artifact/S7FDdtxhaVkzRXfmd5TmTT

`npm run build:artifact` makes that copy in `web/dist-artifact/`. That host blocks downloads and `.glb` files and may refuse WebAssembly, so this build differs from the normal one in three ways:

- Exports open in a sheet: press and hold an image to save it, or copy the design JSON.
- Models are glTF JSON with the binary embedded (`models/<name>.gltf.json`).
- Draco runs as the plain JS decoder.

Republish after changing the models or the editor.

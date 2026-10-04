import * as THREE from "three";
import { collarTemplate, drawGarment, drawMaterial, heightToNormal } from "./kitTexture.js";
import { GARMENTS, hasFinish, walk } from "./project.js";

// Owns the hidden canvases + CanvasTextures of every garment and repaints one only when something it uses changed.
// Kept outside React: the app calls render() (at most once per frame) and hands the textures to the 3D view, which
// keeps the same texture objects for the whole session, so a design change never reloads a model.
//
// Per garment:
//   textures[g]       colour (always)
//   collar            the shirt collar alone at a higher resolution, mapped onto the collar mesh (see collarTemplate)
//   maps[g]           { normal, orm } material maps, or null while no layer of the garment has a finish. They are
//                     painted at `materialScale` of the colour size and only repaint when the layer shapes change
//                     (a palette change never touches them).

export class KitRenderer {
  constructor(size = 2048, materialScale = 1) {
    this.size = size;
    this.materialScale = materialScale;
    this.textures = Object.fromEntries(GARMENTS.map((g) => [g, makeTexture(size, size)]));
    this.collar = makeTexture(collarWidth(size), 64);
    this.maps = Object.fromEntries(GARMENTS.map((g) => [g, null]));
    this.store = {}; // garment -> { height, normal, orm } kept once created
    this.painted = {}; // garment -> the inputs of its last repaint
    this.paintedMaps = {};
  }

  /** Change the texture resolution (1024, 2048 or 4096); the next render() repaints everything. */
  resize(size) {
    this.size = size;
    for (const t of [...Object.values(this.textures), this.collar]) t.dispose(); // the GPU copy has a fixed size
    for (const t of Object.values(this.textures)) {
      t.image.width = t.image.height = size;
      t.needsUpdate = true;
    }
    this.collar.image.width = collarWidth(size);
    for (const s of Object.values(this.store)) {
      s.normal.dispose();
      s.orm.dispose();
    }
    this.store = {};
    this.painted = {};
    this.paintedMaps = {};
  }

  /**
   * project: the kit project; templates: model name -> UV template; models: garment -> model name;
   * images: asset id -> decoded image; fontsKey: changes when a web font finishes loading.
   * Returns { repainted: [garments], mapsChanged } (mapsChanged: some garment gained or lost its material maps).
   */
  render(project, templates, models, images, fontsKey) {
    const repainted = [];
    let mapsChanged = false;
    for (const g of GARMENTS) {
      const template = templates[models[g]];
      if (!template) continue;
      const layers = project.garments[g].layers;
      const uses = usage(layers);
      const shapes = [
        template, layers,
        uses.text ? project.font : null,
        uses.text ? project.player : null,
        uses.text ? fontsKey : null,
        ...uses.assets.map((id) => images[id] || null),
      ];
      const inputs = [project.palette, ...shapes];
      if (!same(this.painted[g], inputs)) {
        drawGarment(this.textures[g].image, g, template, project, images);
        this.textures[g].needsUpdate = true;
        if (g === "shirt") this.paintCollar(template, project, images);
        this.painted[g] = inputs;
        repainted.push(g);
      }
      // Material maps: only for garments that use them.
      if (!uses.finish) {
        if (this.maps[g]) {
          this.maps[g] = null;
          mapsChanged = true;
        }
        this.paintedMaps[g] = null;
        continue;
      }
      if (same(this.paintedMaps[g], shapes)) continue;
      const s = this.mapStore(g);
      drawMaterial(s.height, s.orm.image, g, template, project, images);
      heightToNormal(s.height, s.normal.image);
      s.normal.needsUpdate = s.orm.needsUpdate = true;
      this.paintedMaps[g] = shapes;
      if (!this.maps[g]) {
        this.maps[g] = { normal: s.normal, orm: s.orm };
        mapsChanged = true;
      }
    }
    return { repainted, mapsChanged };
  }

  paintCollar(template, project, images) {
    const c = collarTemplate(template, this.collar.image.width);
    if (!c) return;
    const canvas = this.collar.image;
    if (canvas.height !== c.height) {
      canvas.height = c.height;
      this.collar.dispose();
    }
    drawGarment(canvas, "shirt", c.template, project, images);
    this.collar.repeat.set(...c.repeat);
    this.collar.offset.set(...c.offset);
    this.collar.updateMatrix();
    this.collar.needsUpdate = true;
  }

  mapStore(g) {
    if (!this.store[g]) {
      const n = Math.max(256, Math.round(this.size * this.materialScale));
      const height = document.createElement("canvas");
      height.width = height.height = n;
      height.getContext("2d", { willReadFrequently: true }); // read back by heightToNormal
      const normal = makeTexture(n, n, THREE.NoColorSpace);
      const orm = makeTexture(n, n, THREE.NoColorSpace);
      this.store[g] = { height, normal, orm };
    }
    return this.store[g];
  }
}

const same = (a, b) => !!a && a.length === b.length && a.every((v, i) => v === b[i]);

// The collar texture: twice the garment width (at most 4096), so the thin collar band gets about five times the pixels.
const collarWidth = (size) => Math.min(4096, size * 2);

function usage(layers) {
  const assets = [];
  let text = false;
  let finish = false;
  walk(layers, (l) => {
    if (l.type === "text") text = true;
    if (l.type === "image" && l.asset) assets.push(l.asset);
    if (hasFinish(l) && l.visible) finish = true;
  });
  return { text, assets, finish };
}

function makeTexture(w, h, colorSpace = THREE.SRGBColorSpace) {
  const canvas = document.createElement("canvas"); // hidden: only the 3D view and the downloads show it
  canvas.width = w;
  canvas.height = h;
  const texture = new THREE.CanvasTexture(canvas);
  texture.flipY = false; // glTF UVs: canvas top = texture v 0
  texture.colorSpace = colorSpace;
  return texture;
}

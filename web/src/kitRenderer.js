import * as THREE from "three";
import { drawGarment, drawMaterialMaps } from "./kitTexture.js";
import { GARMENTS, walk } from "./project.js";

// Owns one hidden canvas + CanvasTexture per garment and repaints a garment only when something it uses changed.
// Kept outside React: the app calls render() (at most once per frame) and hands `textures` to the 3D view, which
// keeps the same texture objects for the whole session, so a design change never reloads a model.

export class KitRenderer {
  constructor(size = 2048) {
    this.textures = Object.fromEntries(GARMENTS.map((g) => [g, makeTexture(size)]));
    this.materials = Object.fromEntries(GARMENTS.map((g) => [g, {
      roughness: makeDataTexture(size),
      bump: makeDataTexture(size),
    }]));
    this.painted = {}; // garment -> the inputs of its last repaint
  }

  /** Change the texture resolution (1024, 2048 or 4096); the next render() repaints everything. */
  resize(size) {
    for (const t of [...Object.values(this.textures), ...Object.values(this.materials).flatMap(Object.values)]) {
      if (t.image.width === size) continue;
      t.image.width = t.image.height = size;
      t.dispose(); // the GPU copy has a fixed size
      t.needsUpdate = true;
    }
    this.painted = {};
  }

  /**
   * project: the kit project; templates: model name -> UV template; models: garment -> model name;
   * images: asset id -> decoded image; fontsKey: changes when a web font finishes loading.
   * Returns the garments that were repainted.
   */
  render(project, templates, models, images, fontsKey) {
    const repainted = [];
    for (const g of GARMENTS) {
      const template = templates[models[g]];
      if (!template) continue;
      const layers = project.garments[g].layers;
      const uses = usage(layers);
      const inputs = [
        template, layers, project.palette,
        uses.text ? project.font : null,
        uses.text ? project.player : null,
        uses.text ? fontsKey : null,
        ...uses.assets.map((id) => images[id] || null),
      ];
      const last = this.painted[g];
      if (last && last.length === inputs.length && last.every((v, i) => v === inputs[i])) continue;
      drawGarment(this.textures[g].image, g, template, project, images);
      this.textures[g].needsUpdate = true;
      drawMaterialMaps(this.materials[g].roughness.image, this.materials[g].bump.image, g, template, project);
      this.materials[g].roughness.needsUpdate = true;
      this.materials[g].bump.needsUpdate = true;
      this.painted[g] = inputs;
      repainted.push(g);
    }
    return repainted;
  }
}

function usage(layers) {
  const assets = [];
  let text = false;
  walk(layers, (l) => {
    if (l.type === "text") text = true;
    if (l.type === "image" && l.asset) assets.push(l.asset);
  });
  return { text, assets };
}

function makeTexture(size) {
  const canvas = document.createElement("canvas"); // hidden: only the 3D view and the downloads show it
  canvas.width = canvas.height = size;
  const texture = new THREE.CanvasTexture(canvas);
  texture.flipY = false; // glTF UVs: canvas top = texture v 0
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makeDataTexture(size) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const texture = new THREE.CanvasTexture(canvas);
  texture.flipY = false;
  texture.colorSpace = THREE.NoColorSpace;
  return texture;
}

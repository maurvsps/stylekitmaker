import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The Draco decoder ships with three.js; serve it at /draco/ in dev and copy it into the build.
const dracoDir = fileURLToPath(new URL("./node_modules/three/examples/jsm/libs/draco/gltf/", import.meta.url));

function dracoDecoder() {
  return {
    name: "draco-decoder",
    configureServer(server) {
      server.middlewares.use("/draco/", (req, res, next) => {
        const file = (req.url || "").split("?")[0].replace(/^\//, "");
        if (!readdirSync(dracoDir).includes(file)) return next();
        res.setHeader("Content-Type", file.endsWith(".wasm") ? "application/wasm" : "text/javascript");
        res.end(readFileSync(dracoDir + file));
      });
    },
    generateBundle() {
      for (const file of readdirSync(dracoDir)) {
        this.emitFile({ type: "asset", fileName: `draco/${file}`, source: readFileSync(dracoDir + file) });
      }
    },
  };
}

// Models (GLB + UV template JSON) come from the repository's /public/models, written by blender/make_kit.py.
// The dev server serves the whole /public folder; a build copies only the files the editor loads.
const modelsDir = fileURLToPath(new URL("../public/models/", import.meta.url));

function kitModels() {
  return {
    name: "kit-models",
    generateBundle() {
      const manifest = readFileSync(modelsDir + "kits.json");
      this.emitFile({ type: "asset", fileName: "models/kits.json", source: manifest });
      for (const { name } of JSON.parse(manifest).kits) {
        for (const file of [`${name}.glb`, `${name}.json`, `${name}_ao.png`, `${name}_uv.png`]) {
          if (!existsSync(modelsDir + file)) continue;
          this.emitFile({ type: "asset", fileName: `models/${file}`, source: readFileSync(modelsDir + file) });
        }
      }
    },
  };
}

// Third-party models (assets/third_party/fifakitcreator, used with permission: see CREDIT.txt there), served at
// /third_party/fifakitcreator/ in dev and copied into the build.
const fkcDir = fileURLToPath(new URL("../assets/third_party/fifakitcreator/", import.meta.url));

function thirdPartyModels() {
  const files = () => (existsSync(fkcDir) ? readdirSync(fkcDir).filter((f) => /\.(obj|png|txt)$/i.test(f)) : []);
  return {
    name: "third-party-models",
    configureServer(server) {
      server.middlewares.use("/third_party/fifakitcreator/", (req, res, next) => {
        const file = decodeURIComponent((req.url || "").split("?")[0].replace(/^\//, ""));
        if (!files().includes(file)) return next();
        res.setHeader("Content-Type", file.endsWith(".png") ? "image/png" : "text/plain");
        res.end(readFileSync(fkcDir + file));
      });
    },
    generateBundle() {
      for (const file of files()) {
        this.emitFile({ type: "asset", fileName: `third_party/fifakitcreator/${file}`, source: readFileSync(fkcDir + file) });
      }
    },
  };
}

export default defineConfig(({ command }) => ({
  base: "./", // relative URLs, so the build works from any folder
  publicDir: command === "build" ? false : "../public",
  plugins: [react(), dracoDecoder(), kitModels(), thirdPartyModels()],
  server: { port: 5174 },
}));

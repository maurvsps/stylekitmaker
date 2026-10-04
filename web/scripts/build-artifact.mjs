// Builds a self-contained copy of the editor for hosts that block downloads and .glb files (a claude.ai artifact):
// exports open in a sheet, the Draco decoder runs as plain JS, models are glTF JSON with the binary embedded,
// and the page's CSS and JS are inlined. Output: web/dist-artifact/ (index.html without <html>/<head>, models/, draco/).
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const web = path.resolve(import.meta.dirname, "..");
const build = path.join(web, "node_modules", ".cache", "artifact-build");
const out = path.join(web, "dist-artifact");

execSync(`npx vite build --outDir "${build}" --emptyOutDir`, {
  cwd: web, stdio: "inherit", env: { ...process.env, VITE_NO_DOWNLOAD: "1", VITE_MODEL_EXT: ".gltf.json" },
});

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "models"), { recursive: true });
fs.mkdirSync(path.join(out, "draco"));
fs.copyFileSync(path.join(build, "draco", "draco_decoder.js"), path.join(out, "draco", "draco_decoder.js"));

const { kits } = JSON.parse(fs.readFileSync(path.join(build, "models", "kits.json")));
fs.copyFileSync(path.join(build, "models", "kits.json"), path.join(out, "models", "kits.json"));
for (const { name } of kits) {
  fs.copyFileSync(path.join(build, "models", `${name}.json`), path.join(out, "models", `${name}.json`));
  const ao = path.join(build, "models", `${name}_ao.png`);
  if (fs.existsSync(ao)) fs.copyFileSync(ao, path.join(out, "models", `${name}_ao.png`));
  embedModel(name);
}
embedModel("mannequin");

function embedModel(name) {
  const glb = fs.readFileSync(path.join(build, "models", `${name}.glb`));
  const jsonLength = glb.readUInt32LE(12);
  const gltf = JSON.parse(glb.subarray(20, 20 + jsonLength).toString());
  const binStart = 20 + jsonLength;
  const bin = glb.subarray(binStart + 8, binStart + 8 + glb.readUInt32LE(binStart));
  gltf.buffers[0].uri = `data:application/octet-stream;base64,${bin.toString("base64")}`;
  fs.writeFileSync(path.join(out, "models", `${name}.gltf.json`), JSON.stringify(gltf));
}

const assets = fs.readdirSync(path.join(build, "assets"));
const read = (prefix, ext) => fs.readFileSync(path.join(build, "assets", assets.find((f) => f.startsWith(prefix) && f.endsWith(ext))), "utf8");
const css = read("index-", ".css");
const js = read("index-", ".js").replaceAll("</script", "<\\/script");
const fonts = fs.readFileSync(path.join(web, "index.html"), "utf8").match(/<link[^>]+fonts\.g[^>]+>/g).join("\n");
fs.writeFileSync(path.join(out, "index.html"),
  `<title>Football Kit Maker</title>\n${fonts}\n<style>${css}</style>\n<div id="root"></div>\n<script type="module">${js}</script>\n`);
console.log(`Artifact build in ${path.relative(process.cwd(), out)}: index.html + ${kits.length * 2 + 2} model files + Draco decoder`);

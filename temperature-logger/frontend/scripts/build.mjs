import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(project, "../src/static");
const destination = resolve(project, "dist");
const assets = [
  ["index.html", "index.html"],
  ["stats.html", "stats.html"],
  ["app.css", "static/app.css"],
  ["monitor.js", "static/monitor.js"],
  ["comfort.mjs", "static/comfort.mjs"],
];

for (const [name] of assets) {
  if (!existsSync(resolve(source, name))) {
    throw new Error(`Missing Flask frontend asset: ${name}`);
  }
}
rmSync(destination, { force: true, recursive: true });
for (const [name, output] of assets) {
  const path = resolve(destination, output);
  mkdirSync(dirname(path), { recursive: true });
  copyFileSync(resolve(source, name), path);
}
writeFileSync(resolve(destination, "404.html"),
  "<!doctype html><html lang=\"ja\"><meta charset=\"utf-8\"><title>404 | 温湿度モニター</title><body><p>ページが見つかりません．</p><a href=\"/\">トップに戻る</a></body></html>\n");
console.log("Copied existing Flask UI into Workers Static Assets.");

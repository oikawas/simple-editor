// Draws the app icon and writes every size the platforms need.
//
//   node design/icon/make-icons.mjs
//
// Needs Playwright with Chromium (used to render the SVG). The artwork is
// defined once here; the outputs are committed, so this only runs when the
// icon changes.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const out = (p) => {
  const file = path.join(root, p);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
};

// The artwork on a 1024 square: a sheet of paper with a sunset-colored
// binding band (it is also a diary), on an indigo-to-violet field.
const defs = `
  <linearGradient id="field" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#4f74ff"/>
    <stop offset="0.55" stop-color="#5a4ff5"/>
    <stop offset="1" stop-color="#7a3fe6"/>
  </linearGradient>
  <radialGradient id="glow" cx="0.22" cy="0.12" r="0.75">
    <stop offset="0" stop-color="#ffffff" stop-opacity="0.32"/>
    <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="paper" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#ffffff"/>
    <stop offset="1" stop-color="#eef0fb"/>
  </linearGradient>
  <linearGradient id="band" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="#ff9a5a"/>
    <stop offset="1" stop-color="#ff5a7e"/>
  </linearGradient>
  <filter id="lift" x="-30%" y="-30%" width="160%" height="170%">
    <feDropShadow dx="0" dy="26" stdDeviation="30" flood-color="#1c1160" flood-opacity="0.38"/>
  </filter>
  <filter id="ring" x="-50%" y="-50%" width="200%" height="200%">
    <feDropShadow dx="0" dy="6" stdDeviation="6" flood-color="#1c1160" flood-opacity="0.3"/>
  </filter>
  <clipPath id="sheet"><rect x="262" y="214" width="500" height="610" rx="68"/></clipPath>`;

const art = `
  <rect width="1024" height="1024" fill="url(#field)"/>
  <rect width="1024" height="1024" fill="url(#glow)"/>
  <g filter="url(#lift)">
    <rect x="262" y="214" width="500" height="610" rx="68" fill="url(#paper)"/>
  </g>
  <g clip-path="url(#sheet)">
    <rect x="262" y="214" width="500" height="138" fill="url(#band)"/>
  </g>
  <rect x="330" y="430" width="300" height="38" rx="19" fill="#4b55e8"/>
  <rect x="330" y="514" width="364" height="26" rx="13" fill="#d3d8f6"/>
  <rect x="330" y="580" width="330" height="26" rx="13" fill="#d3d8f6"/>
  <rect x="330" y="646" width="250" height="26" rx="13" fill="#d3d8f6"/>
  <circle cx="676" cy="738" r="20" fill="#ff6a6f"/>
  <g filter="url(#ring)" fill="#ffffff">
    <rect x="384" y="168" width="40" height="104" rx="20"/>
    <rect x="600" y="168" width="40" height="104" rx="20"/>
  </g>`;

const svg = (body, extraDefs = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs>${defs}${extraDefs}</defs>${body}</svg>\n`;

// Full bleed: for systems that cut their own shape (iOS, Android/PWA maskable).
const fullBleed = svg(art);

// A rounded tile filling the canvas: favicons, PWA "any".
const tile = svg(
  `<g clip-path="url(#tile)">${art}</g>`,
  `<clipPath id="tile"><rect width="1024" height="1024" rx="228"/></clipPath>`,
);

// macOS (and Linux docks): the tile at 824 inside the 1024 canvas, with a
// shadow, as the system's own app icons are drawn.
const framed = svg(
  `<g filter="url(#drop)"><g transform="translate(100 100) scale(0.8046875)" clip-path="url(#tile)">${art}</g></g>`,
  `<clipPath id="tile"><rect width="1024" height="1024" rx="230"/></clipPath>
   <filter id="drop" x="-10%" y="-10%" width="120%" height="125%">
     <feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#000000" flood-opacity="0.3"/>
   </filter>`,
);

fs.writeFileSync(out("design/icon/icon-full-bleed.svg"), fullBleed);
fs.writeFileSync(out("client/public/icon.svg"), tile);
fs.writeFileSync(out("linux/data/icons/hicolor/scalable/apps/io.github.oikawas.SimpleEditor.svg"), framed);

const browser = await chromium.launch();
const page = await browser.newPage();
// Full-bleed images are rendered opaque: iOS rejects app icons with alpha.
async function png(source, size, file, opaque = false) {
  await page.setViewportSize({ width: size, height: size });
  const html = source.replace("<svg ", `<svg width="${size}" height="${size}" `);
  await page.setContent(`<html><body style="margin:0;background:transparent">${html}</body></html>`);
  await page.locator("svg").screenshot({ path: out(file), omitBackground: !opaque });
}

await png(tile, 192, "client/public/icon-192.png");
await png(tile, 512, "client/public/icon-512.png");
await png(fullBleed, 512, "client/public/icon-maskable-512.png", true);
await png(fullBleed, 180, "client/public/apple-touch-icon.png", true);

// Xcode asset catalog: one 1024 image for iOS, every size for macOS.
const set = "apple/App/Assets.xcassets/AppIcon.appiconset";
await png(fullBleed, 1024, `${set}/ios-1024.png`, true);
const images = [{ filename: "ios-1024.png", idiom: "universal", platform: "ios", size: "1024x1024" }];
for (const pt of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const name = `mac-${pt}@${scale}x.png`;
    await png(framed, pt * scale, `${set}/${name}`);
    images.push({ filename: name, idiom: "mac", scale: `${scale}x`, size: `${pt}x${pt}` });
  }
}
const info = { author: "xcode", version: 1 };
fs.writeFileSync(out(`${set}/Contents.json`), JSON.stringify({ images, info }, null, 2) + "\n");
fs.writeFileSync(out("apple/App/Assets.xcassets/Contents.json"), JSON.stringify({ info }, null, 2) + "\n");

await browser.close();
console.log("icons written");

#!/usr/bin/env node
/**
 * Rasterises the icon and the social preview card.
 *
 *   node scripts/build-assets.mjs
 *
 * Sources are assets/favicon.svg and assets/og-card.html; the PNG and ICO files
 * they produce are committed, so this only needs to run when a source changes.
 * Rendering is done by headless Chrome, which every developer here already has —
 * set CHROME=/path/to/binary if it lives somewhere unusual.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const assets = resolve(dirname(fileURLToPath(import.meta.url)), "..", "assets");
const scratch = mkdtempSync(join(tmpdir(), "gitlab-mcp-assets-"));

const CHROME_CANDIDATES = [
  process.env.CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);

function chrome() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      return candidate;
    } catch {
      // Try the next one.
    }
  }
  throw new Error(`No Chrome found. Tried:\n  ${CHROME_CANDIDATES.join("\n  ")}`);
}

const BROWSER = chrome();

/** Screenshots a local page at an exact pixel size, on a transparent canvas. */
function shoot(pageUrl, width, height, out) {
  execFileSync(
    BROWSER,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      "--default-background-color=00000000",
      `--window-size=${width},${height}`,
      `--screenshot=${out}`,
      pageUrl,
    ],
    { stdio: "ignore" },
  );
  console.log(`  ${out.replace(`${assets}/`, "")} — ${width}×${height}`);
}

/** The SVG has no intrinsic size, so it is scaled by a wrapper page. */
function renderIcon(size, out) {
  const page = join(scratch, `icon-${size}.html`);
  writeFileSync(
    page,
    `<!doctype html><meta charset="utf-8">` +
      `<style>html,body{margin:0;background:transparent}` +
      `img{display:block;width:${size}px;height:${size}px}</style>` +
      `<img src="file://${join(assets, "favicon.svg")}">`,
  );
  shoot(`file://${page}`, size, size, out);
}

/**
 * Packs PNGs into an .ico. Windows and older browsers ask for /favicon.ico by
 * name, and an ICO may simply contain PNG frames — no BMP encoding needed.
 */
function buildIco(pngPaths, out) {
  const images = pngPaths.map((path) => readFileSync(path));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const entries = images.map((image, index) => {
    const size = SIZES_IN_ICO[index];
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size === 256 ? 0 : size, 0); // width, 0 means 256
    entry.writeUInt8(size === 256 ? 0 : size, 1); // height
    entry.writeUInt8(0, 2); // palette size
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(image.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += image.length;
    return entry;
  });

  writeFileSync(out, Buffer.concat([header, ...entries, ...images]));
  console.log(`  ${out.replace(`${assets}/`, "")} — ${SIZES_IN_ICO.join(", ")}px`);
}

const SIZES_IN_ICO = [16, 32, 48];

try {
  console.log("Icons");
  renderIcon(180, join(assets, "apple-touch-icon.png")); // iOS home screen
  renderIcon(192, join(assets, "icon-192.png")); // Android / PWA
  renderIcon(512, join(assets, "icon-512.png")); // splash and store listings

  const frames = SIZES_IN_ICO.map((size) => {
    const path = join(scratch, `ico-${size}.png`);
    renderIcon(size, path);
    return path;
  });
  buildIco(frames, join(assets, "favicon.ico"));

  console.log("Social card");
  shoot(`file://${join(assets, "og-card.html")}`, 1200, 630, join(assets, "og-image.png"));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

#!/usr/bin/env node
// Generates the Staples letter-mark favicon set into ui/public. Run from the
// repo root: `node scripts/brand/generate-icons.mjs`. Uses the `sharp`
// dependency that server/ already carries.
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(new URL("../../server/package.json", import.meta.url));
const sharp = require("sharp");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const out = path.join(root, "ui/public");
mkdirSync(out, { recursive: true });

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#18181b"/>
  <text x="32" y="45" text-anchor="middle" font-family="Inter, Helvetica, Arial, sans-serif" font-size="40" font-weight="700" fill="#ffffff">S</text>
</svg>
`;
writeFileSync(path.join(out, "favicon.svg"), svg);

async function png(size) {
  return sharp(Buffer.from(svg), { density: 512 }).resize(size, size).png().toBuffer();
}

/** ICO container holding PNG-encoded images (supported by every current browser). */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, data } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2); entry.writeUInt8(0, 3); entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8); entry.writeUInt32LE(offset, 12);
    offset += data.length; entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...images.map((image) => image.data)]);
}

const sizes = { "favicon-16x16.png": 16, "favicon-32x32.png": 32, "apple-touch-icon.png": 180, "android-chrome-192x192.png": 192, "android-chrome-512x512.png": 512 };
for (const [file, size] of Object.entries(sizes)) writeFileSync(path.join(out, file), await png(size));
writeFileSync(path.join(out, "favicon.ico"), ico([{ size: 16, data: await png(16) }, { size: 32, data: await png(32) }, { size: 48, data: await png(48) }]));
console.log(`wrote ${Object.keys(sizes).length + 2} icons to ${out}`);

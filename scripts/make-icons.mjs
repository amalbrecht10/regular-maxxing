// Renders public/icons/icon.svg into the PNG sizes iOS and Android need.
// Run with: node scripts/make-icons.mjs   (the PNGs are committed, so this only reruns after a design change)
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";

const svg = readFileSync("public/icons/icon.svg", "utf8");
const targets = [
  // iOS rounds the corners itself and shows transparency as black, so the touch icon is full-bleed square.
  { file: "apple-touch-icon.png", size: 180, square: true, pad: 0 },
  { file: "icon-192.png", size: 192, square: false, pad: 0 },
  { file: "icon-512.png", size: 512, square: false, pad: 0 },
  // Maskable icons need their content inside the central 80% safe zone.
  { file: "icon-maskable-512.png", size: 512, square: true, pad: 0.1 },
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const t of targets) {
  const inner = Math.round(t.size * (1 - 2 * t.pad));
  const art = t.square ? svg.replace('rx="112"', 'rx="0"') : svg;
  await page.setViewportSize({ width: t.size, height: t.size });
  await page.setContent(
    `<html><body style="margin:0;background:${t.square ? "#b9502a" : "transparent"};display:grid;place-items:center;width:${t.size}px;height:${t.size}px">
      <div style="width:${inner}px;height:${inner}px">${art.replace("<svg ", `<svg width="${inner}" height="${inner}" `)}</div></body></html>`,
  );
  await page.screenshot({ path: `public/icons/${t.file}`, omitBackground: !t.square });
  console.log("wrote", t.file);
}
await browser.close();

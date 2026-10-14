// Display list -> RGB8 pixels. Text is composited from the baked coverage LUT.
import { FONTS, glyphIndex } from './font.js';

// Coverage is linear, so blend in linear light: sRGB -> linear -> lerp -> sRGB.
const TO_LIN = Float32Array.from({ length: 256 }, (_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
const TO_SRGB = Uint8Array.from({ length: 4096 }, (_, i) => { const l = i / 4095; return Math.round(255 * (l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055)); });

export function rasterize({ width, height, background, ops }) {
  const px = new Uint8Array(width * height * 3);
  const fill = (x, y, w, h, rgb) => {
    const x0 = Math.max(0, x), x1 = Math.min(width, x + w), y0 = Math.max(0, y), y1 = Math.min(height, y + h);
    if (x0 >= x1 || y0 >= y1) return;
    const r = rgb >> 16, g = (rgb >> 8) & 255, b = rgb & 255, first = (y0 * width + x0) * 3, n = (x1 - x0) * 3;
    for (let i = first; i < first + n; i += 3) { px[i] = r; px[i + 1] = g; px[i + 2] = b; }
    for (let yy = y0 + 1; yy < y1; yy++) px.copyWithin((yy * width + x0) * 3, first, first + n);
  };
  const text = (x, y, str, size, rgb) => {
    const f = FONTS[size], cell = f.w * f.h;
    const sr = TO_LIN[rgb >> 16], sg = TO_LIN[(rgb >> 8) & 255], sb = TO_LIN[rgb & 255];
    for (const ch of str) {
      const g = glyphIndex(ch.codePointAt(0)) * cell;
      for (let r = 0; r < f.h; r++) {
        const yy = y + r;
        if (yy < 0 || yy >= height) continue;
        for (let c = 0; c < f.w; c++) {
          const a = f.data[g + r * f.w + c], xx = x + c;
          if (a === 0 || xx < 0 || xx >= width) continue;
          const i = (yy * width + xx) * 3, t = a / 255;
          const dr = TO_LIN[px[i]], dg = TO_LIN[px[i + 1]], db = TO_LIN[px[i + 2]];
          px[i] = TO_SRGB[((dr + (sr - dr) * t) * 4095 + 0.5) | 0];
          px[i + 1] = TO_SRGB[((dg + (sg - dg) * t) * 4095 + 0.5) | 0];
          px[i + 2] = TO_SRGB[((db + (sb - db) * t) * 4095 + 0.5) | 0];
        }
      }
      x += f.w;
    }
  };
  fill(0, 0, width, height, background);
  for (const o of ops) {
    if (o.op === 'rect') fill(o.x, o.y, o.w, o.h, o.rgb);
    else if (o.op === 'text') text(o.x, o.y, o.text, o.size, o.rgb);
    else throw new Error(`unknown display op ${o.op}`);
  }
  return px;
}

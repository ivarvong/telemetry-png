// otel-png-raster.mjs — draw operations -> PNG scanlines. Knows nothing about spans.
//
// The medium is an indexed-colour image: one byte per pixel, a small fixed palette,
// and a monospace bitmap font on an 8 x 17 cell. Draw operations are in logical
// pixels; `scale` (1 or 2) multiplies them. A canvas owns one reusable buffer, so
// painting any number of bands allocates nothing.
//
//   { op: 'rect',  x, y, w, h, ink }
//   { op: 'text',  x, y, str, ink, paper, bold }    paper must be what is underneath
//   { op: 'dotsV', x, y, h, ink }                    1 px dotted rule, 1 on / 2 off
//   { op: 'dotsH', x, y, w, ink }

import { FONT_CELL, FONT_META, FONT_BYTES, FONT_RLE_B64 } from './otel-png-font.mjs';

export const CELL = FONT_CELL;

// ---------- palette ----------

// Seven series hues, validated for adjacent-pair CVD separation on black.
const SERIES_RGB = [0xbe8610, 0x4068d0, 0xc2562e, 0x2f9b83, 0xb03a98, 0x7a9a42, 0x7a58cc];
const mix = (bg, fg, t) =>
  [16, 8, 0].reduce((rgb, sh) => {
    const a = (bg >> sh) & 255, b = (fg >> sh) & 255;
    return rgb | (Math.round(a + (b - a) * t) << sh);
  }, 0);

export const PALETTE = [];
const add = (rgb) => PALETTE.push(rgb) - 1;
export const INK = {
  BG: add(0x000000),
  FG: add(0xffffff),
  MUTED: add(0x8f8f8f),
  FAINT: add(0x3d3d3d),
  ERR: add(0xff453a),
  OTHER: add(0x777777),
  OTHER_DIM: add(mix(0, 0x777777, 0.38)),
  SERIES: SERIES_RGB.map(add),
  SERIES_DIM: SERIES_RGB.map((c) => add(mix(0, c, 0.38))),
};

// Anti-aliased text in an indexed image: font coverage is 0..15, so for each
// (ink, paper) pair the palette holds the 14 blends in between, and a 16-entry
// lookup maps coverage straight to a palette index. Coverage 0 is left untouched.
const LUTS = new Map();
function pair(ink, paper) {
  const lut = new Uint8Array(16);
  for (let a = 1; a < 15; a++) lut[a] = add(mix(PALETTE[paper], PALETTE[ink], a / 15));
  lut[15] = ink;
  LUTS.set((ink << 8) | paper, lut);
}
pair(INK.FG, INK.BG);
pair(INK.MUTED, INK.BG);
pair(INK.BG, INK.ERR);
pair(INK.BG, INK.FG);

// ---------- font ----------

// The atlas is run-length packed: each byte is (coverage << 4) | (run - 1).
let fonts;
export function loadFonts() {
  if (fonts) return fonts;
  const rle = atob(FONT_RLE_B64);
  const atlas = new Uint8Array(FONT_BYTES);
  let o = 0;
  for (let i = 0; i < rle.length; i++) {
    const byte = rle.charCodeAt(i);
    const v = byte >> 4;
    for (let n = (byte & 15) + 1; n > 0; n--) atlas[o++] = v;
  }
  if (o !== FONT_BYTES) throw new Error('font atlas corrupt');
  fonts = {};
  for (const [scale, faces] of Object.entries(FONT_META)) {
    fonts[scale] = {};
    for (const [name, m] of Object.entries(faces)) {
      fonts[scale][name] = { ...m, atlas, index: new Map([...m.chars].map((ch, i) => [ch, i])) };
    }
  }
  return fonts;
}
export const fontsLoaded = () => fonts !== undefined;

// ---------- canvas ----------

// Each scanline is 1 filter byte (0 = None) followed by `width * scale` palette indices.
export function makeCanvas(width, maxBandHeight, scale = 1) {
  if (!FONT_META[scale]) throw new Error(`scale must be one of ${Object.keys(FONT_META)}`);
  const S = scale, W = width * S, stride = W + 1;
  const buf = new Uint8Array(stride * maxBandHeight * S);
  const faces = loadFonts()[S];
  const stats = { rects: 0, glyphs: 0 };
  let H = 0, y0 = 0; // current band: device height, absolute logical y

  function rect(x, y, w, h, ink) {
    const x0 = Math.max(0, x * S), x1 = Math.min(W, (x + w) * S);
    const r1 = Math.min(H, (y + h) * S);
    if (x0 >= x1) return;
    stats.rects++;
    for (let r = Math.max(0, y * S); r < r1; r++) buf.fill(ink, r * stride + 1 + x0, r * stride + 1 + x1);
  }

  function text(x, y, str, ink, paper, bold) {
    const lut = LUTS.get((ink << 8) | paper);
    if (!lut) throw new Error(`no blend ramp for ink ${ink} on paper ${paper}`);
    const { w, h, atlas, index, off } = bold ? faces.bold : faces.body;
    const fallback = index.get('?');
    let px = x * S;
    const py = y * S;
    for (const ch of str) {
      if (ch !== ' ' && px >= 0 && px + w <= W) {
        stats.glyphs++;
        const cell = off + (index.get(ch) ?? fallback) * w * h;
        for (let gy = Math.max(0, -py); gy < h && py + gy < H; gy++) {
          const dst = (py + gy) * stride + 1 + px, src = cell + gy * w;
          for (let gx = 0; gx < w; gx++) {
            const a = atlas[src + gx];
            if (a !== 0) buf[dst + gx] = lut[a];
          }
        }
      }
      px += w;
    }
  }

  return {
    stride, stats,
    // Paint one band and return its scanlines: a view of the reused buffer, valid until the next paint.
    paint(band) {
      H = band.h * S; y0 = band.y;
      if (H * stride > buf.length) throw new Error('band taller than the canvas');
      const view = buf.subarray(0, H * stride);
      view.fill(0); // filter byte None, every pixel background
      stats.rects = 0; stats.glyphs = 0;
      for (const o of band.ops) {
        if (o.op === 'rect') rect(o.x, o.y, o.w, o.h, o.ink);
        else if (o.op === 'text') text(o.x, o.y, o.str, o.ink, o.paper, o.bold);
        else if (o.op === 'dotsV') { for (let y = o.y; y < o.y + o.h; y++) if ((y0 + y) % 3 === 0) rect(o.x, y, 1, 1, o.ink); }
        else if (o.op === 'dotsH') { for (let x = o.x; x < o.x + o.w; x += 3) rect(x, o.y, 1, 1, o.ink); }
        else throw new Error(`unknown op ${o.op}`);
      }
      return view;
    },
  };
}

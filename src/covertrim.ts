// Server-side whitespace trim for *square* cover images. Some Yahoo!ショッピング
// sellers (notably netoff) upload the real portrait cover centred on a 1:1 white
// canvas, leaving wide white bars. Our frames are 3:4, so object-fit alone can't
// remove bars that large. Here we decode the JPEG, find the real content bounding
// box (non-white rows/cols), crop to it, and re-encode. Runs once per image in
// /cover; the result is persisted in R2 so no client-side canvas work is needed.
//
// Mirrors the bounding-box heuristic validated in public/cover-fit.js: a row/col
// counts as "content" if ≥2% of its pixels are non-white (white = r,g,b each ≥243).
import decodeJpeg, { init as initDecode } from "@jsquash/jpeg/decode";
import encodeJpeg, { init as initEncode } from "@jsquash/jpeg/encode";
// CF Workers can't dynamically import wasm — bundle the codecs explicitly.
import DEC_WASM from "../node_modules/@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm";
import ENC_WASM from "../node_modules/@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm";

const WHITE = 243; // r,g,b each ≥ this ⇒ pixel is "white"
const INK = 0.02; // a row/col needs ≥2% non-white px to be "content"
const PAD = 0.01; // keep 1% of the side as breathing room after trim
const SQUARE_TOL = 0.08; // |w-h|/max within this ⇒ treat as a padded square

// init() accepts a WebAssembly.Module as its first arg at runtime; the published
// types lag behind, so cast. Memoise so the wasm is instantiated once per isolate.
let decReady: Promise<void> | null = null;
let encReady: Promise<void> | null = null;

interface RgbaImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

function isWhite(d: Uint8ClampedArray, i: number): boolean {
  return d[i] >= WHITE && d[i + 1] >= WHITE && d[i + 2] >= WHITE;
}

function contentBox(d: Uint8ClampedArray, W: number, H: number) {
  function rowHasInk(y: number): boolean {
    let ink = 0;
    const o = y * W * 4;
    for (let x = 0; x < W; x++) if (!isWhite(d, o + x * 4)) ink++;
    return ink / W >= INK;
  }
  function colHasInk(x: number): boolean {
    let ink = 0;
    for (let y = 0; y < H; y++) if (!isWhite(d, (y * W + x) * 4)) ink++;
    return ink / H >= INK;
  }
  let top = 0;
  while (top < H && !rowHasInk(top)) top++;
  let bot = H - 1;
  while (bot > top && !rowHasInk(bot)) bot--;
  let left = 0;
  while (left < W && !colHasInk(left)) left++;
  let right = W - 1;
  while (right > left && !colHasInk(right)) right--;
  if (right <= left || bot <= top) return null;
  return { left, top, right, bot };
}

// Returns a trimmed JPEG, or null when there's nothing worth trimming (not square,
// no detectable content, or content already fills the frame) — callers then keep
// the original image.
export async function trimWhitespace(jpeg: ArrayBuffer): Promise<ArrayBuffer | null> {
  if (!decReady) decReady = (initDecode as (m: WebAssembly.Module) => Promise<void>)(DEC_WASM);
  await decReady;
  const img = (await decodeJpeg(jpeg)) as unknown as RgbaImage;
  const W = img.width;
  const H = img.height;
  if (!W || !H) return null;
  if (Math.abs(W - H) / Math.max(W, H) > SQUARE_TOL) return null;

  const box = contentBox(img.data, W, H);
  if (!box) return null;
  const padX = Math.round(W * PAD);
  const padY = Math.round(H * PAD);
  const sx = Math.max(0, box.left - padX);
  const sy = Math.max(0, box.top - padY);
  const sw = Math.min(W - sx, box.right - box.left + 1 + padX * 2);
  const sh = Math.min(H - sy, box.bot - box.top + 1 + padY * 2);
  if (sw >= W * 0.97 && sh >= H * 0.97) return null;

  const out = new Uint8ClampedArray(sw * sh * 4);
  const rowBytes = sw * 4;
  for (let y = 0; y < sh; y++) {
    const srcStart = ((sy + y) * W + sx) * 4;
    out.set(img.data.subarray(srcStart, srcStart + rowBytes), y * rowBytes);
  }

  if (!encReady) encReady = (initEncode as (m: WebAssembly.Module) => Promise<void>)(ENC_WASM);
  await encReady;
  return await encodeJpeg({ data: out, width: sw, height: sh }, { quality: 82 });
}

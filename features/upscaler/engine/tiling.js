/**
 * Tiling utilities — dividing images into overlapping tiles and
 * reassembling them with seam-free stitching.
 */

/**
 * Compute the interior region a tile should contribute, trimming overlap
 * margins at seams. Returns a canvas-space rect { x, y, w, h }.
 *
 * Each side touching another tile is trimmed by half the overlap;
 * edges against the canvas boundary keep their full extent.
 */
export function overlapCrop(destX, destY, tileW, tileH, canvasW, canvasH, overlap) {
  const cropL = destX > 0 ? (overlap / 2) | 0 : 0;
  const cropT = destY > 0 ? (overlap / 2) | 0 : 0;
  const cropR = (destX + tileW) < canvasW ? (overlap / 2) | 0 : 0;
  const cropB = (destY + tileH) < canvasH ? (overlap / 2) | 0 : 0;
  return {
    x: destX + cropL,
    y: destY + cropT,
    w: tileW - cropL - cropR,
    h: tileH - cropT - cropB,
  };
}

/**
 * Build the grid of overlapping source tiles that cover the image.
 * Returns an array of { x, y, w, h } in source-pixel coordinates.
 */
export function buildTileGrid(srcW, srcH, tileSize, overlap) {
  const noTiling = tileSize <= 0;
  const size = noTiling ? Math.max(srcW, srcH) : tileSize;
  const step = noTiling ? size : size - overlap;
  const tiles = [];
  for (let ty = 0; ty < srcH; ty += step) {
    for (let tx = 0; tx < srcW; tx += step) {
      tiles.push({
        x: tx, y: ty,
        w: Math.min(size, srcW - tx),
        h: Math.min(size, srcH - ty),
      });
    }
  }
  return tiles;
}

/** Write an ImageData to the canvas, trimming overlap margins at tile seams. */
export function pasteTileCropped(ctx, imgData, dx, dy, canvasW, canvasH, overlap) {
  const crop = overlapCrop(dx, dy, imgData.width, imgData.height, canvasW, canvasH, overlap);
  if (crop.w <= 0 || crop.h <= 0) return;
  ctx.putImageData(imgData, dx, dy, crop.x - dx, crop.y - dy, crop.w, crop.h);
}

// ─── Gaussian tile blending ────────────────────────────────────────────
// For diffusion-style refiners (e.g. TinySR) the tile-edge artifacts are
// strong enough that the half-overlap hard crop above shows visible seams.
// `makeGaussianWeights2D` produces a per-pixel weight kernel matching
// TinySR's pipeline.js: variance=0.01 scaled by tile^2 so the shape is
// scale-invariant. Engines that opt in maintain a float32 accumulator and
// a contribution buffer, then divide once at the end.

/**
 * 2D Gaussian weight kernel for tile blending. Returns a Float32Array of
 * length tileH*tileW with pixel-space weights (single channel — apply the
 * same weight to all 3 colour channels at accumulation time).
 *
 * Matches the formula in tinysr/tools/web/pipeline.js:makeGaussianWeights
 * so the visual behaviour ports over directly.
 */
export function makeGaussianWeights2D(tileH, tileW) {
  const variance = 0.01;
  const midX = (tileW - 1) / 2;
  const midY = tileH / 2;  // intentional asymmetry — matches the upstream
  const denomX = tileW * tileW * 2 * variance;
  const denomY = tileH * tileH * 2 * variance;
  const norm = 1 / Math.sqrt(2 * Math.PI * variance);
  const xs = new Float32Array(tileW);
  const ys = new Float32Array(tileH);
  for (let i = 0; i < tileW; i++) xs[i] = norm * Math.exp(-((i - midX) ** 2) / denomX);
  for (let i = 0; i < tileH; i++) ys[i] = norm * Math.exp(-((i - midY) ** 2) / denomY);
  const out = new Float32Array(tileH * tileW);
  for (let y = 0; y < tileH; y++) {
    const yw = ys[y];
    const rowOff = y * tileW;
    for (let x = 0; x < tileW; x++) out[rowOff + x] = yw * xs[x];
  }
  return out;
}

/**
 * Accumulate one model-output tile into the canvas-sized float32 buffers
 * `accumRGB` (3*outW*outH, RGB-planar) and `accumW` (outW*outH), weighted
 * by `weights`. `srcRGB` is in [0, modelValueRange]; `layout` is 'chw' for
 * RGB-planar input or 'hwc' for RGB-interleaved. Crops to the top-left
 * (tileW × tileH) region if the model output was padded.
 */
export function accumulateGaussianTile(
  accumRGB, accumW, outW, outH,
  srcRGB, srcStrideW, srcStrideH,
  tileW, tileH, destX, destY,
  weights, valueScale, layout,
) {
  const outPlane = outW * outH;
  const isCHW = layout === 'chw';
  const chanStride = isCHW ? srcStrideW * srcStrideH : 1;
  const colStride = isCHW ? 1 : 3;
  const rowStride = isCHW ? srcStrideW : srcStrideW * 3;
  for (let y = 0; y < tileH; y++) {
    const dy = destY + y;
    if (dy < 0 || dy >= outH) continue;
    const wRow = y * tileW;
    const sRow = y * rowStride;
    const dRow = dy * outW;
    for (let x = 0; x < tileW; x++) {
      const dx = destX + x;
      if (dx < 0 || dx >= outW) continue;
      const w = weights[wRow + x];
      const srcIdx = sRow + x * colStride;
      const dstIdx = dRow + dx;
      accumRGB[dstIdx]                += srcRGB[srcIdx]                  * valueScale * w;
      accumRGB[outPlane + dstIdx]     += srcRGB[srcIdx + chanStride]     * valueScale * w;
      accumRGB[2 * outPlane + dstIdx] += srcRGB[srcIdx + 2 * chanStride] * valueScale * w;
      accumW[dstIdx] += w;
    }
  }
}

/**
 * Divide accumulated RGB by weights inside a rectangular region of the
 * output canvas, clamp to [0,255], and write via putImageData. Called
 * after each tile accumulates so the user sees progressive preview; the
 * last tile to touch any given pixel ends up writing the final value
 * (which is the same value a single full-canvas finalize would produce).
 *
 * Clips the region to the canvas bounds, so callers can pass tile-sized
 * rects without worrying about edge tiles.
 */
export function finalizeGaussianRegion(ctx, outX, outY, regionW, regionH, outW, outH, accumRGB, accumW) {
  const x0 = Math.max(0, outX | 0);
  const y0 = Math.max(0, outY | 0);
  const x1 = Math.min(outW, (outX + regionW) | 0);
  const y1 = Math.min(outH, (outY + regionH) | 0);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return;
  const imgData = ctx.createImageData(w, h);
  const px = imgData.data;
  const plane = outW * outH;
  for (let y = 0; y < h; y++) {
    const srcRow = (y0 + y) * outW;
    const dstRow = y * w;
    for (let x = 0; x < w; x++) {
      // accumW is zero only if no tile covered this pixel — shouldn't
      // happen for pixels reached by this call, but guard against NaN.
      const srcIdx = srcRow + x0 + x;
      const wAcc = accumW[srcIdx] || 1;
      const r = accumRGB[srcIdx] / wAcc;
      const g = accumRGB[plane + srcIdx] / wAcc;
      const b = accumRGB[2 * plane + srcIdx] / wAcc;
      const o = (dstRow + x) * 4;
      px[o]     = r < 0 ? 0 : r > 255 ? 255 : (r + 0.5) | 0;
      px[o + 1] = g < 0 ? 0 : g > 255 ? 255 : (g + 0.5) | 0;
      px[o + 2] = b < 0 ? 0 : b > 255 ? 255 : (b + 0.5) | 0;
      px[o + 3] = 255;
    }
  }
  ctx.putImageData(imgData, x0, y0);
}

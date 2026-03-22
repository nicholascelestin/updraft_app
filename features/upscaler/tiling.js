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

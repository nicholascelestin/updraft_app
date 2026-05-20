function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

function smoothstep(edge0, edge1, x) {
  if (edge1 <= edge0) return x >= edge1 ? 1 : 0;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function expandRect(rect, paddingPx, maxW, maxH) {
  const x1 = clamp(rect.x - paddingPx, 0, maxW);
  const y1 = clamp(rect.y - paddingPx, 0, maxH);
  const x2 = clamp(rect.x + rect.w + paddingPx, 0, maxW);
  const y2 = clamp(rect.y + rect.h + paddingPx, 0, maxH);
  return {
    x: Math.floor(x1),
    y: Math.floor(y1),
    w: Math.max(1, Math.ceil(x2 - x1)),
    h: Math.max(1, Math.ceil(y2 - y1)),
  };
}

export function ensureCanvas(imageLike) {
  if (imageLike?.getContext?.('2d')) return imageLike;
  const copy = document.createElement('canvas');
  copy.width = imageLike.width;
  copy.height = imageLike.height;
  copy.getContext('2d').drawImage(imageLike, 0, 0);
  return copy;
}

export function cropToCanvas(image, rect) {
  const c = document.createElement('canvas');
  c.width = rect.w;
  c.height = rect.h;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(
    image,
    rect.x, rect.y, rect.w, rect.h,
    0, 0, rect.w, rect.h,
  );
  return c;
}

export function canvasToBlobUrl(canvas) {
  return new Promise(resolve => canvas.toBlob(blob => resolve(URL.createObjectURL(blob)), 'image/png'));
}

export function imageToBlobUrl(image) {
  const c = document.createElement('canvas');
  c.width = image.width;
  c.height = image.height;
  c.getContext('2d').drawImage(image, 0, 0);
  return canvasToBlobUrl(c);
}

export function blendCanvas(destCanvas, srcCanvas, opacity) {
  const alpha = clamp(opacity, 0, 1);
  if (alpha <= 0) return destCanvas;
  const ctx = destCanvas.getContext('2d');
  if (!ctx) return destCanvas;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(srcCanvas, 0, 0, destCanvas.width, destCanvas.height);
  ctx.restore();
  return destCanvas;
}

// Composite `patch` onto `dest` at (x, y) with a feathered alpha mask.
// `innerRect` (in patch-local coords) marks the unfeathered region; pixels
// outside it fade out over `featherPx`. Without it, feathering runs from
// the patch edges inward.
export function compositeFeathered(destCanvas, patchCanvas, x, y, {
  featherPx = 8,
  innerRect = null,
  blendOpacity = 1,
} = {}) {
  const w = patchCanvas.width;
  const h = patchCanvas.height;
  if (w < 1 || h < 1) return false;
  const opacity = clamp(blendOpacity, 0, 1);
  if (opacity <= 0) return true;
  const minDim = Math.min(w, h);
  const t = Math.max(1, Math.min(Math.floor(featherPx), Math.floor(minDim / 2)));

  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = w;
  maskCanvas.height = h;
  const mctx = maskCanvas.getContext('2d');
  if (!mctx) return false;
  const mask = mctx.createImageData(w, h);
  const mpx = mask.data;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const idx = (py * w + px) * 4;
      let a = 0;
      if (innerRect) {
        const ix1 = innerRect.x;
        const iy1 = innerRect.y;
        const ix2 = innerRect.x + innerRect.w;
        const iy2 = innerRect.y + innerRect.h;
        const ox = px < ix1 ? (ix1 - px) : px >= ix2 ? (px - ix2 + 1) : 0;
        const oy = py < iy1 ? (iy1 - py) : py >= iy2 ? (py - iy2 + 1) : 0;
        const d = Math.hypot(ox, oy);
        a = d <= 0 ? 1 : (1 - smoothstep(0, t, d));
      } else {
        const dx = Math.min(px, w - 1 - px);
        const dy = Math.min(py, h - 1 - py);
        const d = Math.min(dx, dy);
        a = smoothstep(0, t, d);
      }
      const alpha = Math.max(0, Math.min(255, Math.round(a * opacity * 255)));
      mpx[idx] = 255;
      mpx[idx + 1] = 255;
      mpx[idx + 2] = 255;
      mpx[idx + 3] = alpha;
    }
  }
  mctx.putImageData(mask, 0, 0);

  const patchMasked = document.createElement('canvas');
  patchMasked.width = w;
  patchMasked.height = h;
  const pctx = patchMasked.getContext('2d');
  if (!pctx) return false;
  pctx.drawImage(patchCanvas, 0, 0);
  pctx.globalCompositeOperation = 'destination-in';
  pctx.drawImage(maskCanvas, 0, 0);

  const dctx = destCanvas.getContext('2d');
  if (!dctx) return false;
  dctx.drawImage(patchMasked, x, y);

  maskCanvas.width = 0;
  maskCanvas.height = 0;
  patchMasked.width = 0;
  patchMasked.height = 0;
  return true;
}

// Feather width (output px) for compositing a detection patch back onto an
// upscaled canvas. Scales with the detected region's min dimension, clamped
// by the padding ring and patch size so the transition stays inside the pad.
export function computeFeatherPx({
  configuredFeatherPx,
  regionW,
  regionH,
  patchW,
  patchH,
  paddingPx,
  scale,
}) {
  const minOut = 4;
  const maxOut = 12;
  const configuredOut = Math.max(0, configuredFeatherPx * scale);
  const regionMinOut = Math.max(1, Math.min(regionW, regionH) * scale);
  const regionDriven = Math.round(regionMinOut * 0.015);
  let feather = clamp(
    Math.max(configuredOut, regionDriven),
    minOut,
    maxOut,
  );

  const paddingOut = Math.max(0, paddingPx * scale);
  if (paddingOut > 0) {
    feather = Math.min(feather, Math.max(4, Math.round(paddingOut * 0.9)));
  } else {
    feather = Math.min(feather, 12);
  }

  const patchLimit = Math.max(2, Math.floor(Math.min(patchW, patchH) / 4));
  return Math.max(2, Math.min(Math.round(feather), patchLimit));
}

/**
 * Face enhancement pipeline — detect faces in the source image, upscale each
 * face ROI with a dedicated model, and composite the results onto the base
 * upscaled canvas with feathered blending.
 *
 * Pure pipeline logic: engines are received as arguments, not owned.
 */

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

function expandRect(rect, paddingPx, maxW, maxH) {
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

function cropToCanvas(image, rect) {
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

function smoothstep(edge0, edge1, x) {
  if (edge1 <= edge0) return x >= edge1 ? 1 : 0;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function computeFaceFeatherPx({
  configuredFeatherPx,
  faceW,
  faceH,
  patchW,
  patchH,
  paddingPx,
  scale,
}) {
  const minOut = 4;
  const maxOut = 12;
  const configuredOut = Math.max(0, configuredFeatherPx * scale);
  const faceMinOut = Math.max(1, Math.min(faceW, faceH) * scale);
  const faceDriven = Math.round(faceMinOut * 0.015);
  let feather = clamp(
    Math.max(configuredOut, faceDriven),
    minOut,
    maxOut,
  );

  const paddingOut = Math.max(0, paddingPx * scale);
  if (paddingOut > 0) {
    // Keep the transition mostly inside the padded ring around the face box.
    feather = Math.min(feather, Math.max(4, Math.round(paddingOut * 0.9)));
  } else {
    feather = Math.min(feather, 12);
  }

  const patchLimit = Math.max(2, Math.floor(Math.min(patchW, patchH) / 4));
  return Math.max(2, Math.min(Math.round(feather), patchLimit));
}

function compositeFeathered(destCanvas, patchCanvas, x, y, {
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

/**
 * Detect faces in the source image, upscale each face ROI, and composite
 * the enhanced patches onto the base upscaled canvas.
 *
 * @param {HTMLImageElement|HTMLCanvasElement} sourceImage — original (pre-upscale) image
 * @param {HTMLCanvasElement} upscaledCanvas — base upscaled result (modified in-place)
 * @param {object} opts
 * @param {object} opts.detectorEngine — loaded FaceDetectorEngine instance
 * @param {object} opts.faceEngine — loaded UpscalerEngine for face ROIs
 * @param {number} opts.baseScale — scale factor of the base upscale (e.g. 4)
 * @param {string} [opts.detectorKey='face-yunet']
 * @param {number} [opts.paddingPx=0]
 * @param {number} [opts.featherPx=16]
 * @param {number} [opts.blendOpacity=1]
 * @param {number} [opts.scoreThreshold]
 * @param {AbortSignal} [opts.signal]
 */
export async function applyFacePass(sourceImage, upscaledCanvas, {
  detectorEngine,
  faceEngine,
  baseScale,
  detectorKey = 'face-yunet',
  paddingPx = 0,
  featherPx = 16,
  blendOpacity = 1,
  scoreThreshold,
  signal,
}) {
  if (!upscaledCanvas?.getContext?.('2d')) {
    console.warn('[FaceEnhance] Face pass skipped: output canvas has no 2D context.');
    return;
  }

  if (signal?.aborted) throw new DOMException('Upscale cancelled', 'AbortError');
  console.info(
    `[FaceEnhance] Face pass start. detector=${detectorKey}, padding=${paddingPx}px, scoreThreshold=${scoreThreshold ?? 'default'}`,
  );

  const faces = await detectorEngine.detectFaces(sourceImage, {
    detectorKey,
    scoreThreshold,
    signal,
  });
  if (!faces.length) {
    console.info('[FaceEnhance] No faces detected; skipping face compositing.');
    return;
  }
  console.info(`[FaceEnhance] Detected ${faces.length} face(s).`);

  const sourceW = sourceImage.width;
  const sourceH = sourceImage.height;

  for (const face of faces) {
    if (signal?.aborted) throw new DOMException('Upscale cancelled', 'AbortError');
    const roi = expandRect(face, paddingPx, sourceW, sourceH);
    if (roi.w < 1 || roi.h < 1) {
      console.info('[FaceEnhance] Skipping degenerate face ROI.');
      continue;
    }
    console.info(
      `[FaceEnhance] Processing face ROI: x=${roi.x}, y=${roi.y}, w=${roi.w}, h=${roi.h}, score=${face.score?.toFixed?.(3) ?? 'n/a'}`,
    );
    const cropCanvas = cropToCanvas(sourceImage, roi);
    if (!cropCanvas) {
      console.warn('[FaceEnhance] Failed to create crop canvas for face ROI; skipping.');
      continue;
    }
    const faceTile = Math.min(192, Math.max(64, Math.min(roi.w, roi.h)));
    const { canvas: patchUpscaled } = await faceEngine.upscale(cropCanvas, faceTile, { signal });

    const targetW = roi.w * baseScale;
    const targetH = roi.h * baseScale;
    const patchCanvas = document.createElement('canvas');
    patchCanvas.width = targetW;
    patchCanvas.height = targetH;
    const pctx = patchCanvas.getContext('2d');
    if (!pctx) {
      console.warn('[FaceEnhance] Failed to create patch canvas context; skipping face ROI.');
      continue;
    }
    pctx.imageSmoothingEnabled = true;
    pctx.imageSmoothingQuality = 'high';
    pctx.drawImage(patchUpscaled, 0, 0, targetW, targetH);

    const faceFeatherPx = computeFaceFeatherPx({
      configuredFeatherPx: featherPx,
      faceW: face.w,
      faceH: face.h,
      patchW: targetW,
      patchH: targetH,
      paddingPx,
      scale: baseScale,
    });
    const innerRect = {
      x: Math.max(0, (face.x - roi.x) * baseScale),
      y: Math.max(0, (face.y - roi.y) * baseScale),
      w: Math.max(1, face.w * baseScale),
      h: Math.max(1, face.h * baseScale),
    };

    const ok = compositeFeathered(
      upscaledCanvas,
      patchCanvas,
      roi.x * baseScale,
      roi.y * baseScale,
      { featherPx: faceFeatherPx, innerRect, blendOpacity },
    );
    if (!ok) {
      console.warn('[FaceEnhance] Face composite failed for ROI; continuing.');
    }
    console.info(
      `[FaceEnhance] Composited face patch at output x=${roi.x * baseScale}, y=${roi.y * baseScale}, w=${targetW}, h=${targetH}, feather=${faceFeatherPx}px, blend=${blendOpacity.toFixed(2)}, innerRect=${innerRect.w.toFixed(1)}x${innerRect.h.toFixed(1)}`,
    );

    cropCanvas.width = 0;
    cropCanvas.height = 0;
    patchCanvas.width = 0;
    patchCanvas.height = 0;
    patchUpscaled.width = 0;
    patchUpscaled.height = 0;
  }
  console.info('[FaceEnhance] Face pass complete.');
}

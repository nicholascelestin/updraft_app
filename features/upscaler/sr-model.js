// Immutable value object describing one ONNX upscale model. Normalizes its own
// raw attrs — coercing the heterogeneous shapes SRModelStore feeds it (registry
// literals, localStorage records, upload-dialog form strings) — then freezes.
// DEFAULTS is the single source of truth for valid field values.

function clampInt(value, min, max, fallback) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export class SRModel {
  constructor(attrs = {}) {
    if (!attrs?.url) throw new Error('SRModel requires a url');
    Object.assign(this, { ...SRModel.DEFAULTS, ...attrs, ...SRModel.#normalize(attrs) });
    Object.freeze(this);
  }

  static #normalize(raw) {
    const D = SRModel.DEFAULTS;
    return {
      label: String(raw.label || '').trim() || D.label,
      scale: clampInt(raw.scale, 1, 16, D.scale),
      range: raw.range === 255 || raw.range === '255' ? 255 : D.range,
      layout: String(raw.layout || '').toLowerCase() === 'nhwc' ? 'nhwc' : D.layout,
      multipleOf: clampInt(raw.multipleOf, 1, 256, D.multipleOf),
      maxTileSize: raw.maxTileSize == null || raw.maxTileSize === ''
        ? D.maxTileSize
        : clampInt(raw.maxTileSize, 1, 4096, D.maxTileSize),
      precision: String(raw.precision || '').toLowerCase() === 'fp16' ? 'fp16' : D.precision,
      upscaleBefore: raw.upscaleBefore === true || raw.upscaleBefore === 'true'
        || raw.upscaleBefore === 1 || raw.upscaleBefore === '1',
      tileBlend: raw.tileBlend === 'gaussian' ? 'gaussian' : D.tileBlend,
    };
  }

  get hasFixedInputSize() {
    return this.multipleOf >= 1
        && this.maxTileSize != null
        && this.multipleOf === this.maxTileSize;
  }

  with(overrides) {
    return new SRModel({ ...this, ...overrides });
  }

  // url/custom are re-derived on hydrate, so they're omitted here.
  toStorageJSON() {
    return {
      label: this.label,
      scale: this.scale,
      range: this.range,
      layout: this.layout,
      multipleOf: this.multipleOf,
      maxTileSize: this.maxTileSize,
      precision: this.precision,
      upscaleBefore: this.upscaleBefore,
      tileBlend: this.tileBlend,
      sizeMB: this.sizeMB,
    };
  }

  static DEFAULTS = Object.freeze({
    label: 'Custom ONNX',
    scale: 4,
    range: 1,
    layout: 'nchw',
    multipleOf: 1,
    maxTileSize: null,
    precision: 'fp32',
    upscaleBefore: false,
    tileBlend: 'overlapCrop',
    sizeMB: null,
    custom: false,
  });
}

import { CUSTOM_MODEL_URL_PREFIX, getModelCache } from 'lib/fetch-progress';

const CUSTOM_MODELS_KEY = 'upscaler_custom_models';

function sanitizeScale(scale) {
  const parsed = parseInt(scale, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  if (parsed > 16) return 16;
  return parsed;
}

function sanitizeRange(range) {
  const parsed = parseInt(range, 10);
  if (parsed === 255) return 255;
  return 1;
}

function sanitizeLayout(layout) {
  const normalized = String(layout || '').toLowerCase();
  if (normalized === 'nhwc') return 'nhwc';
  return 'nchw';
}

function sanitizeMultipleOf(multipleOf) {
  const parsed = parseInt(multipleOf, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  if (parsed > 64) return 64;
  return parsed;
}

function normalizeLabel(label) {
  const trimmed = (label || '').trim();
  return trimmed || 'Custom ONNX';
}

function toModelRecord(raw = {}) {
  const id = String(raw.id || '');
  if (!id) return null;
  const scale = sanitizeScale(raw.scale);
  const range = sanitizeRange(raw.range);
  const layout = sanitizeLayout(raw.layout);
  const multipleOf = sanitizeMultipleOf(raw.multipleOf);
  const sizeBytes = Number.isFinite(raw.sizeBytes) ? Math.max(0, raw.sizeBytes) : 0;
  const sizeMB = Number((sizeBytes / (1024 * 1024)).toFixed(1));
  return {
    id,
    url: `${CUSTOM_MODEL_URL_PREFIX}${id}`,
    label: normalizeLabel(raw.label),
    scale,
    range,
    layout,
    multipleOf,
    sizeBytes,
    sizeMB,
    custom: true,
  };
}

function readStoredRecords() {
  try {
    const json = localStorage.getItem(CUSTOM_MODELS_KEY);
    if (!json) return [];
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(toModelRecord)
      .filter(Boolean);
  } catch {
    return [];
  }
}

function persistRecords(records) {
  const payload = records.map(({ id, label, scale, range, layout, multipleOf, sizeBytes }) => ({
    id,
    label,
    scale,
    range,
    layout,
    multipleOf,
    sizeBytes,
  }));
  localStorage.setItem(CUSTOM_MODELS_KEY, JSON.stringify(payload));
}

export function listCustomModels() {
  return readStoredRecords();
}

export function getUploadCustomOptionHTML() {
  return '<option value="__upload_custom__">Upload custom…</option>';
}

export function getCustomModelByUrl(url) {
  if (!url || typeof url !== 'string') return null;
  return readStoredRecords().find((model) => model.url === url) || null;
}

export async function saveCustomModel({ file, label, scale, range, layout, multipleOf }) {
  if (!(file instanceof File)) {
    throw new Error('Missing ONNX file for custom model upload.');
  }
  const normalizedLabel = normalizeLabel(label);
  const normalizedScale = sanitizeScale(scale);
  const normalizedRange = sanitizeRange(range);
  const normalizedLayout = sanitizeLayout(layout);
  const normalizedMultipleOf = sanitizeMultipleOf(multipleOf);
  const idSeed = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const id = `custom-${idSeed}`;
  const url = `${CUSTOM_MODEL_URL_PREFIX}${id}`;
  const bytes = await file.arrayBuffer();

  const cache = await getModelCache();
  if (!cache) {
    throw new Error('Browser Cache API is unavailable, cannot store custom model.');
  }
  await cache.put(url, new Response(bytes, {
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(bytes.byteLength),
    },
  }));

  const records = readStoredRecords();
  const model = toModelRecord({
    id,
    label: normalizedLabel,
    scale: normalizedScale,
    range: normalizedRange,
    layout: normalizedLayout,
    multipleOf: normalizedMultipleOf,
    sizeBytes: bytes.byteLength,
  });
  records.unshift(model);
  persistRecords(records);
  return model;
}

export async function deleteCustomModelByUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const records = readStoredRecords();
  const model = records.find((entry) => entry.url === url);
  if (!model) return false;

  const cache = await getModelCache();
  await cache?.delete(url);

  persistRecords(records.filter((entry) => entry.id !== model.id));
  return true;
}

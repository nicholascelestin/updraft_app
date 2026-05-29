// Unified store of SRModels. Built-ins come from the registry; customs are
// hydrated from localStorage and their ONNX bytes from the browser Cache API.
// Reads are uniform across the two sources; writes are typed (addCustom /
// updateCustom / deleteCustom — built-ins are bundle-immutable).

import { CUSTOM_MODEL_URL_PREFIX, putModelBytes, deleteModelBytes } from 'lib/model-cache';
import { UPSCALER_MODELS } from './model-registry.js';
import { SRModel } from './sr-model.js';
import { inspectOnnxFile } from './inspect-onnx.js';

const STORAGE_KEY = 'upscaler_custom_models';

class SRModelStore extends EventTarget {
  #builtins;
  #customs;

  constructor() {
    super();
    this.#builtins = UPSCALER_MODELS.map((raw) =>
      new SRModel({ ...raw, custom: false })
    );
    this.#customs = this.#hydrateCustoms();
  }

  list() { return [...this.#builtins, ...this.#customs]; }
  get(url) { return this.list().find((m) => m.url === url) ?? null; }
  has(url) { return this.get(url) !== null; }

  async addCustom(file, overrides = {}) {
    if (!(file instanceof File)) throw new Error('Missing ONNX file for custom model upload.');
    const id = `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const url = `${CUSTOM_MODEL_URL_PREFIX}${id}`;
    const bytes = await file.arrayBuffer();
    await putModelBytes(url, bytes);
    const sizeMB = Number((bytes.byteLength / (1024 * 1024)).toFixed(1));
    const model = new SRModel({ ...overrides, url, sizeMB, custom: true });
    this.#customs.unshift(model);
    this.#persistCustoms();
    this.#notify();
    return model;
  }

  updateCustom(url, updates) {
    const idx = this.#customs.findIndex((m) => m.url === url);
    if (idx === -1) return null;
    const model = new SRModel({
      ...this.#customs[idx],
      ...updates,
      url,
      custom: true,
    });
    this.#customs[idx] = model;
    this.#persistCustoms();
    this.#notify();
    return model;
  }

  async deleteCustom(url) {
    const before = this.#customs.length;
    this.#customs = this.#customs.filter((m) => m.url !== url);
    if (this.#customs.length === before) return false;
    await deleteModelBytes(url);
    this.#persistCustoms();
    this.#notify();
    return true;
  }

  // Re-exported so the upload dialog only needs to import the store.
  async inspect(file, opts) {
    return inspectOnnxFile(file, opts);
  }

  #hydrateCustoms() {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
      if (!Array.isArray(stored)) return [];
      return stored.map((raw) => {
        // Pre-sizeMB records persisted sizeBytes only.
        const sizeMB = Number.isFinite(raw.sizeMB)
          ? raw.sizeMB
          : Number(((raw.sizeBytes ?? 0) / (1024 * 1024)).toFixed(1));
        return new SRModel({
          ...raw,
          sizeMB,
          url: `${CUSTOM_MODEL_URL_PREFIX}${raw.id}`,
          custom: true,
        });
      });
    } catch {
      return [];
    }
  }

  #persistCustoms() {
    const records = this.#customs.map((m) => ({
      id: m.url.slice(CUSTOM_MODEL_URL_PREFIX.length),
      ...m.toStorageJSON(),
    }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  }

  #notify() { this.dispatchEvent(new Event('change')); }
}

export const modelStore = new SRModelStore();

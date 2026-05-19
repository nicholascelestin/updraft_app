/**
 * <upscale-preview> — canvas that shows live tile-by-tile upscale progress.
 *
 * Pure presentation component. The parent orchestrates engines and the
 * upscale pipeline; this element just renders tiles as they arrive.
 */

import { morph } from 'lib/morph';

class UpscalePreview extends HTMLElement {
  #ctx = null;

  connectedCallback() {
    this.classList.add('upscale-preview');
    this.#render();
  }

  /**
   * Set up the canvas with a dimmed version of the source image,
   * indicating that upscaling is about to begin.
   */
  showDimmedPreview(image, outW, outH) {
    this.style.setProperty('--ar', `${outW} / ${outH}`);
    this.style.setProperty('--ar-num', `${outW / outH}`);
    this.style.setProperty('--natural-w', `${outW}px`);
    this.#render();
    this.style.display = 'block';

    const canvas = this.querySelector('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(image, 0, 0, outW, outH);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.fillRect(0, 0, outW, outH);
    this.#ctx = ctx;
  }

  /**
   * Draw a completed tile onto the preview canvas.
   * Uses the overlap-cropped rect when available so each pixel is written
   * exactly once per step (avoids double-blend artifacts at tile seams).
   * @param {{ canvas: HTMLCanvasElement, outX: number, outY: number, outW: number, outH: number, crop?: {x:number,y:number,w:number,h:number} }} tileInfo
   * @param {{ opacity?: number }} [opts]
   */
  drawTile(tileInfo, { opacity = 1 } = {}) {
    if (!this.#ctx) return;
    const { x, y, w, h } = tileInfo.crop ?? {
      x: tileInfo.outX, y: tileInfo.outY, w: tileInfo.outW, h: tileInfo.outH,
    };
    const needsAlpha = opacity < 1;
    if (needsAlpha) { this.#ctx.save(); this.#ctx.globalAlpha = opacity; }
    this.#ctx.drawImage(tileInfo.canvas, x, y, w, h, x, y, w, h);
    if (needsAlpha) this.#ctx.restore();
  }

  hide() {
    this.style.display = 'none';
    this.style.removeProperty('--ar');
    this.style.removeProperty('--ar-num');
    this.style.removeProperty('--natural-w');
    const canvas = this.querySelector('canvas');
    if (canvas) { canvas.width = 0; canvas.height = 0; }
    this.#ctx = null;
  }

  #render() {
    morph(this, `
      <style>
        .upscale-preview { display: none; position: relative; }
        .upscale-preview:not(.expanded) {
          width: 100%;
          max-width: 100%;
          aspect-ratio: var(--ar, auto);
          margin-inline: auto;
        }
        .upscale-preview.expanded {
          height: calc(100vh - 1rem);
          width: calc((100vh - 1rem) * var(--ar-num, 1));
          max-width: none;
          margin-inline: auto;
        }
        /* native-size: canvas at its natural pixel dimensions, centered in
           a workspace-sized scroll container. Mirrors the compare-slider. */
        .upscale-preview.native-size {
          width: 100%;
          max-width: 100%;
          height: calc(100vh - 1rem);
          max-height: calc(100vh - 1rem);
          overflow: auto;
          display: flex;
          margin-inline: auto;
        }
        .upscale-preview.native-size canvas {
          margin: auto;
          width: auto;
          height: auto;
          max-width: none;
          flex: 0 0 auto;
        }
        .upscale-preview canvas {
          display: block;
          width: 100%;
          height: auto;
          max-width: 100%;
          border: 1px solid var(--pico-muted-border-color, #333);
          border-radius: var(--pico-border-radius, 4px);
          background: #000;
        }
      </style>
      <canvas></canvas>
    `);
  }
}

customElements.define('upscale-preview', UpscalePreview);

/**
 * GpuTileRenderer — renders CHW float32 ORT output buffers directly to a
 * GPU texture via a WGSL fragment shader, avoiding the GPU→CPU readback.
 *
 * Usage:
 *   const renderer = new GpuTileRenderer(device);
 *   renderer.configure(canvas, outW, outH);
 *   // per tile:
 *   renderer.renderTile(gpuBuffer, tileW, tileH, destX, destY, overlap, outputScale);
 *   renderer.presentToCanvas();
 *   // cleanup:
 *   renderer.destroy();
 */

const SHADER = /* wgsl */ `
struct Params {
  tileW: u32,
  tileH: u32,
  destX: u32,
  destY: u32,
  outputScale: f32,
}

@group(0) @binding(0) var<storage, read> chw: array<f32>;
@group(0) @binding(1) var<uniform> params: Params;

@vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pos = array<vec2f, 6>(
    vec2f(-1, -1), vec2f(1, -1), vec2f(-1, 1),
    vec2f(-1, 1),  vec2f(1, -1), vec2f(1, 1),
  );
  return vec4f(pos[vi], 0, 1);
}

@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let x = u32(pos.x) - params.destX;
  let y = u32(pos.y) - params.destY;
  let plane = params.tileW * params.tileH;
  let s = params.outputScale;
  return vec4f(
    clamp(chw[y * params.tileW + x] * s, 0.0, 1.0),
    clamp(chw[plane + y * params.tileW + x] * s, 0.0, 1.0),
    clamp(chw[2u * plane + y * params.tileW + x] * s, 0.0, 1.0),
    1.0,
  );
}
`;

const PARAMS_SIZE = 5 * 4; // 5 u32/f32 fields × 4 bytes, padded to 16-byte alignment
const PARAMS_BUFFER_SIZE = Math.ceil(PARAMS_SIZE / 16) * 16;

export class GpuTileRenderer {
  #device;
  #pipeline = null;
  #bindGroupLayout = null;
  #paramsBuffer = null;
  #outputTexture = null;
  #canvasCtx = null;
  #canvasFormat;
  #width = 0;
  #height = 0;

  constructor(device) {
    this.#device = device;
    this.#canvasFormat = navigator.gpu.getPreferredCanvasFormat();
    this.#initPipeline();
  }

  configure(canvas, width, height) {
    this.#canvasCtx = canvas.getContext('webgpu');
    this.#canvasCtx.configure({
      device: this.#device,
      format: this.#canvasFormat,
      alphaMode: 'opaque',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
    });

    this.#width = width;
    this.#height = height;

    this.#outputTexture?.destroy();
    this.#outputTexture = this.#device.createTexture({
      size: [width, height],
      format: this.#canvasFormat,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.TEXTURE_BINDING,
    });

    // Clear the persistent texture to black
    const encoder = this.#device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.#outputTexture.createView(),
        loadOp: 'clear',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        storeOp: 'store',
      }],
    });
    pass.end();
    this.#device.queue.submit([encoder.finish()]);
  }

  /**
   * Render one tile from an ORT GPU buffer onto the persistent output texture.
   *
   * @param {GPUBuffer} gpuBuffer - ORT output tensor's GPUBuffer (CHW float32)
   * @param {number} tileW - output tile width in pixels
   * @param {number} tileH - output tile height in pixels
   * @param {number} destX - destination X on the output texture
   * @param {number} destY - destination Y on the output texture
   * @param {number} overlap - overlap in output-space pixels
   * @param {number} outputScale - multiply CHW values by this (1.0 for 0-1 models, 1/255 for 0-255 models)
   */
  renderTile(gpuBuffer, tileW, tileH, destX, destY, overlap, outputScale) {
    const cropL = destX > 0 ? (overlap / 2) | 0 : 0;
    const cropT = destY > 0 ? (overlap / 2) | 0 : 0;
    const cropR = (destX + tileW) < this.#width  ? (overlap / 2) | 0 : 0;
    const cropB = (destY + tileH) < this.#height ? (overlap / 2) | 0 : 0;

    const scissorX = destX + cropL;
    const scissorY = destY + cropT;
    const scissorW = tileW - cropL - cropR;
    const scissorH = tileH - cropT - cropB;

    if (scissorW <= 0 || scissorH <= 0) return;

    // Write tile params to uniform buffer
    const paramsData = new ArrayBuffer(PARAMS_BUFFER_SIZE);
    const u32 = new Uint32Array(paramsData);
    const f32 = new Float32Array(paramsData);
    u32[0] = tileW;
    u32[1] = tileH;
    u32[2] = destX;
    u32[3] = destY;
    f32[4] = outputScale;
    this.#device.queue.writeBuffer(this.#paramsBuffer, 0, paramsData);

    const bindGroup = this.#device.createBindGroup({
      layout: this.#bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: gpuBuffer } },
        { binding: 1, resource: { buffer: this.#paramsBuffer } },
      ],
    });

    const encoder = this.#device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.#outputTexture.createView(),
        loadOp: 'load',
        storeOp: 'store',
      }],
    });

    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.setViewport(destX, destY, tileW, tileH, 0, 1);
    pass.setScissorRect(scissorX, scissorY, scissorW, scissorH);
    pass.draw(6);
    pass.end();

    this.#device.queue.submit([encoder.finish()]);
  }

  /** Copy the persistent output texture to the canvas for display / toBlob. */
  presentToCanvas() {
    const canvasTex = this.#canvasCtx.getCurrentTexture();
    const encoder = this.#device.createCommandEncoder();
    encoder.copyTextureToTexture(
      { texture: this.#outputTexture },
      { texture: canvasTex },
      [this.#width, this.#height],
    );
    this.#device.queue.submit([encoder.finish()]);
  }

  destroy() {
    this.#outputTexture?.destroy();
    this.#outputTexture = null;
    this.#paramsBuffer?.destroy();
    this.#paramsBuffer = null;
  }

  #initPipeline() {
    const module = this.#device.createShaderModule({ code: SHADER });

    this.#bindGroupLayout = this.#device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'read-only-storage' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ],
    });

    const pipelineLayout = this.#device.createPipelineLayout({
      bindGroupLayouts: [this.#bindGroupLayout],
    });

    this.#pipeline = this.#device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module, entryPoint: 'vs' },
      fragment: {
        module,
        entryPoint: 'fs',
        targets: [{ format: this.#canvasFormat }],
      },
    });

    this.#paramsBuffer = this.#device.createBuffer({
      size: PARAMS_BUFFER_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }
}

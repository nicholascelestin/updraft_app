/**
 * GpuFrameExtractor — uploads a video/image frame to a GPU texture and
 * extracts CHW float32 tiles via a compute shader, avoiding CPU-side
 * getImageData() + extractTileCHW() entirely.
 *
 * Usage:
 *   const extractor = new GpuFrameExtractor(device);
 *   extractor.uploadFrame(videoElement, width, height);
 *   const gpuBuffer = extractor.extractTile(tx, ty, tw, th, inputRange);
 *   // gpuBuffer contains CHW float32 data for the tile
 *   extractor.destroy();
 */

const SHADER = /* wgsl */ `
struct Params {
  tileX: u32,
  tileY: u32,
  tileW: u32,
  tileH: u32,
  scale: f32,
}

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> out: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let col = gid.x;
  let row = gid.y;
  if (col >= params.tileW || row >= params.tileH) { return; }

  let pixel = textureLoad(src, vec2u(params.tileX + col, params.tileY + row), 0);
  let plane = params.tileW * params.tileH;
  let idx = row * params.tileW + col;

  // Texture values are [0,1]; scale converts to model's expected range
  // (1.0 keeps [0,1], 255.0 produces [0,255]).
  out[idx]               = pixel.r * params.scale;
  out[plane + idx]       = pixel.g * params.scale;
  out[2u * plane + idx]  = pixel.b * params.scale;
}
`;

const PARAMS_SIZE = 5 * 4;
const PARAMS_BUFFER_SIZE = Math.ceil(PARAMS_SIZE / 16) * 16;

export class GpuFrameExtractor {
  #device;
  #pipeline;
  #bindGroupLayout;
  #paramsBuffer;
  #frameTexture = null;
  #tileBuffer = null;
  #tileBufferSize = 0;

  constructor(device) {
    this.#device = device;
    this.#initPipeline();
  }

  /**
   * Upload a frame source to the internal GPU texture.
   * Accepts HTMLVideoElement, HTMLImageElement, HTMLCanvasElement,
   * ImageBitmap, VideoFrame, OffscreenCanvas — anything valid for
   * copyExternalImageToTexture().
   */
  uploadFrame(source, width, height) {
    if (this.#frameTexture &&
        (this.#frameTexture.width !== width || this.#frameTexture.height !== height)) {
      this.#frameTexture.destroy();
      this.#frameTexture = null;
    }

    if (!this.#frameTexture) {
      this.#frameTexture = this.#device.createTexture({
        size: [width, height],
        format: 'rgba8unorm',
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });
    }

    this.#device.queue.copyExternalImageToTexture(
      { source },
      { texture: this.#frameTexture },
      [width, height],
    );
  }

  /**
   * Run the compute shader to extract a tile as CHW float32 into a
   * reusable GPU storage buffer.
   *
   * @param {number} tx - source tile X
   * @param {number} ty - source tile Y
   * @param {number} tw - tile width
   * @param {number} th - tile height
   * @param {number} inputRange - model input range (1 or 255);
   *   texture values are [0,1] so this acts as a multiplier.
   * @returns {GPUBuffer} containing 3×tw×th float32 values in CHW order
   */
  extractTile(tx, ty, tw, th, inputRange) {
    const byteSize = 3 * tw * th * 4;

    if (this.#tileBufferSize < byteSize) {
      this.#tileBuffer?.destroy();
      this.#tileBuffer = this.#device.createBuffer({
        size: byteSize,
        usage:
          GPUBufferUsage.STORAGE |
          GPUBufferUsage.COPY_SRC |
          GPUBufferUsage.COPY_DST,
      });
      this.#tileBufferSize = byteSize;
    }

    const paramsData = new ArrayBuffer(PARAMS_BUFFER_SIZE);
    const u32 = new Uint32Array(paramsData);
    const f32 = new Float32Array(paramsData);
    u32[0] = tx;
    u32[1] = ty;
    u32[2] = tw;
    u32[3] = th;
    f32[4] = inputRange;
    this.#device.queue.writeBuffer(this.#paramsBuffer, 0, paramsData);

    const bindGroup = this.#device.createBindGroup({
      layout: this.#bindGroupLayout,
      entries: [
        { binding: 0, resource: this.#frameTexture.createView() },
        { binding: 1, resource: { buffer: this.#tileBuffer, size: byteSize } },
        { binding: 2, resource: { buffer: this.#paramsBuffer } },
      ],
    });

    const encoder = this.#device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(tw / 16), Math.ceil(th / 16));
    pass.end();
    this.#device.queue.submit([encoder.finish()]);

    return this.#tileBuffer;
  }

  destroy() {
    this.#frameTexture?.destroy();
    this.#frameTexture = null;
    this.#tileBuffer?.destroy();
    this.#tileBuffer = null;
    this.#paramsBuffer?.destroy();
    this.#paramsBuffer = null;
  }

  #initPipeline() {
    const module = this.#device.createShaderModule({ code: SHADER });

    this.#bindGroupLayout = this.#device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'float' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'storage' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'uniform' },
        },
      ],
    });

    this.#pipeline = this.#device.createComputePipeline({
      layout: this.#device.createPipelineLayout({
        bindGroupLayouts: [this.#bindGroupLayout],
      }),
      compute: { module, entryPoint: 'main' },
    });

    this.#paramsBuffer = this.#device.createBuffer({
      size: PARAMS_BUFFER_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }
}

type MediaInput =
  | { type: "url"; url: string; mimeType?: string; name?: string }
  | { type: "base64"; data: string; mimeType: string; name?: string }
  | { type: "binary"; data: Uint8Array; mimeType: string; name?: string };

type MediaAsset = MediaInput & { mediaType: "image" | "video" | "audio" };

interface ImageRequest {
  model: string;
  prompt: string;
  images?: MediaInput[];
  mask?: MediaInput;
  n?: number;
  ratio?: string;
  size?: string;
  quality?: string;
  outputFormat?: string;
  other?: Record<string, unknown>;
}

interface VideoRequest {
  model: string;
  prompt: string;
  mode?: string;
  images?: MediaInput[];
  videos?: MediaInput[];
  audios?: MediaInput[];
  firstFrame?: MediaInput;
  lastFrame?: MediaInput;
  duration?: number;
  ratio?: string;
  resolution?: string;
  generateAudio?: boolean;
  watermark?: boolean;
  other?: Record<string, unknown>;
}

interface ProviderContext {
  config: { apiKey?: string };
  signal?: AbortSignal;
  tool: { fetch: typeof globalThis.fetch };
}

type Json = Record<string, unknown>;

interface ImageModelOptions {
  tiers: string[] | null;
  ratios: string[];
  maxReferences: number;
  fixedCount?: number;
  maxCount?: number;
  qualities?: string[];
}

interface VideoModelOptions {
  resolutions: string[];
  ratios: string[];
  minDuration: number;
  maxDuration: number;
  audio: boolean;
}

const API_BASE = "https://openrouter.ai/api/v1";
const IMAGE_TIMEOUT_MS = 180000;
const SUBMIT_TIMEOUT_MS = 90000;
const POLL_TIMEOUT_MS = 60000;
const DOWNLOAD_TIMEOUT_MS = 600000;
const POLL_INTERVAL_MS = 10000;
const VIDEO_TOTAL_TIMEOUT_MS = 20 * 60 * 1000;

const IMAGE_RESERVED = ["model", "prompt", "n", "resolution", "aspect_ratio", "size", "quality", "output_format", "input_references"];
const VIDEO_RESERVED = ["model", "prompt", "duration", "resolution", "aspect_ratio", "size", "frame_images", "input_references", "generate_audio", "aigc_watermark", "callback_url"];

const QWEN_RATIOS = ["1:1", "1:2", "1:4", "2:1", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "9:16", "16:9"];
const GEMINI_PRO_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
const GEMINI_FLASH_RATIOS = ["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"];
const GPT_IMAGE_RATIOS = ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9", "auto"];
const HAILUO_RATIOS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];
const WAN_RATIOS = ["16:9", "4:3", "1:1", "3:4", "9:16"];

const IMAGE_MODELS: Record<string, ImageModelOptions> = {
  "qwen/qwen-image-3": { tiers: ["1K", "2K"], ratios: QWEN_RATIOS, maxReferences: 4 },
  "qwen/qwen-image-3-pro": { tiers: ["1K", "2K"], ratios: QWEN_RATIOS, maxReferences: 4 },
  "google/gemini-3-pro-image": { tiers: ["1K", "2K", "4K"], ratios: GEMINI_PRO_RATIOS, maxReferences: 14, fixedCount: 1 },
  "google/gemini-3.1-flash-image": { tiers: ["512", "1K", "2K", "4K"], ratios: GEMINI_FLASH_RATIOS, maxReferences: 14, fixedCount: 1 },
  "openai/gpt-image-2": {
    tiers: null,
    ratios: GPT_IMAGE_RATIOS,
    maxReferences: 16,
    maxCount: 10,
    qualities: ["auto", "low", "medium", "high"],
  },
};

const VIDEO_MODELS: Record<string, VideoModelOptions> = {
  "minimax/hailuo-3": { resolutions: ["2K"], ratios: HAILUO_RATIOS, minDuration: 5, maxDuration: 15, audio: true },
  "minimax/hailuo-3-max": { resolutions: ["480p", "768p"], ratios: HAILUO_RATIOS, minDuration: 5, maxDuration: 15, audio: false },
  "alibaba/wan-3.0": { resolutions: ["480p", "720p", "1080p"], ratios: WAN_RATIOS, minDuration: 2, maxDuration: 30, audio: true },
};

function asRecord(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function readApiKey(context: ProviderContext): string {
  const apiKey = typeof context.config.apiKey === "string" ? context.config.apiKey.trim() : "";
  if (!apiKey) throw new Error("请先在供应商配置中填写 OpenRouter API Key");
  return apiKey;
}

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: "Bearer " + apiKey };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error("操作已取消");
    error.name = "AbortError";
    throw error;
  }
}

function combineSignal(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([timeout, parent]) : timeout;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      const error = new Error("操作已取消");
      error.name = "AbortError";
      reject(error);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const error = new Error("操作已取消");
      error.name = "AbortError";
      reject(error);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function normalizeBase64(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("data:")) {
    const comma = trimmed.indexOf(",");
    if (comma > 0) return trimmed.slice(comma + 1);
  }
  return trimmed;
}

function toImageUrl(input: MediaInput): string {
  if (input.type === "url") {
    if (!/^https?:\/\//i.test(input.url)) throw new Error("参考图地址必须是 http(s) 链接");
    return input.url;
  }
  if (input.type === "base64") {
    const data = normalizeBase64(input.data);
    if (!data) throw new Error("参考图内容为空");
    return "data:" + (input.mimeType || "image/png") + ";base64," + data;
  }
  if (!input.data || input.data.length === 0) throw new Error("参考图内容为空");
  return "data:" + (input.mimeType || "image/png") + ";base64," + Buffer.from(input.data).toString("base64");
}

async function readError(response: Response): Promise<string> {
  let text = "";
  try {
    text = (await response.text()).trim();
  } catch {
    text = "";
  }
  let detail = "";
  if (text) {
    try {
      const parsed = asRecord(JSON.parse(text) as unknown);
      if (parsed) {
        const error = parsed.error;
        const errorRecord = asRecord(error);
        if (typeof error === "string") detail = error;
        else if (errorRecord && typeof errorRecord.message === "string") detail = String(errorRecord.message);
        else if (typeof parsed.message === "string") detail = String(parsed.message);
      }
    } catch {
      detail = "";
    }
    if (!detail) detail = text.slice(0, 300);
  }
  return "HTTP " + response.status + (detail ? "：" + detail : "");
}

function mergeOther(target: Json, other: Record<string, unknown> | undefined, reserved: string[]): void {
  if (!other) return;
  for (const key of Object.keys(other)) {
    if (reserved.includes(key)) throw new Error("扩展参数中不能覆盖公共字段：" + key);
    const value = other[key];
    if (value === undefined || value === null) continue;
    target[key] = value;
  }
}

function ratioFromPixels(size: string, ratios: string[]): string {
  const matched = /^(\d+)x(\d+)$/i.exec(size);
  if (!matched) throw new Error("尺寸格式无法识别：" + size);
  const width = Number(matched[1]);
  const height = Number(matched[2]);
  if (!width || !height) throw new Error("尺寸格式无法识别：" + size);
  const target = width / height;
  let best = "";
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const ratio of ratios) {
    if (ratio === "auto") continue;
    const parts = ratio.split(":");
    const rw = Number(parts[0]);
    const rh = Number(parts[1]);
    if (!rw || !rh) continue;
    const diff = Math.abs(target - rw / rh);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = ratio;
    }
  }
  if (!best || bestDiff > 0.02) {
    throw new Error("像素尺寸 " + size + " 无法对应到该模型支持的比例（" + ratios.join("、") + "）");
  }
  return best;
}

function jobError(info: Json | null): string {
  if (!info) return "平台未返回失败原因";
  const error = info.error;
  if (typeof error === "string" && error.trim()) return error.trim();
  const errorRecord = asRecord(error);
  if (errorRecord && typeof errorRecord.message === "string" && String(errorRecord.message).trim()) {
    return String(errorRecord.message).trim();
  }
  if (typeof info.message === "string" && info.message.trim()) return info.message.trim();
  return "平台未返回失败原因";
}

function firstUrl(value: unknown): string {
  if (typeof value === "string" && /^https?:\/\//i.test(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string" && /^https?:\/\//i.test(item)) return item;
    }
  }
  return "";
}

function pickVideoMime(value: string | null): string {
  if (!value) return "video/mp4";
  const base = value.split(";")[0].trim().toLowerCase();
  return base.startsWith("video/") ? base : "video/mp4";
}

export default {
  id: "openRouter",
  label: "OpenRouter 媒体",
  version: "2.0.0",
  readme: `OpenRouter 媒体接入：图片走 \`/api/v1/images\`（同步返回 base64），视频走 \`/api/v1/videos\`（提交 → 轮询 → 带密钥下载）。

**图片（文生图 / 图生图）**
- Qwen Image 3 / 3 Pro：1K、2K，最多 4 张参考图，没有 21:9。
- Gemini 3 Pro Image：1K、2K、4K，最多 14 张参考图，单次只能出 1 张。
- Gemini 3.1 Flash Image：512、1K、2K、4K，最多 14 张参考图，单次只能出 1 张。
- GPT Image 2：只有比例（含 21:9、auto）与画质档位，没有分辨率档位；最多 16 张参考图，单次最多 10 张。

**视频（首帧图生视频，末帧可选）**
- MiniMax H3（\`minimax/hailuo-3\`）：2K，支持原生音频。
- MiniMax H3 Max（\`minimax/hailuo-3-max\`）：480p / 768p，不支持原生音频。
- 两者时长均为 5~15 秒的整数。
- Wan 3.0（\`alibaba/wan-3.0\`）：480p / 720p / 1080p，比例 16:9、4:3、1:1、3:4、9:16，时长 2~30 秒整数，支持首帧与末帧、原生音频；本适配只接首帧图生视频，不含文生视频与参考生视频。

视频结果以二进制返回，不依赖会过期的签名链接。API Key 只在本供应商配置中填写，与文字模型供应商互不影响。

提示：本适配依据 OpenRouter 官方文档整理，尚未在该平台实际调用验证，费用以平台账单为准。`,
  rules: [
    {
      type: "input",
      field: "apiKey",
      title: "OpenRouter API Key",
      value: "",
      props: { type: "password", showPassword: true, autocomplete: "off", placeholder: "sk-or-v1-..." },
      validate: [{ required: true, message: "请填写 OpenRouter API Key" }],
    },
  ],
  models: [
    {
      "id": "qwen/qwen-image-3",
      "label": "Qwen Image 3（文生图 / 参考图）",
      "type": "image",
      "mode": [
        "text",
        "singleImage",
        "multiReference"
      ],
      "imageSizes": [
        "1K",
        "2K"
      ],
      "imageRatios": [
        "1:1",
        "1:2",
        "1:4",
        "2:1",
        "2:3",
        "3:2",
        "3:4",
        "4:1",
        "4:3",
        "4:5",
        "5:4",
        "9:16",
        "16:9"
      ]
    },
    {
      "id": "qwen/qwen-image-3-pro",
      "label": "Qwen Image 3 Pro（文生图 / 参考图）",
      "type": "image",
      "mode": [
        "text",
        "singleImage",
        "multiReference"
      ],
      "imageSizes": [
        "1K",
        "2K"
      ],
      "imageRatios": [
        "1:1",
        "1:2",
        "1:4",
        "2:1",
        "2:3",
        "3:2",
        "3:4",
        "4:1",
        "4:3",
        "4:5",
        "5:4",
        "9:16",
        "16:9"
      ]
    },
    {
      "id": "google/gemini-3-pro-image",
      "label": "Gemini 3 Pro Image（Nano Banana Pro）",
      "type": "image",
      "mode": [
        "text",
        "singleImage",
        "multiReference"
      ],
      "imageSizes": [
        "1K",
        "2K",
        "4K"
      ],
      "imageRatios": [
        "1:1",
        "2:3",
        "3:2",
        "3:4",
        "4:3",
        "4:5",
        "5:4",
        "9:16",
        "16:9",
        "21:9"
      ]
    },
    {
      "id": "google/gemini-3.1-flash-image",
      "label": "Gemini 3.1 Flash Image（Nano Banana 2）",
      "type": "image",
      "mode": [
        "text",
        "singleImage",
        "multiReference"
      ],
      "imageSizes": [
        "512",
        "1K",
        "2K",
        "4K"
      ],
      "imageRatios": [
        "1:1",
        "1:4",
        "1:8",
        "2:3",
        "3:2",
        "3:4",
        "4:1",
        "4:3",
        "4:5",
        "5:4",
        "8:1",
        "9:16",
        "16:9",
        "21:9"
      ]
    },
    {
      "id": "openai/gpt-image-2",
      "label": "GPT Image 2（比例 + 画质档位）",
      "type": "image",
      "mode": [
        "text",
        "singleImage",
        "multiReference"
      ],
      "imageRatios": [
        "1:1",
        "3:2",
        "2:3",
        "4:3",
        "3:4",
        "16:9",
        "9:16",
        "21:9",
        "auto"
      ]
    },
    {
      "id": "minimax/hailuo-3",
      "label": "MiniMax H3（首帧图生视频，末帧可选）",
      "type": "video",
      "mode": [
        "endFrameOptional"
      ],
      "durationResolutionMap": [
        {
          "duration": [
            5,
            6,
            7,
            8,
            9,
            10,
            11,
            12,
            13,
            14,
            15
          ],
          "resolution": [
            "2K"
          ]
        }
      ]
    },
    {
      "id": "minimax/hailuo-3-max",
      "label": "MiniMax H3 Max（首帧图生视频，末帧可选）",
      "type": "video",
      "mode": [
        "endFrameOptional"
      ],
      "durationResolutionMap": [
        {
          "duration": [
            5,
            6,
            7,
            8,
            9,
            10,
            11,
            12,
            13,
            14,
            15
          ],
          "resolution": [
            "480p",
            "768p"
          ]
        }
      ]
    },
    {
      "id": "alibaba/wan-3.0",
      "label": "Wan 3.0（首帧图生视频，末帧可选，2~30 秒）",
      "type": "video",
      "mode": [
        "endFrameOptional"
      ],
      "durationResolutionMap": [
        {
          "duration": [
            2,
            3,
            4,
            5,
            6,
            7,
            8,
            9,
            10,
            11,
            12,
            13,
            14,
            15,
            16,
            17,
            18,
            19,
            20,
            21,
            22,
            23,
            24,
            25,
            26,
            27,
            28,
            29,
            30
          ],
          "resolution": [
            "480p",
            "720p",
            "1080p"
          ]
        }
      ]
    }
  ],

  async generateImage(this: ProviderContext, request: ImageRequest): Promise<MediaAsset[]> {
    throwIfAborted(this.signal);
    const apiKey = readApiKey(this);
    const options = IMAGE_MODELS[request.model];
    if (!options) throw new Error("不支持的图片模型：" + String(request.model));
    const prompt = typeof request.prompt === "string" ? request.prompt.trim() : "";
    if (!prompt) throw new Error("请填写图片提示词");
    if (request.mask) throw new Error("OpenRouter 图片接口不支持蒙版（mask）输入");

    const references: MediaInput[] = request.images ?? [];
    if (references.length > options.maxReferences) {
      throw new Error("该模型最多支持 " + options.maxReferences + " 张参考图，当前传入了 " + references.length + " 张");
    }

    const body: Json = { model: request.model, prompt };

    if (request.n !== undefined) {
      const n = request.n;
      if (!Number.isInteger(n) || n < 1) throw new Error("生成数量必须是正整数");
      if (options.fixedCount !== undefined && n !== options.fixedCount) {
        throw new Error("该模型每次只能生成 " + options.fixedCount + " 张图片");
      }
      if (options.maxCount !== undefined && n > options.maxCount) {
        throw new Error("该模型单次最多生成 " + options.maxCount + " 张图片");
      }
      body.n = n;
    }

    let pixelSize = "";
    let tier = "";
    if (typeof request.size === "string" && request.size.trim()) {
      const size = request.size.trim();
      if (/^\d+\s*[xX]\s*\d+$/.test(size)) pixelSize = size.replace(/\s+/g, "").toLowerCase();
      else tier = size.toUpperCase();
    }

    if (tier) {
      if (!options.tiers) throw new Error("该模型不支持分辨率档位，请改用画面比例或具体像素尺寸");
      if (!options.tiers.includes(tier)) {
        throw new Error("该模型不支持 " + request.size + " 分辨率，可选：" + options.tiers.join("、"));
      }
    }

    if (pixelSize) {
      if (options.tiers) body.size = pixelSize;
      else body.aspect_ratio = ratioFromPixels(pixelSize, options.ratios);
    } else {
      if (tier) body.resolution = tier;
      if (request.ratio !== undefined) {
        if (!options.ratios.includes(request.ratio)) {
          throw new Error("该模型不支持比例 " + request.ratio + "，可选：" + options.ratios.join("、"));
        }
        body.aspect_ratio = request.ratio;
      }
    }

    if (request.quality !== undefined) {
      if (options.qualities && !options.qualities.includes(request.quality)) {
        throw new Error("该模型画质档位只能是：" + options.qualities.join("、"));
      }
      body.quality = request.quality;
    }
    if (request.outputFormat !== undefined) body.output_format = request.outputFormat;

    if (references.length) {
      body.input_references = references.map((item) => ({ type: "image_url", image_url: { url: toImageUrl(item) } }));
    }

    mergeOther(body, request.other, IMAGE_RESERVED);
    throwIfAborted(this.signal);

    const response = await this.tool.fetch(API_BASE + "/images", {
      method: "POST",
      headers: { ...authHeaders(apiKey), "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: combineSignal(this.signal, IMAGE_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error("OpenRouter 图片生成失败：" + (await readError(response)));

    const payload = asRecord(await (response.json() as Promise<unknown>));
    const data = payload ? payload.data : undefined;
    if (!Array.isArray(data)) throw new Error("OpenRouter 图片接口返回了无法识别的数据");

    const assets: MediaAsset[] = [];
    for (const item of data) {
      const entry = asRecord(item);
      if (!entry) continue;
      const raw = typeof entry.b64_json === "string" ? entry.b64_json : "";
      const data64 = normalizeBase64(raw);
      if (!data64) continue;
      let mimeType = "";
      if (typeof entry.media_type === "string" && entry.media_type.includes("/")) mimeType = entry.media_type;
      if (!mimeType && raw.startsWith("data:")) {
        const head = raw.slice(5, raw.indexOf(","));
        if (head) mimeType = head.split(";")[0];
      }
      assets.push({ mediaType: "image", type: "base64", data: data64, mimeType: mimeType || "image/png" });
    }
    if (!assets.length) throw new Error("OpenRouter 未返回图片数据（该模型可能只返回了文字说明）");
    throwIfAborted(this.signal);
    return assets;
  },

  async generateVideo(this: ProviderContext, request: VideoRequest): Promise<MediaAsset[]> {
    throwIfAborted(this.signal);
    const apiKey = readApiKey(this);
    const options = VIDEO_MODELS[request.model];
    if (!options) throw new Error("不支持的视频模型：" + String(request.model));
    const prompt = typeof request.prompt === "string" ? request.prompt.trim() : "";
    if (!prompt) throw new Error("请填写视频提示词");

    if (request.mode !== undefined && request.mode !== "endFrameOptional") {
      throw new Error("当前接入只支持「首帧图生视频（末帧可选）」模式");
    }
    if (request.videos && request.videos.length) throw new Error("当前接入不支持参考视频输入");
    if (request.audios && request.audios.length) throw new Error("当前接入不支持参考音频输入");

    let firstFrame: MediaInput | undefined = request.firstFrame;
    if (!firstFrame && request.images && request.images.length) {
      if (request.images.length > 1) throw new Error("当前接入只支持 1 张首帧图，请勿传入多张参考图");
      firstFrame = request.images[0];
    }
    if (!firstFrame) throw new Error("请提供首帧参考图");

    const frameImages: Json[] = [
      { type: "image_url", image_url: { url: toImageUrl(firstFrame) }, frame_type: "first_frame" },
    ];
    if (request.lastFrame) {
      frameImages.push({ type: "image_url", image_url: { url: toImageUrl(request.lastFrame) }, frame_type: "last_frame" });
    }

    const body: Json = { model: request.model, prompt, frame_images: frameImages };

    if (request.duration !== undefined) {
      const duration = request.duration;
      if (!Number.isInteger(duration) || duration < options.minDuration || duration > options.maxDuration) {
        throw new Error("该模型时长需为 " + options.minDuration + "~" + options.maxDuration + " 之间的整数秒");
      }
      body.duration = duration;
    }
    if (request.resolution !== undefined) {
      if (!options.resolutions.includes(request.resolution)) {
        throw new Error("该模型不支持分辨率 " + request.resolution + "，可选：" + options.resolutions.join("、"));
      }
      body.resolution = request.resolution;
    }
    if (request.ratio !== undefined) {
      if (!options.ratios.includes(request.ratio)) {
        throw new Error("该模型不支持比例 " + request.ratio + "，可选：" + options.ratios.join("、"));
      }
      body.aspect_ratio = request.ratio;
    }
    if (request.generateAudio === true && !options.audio) {
      throw new Error("该模型不支持原生音频生成");
    }
    if (options.audio && request.generateAudio !== undefined) body.generate_audio = request.generateAudio;
    if (request.watermark !== undefined) body.aigc_watermark = request.watermark;

    mergeOther(body, request.other, VIDEO_RESERVED);
    throwIfAborted(this.signal);

    const submitResponse = await this.tool.fetch(API_BASE + "/videos", {
      method: "POST",
      headers: { ...authHeaders(apiKey), "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: combineSignal(this.signal, SUBMIT_TIMEOUT_MS),
    });
    if (!submitResponse.ok) throw new Error("OpenRouter 视频提交失败：" + (await readError(submitResponse)));

    const submitted = asRecord(await (submitResponse.json() as Promise<unknown>));
    const jobId = submitted && typeof submitted.id === "string" ? submitted.id : "";
    if (!jobId) throw new Error("OpenRouter 视频提交未返回任务 id");

    let pollingUrl = API_BASE + "/videos/" + encodeURIComponent(jobId);
    if (submitted && typeof submitted.polling_url === "string" && /^https?:\/\//i.test(submitted.polling_url)) {
      pollingUrl = submitted.polling_url;
    }

    const deadline = Date.now() + VIDEO_TOTAL_TIMEOUT_MS;
    let info: Json | null = submitted;
    let status = "pending";
    if (submitted && typeof submitted.status === "string") status = submitted.status;

    while (status !== "completed") {
      if (status === "failed" || status === "error" || status === "cancelled" || status === "canceled") {
        throw new Error("OpenRouter 视频生成失败：" + jobError(info));
      }
      if (!["pending", "queued", "in_progress", "processing", "running"].includes(status)) {
        throw new Error("OpenRouter 视频任务返回未知状态：" + status);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 1000) throw new Error("视频生成等待超时（约 20 分钟），任务可能仍在平台继续运行");
      await sleep(Math.min(POLL_INTERVAL_MS, remaining), this.signal);
      throwIfAborted(this.signal);

      const pollResponse = await this.tool.fetch(pollingUrl, {
        method: "GET",
        headers: authHeaders(apiKey),
        signal: combineSignal(this.signal, POLL_TIMEOUT_MS),
      });
      if (!pollResponse.ok) throw new Error("查询视频任务失败：" + (await readError(pollResponse)));
      const payload = asRecord(await (pollResponse.json() as Promise<unknown>));
      if (!payload) throw new Error("查询视频任务返回了无法识别的数据");
      info = payload;
      status = typeof payload.status === "string" ? payload.status : "pending";
    }

    throwIfAborted(this.signal);
    const contentUrl = API_BASE + "/videos/" + encodeURIComponent(jobId) + "/content?index=0";
    const contentResponse = await this.tool.fetch(contentUrl, {
      method: "GET",
      headers: authHeaders(apiKey),
      signal: combineSignal(this.signal, DOWNLOAD_TIMEOUT_MS),
    });
    if (contentResponse.ok) {
      const bytes = new Uint8Array(await contentResponse.arrayBuffer());
      if (!bytes.length) throw new Error("下载的视频内容为空");
      return [{ mediaType: "video", type: "binary", data: bytes, mimeType: pickVideoMime(contentResponse.headers.get("content-type")) }];
    }

    const downloadError = await readError(contentResponse);
    let signedUrl = "";
    if (info) signedUrl = firstUrl(info.unsigned_urls);
    if (!signedUrl && info) signedUrl = firstUrl(info.urls);
    if (signedUrl) {
      const signedResponse = await this.tool.fetch(signedUrl, {
        method: "GET",
        signal: combineSignal(this.signal, DOWNLOAD_TIMEOUT_MS),
      });
      if (signedResponse.ok) {
        const bytes = new Uint8Array(await signedResponse.arrayBuffer());
        if (bytes.length) {
          return [{ mediaType: "video", type: "binary", data: bytes, mimeType: pickVideoMime(signedResponse.headers.get("content-type")) }];
        }
      }
    }
    throw new Error("下载视频失败：" + downloadError);
  },
};

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
  // 无参考图时走 endpoint，有参考图时走 editEndpoint
  endpoint: string;
  editEndpoint: string;
  family: "nano" | "gptImage";
  tiers: string[] | null;
  ratios: string[];
  maxReferences: number;
  maxCount: number;
  qualities?: string[];
}

interface VideoModelOptions {
  endpoint: string;
  resolutions: string[];
  minDuration: number;
  maxDuration: number;
  // Wan 系列的参数命名与 H3 不同（start_image_url、audio、小写分辨率、reference 上限也不同），走独立分支
  wan?: "i2v" | "t2v" | "ref";
  // Seedance（字节）：duration 是字符串、参考写作 @Image1，参考上限因版本而异
  seedance?: "i2v" | "t2v" | "ref";
  refLimits?: { images: number; videos: number; audios: number };
  // 参考生视频端点：图 / 视频 / 音频参考分别进 reference_*_urls，提示词里用 Image 1、Video 1、Audio 1 引用
  reference?: boolean;
  // 参考端点是否还接受首帧 / 末帧（fal 上只有 H3 Max 的参考端点接受）
  frames?: boolean;
  // H3 文生视频：不收图，比例 21:9～9:16（没有 adaptive），可带 1 段目标音频（target_audio_url）
  t2v?: boolean;
  // H3 Max 对嘴：只收 1 张图 + 1 段音频，没有提示词，时长跟随音频
  lipsync?: boolean;
}

const REFERENCE_LIMITS = { images: 9, videos: 3, audios: 3, total: 12 };

const QUEUE_BASE = "https://queue.fal.run/";
const SUBMIT_TIMEOUT_MS = 90000;
const POLL_TIMEOUT_MS = 60000;
const RESULT_TIMEOUT_MS = 120000;
const DOWNLOAD_TIMEOUT_MS = 600000;
const POLL_INTERVAL_MS = 5000;
const IMAGE_TOTAL_TIMEOUT_MS = 10 * 60 * 1000;
const VIDEO_TOTAL_TIMEOUT_MS = 20 * 60 * 1000;

const IMAGE_RESERVED = ["prompt", "image_urls", "mask_url", "num_images", "aspect_ratio", "resolution", "image_size", "quality", "output_format", "sync_mode"];
const VIDEO_RESERVED = ["prompt", "start_image_url", "audio", "image_url", "end_image_url", "duration", "resolution", "aspect_ratio", "sync_mode", "reference_image_urls", "reference_video_urls", "reference_audio_urls", "reference_conditions", "image_urls", "video_urls", "audio_urls", "generate_audio", "audio_url", "target_audio_url"];

const NANO_RATIOS = ["auto", "21:9", "16:9", "3:2", "4:3", "5:4", "1:1", "4:5", "3:4", "2:3", "9:16"];
// GPT Image 2 在 fal 上只公布 7 个预设尺寸，这里只暴露能与之一一对应的比例
const GPT_IMAGE_PRESETS: Record<string, string> = {
  "1:1": "square_hd",
  "4:3": "landscape_4_3",
  "16:9": "landscape_16_9",
  "3:4": "portrait_4_3",
  "9:16": "portrait_16_9",
  auto: "auto",
};

const IMAGE_MODELS: Record<string, ImageModelOptions> = {
  "fal-ai/nano-banana-pro": {
    endpoint: "fal-ai/nano-banana-pro",
    editEndpoint: "fal-ai/nano-banana-pro/edit",
    family: "nano",
    tiers: ["1K", "2K", "4K"],
    ratios: NANO_RATIOS,
    maxReferences: 14,
    maxCount: 4,
  },
  "openai/gpt-image-2": {
    endpoint: "openai/gpt-image-2",
    editEndpoint: "openai/gpt-image-2/edit",
    family: "gptImage",
    tiers: null,
    ratios: Object.keys(GPT_IMAGE_PRESETS),
    maxReferences: 16,
    maxCount: 4,
    qualities: ["auto", "low", "medium", "high"],
  },
};

const VIDEO_MODELS: Record<string, VideoModelOptions> = {
  "minimax/h3/image-to-video": {
    endpoint: "minimax/h3/image-to-video",
    resolutions: ["480P", "768P", "2K", "4K"],
    minDuration: 5,
    maxDuration: 15,
  },
  "minimax/h3-max/image-to-video": {
    endpoint: "minimax/h3-max/image-to-video",
    resolutions: ["480P", "768P", "1080P"],
    minDuration: 3,
    maxDuration: 15,
  },
  "minimax/h3-max-turbo/image-to-video": {
    endpoint: "minimax/h3-max-turbo/image-to-video",
    resolutions: ["480P", "768P", "1080P"],
    minDuration: 3,
    maxDuration: 15,
  },
  "minimax/h3/reference-to-video": {
    endpoint: "minimax/h3/reference-to-video",
    resolutions: ["480P", "768P", "2K", "4K"],
    minDuration: 5,
    maxDuration: 15,
    reference: true,
  },
  "minimax/h3-max/reference-to-video": {
    endpoint: "minimax/h3-max/reference-to-video",
    resolutions: ["480P", "768P", "1080P"],
    minDuration: 3,
    maxDuration: 15,
    reference: true,
    frames: true,
  },
  "minimax/h3-max-turbo/reference-to-video": {
    endpoint: "minimax/h3-max-turbo/reference-to-video",
    resolutions: ["480P", "768P", "1080P"],
    minDuration: 3,
    maxDuration: 15,
    reference: true,
  },
  // 2026-10-22 依 fal 官方 API 页补上：文生视频三个、H3 Max 对嘴一个
  "minimax/h3/text-to-video": {
    endpoint: "minimax/h3/text-to-video",
    resolutions: ["480P", "768P", "2K", "4K"],
    minDuration: 5,
    maxDuration: 15,
    t2v: true,
  },
  "minimax/h3-max/text-to-video": {
    endpoint: "minimax/h3-max/text-to-video",
    resolutions: ["480P", "768P", "1080P"],
    minDuration: 3,
    maxDuration: 15,
    t2v: true,
  },
  "minimax/h3-max-turbo/text-to-video": {
    endpoint: "minimax/h3-max-turbo/text-to-video",
    resolutions: ["480P", "768P", "1080P"],
    minDuration: 3,
    maxDuration: 15,
    t2v: true,
  },
  "minimax/h3-max/lip-sync/image-to-video": {
    endpoint: "minimax/h3-max/lip-sync/image-to-video",
    resolutions: ["480P", "768P", "1080P", "2K"],
    minDuration: 5,
    maxDuration: 900,
    lipsync: true,
  },
  "alibaba/wan-3.0/image-to-video": {
    endpoint: "alibaba/wan-3.0/image-to-video",
    resolutions: ["480p", "720p", "1080p"],
    minDuration: 2,
    maxDuration: 30,
    wan: "i2v",
  },
  "alibaba/wan-3.0/text-to-video": {
    endpoint: "alibaba/wan-3.0/text-to-video",
    resolutions: ["480p", "720p", "1080p"],
    minDuration: 2,
    maxDuration: 30,
    wan: "t2v",
  },
  "alibaba/wan-3.0/reference-to-video": {
    endpoint: "alibaba/wan-3.0/reference-to-video",
    resolutions: ["480p", "720p", "1080p"],
    minDuration: 2,
    maxDuration: 30,
    wan: "ref",
  },
  "bytedance/seedance-2.0/image-to-video": {
    endpoint: "bytedance/seedance-2.0/image-to-video",
    resolutions: ["480p", "720p", "1080p", "4k"],
    minDuration: 4,
    maxDuration: 15,
    seedance: "i2v",
  },
  "bytedance/seedance-2.0/text-to-video": {
    endpoint: "bytedance/seedance-2.0/text-to-video",
    resolutions: ["480p", "720p", "1080p", "4k"],
    minDuration: 4,
    maxDuration: 15,
    seedance: "t2v",
  },
  "bytedance/seedance-2.0/reference-to-video": {
    endpoint: "bytedance/seedance-2.0/reference-to-video",
    resolutions: ["480p", "720p", "1080p", "4k"],
    minDuration: 4,
    maxDuration: 15,
    seedance: "ref",
    refLimits: { images: 9, videos: 3, audios: 3 },
  },
  "bytedance/seedance-2.5/image-to-video": {
    endpoint: "bytedance/seedance-2.5/image-to-video",
    resolutions: ["480p", "720p", "1080p"],
    minDuration: 4,
    maxDuration: 30,
    seedance: "i2v",
  },
  "bytedance/seedance-2.5/text-to-video": {
    endpoint: "bytedance/seedance-2.5/text-to-video",
    resolutions: ["480p", "720p", "1080p"],
    minDuration: 4,
    maxDuration: 30,
    seedance: "t2v",
  },
  "bytedance/seedance-2.5/reference-to-video": {
    endpoint: "bytedance/seedance-2.5/reference-to-video",
    resolutions: ["480p", "720p", "1080p"],
    minDuration: 4,
    maxDuration: 30,
    seedance: "ref",
    refLimits: { images: 30, videos: 10, audios: 10 },
  },
};

const WAN_RATIOS = ["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16"];
const WAN_REFERENCE_LIMITS = { images: 10, videos: 5, audios: 5 };

// 宿主把提示词原样交给供应商，不会替换 {{ref N}}；fal 的参考生视频按「类别加顺序」引用（Image 1、Video 1、Audio 1）。
// 只有在参考全是图片时，{{ref N}} 的编号才与 Image N 一一对应，此时才安全地替换；含视频或音频时无法判断，保持原样。
function translateImageRefs(prompt: string, images: number, videos: number, audios: number, style: "space" | "at" = "space"): string {
  if (!images || videos || audios) return prompt;
  return prompt.replace(/\{\{ref\s+(\d+)\}\}/g, (match, n) => (Number(n) >= 1 && Number(n) <= images ? (style === "at" ? "@Image" + n : "Image " + n) : match));
}

function asRecord(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function readApiKey(context: ProviderContext): string {
  const apiKey = typeof context.config.apiKey === "string" ? context.config.apiKey.trim() : "";
  if (!apiKey) throw new Error("请先在供应商配置中填写 Fal API Key");
  return apiKey;
}

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: "Key " + apiKey };
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

// fal 的文件字段同时接受公开 URL 与 base64 data URI
function toFileUrl(input: MediaInput, label: string, fallbackMime: string): string {
  if (input.type === "url") {
    if (!/^https?:\/\//i.test(input.url)) throw new Error(label + "地址必须是 http(s) 链接");
    return input.url;
  }
  if (input.type === "base64") {
    const data = normalizeBase64(input.data);
    if (!data) throw new Error(label + "内容为空");
    return "data:" + (input.mimeType || fallbackMime) + ";base64," + data;
  }
  if (!input.data || input.data.length === 0) throw new Error(label + "内容为空");
  return "data:" + (input.mimeType || fallbackMime) + ";base64," + Buffer.from(input.data).toString("base64");
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
        const d = parsed.detail;
        if (typeof d === "string") detail = d;
        else if (Array.isArray(d)) {
          detail = d
            .map((item) => {
              const rec = asRecord(item);
              return rec && typeof rec.msg === "string" ? String(rec.msg) : "";
            })
            .filter(Boolean)
            .join("；");
        }
        if (!detail) {
          const error = parsed.error;
          const errorRecord = asRecord(error);
          if (typeof error === "string") detail = error;
          else if (errorRecord && typeof errorRecord.message === "string") detail = String(errorRecord.message);
          else if (typeof parsed.message === "string") detail = String(parsed.message);
        }
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

function firstUrl(value: unknown): string {
  if (typeof value === "string" && /^https?:\/\//i.test(value)) return value;
  return "";
}

function mimeOf(headerValue: string | null, declared: unknown, prefix: string, fallback: string): string {
  const candidates = [headerValue ? headerValue.split(";")[0].trim().toLowerCase() : "", typeof declared === "string" ? declared.trim().toLowerCase() : ""];
  for (const candidate of candidates) {
    if (candidate.startsWith(prefix)) return candidate;
  }
  return fallback;
}

// 提交 → 轮询 status_url → 取 response_url。三个地址都用平台返回的，不自行拼接（fal 的子路径端点会省略后缀）
async function runQueue(context: ProviderContext, endpoint: string, input: Json, totalTimeoutMs: number, name: string): Promise<Json> {
  const apiKey = readApiKey(context);
  throwIfAborted(context.signal);

  const submitResponse = await context.tool.fetch(QUEUE_BASE + endpoint, {
    method: "POST",
    headers: { ...authHeaders(apiKey), "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal: combineSignal(context.signal, SUBMIT_TIMEOUT_MS),
  });
  if (!submitResponse.ok) throw new Error("Fal " + name + "提交失败：" + (await readError(submitResponse)));

  const submitted = asRecord(await (submitResponse.json() as Promise<unknown>));
  const statusUrl = submitted ? firstUrl(submitted.status_url) : "";
  const responseUrl = submitted ? firstUrl(submitted.response_url) : "";
  if (!statusUrl || !responseUrl) throw new Error("Fal 提交未返回任务地址");

  const deadline = Date.now() + totalTimeoutMs;
  let status = typeof submitted?.status === "string" ? String(submitted.status) : "IN_QUEUE";

  while (status !== "COMPLETED") {
    if (!["IN_QUEUE", "IN_PROGRESS"].includes(status)) {
      throw new Error("Fal 任务返回未知状态：" + status);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 1000) throw new Error("Fal " + name + "等待超时，任务可能仍在平台继续运行（request_id：" + String(submitted?.request_id ?? "") + "）");
    await sleep(Math.min(POLL_INTERVAL_MS, remaining), context.signal);
    throwIfAborted(context.signal);

    const pollResponse = await context.tool.fetch(statusUrl, {
      method: "GET",
      headers: authHeaders(apiKey),
      signal: combineSignal(context.signal, POLL_TIMEOUT_MS),
    });
    if (!pollResponse.ok) throw new Error("查询 Fal 任务失败：" + (await readError(pollResponse)));
    const payload = asRecord(await (pollResponse.json() as Promise<unknown>));
    if (!payload) throw new Error("查询 Fal 任务返回了无法识别的数据");
    status = typeof payload.status === "string" ? payload.status : "IN_QUEUE";
  }

  throwIfAborted(context.signal);
  const resultResponse = await context.tool.fetch(responseUrl, {
    method: "GET",
    headers: authHeaders(apiKey),
    signal: combineSignal(context.signal, RESULT_TIMEOUT_MS),
  });
  // fal 的失败（安全审查、参数不合法等）在取结果时以非 2xx 返回
  if (!resultResponse.ok) throw new Error("Fal " + name + "失败：" + (await readError(resultResponse)));
  const result = asRecord(await (resultResponse.json() as Promise<unknown>));
  if (!result) throw new Error("Fal " + name + "返回了无法识别的数据");
  return result;
}

async function downloadBinary(context: ProviderContext, url: string, declaredMime: unknown, prefix: string, fallback: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const response = await context.tool.fetch(url, {
    method: "GET",
    signal: combineSignal(context.signal, DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("下载生成结果失败：" + (await readError(response)));
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length) throw new Error("下载的内容为空");
  return { bytes, mimeType: mimeOf(response.headers.get("content-type"), declaredMime, prefix, fallback) };
}

// Seedance 2.0 / 2.5：duration 为字符串（4~15 或 4~30，或 auto）、分辨率小写、generate_audio 明确开关，参考写作 @Image1、@Video1、@Audio1
async function generateSeedanceVideo(context: ProviderContext, request: VideoRequest, options: VideoModelOptions, prompt: string): Promise<MediaAsset[]> {
  const body: Json = { prompt };
  const kind = options.seedance;

  if (kind === "ref") {
    const limits = options.refLimits!;
    const images = request.images ?? [];
    const videos = request.videos ?? [];
    const audios = request.audios ?? [];
    if (images.length > limits.images) throw new Error("参考图最多 " + limits.images + " 张，当前 " + images.length + " 张");
    if (videos.length > limits.videos) throw new Error("参考视频最多 " + limits.videos + " 段，当前 " + videos.length + " 段");
    if (audios.length > limits.audios) throw new Error("参考音频最多 " + limits.audios + " 段，当前 " + audios.length + " 段");
    if (request.firstFrame || request.lastFrame) throw new Error("Seedance 参考生视频不接受首帧 / 末帧，请改用图生视频模型，或把画面作为参考图传入");
    if (images.length) body.image_urls = images.map((item, index) => toFileUrl(item, "第 " + (index + 1) + " 张参考图", "image/png"));
    if (videos.length) body.video_urls = videos.map((item, index) => toFileUrl(item, "第 " + (index + 1) + " 段参考视频", "video/mp4"));
    if (audios.length) body.audio_urls = audios.map((item, index) => toFileUrl(item, "第 " + (index + 1) + " 段参考音频", "audio/mpeg"));
    body.prompt = translateImageRefs(prompt, images.length, videos.length, audios.length, "at");
  } else if (kind === "i2v") {
    let first: MediaInput | undefined = request.firstFrame;
    if (!first && request.images && request.images.length) {
      if (request.images.length > 1) throw new Error("图生视频只支持 1 张首帧图，多张参考图请改用 reference-to-video 模型");
      first = request.images[0];
    }
    if (!first) throw new Error("Seedance 图生视频必须提供首帧图");
    if (request.videos && request.videos.length) throw new Error("该模型不支持参考视频输入，请改用 reference-to-video 模型");
    if (request.audios && request.audios.length) throw new Error("该模型不支持参考音频输入，请改用 reference-to-video 模型");
    body.image_url = toFileUrl(first, "首帧图", "image/png");
    if (request.lastFrame) body.end_image_url = toFileUrl(request.lastFrame, "末帧图", "image/png");
  } else {
    if ((request.images && request.images.length) || (request.videos && request.videos.length) || (request.audios && request.audios.length) || request.firstFrame || request.lastFrame) {
      throw new Error("文生视频不接受图片、视频或音频输入，请改用图生视频或参考生视频模型");
    }
  }

  if (request.duration !== undefined) {
    const duration = request.duration;
    if (!Number.isInteger(duration) || duration < options.minDuration || duration > options.maxDuration) {
      throw new Error("该模型时长需为 " + options.minDuration + "~" + options.maxDuration + " 之间的整数秒");
    }
    body.duration = String(duration);
  }
  if (request.resolution !== undefined) {
    const resolution = request.resolution.toLowerCase();
    if (!options.resolutions.includes(resolution)) {
      throw new Error("该模型不支持分辨率 " + request.resolution + "，可选：" + options.resolutions.join("、"));
    }
    body.resolution = resolution;
  }
  // 图生视频的画幅跟随首幀（2.5 图生视频固定 auto），不送比例；文生与参考生视频才送
  if (request.ratio !== undefined && kind !== "i2v") {
    if (!["auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"].includes(request.ratio)) throw new Error("该模型不支持比例 " + request.ratio);
    body.aspect_ratio = request.ratio;
  }
  if (request.generateAudio !== undefined) body.generate_audio = request.generateAudio;

  mergeOther(body, request.other, VIDEO_RESERVED);
  const result = await runQueue(context, options.endpoint, body, VIDEO_TOTAL_TIMEOUT_MS, "视频生成");

  const video = asRecord(result.video);
  const url = video ? firstUrl(video.url) : "";
  if (!url) throw new Error("Fal 未返回视频地址");
  const file = await downloadBinary(context, url, video?.content_type, "video/", "video/mp4");
  throwIfAborted(context.signal);
  return [{ mediaType: "video", type: "binary", data: file.bytes, mimeType: file.mimeType }];
}

// Wan 3.0：start_image_url / end_image_url、audio 布尔开关、小写分辨率、时长 2~30 秒整数、比例含 adaptive
// H3 Max 对嘴：image_url + audio_url，没有提示词与比例；输出时长等于音频长度（音频 5 秒～15 分钟）。
// 节点会带时长与比例，这里不送（fal 不收），以音频为准。
async function generateLipSyncVideo(context: ProviderContext, request: VideoRequest, options: VideoModelOptions): Promise<MediaAsset[]> {
  if (request.videos && request.videos.length) throw new Error("对嘴模型不接受参考视频");
  const images = request.images ?? [];
  const audios = request.audios ?? [];
  const image = request.firstFrame ?? images[0];
  if (!image || images.length > 1) throw new Error("对嘴需要刚好 1 张人物图（可用首帧或 1 张参考图）");
  if (audios.length !== 1) throw new Error("对嘴需要刚好 1 段音频（至少 5 秒），画面的嘴型会跟着它动，成片时长等于音频长度");
  const body: Json = {
    image_url: toFileUrl(image, "人物图", "image/png"),
    audio_url: toFileUrl(audios[0], "对嘴音频", "audio/mpeg"),
  };
  if (request.resolution !== undefined) {
    const resolution = request.resolution.toUpperCase();
    if (!options.resolutions.includes(resolution)) throw new Error("该模型不支持分辨率 " + request.resolution + "，可选：" + options.resolutions.join("、"));
    body.resolution = resolution;
  }
  mergeOther(body, request.other, VIDEO_RESERVED);
  const result = await runQueue(context, options.endpoint, body, VIDEO_TOTAL_TIMEOUT_MS, "视频生成");
  const video = asRecord(result.video);
  const url = video ? firstUrl(video.url) : "";
  if (!url) throw new Error("Fal 未返回视频地址");
  const file = await downloadBinary(context, url, video?.content_type, "video/", "video/mp4");
  throwIfAborted(context.signal);
  return [{ mediaType: "video", type: "binary", data: file.bytes, mimeType: file.mimeType }];
}

async function generateWanVideo(context: ProviderContext, request: VideoRequest, options: VideoModelOptions, prompt: string): Promise<MediaAsset[]> {
  // 提示词改写默认关闭，保证台词与动作原样送达。fal 文档提示关闭可能降低画质，需要时可在扩展参数传 enable_prompt_expansion: true
  const body: Json = { prompt, enable_prompt_expansion: false, sync_mode: false };

  if (options.wan === "ref") {
    const images = request.images ?? [];
    const videos = request.videos ?? [];
    const audios = request.audios ?? [];
    if (images.length > WAN_REFERENCE_LIMITS.images) throw new Error("参考图最多 " + WAN_REFERENCE_LIMITS.images + " 张，当前 " + images.length + " 张");
    if (videos.length > WAN_REFERENCE_LIMITS.videos) throw new Error("参考视频最多 " + WAN_REFERENCE_LIMITS.videos + " 段，当前 " + videos.length + " 段");
    if (audios.length > WAN_REFERENCE_LIMITS.audios) throw new Error("参考音频最多 " + WAN_REFERENCE_LIMITS.audios + " 段，当前 " + audios.length + " 段");
    if (request.firstFrame || request.lastFrame) throw new Error("Wan 参考生视频不接受首帧 / 末帧，请改用图生视频模型，或把画面作为参考图传入");
    if (images.length) body.reference_image_urls = images.map((item, index) => toFileUrl(item, "第 " + (index + 1) + " 张参考图", "image/png"));
    if (videos.length) body.reference_video_urls = videos.map((item, index) => toFileUrl(item, "第 " + (index + 1) + " 段参考视频", "video/mp4"));
    if (audios.length) body.reference_audio_urls = audios.map((item, index) => toFileUrl(item, "第 " + (index + 1) + " 段参考音频", "audio/mpeg"));
    body.prompt = translateImageRefs(prompt, images.length, videos.length, audios.length);
  } else if (options.wan === "i2v") {
    let first: MediaInput | undefined = request.firstFrame;
    if (!first && request.images && request.images.length) {
      if (request.images.length > 1) throw new Error("图生视频只支持 1 张首帧图，多张参考图请改用 reference-to-video 模型");
      first = request.images[0];
    }
    if (!first) throw new Error("Wan 图生视频必须提供首帧图");
    if (request.videos && request.videos.length) throw new Error("该模型不支持参考视频输入，请改用 reference-to-video 模型");
    if (request.audios && request.audios.length) throw new Error("该模型不支持参考音频输入，请改用 reference-to-video 模型");
    body.start_image_url = toFileUrl(first, "首帧图", "image/png");
    if (request.lastFrame) body.end_image_url = toFileUrl(request.lastFrame, "末帧图", "image/png");
  } else {
    if ((request.images && request.images.length) || (request.videos && request.videos.length) || (request.audios && request.audios.length) || request.firstFrame || request.lastFrame) {
      throw new Error("文生视频不接受图片、视频或音频输入，请改用图生视频或参考生视频模型");
    }
  }

  if (request.duration !== undefined) {
    const duration = request.duration;
    if (!Number.isInteger(duration) || duration < options.minDuration || duration > options.maxDuration) {
      throw new Error("该模型时长需为 " + options.minDuration + "~" + options.maxDuration + " 之间的整数秒");
    }
    body.duration = duration;
  }
  if (request.resolution !== undefined) {
    const resolution = request.resolution.toLowerCase();
    if (!options.resolutions.includes(resolution)) {
      throw new Error("该模型不支持分辨率 " + request.resolution + "，可选：" + options.resolutions.join("、"));
    }
    body.resolution = resolution;
  }
  // 图生视频的画幅跟随首幀；宿主节点永远会带一个比例（默认 9:16），在这里送出会覆盖首幀的画幅，所以只在文生与参考生视频送
  if (request.ratio !== undefined && options.wan !== "i2v") {
    if (!WAN_RATIOS.includes(request.ratio)) throw new Error("该模型不支持比例 " + request.ratio + "，可选：" + WAN_RATIOS.join("、"));
    body.aspect_ratio = request.ratio;
  }
  // fal 的 Wan 有明确的声音开关；未指定时沿用平台默认（开启）
  if (request.generateAudio !== undefined) body.audio = request.generateAudio;

  mergeOther(body, request.other, VIDEO_RESERVED);
  const result = await runQueue(context, options.endpoint, body, VIDEO_TOTAL_TIMEOUT_MS, "视频生成");

  const video = asRecord(result.video);
  const url = video ? firstUrl(video.url) : "";
  if (!url) throw new Error("Fal 未返回视频地址");
  const file = await downloadBinary(context, url, video?.content_type, "video/", "video/mp4");
  throwIfAborted(context.signal);
  return [{ mediaType: "video", type: "binary", data: file.bytes, mimeType: file.mimeType }];
}

export default {
  id: "falAi",
  label: "Fal AI 媒体",
  version: "1.0.0",
  readme: `Fal AI 媒体接入：统一走 fal 队列接口（提交 → 轮询 → 取结果 → 下载）。认证为 \`Authorization: Key <FAL_KEY>\`，Key 在 fal.ai/dashboard/keys 获取，只在本供应商配置中填写。

**视频（首帧图生视频，末帧可选；不传首帧时 fal 会按文生视频处理）**
- MiniMax H3（\`minimax/h3/image-to-video\`）：480P / 768P 为原生生成，2K / 4K 由 768P 放大；时长 5~15 秒整数；默认 2K。
- MiniMax H3 Max（\`minimax/h3-max/image-to-video\`）：480P / 768P / 1080P；fal 公布的时长范围是 0.92~15 秒，这里只开放 3~15 的整数秒。
- MiniMax H3 Max Turbo（\`minimax/h3-max-turbo/image-to-video\`）：H3 的后训练版本，参数与 H3 Max 相同（480P / 768P / 1080P，这里开放 3~15 的整数秒）。
**视频（参考生视频，\`reference-to-video\` 三个端点）**
- 图片参考最多 9 张、视频参考最多 3 段（每段 2~15 秒，合计不超过 15 秒）、音频参考最多 3 段（每段 2~15 秒，合计不超过 15 秒），三者合计不超过 12 个文件。
- 提示词里按「类别 + 顺序」引用参考：\`Image 1\`、\`Image 2\`、\`Video 1\`、\`Audio 1\`……，顺序就是传入顺序；这与 Seedance 的 \`{{ref N}}\` 占位不同，不要混用。
- 只有 H3 Max 的参考端点同时接受首帧（\`image_url\`）与末帧（\`end_image_url\`）；H3 与 H3 Max Turbo 的参考端点不接受。
- 宿主不会替换提示词里的 \`{{ref N}}\`。本供应商在参考**全是图片**时，把 \`{{ref N}}\` 替换成 \`Image N\`（编号一致才安全）；含视频或音频参考时保持原样，因此提示词请直接写 \`Image N\`、\`Video N\`、\`Audio N\`。
- 比例可选 adaptive（默认，跟随参考）、21:9、16:9、4:3、1:1、3:4、9:16。
- 音频参考的实际效果（是否能固定角色声音）尚未实测。

- 画幅跟随输入图，没有单独的比例参数；提示词改写默认关闭（\`prompt_expansion_mode: disabled\`），需要时可在扩展参数里传 \`balanced\` 或 \`quality\`。
**视频（MiniMax H3 文生视频与对嘴，2026-10-22 补上）**
- 文生视频：\`minimax/h3/text-to-video\`（5~15 秒，480P / 768P / 2K / 4K，默认 2K）、\`minimax/h3-max/text-to-video\` 与 \`minimax/h3-max-turbo/text-to-video\`（480P / 768P / 1080P；fal 没写时长范围，这里比照同型号图生视频开放 3~15 秒）。比例 21:9、16:9、4:3、1:1、3:4、9:16（没有 adaptive，默认 16:9）。可带 1 段音频（至少 2 秒、最大 15 MB）当成片音轨（\`target_audio_url\`）。
- 对嘴：\`minimax/h3-max/lip-sync/image-to-video\`，1 张人物图（长宽比 0.4~2.5）+ 1 段音频（5 秒～15 分钟），嘴型跟着音频动，成片时长等于音频长度；没有提示词与比例，节点上的时长、比例不会送出。分辨率 480P / 768P / 1080P / 2K（默认 768P）。扩展参数可传 \`enable_transcription: true\`（先转写音频再对嘴）。
- 以上四个端点尚未实际调用验证。

- fal 没有「是否生成音频」的开关；文档只公布了 \`target_audio_url\`（用指定音频替换输出音轨），没有明文说明会生成对白或音效。使用者观察 fal 页面的 H3 Max 与 Turbo 示范影片都带说话与音效，但本接入尚未实测；以实际生成结果为准。

**视频（Wan 3.0，阿里）**
- 图生视频：首帧必填、末帧可选；文生视频；参考生视频（图最多 10、视频最多 5、音频最多 5；提示词里按位置引用，如 \`the subject in Image 1 walks past Video 1\`；输入视频的时长另外计费）。
- 时长 2~30 秒整数；分辨率 480p / 720p / 1080p（小写）；比例 adaptive、16:9、4:3、1:1、3:4、9:16。
- **声音有明确开关**（\`audio\`，平台默认开启）；节点里的「生成音频」会映射到它。
- 提示词改写默认关闭，保证台词与动作原样送达；fal 文档提示关闭「可能降低画质」，需要时在扩展参数传 \`enable_prompt_expansion: true\`，建议同一首帧各生成一次比较。
- 另有 \`alibaba/wan-3.0-prime/image-to-video\`（快速版）端点，本接入尚未收录。

**视频（Seedance，字节）**
- Seedance 2.0 与 2.5 各有图生视频、文生视频、参考生视频三个端点。2.0：4~15 秒，分辨率 480p / 720p / 1080p / 4k；2.5：4~30 秒，480p / 720p / 1080p。
- 时长在 fal 接口里是字符串，本供应商会自动转换；不指定时长时由模型自动决定。**声音有明确开关**（generate_audio，默认开启），包含音效、环境声与口型同步的对白，费用与是否开声音无关（依 fal 文档）。
- 参考生视频：2.0 最多图 9、视频 3、音频 3；2.5 最多图 30、视频 10、音频 10（三类合计不超过 50）。提示词里按 @Image1、@Video1、@Audio1 引用（注意与 Wan、H3 的 Image 1 写法不同）；参考全是图片时，本供应商把残留的 {{ref N}} 换成 @ImageN。
- 图生视频的画幅跟随首帧，不送比例；文生与参考生视频才送比例。2.5 参考生视频另有 task（reference、editing、extension）、draft（480p 草稿预览）等参数，可在扩展参数传入。

**图片（文生图 / 参考图编辑，有参考图时自动改走 /edit 端点）**
- Nano Banana Pro（\`fal-ai/nano-banana-pro\`）：1K / 2K / 4K，比例含 auto 与 21:9，一次最多 4 张。
- GPT Image 2（\`openai/gpt-image-2\`）：只有 1:1、4:3、3:4、16:9、9:16、auto 这几个预设比例，另有画质档位；支持蒙版；一次最多 4 张，参考图最多 16 张。

结果以二进制返回，不依赖会过期的链接。本适配依据 fal 官方 OpenAPI 整理，尚未在该平台实际调用验证，费用以 fal 账单为准。`,
  rules: [
    {
      type: "input",
      field: "apiKey",
      title: "Fal API Key",
      value: "",
      props: { type: "password", showPassword: true, autocomplete: "off", placeholder: "在 fal.ai/dashboard/keys 获取" },
      validate: [{ required: true, message: "请填写 Fal API Key" }],
    },
  ],
  models: [
    {
      id: "fal-ai/nano-banana-pro",
      label: "Nano Banana Pro（Gemini 3 Pro Image，文生图 / 参考图）",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      imageSizes: ["1K", "2K", "4K"],
      imageRatios: ["auto", "21:9", "16:9", "3:2", "4:3", "5:4", "1:1", "4:5", "3:4", "2:3", "9:16"],
    },
    {
      id: "openai/gpt-image-2",
      label: "GPT Image 2（文生图 / 参考图 / 蒙版）",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      imageRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "auto"],
    },
    {
      id: "minimax/h3/image-to-video",
      label: "MiniMax H3（首帧图生视频，末帧可选）",
      type: "video",
      audio: true, // fal 的 H3 一律生成聲音（音效、對白可對嘴），沒有開關（依 fal 範例影片）
      mode: ["endFrameOptional"],
      durationResolutionMap: [{ duration: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480P", "768P", "2K", "4K"] }],
    },
    {
      id: "minimax/h3-max/image-to-video",
      label: "MiniMax H3 Max（首帧图生视频，末帧可选）",
      type: "video",
      audio: true, // fal 的 H3 一律生成聲音（音效、對白可對嘴），沒有開關（依 fal 範例影片）
      mode: ["endFrameOptional"],
      durationResolutionMap: [{ duration: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480P", "768P", "1080P"] }],
    },
    {
      id: "minimax/h3-max-turbo/image-to-video",
      label: "MiniMax H3 Max Turbo（首帧图生视频，末帧可选）",
      type: "video",
      audio: true, // fal 的 H3 一律生成聲音（音效、對白可對嘴），沒有開關（依 fal 範例影片）
      mode: ["endFrameOptional"],
      durationResolutionMap: [{ duration: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480P", "768P", "1080P"] }],
    },
    {
      id: "minimax/h3/reference-to-video",
      label: "MiniMax H3 参考生视频（图 9 / 视频 3 / 音频 3）",
      type: "video",
      audio: true, // fal 的 H3 一律生成聲音（音效、對白可對嘴），沒有開關（依 fal 範例影片）
      mode: ["text", ["imageReference:9", "videoReference:3", "audioReference:3"]],
      durationResolutionMap: [{ duration: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480P", "768P", "2K", "4K"] }],
    },
    {
      id: "minimax/h3-max/reference-to-video",
      label: "MiniMax H3 Max 参考生视频（图 9 / 视频 3 / 音频 3，可加首末帧）",
      type: "video",
      audio: true, // fal 的 H3 一律生成聲音（音效、對白可對嘴），沒有開關（依 fal 範例影片）
      mode: ["text", ["imageReference:9", "videoReference:3", "audioReference:3"]],
      durationResolutionMap: [{ duration: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480P", "768P", "1080P"] }],
    },
    {
      id: "alibaba/wan-3.0/image-to-video",
      label: "Wan 3.0 图生视频（首帧必填，末帧可选，2~30 秒，可开关声音）",
      type: "video",
      audio: "optional", // fal 有聲音開關（wan：audio，seedance：generate_audio），節點才能切換「生成音頻」
      mode: ["endFrameOptional"],
      durationResolutionMap: [{ duration: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], resolution: ["480p", "720p", "1080p"] }],
    },
    {
      id: "alibaba/wan-3.0/text-to-video",
      label: "Wan 3.0 文生视频（2~30 秒，可开关声音）",
      type: "video",
      audio: "optional", // fal 有聲音開關（wan：audio，seedance：generate_audio），節點才能切換「生成音頻」
      mode: ["text"],
      durationResolutionMap: [{ duration: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], resolution: ["480p", "720p", "1080p"] }],
    },
    {
      id: "alibaba/wan-3.0/reference-to-video",
      label: "Wan 3.0 参考生视频（图 10 / 视频 5 / 音频 5，2~30 秒）",
      type: "video",
      audio: "optional", // fal 有聲音開關（wan：audio，seedance：generate_audio），節點才能切換「生成音頻」
      mode: ["text", ["imageReference:10", "videoReference:5", "audioReference:5"]],
      durationResolutionMap: [{ duration: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], resolution: ["480p", "720p", "1080p"] }],
    },
    {
      id: "bytedance/seedance-2.0/image-to-video",
      label: "Seedance 2.0 图生视频（首帧必填，末帧可选，4~15 秒，可开关声音）",
      type: "video",
      audio: "optional", // fal 有聲音開關（wan：audio，seedance：generate_audio），節點才能切換「生成音頻」
      mode: ["endFrameOptional"],
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p", "720p", "1080p", "4k"] }],
    },
    {
      id: "bytedance/seedance-2.0/text-to-video",
      label: "Seedance 2.0 文生视频（4~15 秒，可开关声音）",
      type: "video",
      audio: "optional", // fal 有聲音開關（wan：audio，seedance：generate_audio），節點才能切換「生成音頻」
      mode: ["text"],
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p", "720p", "1080p", "4k"] }],
    },
    {
      id: "bytedance/seedance-2.0/reference-to-video",
      label: "Seedance 2.0 参考生视频（图 9 / 视频 3 / 音频 3，4~15 秒）",
      type: "video",
      audio: "optional", // fal 有聲音開關（wan：audio，seedance：generate_audio），節點才能切換「生成音頻」
      mode: ["text", ["imageReference:9", "videoReference:3", "audioReference:3"]],
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p", "720p", "1080p", "4k"] }],
    },
    {
      id: "bytedance/seedance-2.5/image-to-video",
      label: "Seedance 2.5 图生视频（首帧必填，末帧可选，4~30 秒，可开关声音）",
      type: "video",
      audio: "optional", // fal 有聲音開關（wan：audio，seedance：generate_audio），節點才能切換「生成音頻」
      mode: ["endFrameOptional"],
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], resolution: ["480p", "720p", "1080p"] }],
    },
    {
      id: "bytedance/seedance-2.5/text-to-video",
      label: "Seedance 2.5 文生视频（4~30 秒，可开关声音）",
      type: "video",
      audio: "optional", // fal 有聲音開關（wan：audio，seedance：generate_audio），節點才能切換「生成音頻」
      mode: ["text"],
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], resolution: ["480p", "720p", "1080p"] }],
    },
    {
      id: "bytedance/seedance-2.5/reference-to-video",
      label: "Seedance 2.5 参考生视频（图 30 / 视频 10 / 音频 10，4~30 秒）",
      type: "video",
      audio: "optional", // fal 有聲音開關（wan：audio，seedance：generate_audio），節點才能切換「生成音頻」
      mode: ["text", ["imageReference:30", "videoReference:10", "audioReference:10"]],
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], resolution: ["480p", "720p", "1080p"] }],
    },
    {
      id: "minimax/h3-max-turbo/reference-to-video",
      label: "MiniMax H3 Max Turbo 参考生视频（图 9 / 视频 3 / 音频 3）",
      type: "video",
      audio: true, // fal 的 H3 一律生成聲音（音效、對白可對嘴），沒有開關（依 fal 範例影片）
      mode: ["text", ["imageReference:9", "videoReference:3", "audioReference:3"]],
      durationResolutionMap: [{ duration: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480P", "768P", "1080P"] }],
    },
    {
      id: "minimax/h3/text-to-video",
      label: "MiniMax H3 文生视频（5~15 秒；可带 1 段音频当成片音轨）",
      type: "video",
      audio: true, // fal 的 H3 一律生成聲音，沒有開關
      mode: ["text", ["audioReference:1"]],
      durationResolutionMap: [{ duration: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480P", "768P", "2K", "4K"] }],
    },
    {
      id: "minimax/h3-max/text-to-video",
      label: "MiniMax H3 Max 文生视频（3~15 秒；可带 1 段音频当成片音轨）",
      type: "video",
      audio: true, // fal 的 H3 一律生成聲音，沒有開關
      mode: ["text", ["audioReference:1"]],
      durationResolutionMap: [{ duration: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480P", "768P", "1080P"] }],
    },
    {
      id: "minimax/h3-max-turbo/text-to-video",
      label: "MiniMax H3 Max Turbo 文生视频（3~15 秒；可带 1 段音频当成片音轨）",
      type: "video",
      audio: true, // fal 的 H3 一律生成聲音，沒有開關
      mode: ["text", ["audioReference:1"]],
      durationResolutionMap: [{ duration: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480P", "768P", "1080P"] }],
    },
    {
      id: "minimax/h3-max/lip-sync/image-to-video",
      label: "MiniMax H3 Max 对嘴（1 张人物图 + 1 段音频；时长跟随音频，节点的时长设定不生效）",
      type: "video",
      audio: true, // 成片音軌就是傳入的音訊
      mode: [["imageReference:1", "audioReference:1"]],
      durationResolutionMap: [{ duration: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480P", "768P", "1080P", "2K"] }],
    },
  ],

  async generateImage(this: ProviderContext, request: ImageRequest): Promise<MediaAsset[]> {
    throwIfAborted(this.signal);
    readApiKey(this);
    const options = IMAGE_MODELS[request.model];
    if (!options) throw new Error("不支持的图片模型：" + String(request.model));
    const prompt = typeof request.prompt === "string" ? request.prompt.trim() : "";
    if (!prompt) throw new Error("请填写图片提示词");

    const references: MediaInput[] = request.images ?? [];
    if (references.length > options.maxReferences) {
      throw new Error("该模型最多支持 " + options.maxReferences + " 张参考图，当前传入了 " + references.length + " 张");
    }
    if (request.mask && options.family !== "gptImage") throw new Error("该模型不支持蒙版（mask）输入");
    if (request.mask && !references.length) throw new Error("使用蒙版时必须同时提供参考图");

    const editing = references.length > 0;
    const body: Json = { prompt, sync_mode: false };

    if (request.n !== undefined) {
      const n = request.n;
      if (!Number.isInteger(n) || n < 1) throw new Error("生成数量必须是正整数");
      if (n > options.maxCount) throw new Error("该模型单次最多生成 " + options.maxCount + " 张图片");
      body.num_images = n;
    }

    let pixelSize = "";
    let tier = "";
    if (typeof request.size === "string" && request.size.trim()) {
      const size = request.size.trim();
      if (/^\d+\s*[xX]\s*\d+$/.test(size)) pixelSize = size.replace(/\s+/g, "").toLowerCase();
      else tier = size.toUpperCase();
    }

    if (options.family === "nano") {
      if (tier) {
        if (!options.tiers!.includes(tier)) throw new Error("该模型不支持 " + request.size + " 分辨率，可选：" + options.tiers!.join("、"));
        body.resolution = tier;
      }
      let ratio = request.ratio;
      if (pixelSize) ratio = ratioFromPixels(pixelSize, options.ratios);
      if (ratio !== undefined) {
        if (!options.ratios.includes(ratio)) throw new Error("该模型不支持比例 " + ratio + "，可选：" + options.ratios.join("、"));
        body.aspect_ratio = ratio;
      }
      if (request.quality !== undefined) throw new Error("该模型没有画质档位参数，请用分辨率档位（1K / 2K / 4K）");
    } else {
      if (tier) throw new Error("该模型不支持分辨率档位，请改用画面比例或具体像素尺寸");
      if (pixelSize) {
        const parts = pixelSize.split("x");
        body.image_size = { width: Number(parts[0]), height: Number(parts[1]) };
      } else if (request.ratio !== undefined) {
        const preset = GPT_IMAGE_PRESETS[request.ratio];
        if (!preset) throw new Error("该模型不支持比例 " + request.ratio + "，可选：" + options.ratios.join("、"));
        body.image_size = preset;
      }
      if (request.quality !== undefined) {
        if (!options.qualities!.includes(request.quality)) throw new Error("该模型画质档位只能是：" + options.qualities!.join("、"));
        body.quality = request.quality;
      }
    }
    if (request.outputFormat !== undefined) body.output_format = request.outputFormat;

    if (editing) {
      body.image_urls = references.map((item, index) => toFileUrl(item, "第 " + (index + 1) + " 张参考图", "image/png"));
      if (request.mask) body.mask_url = toFileUrl(request.mask, "蒙版", "image/png");
    }

    mergeOther(body, request.other, IMAGE_RESERVED);
    const result = await runQueue(this, editing ? options.editEndpoint : options.endpoint, body, IMAGE_TOTAL_TIMEOUT_MS, "图片生成");

    const images = Array.isArray(result.images) ? result.images : [];
    const assets: MediaAsset[] = [];
    for (const item of images) {
      const entry = asRecord(item);
      const url = entry ? firstUrl(entry.url) : "";
      if (!url) continue;
      const file = await downloadBinary(this, url, entry?.content_type, "image/", "image/png");
      assets.push({ mediaType: "image", type: "binary", data: file.bytes, mimeType: file.mimeType });
    }
    if (!assets.length) throw new Error("Fal 未返回图片数据");
    throwIfAborted(this.signal);
    return assets;
  },

  async generateVideo(this: ProviderContext, request: VideoRequest): Promise<MediaAsset[]> {
    throwIfAborted(this.signal);
    readApiKey(this);
    const options = VIDEO_MODELS[request.model];
    if (!options) throw new Error("不支持的视频模型：" + String(request.model));
    const prompt = typeof request.prompt === "string" ? request.prompt.trim() : "";
    if (options.lipsync) return generateLipSyncVideo(this, request, options);
    if (!prompt) throw new Error("请填写视频提示词");

    if (options.wan) return generateWanVideo(this, request, options, prompt);
    if (options.seedance) return generateSeedanceVideo(this, request, options, prompt);

    // 提示词改写默认关闭，保证写进去的镜头、动作与声音描述原样送给模型
    const body: Json = { prompt, prompt_expansion_mode: "disabled", sync_mode: false };

    if (options.reference) {
      const images = request.images ?? [];
      const videos = request.videos ?? [];
      const audios = request.audios ?? [];
      if (images.length > REFERENCE_LIMITS.images) throw new Error("参考图最多 " + REFERENCE_LIMITS.images + " 张，当前 " + images.length + " 张");
      if (videos.length > REFERENCE_LIMITS.videos) throw new Error("参考视频最多 " + REFERENCE_LIMITS.videos + " 段，当前 " + videos.length + " 段");
      if (audios.length > REFERENCE_LIMITS.audios) throw new Error("参考音频最多 " + REFERENCE_LIMITS.audios + " 段，当前 " + audios.length + " 段");
      if (images.length + videos.length + audios.length > REFERENCE_LIMITS.total) {
        throw new Error("图片、视频、音频参考合计最多 " + REFERENCE_LIMITS.total + " 个文件");
      }
      if (images.length) body.reference_image_urls = images.map((item, index) => toFileUrl(item, "第 " + (index + 1) + " 张参考图", "image/png"));
      if (videos.length) body.reference_video_urls = videos.map((item, index) => toFileUrl(item, "第 " + (index + 1) + " 段参考视频", "video/mp4"));
      if (audios.length) body.reference_audio_urls = audios.map((item, index) => toFileUrl(item, "第 " + (index + 1) + " 段参考音频", "audio/mpeg"));
      body.prompt = translateImageRefs(prompt, images.length, videos.length, audios.length);
      if (request.firstFrame || request.lastFrame) {
        if (!options.frames) throw new Error("该参考模型不接受首帧 / 末帧，请改用图生视频模型，或把画面作为参考图传入");
        if (request.firstFrame) body.image_url = toFileUrl(request.firstFrame, "首帧图", "image/png");
        if (request.lastFrame) body.end_image_url = toFileUrl(request.lastFrame, "末帧图", "image/png");
      }
      if (request.ratio !== undefined) {
        if (!["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"].includes(request.ratio)) throw new Error("该模型不支持比例 " + request.ratio);
        body.aspect_ratio = request.ratio;
      }
    } else if (options.t2v) {
      if ((request.images && request.images.length) || request.firstFrame || request.lastFrame) {
        throw new Error("文生视频不接受图片，要用图请改用 image-to-video 或 reference-to-video 模型");
      }
      if (request.videos && request.videos.length) throw new Error("文生视频不接受参考视频");
      if (request.audios && request.audios.length > 1) throw new Error("文生视频最多只接受 1 段目标音频（会成为成片音轨）");
      if (request.ratio !== undefined) {
        if (!["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"].includes(request.ratio)) throw new Error("该模型不支持比例 " + request.ratio + "，可选：21:9、16:9、4:3、1:1、3:4、9:16");
        body.aspect_ratio = request.ratio;
      }
    } else {
      if (request.videos && request.videos.length) throw new Error("该模型不支持参考视频输入，请改用 reference-to-video 模型");
      if (request.audios && request.audios.length > 1) throw new Error("该模型最多只接受 1 段目标音频");

      let firstFrame: MediaInput | undefined = request.firstFrame;
      if (!firstFrame && request.images && request.images.length) {
        if (request.images.length > 1) throw new Error("图生视频只支持 1 张首帧图，多张参考图请改用 reference-to-video 模型");
        firstFrame = request.images[0];
      }
      if (firstFrame) body.image_url = toFileUrl(firstFrame, "首帧图", "image/png");
      if (request.lastFrame) body.end_image_url = toFileUrl(request.lastFrame, "末帧图", "image/png");
    }

    if (request.duration !== undefined) {
      const duration = request.duration;
      if (!Number.isInteger(duration) || duration < options.minDuration || duration > options.maxDuration) {
        throw new Error("该模型时长需为 " + options.minDuration + "~" + options.maxDuration + " 之间的整数秒");
      }
      body.duration = duration;
    }
    if (request.resolution !== undefined) {
      const resolution = request.resolution.toUpperCase();
      if (!options.resolutions.includes(resolution)) {
        throw new Error("该模型不支持分辨率 " + request.resolution + "，可选：" + options.resolutions.join("、"));
      }
      body.resolution = resolution;
    }
    if (!options.reference && request.audios && request.audios.length === 1) {
      body.target_audio_url = toFileUrl(request.audios[0], "目标音频", "audio/mpeg");
    }

    mergeOther(body, request.other, VIDEO_RESERVED);
    const result = await runQueue(this, options.endpoint, body, VIDEO_TOTAL_TIMEOUT_MS, "视频生成");

    const video = asRecord(result.video);
    const url = video ? firstUrl(video.url) : "";
    if (!url) throw new Error("Fal 未返回视频地址");
    const file = await downloadBinary(this, url, video?.content_type, "video/", "video/mp4");
    throwIfAborted(this.signal);
    return [{ mediaType: "video", type: "binary", data: file.bytes, mimeType: file.mimeType }];
  },
};

// MiniMax APIs used by IdeaCut (one key for everything):
//   POST /v1/chat/completions   text (OpenAI-compatible)
//   POST /v1/t2a_v2             speech synthesis
//   POST /v1/get_voice          voice list
//   POST /v1/music_generation   background music (not available to new MiniMax users since 2026-08-20)

export const MINIMAX_BASE_URL = "https://api.minimax.io";
/** International and mainland-China platforms; a key works on only one of them. */
export const MINIMAX_REGIONS = ["https://api.minimax.io", "https://api.minimaxi.com"];
/** Preferred text models, best first; the first one the account can use is picked. */
export const TEXT_MODELS = ["MiniMax-M3.1-Flash-Preview", "MiniMax-M3", "MiniMax-M2.7"];
export const TTS_MODEL = "speech-2.8-hd";
export const MUSIC_MODEL = "music-3.0";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface SpeechResult {
  audio: Buffer;
  format: "mp3";
  durationMs: number;
  /** Sentence timings (ms) when the service returns them. */
  sentences?: { text: string; startMs: number; endMs: number }[];
}

export interface Voice {
  id: string;
  name: string;
  description: string;
}

/** What the workflow needs from an AI provider; MiniMax in production, a mock in demo mode/tests. */
export interface Provider {
  readonly demo: boolean;
  chat(messages: ChatMessage[], opts?: { temperature?: number; maxTokens?: number }): Promise<string>;
  speech(text: string, opts: { voiceId: string; language: "zh" | "en"; speed?: number }): Promise<SpeechResult>;
  voices(): Promise<Voice[]>;
  music(prompt: string, seconds: number): Promise<Buffer>;
}

export class MiniMaxError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/** Human explanations for MiniMax error codes that need the user to act. */
function explain(code: number | undefined, http: number, msg: string): string {
  if (code === 1008 || http === 402) return "MiniMax 账户余额不足，请到 MiniMax 开放平台充值后重试";
  if (code === 2049 || code === 1004 || http === 401) return "MiniMax API Key 无效（注意国际站与国内站的 Key 不通用）";
  if (code === 2013 && /model/i.test(msg)) return `当前账号不能使用这个模型：${msg}`;
  if (code === 1002 || http === 429) return "请求太频繁，稍后自动重试";
  if (code === 1026 || code === 1027) return "内容未通过安全审核，请修改文字后重试";
  return msg;
}

/** Errors the user has to fix (balance, key, model); retrying or falling back would hide them. */
export function isFatal(err: unknown): boolean {
  return err instanceof MiniMaxError && [1004, 1008, 2049, 2013, 401, 402, 1026, 1027].includes(err.status);
}

/** Removes <think>…</think> reasoning blocks that M2.x models put in the content. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

export class MiniMax implements Provider {
  readonly demo = false;
  private textModel?: string;

  constructor(
    private readonly key: string,
    readonly baseUrl = MINIMAX_BASE_URL,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** The best text model this account offers (from GET /v1/models), cached. */
  async model(): Promise<string> {
    if (this.textModel) return this.textModel;
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/v1/models`, { headers: { Authorization: `Bearer ${this.key}` } });
      const ids = new Set(((await res.json()) as { data?: { id: string }[] }).data?.map((m) => m.id) ?? []);
      this.textModel = TEXT_MODELS.find((m) => ids.has(m)) ?? TEXT_MODELS[TEXT_MODELS.length - 1]!;
    } catch {
      this.textModel = TEXT_MODELS[TEXT_MODELS.length - 1]!;
    }
    return this.textModel;
  }

  private async post(path: string, body: unknown, timeoutMs = 120_000): Promise<any> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
    } catch (err) {
      throw new MiniMaxError(`network error calling MiniMax ${path}: ${(err as Error).message}`, 0, true);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text.slice(0, 300) };
    }
    // Errors come either as base_resp.status_code or as an OpenAI-style error ending in "(1008)".
    const tail = String(data?.error?.message ?? "").match(/\((\d{4})\)\s*$/)?.[1];
    const code: number | undefined = data?.base_resp?.status_code ?? (tail ? Number(tail) : undefined);
    if (!res.ok || (code !== undefined && code !== 0)) {
      const msg = data?.base_resp?.status_msg ?? data?.error?.message ?? data?.raw ?? `HTTP ${res.status}`;
      throw new MiniMaxError(`MiniMax ${path}: ${explain(code, res.status, msg)}`, code ?? res.status, res.status === 429 || res.status >= 500 || code === 1002 || code === 1001 || code === 1000);
    }
    return data;
  }

  async chat(messages: ChatMessage[], opts: { temperature?: number; maxTokens?: number } = {}): Promise<string> {
    const model = await this.model();
    const data = await this.post("/v1/chat/completions", {
      model,
      messages,
      temperature: opts.temperature ?? 0.7,
      max_completion_tokens: opts.maxTokens ?? 8192,
      // M3.1 Flash returns reasoning separately; keep it short for structured writing.
      ...(model.includes("Flash") ? { reasoning_effort: "low" } : {}),
    });
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new MiniMaxError("MiniMax returned no text", 200, true);
    return stripThinking(content);
  }

  async speech(text: string, opts: { voiceId: string; language: "zh" | "en"; speed?: number }): Promise<SpeechResult> {
    const data = await this.post("/v1/t2a_v2", {
      model: TTS_MODEL,
      text,
      stream: false,
      language_boost: opts.language === "zh" ? "Chinese" : "English",
      output_format: "hex",
      voice_setting: { voice_id: opts.voiceId, speed: opts.speed ?? 1, vol: 1, pitch: 0 },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 },
      subtitle_enable: true,
      subtitle_type: "sentence",
    });
    const hex = data?.data?.audio;
    if (!hex) throw new MiniMaxError("MiniMax returned no audio", 200, true);
    let sentences: SpeechResult["sentences"];
    const subUrl = data?.data?.subtitle_file;
    if (typeof subUrl === "string" && subUrl.startsWith("http")) {
      try {
        const subs = (await (await this.fetchImpl(subUrl)).json()) as { text: string; time_begin: number; time_end: number }[];
        sentences = subs.map((s) => ({ text: s.text, startMs: s.time_begin, endMs: s.time_end }));
      } catch {
        /* timings are optional */
      }
    }
    return { audio: Buffer.from(hex, "hex"), format: "mp3", durationMs: data?.extra_info?.audio_length ?? 0, sentences };
  }

  async voices(): Promise<Voice[]> {
    const data = await this.post("/v1/get_voice", { voice_type: "system" });
    return (data?.system_voice ?? []).map((v: { voice_id: string; voice_name?: string; description?: string[] }) => ({
      id: v.voice_id,
      name: v.voice_name ?? v.voice_id,
      description: (v.description ?? []).join(" "),
    }));
  }

  async music(prompt: string, _seconds: number): Promise<Buffer> {
    const data = await this.post("/v1/music_generation", { model: MUSIC_MODEL, prompt, is_instrumental: true, output_format: "hex", audio_setting: { sample_rate: 44100, bitrate: 128000, format: "mp3" } }, 300_000);
    const hex = data?.data?.audio;
    if (!hex) throw new MiniMaxError("MiniMax returned no music", 200, false);
    return Buffer.from(hex, "hex");
  }
}

/** Retries retryable failures with exponential backoff. */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseMs = 1500): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      const retryable = err instanceof MiniMaxError ? err.retryable && !isFatal(err) : true;
      if (!retryable || i === attempts - 1) break;
      await new Promise((r) => setTimeout(r, baseMs * 2 ** i));
    }
  }
  throw last;
}

/** Finds which platform (international / mainland China) accepts the key, via a free call. */
export async function detectRegion(key: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  let last: unknown;
  for (const base of MINIMAX_REGIONS) {
    try {
      await new MiniMax(key, base, fetchImpl).voices();
      return base;
    } catch (err) {
      last = err;
    }
  }
  throw last instanceof Error ? last : new Error("MiniMax rejected the key on every platform");
}

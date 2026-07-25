import type {
  AudioFormat,
  TTSAdapter,
  TTSSessionEventMap,
} from "@absolutejs/voice";
import type {
  CartesiaOutputFormat,
  CartesiaTTSOptions,
  CartesiaVoice,
} from "./types";

type ListenerMap = {
  [K in keyof TTSSessionEventMap]: Set<
    (payload: TTSSessionEventMap[K]) => void | Promise<void>
  >;
};

const DEFAULT_BASE_URL = "https://api.cartesia.ai";
const DEFAULT_CARTESIA_VERSION = "2024-11-13";
const DEFAULT_MODEL = "sonic-2";

const DEFAULT_OUTPUT_FORMAT: Required<
  Pick<CartesiaOutputFormat, "container" | "encoding" | "sampleRate">
> = {
  container: "raw",
  encoding: "pcm_s16le",
  sampleRate: 24_000,
};

// Opportunistic HTTP/2 multiplexing for outbound HTTPS calls (Bun 1.3.14+).
type H2Init = RequestInit & { protocol?: "http2" };
const isHttpsUrl = (url: string | URL) =>
  typeof url === "string"
    ? url.startsWith("https://")
    : url.protocol === "https:";
const h2IfHttps = (url: string | URL): H2Init =>
  isHttpsUrl(url) ? { protocol: "http2" } : {};

const createListenerMap = (): ListenerMap => ({
  audio: new Set(),
  close: new Set(),
  error: new Set(),
});

const emit = async <K extends keyof TTSSessionEventMap>(
  listeners: ListenerMap,
  event: K,
  payload: TTSSessionEventMap[K],
) => {
  for (const listener of listeners[event]) {
    await listener(payload);
  }
};

const resolveErrorMessage = (error: unknown): string => {
  if (typeof error === "string" && error.trim()) {
    return error;
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    for (const key of ["message", "detail", "description", "reason"]) {
      const candidate = record[key];
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate;
      }
    }

    if ("error" in record) {
      return resolveErrorMessage(record.error);
    }

    try {
      return JSON.stringify(error);
    } catch {}
  }

  return "Cartesia TTS request failed";
};

const omitUndefined = (value: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );

const resolveVoice = (voice: CartesiaTTSOptions["voice"]): CartesiaVoice => {
  if (typeof voice === "string") {
    return { id: voice, mode: "id" };
  }
  if (voice.mode === "embedding") {
    return voice;
  }
  return { ...voice, mode: "id" };
};

const resolveOutputFormat = (
  outputFormat: CartesiaOutputFormat | undefined,
) => ({
  bit_rate: outputFormat?.bitRate,
  container: outputFormat?.container ?? DEFAULT_OUTPUT_FORMAT.container,
  encoding: outputFormat?.encoding ?? DEFAULT_OUTPUT_FORMAT.encoding,
  sample_rate: outputFormat?.sampleRate ?? DEFAULT_OUTPUT_FORMAT.sampleRate,
});

const resolveVoicePayload = (voice: CartesiaVoice) =>
  omitUndefined({
    __experimental_controls: voice.__experimentalControls,
    embedding: voice.mode === "embedding" ? voice.embedding : undefined,
    id: voice.mode === "id" ? voice.id : undefined,
    mode: voice.mode,
  });

const buildAudioFormat = (
  outputFormat: CartesiaOutputFormat | undefined,
): AudioFormat => {
  const container = outputFormat?.container ?? DEFAULT_OUTPUT_FORMAT.container;
  const encoding = outputFormat?.encoding ?? DEFAULT_OUTPUT_FORMAT.encoding;
  const sampleRate =
    outputFormat?.sampleRate ?? DEFAULT_OUTPUT_FORMAT.sampleRate;

  if (
    container === "raw" &&
    (encoding === "mulaw" || encoding === "pcm_mulaw") &&
    sampleRate === 8_000
  ) {
    return {
      channels: 1,
      container: "raw",
      encoding: "mulaw",
      sampleRateHz: 8_000,
    } as unknown as AudioFormat;
  }

  if (container === "raw" && encoding === "pcm_alaw" && sampleRate === 8_000) {
    return {
      channels: 1,
      container: "raw",
      encoding: "alaw",
      sampleRateHz: 8_000,
    } as unknown as AudioFormat;
  }

  if (container === "raw" && encoding === "pcm_s16le") {
    return {
      channels: 1,
      container: "raw",
      encoding: "pcm_s16le",
      sampleRateHz: sampleRate,
    };
  }

  if (container === "raw" && encoding === "pcm_f32le") {
    return {
      channels: 1,
      container: "raw",
      encoding: "pcm_f32le",
      sampleRateHz: sampleRate,
    } as unknown as AudioFormat;
  }

  if (container === "raw") {
    throw new Error(
      `Unsupported Cartesia raw encoding "${String(encoding)}" for @absolutejs/voice TTS. ` +
        `Use pcm_s16le for browser playback or pcm_mulaw@8000 for telephony.`,
    );
  }

  throw new Error(
    `Unsupported Cartesia container "${String(container)}" for @absolutejs/voice TTS streaming. ` +
      `Use container "raw" to get streamable PCM frames.`,
  );
};

const ensureExpectedRawEncoding = (
  outputFormat: CartesiaOutputFormat | undefined,
) => {
  const container = outputFormat?.container ?? DEFAULT_OUTPUT_FORMAT.container;
  if (container !== "raw") {
    throw new Error(
      `The @absolutejs/voice-cartesia adapter requires output_format.container = "raw" for streaming. Got "${String(container)}".`,
    );
  }
};

const buildTtsRequestPayload = (config: CartesiaTTSOptions, text: string) => {
  const voice = resolveVoice(config.voice);
  return omitUndefined({
    language: config.language,
    model_id: config.model ?? DEFAULT_MODEL,
    output_format: resolveOutputFormat(config.outputFormat),
    speed: config.speed,
    transcript: text,
    voice: resolveVoicePayload(voice),
  });
};

const buildBytesUrl = (config: CartesiaTTSOptions) => {
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  return new URL(`${baseUrl}/tts/bytes`);
};

const buildSseUrl = (config: CartesiaTTSOptions) => {
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  return new URL(`${baseUrl}/tts/sse`);
};

const buildHeaders = (config: CartesiaTTSOptions) => ({
  "Cartesia-Version": config.version ?? DEFAULT_CARTESIA_VERSION,
  "Content-Type": "application/json",
  "X-API-Key": config.apiKey,
});

type SseAudioEvent = {
  data?: string;
  type?: string;
};

const decodeBase64 = (value: string) =>
  new Uint8Array(Buffer.from(value, "base64"));

const parseSseEvent = (block: string): SseAudioEvent | undefined => {
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) return undefined;
  const data = dataLines.join("\n");
  if (!data || data === "[DONE]") return undefined;
  try {
    return JSON.parse(data) as SseAudioEvent;
  } catch {
    return undefined;
  }
};

const splitSseBuffer = (
  buffer: string,
): {
  events: string[];
  remainder: string;
} => {
  const events: string[] = [];
  let remainder = buffer;
  while (true) {
    const boundary = remainder.indexOf("\n\n");
    if (boundary === -1) break;
    events.push(remainder.slice(0, boundary));
    remainder = remainder.slice(boundary + 2);
  }
  return { events, remainder };
};

export const cartesia = (config: CartesiaTTSOptions): TTSAdapter => {
  ensureExpectedRawEncoding(config.outputFormat);
  const fetchImpl = config.fetch ?? globalThis.fetch;
  const transport = config.transport ?? "sse";

  return {
    kind: "tts",
    open: () => {
      const listeners = createListenerMap();
      const audioFormat = buildAudioFormat(config.outputFormat);
      const activeControllers = new Set<AbortController>();
      let closed = false;

      const close = async (reason?: string) => {
        if (closed) return;
        closed = true;
        for (const controller of activeControllers) {
          controller.abort(reason);
        }
        await emit(listeners, "close", {
          reason,
          recoverable: false,
          type: "close",
        });
      };

      const cancel = async (reason?: string) => {
        if (closed) return;
        for (const controller of activeControllers) {
          controller.abort(reason ?? "cancelled");
        }
        activeControllers.clear();
      };

      const on: ReturnType<TTSAdapter["open"]> extends Promise<infer S>
        ? S
        : ReturnType<TTSAdapter["open"]> = {
        cancel,
        close,
        on: (event, handler) => {
          listeners[event].add(handler as never);
          return () => {
            listeners[event].delete(handler as never);
          };
        },
        send: async (text: string) => {
          if (closed) return;
          const trimmed = text.trim();
          if (!trimmed) return;

          const controller = new AbortController();
          activeControllers.add(controller);

          try {
            const target =
              transport === "http"
                ? buildBytesUrl(config)
                : buildSseUrl(config);
            const response = await fetchImpl(target, {
              ...h2IfHttps(target),
              body: JSON.stringify(buildTtsRequestPayload(config, trimmed)),
              headers: buildHeaders(config),
              method: "POST",
              signal: controller.signal,
            });

            if (!response.ok || !response.body) {
              const bodyText = await response.text().catch(() => "");
              throw new Error(
                `Cartesia returned ${String(response.status)} ${response.statusText}${
                  bodyText ? `: ${bodyText.slice(0, 200)}` : ""
                }`,
              );
            }

            if (transport === "http") {
              const reader = response.body.getReader();
              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done || !value) break;
                  await emit(listeners, "audio", {
                    chunk: value,
                    format: audioFormat,
                    receivedAt: Date.now(),
                    type: "audio",
                  });
                }
              } finally {
                reader.releaseLock();
              }
              return;
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder("utf-8");
            let buffer = "";
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (!value) continue;
                buffer += decoder.decode(value, {
                  stream: true,
                });
                const { events, remainder } = splitSseBuffer(buffer);
                buffer = remainder;
                for (const block of events) {
                  const parsed = parseSseEvent(block);
                  if (!parsed || parsed.type === "done" || !parsed.data) {
                    continue;
                  }
                  if (parsed.type === "error") {
                    throw new Error(resolveErrorMessage(parsed));
                  }
                  await emit(listeners, "audio", {
                    chunk: decodeBase64(parsed.data),
                    format: audioFormat,
                    receivedAt: Date.now(),
                    type: "audio",
                  });
                }
              }
            } finally {
              reader.releaseLock();
            }
          } catch (error) {
            if ((error as Error).name === "AbortError") return;
            await emit(listeners, "error", {
              error:
                error instanceof Error
                  ? error
                  : new Error(resolveErrorMessage(error)),
              recoverable: false,
              type: "error",
            });
          } finally {
            activeControllers.delete(controller);
          }
        },
      };

      return on;
    },
  };
};

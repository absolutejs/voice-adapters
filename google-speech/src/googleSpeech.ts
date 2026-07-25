import type {
  STTAdapter,
  STTAdapterSession,
  STTSessionEventMap,
} from "@absolutejs/voice";
import type { GoogleSpeechEncoding, GoogleSpeechSTTOptions } from "./types";

type ListenerMap = {
  [K in keyof STTSessionEventMap]: Set<
    (payload: STTSessionEventMap[K]) => void | Promise<void>
  >;
};

const DEFAULT_BASE_URL = "https://speech.googleapis.com";
const DEFAULT_ENDPOINT_PATH = "/v1/speech:recognize";
const DEFAULT_MODEL: GoogleSpeechSTTOptions["model"] = "default";
const DEFAULT_MAX_BUFFERED_BYTES = 10 * 1024 * 1024; // ~10 MB; v1 hard limit is ~10 MB

// Opportunistic HTTP/2 multiplexing for outbound HTTPS calls (Bun 1.3.14+).
type H2Init = RequestInit & { protocol?: "http2" };
const isHttpsUrl = (url: string | URL) =>
  typeof url === "string"
    ? url.startsWith("https://")
    : url.protocol === "https:";
const h2IfHttps = (url: string | URL): H2Init =>
  isHttpsUrl(url) ? { protocol: "http2" } : {};

const createListenerMap = (): ListenerMap => ({
  close: new Set(),
  endOfTurn: new Set(),
  error: new Set(),
  final: new Set(),
  partial: new Set(),
});

const emit = async <K extends keyof STTSessionEventMap>(
  listeners: ListenerMap,
  event: K,
  payload: STTSessionEventMap[K],
) => {
  for (const listener of listeners[event]) {
    await listener(payload);
  }
};

const toUint8Array = (chunk: ArrayBuffer | ArrayBufferView): Uint8Array => {
  if (chunk instanceof Uint8Array) return chunk;
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  return new Uint8Array(chunk);
};

const concatBuffers = (buffers: readonly Uint8Array[]): Uint8Array => {
  let total = 0;
  for (const buffer of buffers) total += buffer.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const buffer of buffers) {
    out.set(buffer, offset);
    offset += buffer.byteLength;
  }
  return out;
};

const base64Encode = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64");

const resolveEncoding = (format: {
  encoding?: string;
}): GoogleSpeechEncoding => {
  switch (format.encoding) {
    case "pcm_s16le":
      return "LINEAR16";
    case "mulaw":
    case "pcm_mulaw":
      return "MULAW";
    case "alaw":
    case "pcm_alaw":
      return "ALAW";
    default:
      throw new Error(
        `Unsupported audio encoding "${String(format.encoding)}" for @absolutejs/voice-google-speech. ` +
          `Use pcm_s16le, mulaw, or alaw.`,
      );
  }
};

const resolveLanguage = (
  openOptions: { languageStrategy?: unknown },
  config: GoogleSpeechSTTOptions,
): string => {
  const strategy = openOptions.languageStrategy as
    | {
        allowedLanguages?: string[];
        mode: "allow-switching" | "auto-detect" | "fixed";
        primaryLanguage?: string;
        secondaryLanguages?: string[];
      }
    | undefined;
  if (strategy?.mode === "fixed" && strategy.primaryLanguage) {
    return strategy.primaryLanguage;
  }
  if (strategy?.mode === "allow-switching" && strategy.primaryLanguage) {
    return strategy.primaryLanguage;
  }
  if (strategy?.mode === "auto-detect" && strategy.allowedLanguages?.[0]) {
    return strategy.allowedLanguages[0];
  }
  return config.language ?? "en-US";
};

const resolveAlternativeLanguageCodes = (openOptions: {
  languageStrategy?: unknown;
}): readonly string[] | undefined => {
  const strategy = openOptions.languageStrategy as
    | {
        allowedLanguages?: string[];
        mode: "allow-switching" | "auto-detect" | "fixed";
        primaryLanguage?: string;
        secondaryLanguages?: string[];
      }
    | undefined;
  if (strategy?.mode === "allow-switching") {
    const codes = strategy.secondaryLanguages ?? [];
    return codes.length > 0 ? codes : undefined;
  }
  if (strategy?.mode === "auto-detect") {
    const allowed = strategy.allowedLanguages ?? [];
    return allowed.length > 1 ? allowed.slice(1) : undefined;
  }
  return undefined;
};

const buildEndpointUrl = (config: GoogleSpeechSTTOptions): URL => {
  const base = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const url = new URL(`${base}${DEFAULT_ENDPOINT_PATH}`);
  if ("apiKey" in config && config.apiKey) {
    url.searchParams.set("key", config.apiKey);
  }
  return url;
};

const omitUndefined = (value: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );

type GoogleSpeechResponse = {
  results?: Array<{
    alternatives?: Array<{
      confidence?: number;
      transcript?: string;
    }>;
    languageCode?: string;
  }>;
};

const resolveErrorMessage = (error: unknown): string => {
  if (typeof error === "string" && error.trim()) return error;
  if (error instanceof Error && error.message.trim()) return error.message;
  return "Google Speech request failed";
};

export const googleSpeech = (config: GoogleSpeechSTTOptions): STTAdapter => {
  const hasApiKey = "apiKey" in config && Boolean(config.apiKey);
  const hasAccessToken = "accessToken" in config && Boolean(config.accessToken);
  if (!hasApiKey && !hasAccessToken && !config.getAccessToken) {
    throw new Error(
      "@absolutejs/voice-google-speech requires either apiKey, accessToken, or getAccessToken.",
    );
  }
  const fetchImpl = config.fetch ?? globalThis.fetch;
  const maxBufferedBytes =
    config.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  const flushOnClose = config.flushOnClose ?? true;

  return {
    kind: "stt",
    open: (openOptions) => {
      const listeners = createListenerMap();
      const encoding = resolveEncoding(openOptions.format);
      const sampleRateHz = openOptions.format.sampleRateHz ?? 16_000;
      const channels = openOptions.format.channels ?? 1;
      const languageCode = resolveLanguage(openOptions, config);
      const alternativeLanguageCodes =
        resolveAlternativeLanguageCodes(openOptions);

      const buffers: Uint8Array[] = [];
      let bufferedBytes = 0;
      let closed = false;
      let flushSeq = 0;

      const flush = async () => {
        if (buffers.length === 0) return;
        const pcm = concatBuffers(buffers);
        buffers.length = 0;
        bufferedBytes = 0;
        const target = buildEndpointUrl(config);
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (config.getAccessToken) {
          const token = await config.getAccessToken();
          headers["Authorization"] = `Bearer ${token}`;
        } else if (hasAccessToken && "accessToken" in config) {
          headers["Authorization"] = `Bearer ${config.accessToken}`;
        }
        const requestBody = {
          audio: { content: base64Encode(pcm) },
          config: omitUndefined({
            alternativeLanguageCodes,
            audioChannelCount: channels,
            diarizationConfig: config.diarizationConfig,
            enableAutomaticPunctuation: config.enableAutomaticPunctuation,
            enableSpeakerDiarization: config.enableSpeakerDiarization,
            enableWordTimeOffsets: config.enableWordTimeOffsets,
            encoding,
            languageCode,
            model: config.model ?? DEFAULT_MODEL,
            profanityFilter: config.profanityFilter,
            sampleRateHertz: sampleRateHz,
            speechContexts: config.speechContexts,
            useEnhanced: config.useEnhanced,
          }),
        };
        flushSeq += 1;
        try {
          const response = await fetchImpl(target, {
            ...h2IfHttps(target),
            body: JSON.stringify(requestBody),
            headers,
            method: "POST",
          });
          if (!response.ok) {
            const bodyText = await response.text().catch(() => "");
            throw new Error(
              `Google Speech returned ${String(response.status)} ${response.statusText}${
                bodyText ? `: ${bodyText.slice(0, 200)}` : ""
              }`,
            );
          }
          const body = (await response.json()) as GoogleSpeechResponse;
          const results = body.results ?? [];
          const parts: string[] = [];
          let confidenceSum = 0;
          let confidenceCount = 0;
          let firstLanguage: string | undefined;
          for (const result of results) {
            const alternative = result.alternatives?.[0];
            if (alternative?.transcript) {
              parts.push(alternative.transcript.trim());
            }
            if (typeof alternative?.confidence === "number") {
              confidenceSum += alternative.confidence;
              confidenceCount += 1;
            }
            if (!firstLanguage && result.languageCode) {
              firstLanguage = result.languageCode;
            }
          }
          const text = parts.join(" ").trim();
          if (text) {
            await emit(listeners, "final", {
              receivedAt: Date.now(),
              transcript: {
                confidence:
                  confidenceCount > 0
                    ? confidenceSum / confidenceCount
                    : undefined,
                id: `google-speech:final:${String(flushSeq)}`,
                isFinal: true,
                language: firstLanguage ?? languageCode,
                text,
                vendor: "google-speech",
              },
              type: "final",
            });
          }
          await emit(listeners, "endOfTurn", {
            reason: "vendor",
            receivedAt: Date.now(),
            type: "endOfTurn",
          });
        } catch (error) {
          await emit(listeners, "error", {
            error:
              error instanceof Error
                ? error
                : new Error(resolveErrorMessage(error)),
            recoverable: false,
            type: "error",
          });
        }
      };

      const session: STTAdapterSession & {
        flush: () => Promise<void>;
      } = {
        close: async (reason?: string) => {
          if (closed) return;
          closed = true;
          if (flushOnClose) {
            try {
              await flush();
            } catch {}
          }
          await emit(listeners, "close", {
            reason,
            recoverable: false,
            type: "close",
          });
        },
        flush,
        on: (event, handler) => {
          listeners[event].add(handler as never);
          return () => {
            listeners[event].delete(handler as never);
          };
        },
        send: async (audio) => {
          if (closed) return;
          const bytes = toUint8Array(audio);
          if (bytes.byteLength === 0) return;
          if (bufferedBytes + bytes.byteLength > maxBufferedBytes) {
            throw new Error(
              `@absolutejs/voice-google-speech buffer overflow: maxBufferedBytes=${String(maxBufferedBytes)}. Call session.flush() between turns.`,
            );
          }
          buffers.push(bytes);
          bufferedBytes += bytes.byteLength;
        },
      };

      return session;
    },
  };
};

export type GoogleSpeechSession =
  ReturnType<ReturnType<typeof googleSpeech>["open"]> extends Promise<infer S>
    ? S & { flush: () => Promise<void> }
    : ReturnType<ReturnType<typeof googleSpeech>["open"]> & {
        flush: () => Promise<void>;
      };

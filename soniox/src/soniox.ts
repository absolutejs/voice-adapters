import type {
  STTAdapter,
  STTAdapterSession,
  STTSessionEventMap,
} from "@absolutejs/voice";
import type { SonioxAudioEncoding, SonioxSTTOptions } from "./types";

type ListenerMap = {
  [K in keyof STTSessionEventMap]: Set<
    (payload: STTSessionEventMap[K]) => void | Promise<void>
  >;
};

const DEFAULT_BASE_URL = "wss://stt-rt.soniox.com";
const DEFAULT_ENDPOINT_PATH = "/transcribe-websocket";
const DEFAULT_MODEL: SonioxSTTOptions["model"] = "stt-rt-preview";
const DEFAULT_CONNECT_TIMEOUT_MS = 8_000;

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

const omitUndefined = (value: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );

const resolveBaseUrl = (config: SonioxSTTOptions): string =>
  (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");

const resolveSocketUrl = (config: SonioxSTTOptions): URL =>
  new URL(`${resolveBaseUrl(config)}${DEFAULT_ENDPOINT_PATH}`);

const resolveEncoding = (format: {
  encoding?: string;
}): SonioxAudioEncoding => {
  switch (format.encoding) {
    case "pcm_s16le":
      return "pcm_s16le";
    case "mulaw":
    case "pcm_mulaw":
      return "pcm_mulaw";
    case "alaw":
    case "pcm_alaw":
      return "pcm_alaw";
    default:
      throw new Error(
        `Unsupported audio encoding "${String(format.encoding)}" for @absolutejs/voice-soniox. ` +
          `Use pcm_s16le, mulaw, or alaw.`,
      );
  }
};

const resolveLanguageHints = (
  openOptions: { languageStrategy?: unknown },
  config: SonioxSTTOptions,
): readonly string[] | undefined => {
  const strategy = openOptions.languageStrategy as
    | {
        allowedLanguages?: string[];
        mode: "allow-switching" | "auto-detect" | "fixed";
        primaryLanguage?: string;
        secondaryLanguages?: string[];
      }
    | undefined;
  if (strategy?.mode === "fixed" && strategy.primaryLanguage) {
    return [strategy.primaryLanguage];
  }
  if (strategy?.mode === "allow-switching") {
    const combined = [
      ...(strategy.primaryLanguage ? [strategy.primaryLanguage] : []),
      ...(strategy.secondaryLanguages ?? []),
    ];
    return combined.length > 0 ? combined : config.languageHints;
  }
  if (strategy?.mode === "auto-detect" && strategy.allowedLanguages?.length) {
    return strategy.allowedLanguages;
  }
  return config.languageHints;
};

const buildStartConfig = (
  config: SonioxSTTOptions,
  openOptions: {
    format: { channels?: number; encoding?: string; sampleRateHz?: number };
    languageStrategy?: unknown;
  },
) =>
  omitUndefined({
    api_key: config.apiKey,
    audio_format: resolveEncoding(openOptions.format),
    client_reference_id: config.clientReferenceId,
    context: config.context,
    enable_endpoint_detection: config.enableEndpointDetection,
    enable_language_identification: config.enableLanguageIdentification,
    enable_speaker_diarization: config.enableSpeakerDiarization,
    language_hints: resolveLanguageHints(openOptions, config),
    model: config.model ?? DEFAULT_MODEL,
    num_channels: openOptions.format.channels ?? 1,
    sample_rate: openOptions.format.sampleRateHz ?? 16_000,
  });

type SonioxToken = {
  confidence?: number;
  end_ms?: number;
  is_final?: boolean;
  language?: string;
  speaker?: string;
  start_ms?: number;
  text?: string;
};

type SonioxMessage = {
  error_code?: string;
  error_message?: string;
  finished?: boolean;
  tokens?: SonioxToken[];
};

const buildText = (tokens: SonioxToken[]): string =>
  tokens
    .map((token) => token.text ?? "")
    .join("")
    .replace(/\s+/g, " ")
    .trim();

const averageConfidence = (tokens: SonioxToken[]): number | undefined => {
  const values: number[] = [];
  for (const token of tokens) {
    if (typeof token.confidence === "number") {
      values.push(token.confidence);
    }
  }
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const toUint8Array = (chunk: ArrayBuffer | ArrayBufferView): Uint8Array => {
  if (chunk instanceof Uint8Array) return chunk;
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  return new Uint8Array(chunk);
};

export const soniox = (config: SonioxSTTOptions): STTAdapter => {
  if (!config.apiKey) {
    throw new Error("@absolutejs/voice-soniox requires an apiKey.");
  }
  resolveBaseUrl(config);

  return {
    kind: "stt",
    open: async (openOptions) => {
      const listeners = createListenerMap();
      const url = resolveSocketUrl(config);
      const factory =
        config.webSocket?.factory ??
        ((target: string) => new WebSocket(target));
      const socket = factory(url.toString());

      let opened = false;
      let configSent = false;
      let closed = false;
      let seq = 0;
      const pendingAudio: Uint8Array[] = [];
      const connectTimeoutMs =
        config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

      const sendAudio = (audio: Uint8Array) => {
        socket.send(audio);
        seq += 1;
      };

      const flushPending = () => {
        for (const chunk of pendingAudio.splice(0, pendingAudio.length)) {
          sendAudio(chunk);
        }
      };

      const openPromise = new Promise<void>((resolve, reject) => {
        const openTimeout = setTimeout(() => {
          if (configSent) return;
          reject(
            new Error(
              `Soniox websocket open timeout after ${String(connectTimeoutMs)}ms`,
            ),
          );
          try {
            socket.close(1013, "open-timeout");
          } catch {}
        }, connectTimeoutMs);

        socket.addEventListener(
          "open",
          () => {
            opened = true;
            clearTimeout(openTimeout);
            try {
              socket.send(
                JSON.stringify(buildStartConfig(config, openOptions)),
              );
              configSent = true;
              flushPending();
              resolve();
            } catch (error) {
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          },
          { once: true },
        );

        socket.addEventListener("error", () => {
          clearTimeout(openTimeout);
          if (!opened) {
            reject(new Error("Soniox websocket failed to open."));
          }
        });
      });

      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        let parsed: SonioxMessage | undefined;
        try {
          parsed = JSON.parse(event.data) as SonioxMessage;
        } catch {
          return;
        }
        if (!parsed) return;
        if (parsed.error_code) {
          void emit(listeners, "error", {
            code: parsed.error_code,
            error: new Error(
              parsed.error_message ?? `Soniox error (${parsed.error_code})`,
            ),
            recoverable: false,
            type: "error",
          });
          return;
        }
        const tokens = parsed.tokens ?? [];
        if (tokens.length > 0) {
          const finalTokens = tokens.filter((token) => token.is_final === true);
          const partialTokens = tokens.filter(
            (token) => token.is_final !== true,
          );
          if (finalTokens.length > 0) {
            const text = buildText(finalTokens);
            if (text) {
              void emit(listeners, "final", {
                receivedAt: Date.now(),
                transcript: {
                  confidence: averageConfidence(finalTokens),
                  endedAtMs: finalTokens[finalTokens.length - 1]?.end_ms,
                  id: `soniox:final:${String(seq)}`,
                  isFinal: true,
                  language: finalTokens[0]?.language,
                  speaker: finalTokens[0]?.speaker,
                  startedAtMs: finalTokens[0]?.start_ms,
                  text,
                  vendor: "soniox",
                },
                type: "final",
              });
            }
          }
          if (partialTokens.length > 0) {
            const text = buildText(partialTokens);
            if (text) {
              void emit(listeners, "partial", {
                receivedAt: Date.now(),
                transcript: {
                  confidence: averageConfidence(partialTokens),
                  endedAtMs: partialTokens[partialTokens.length - 1]?.end_ms,
                  id: `soniox:partial:${String(seq)}`,
                  isFinal: false,
                  language: partialTokens[0]?.language,
                  speaker: partialTokens[0]?.speaker,
                  startedAtMs: partialTokens[0]?.start_ms,
                  text,
                  vendor: "soniox",
                },
                type: "partial",
              });
            }
          }
        }
        if (parsed.finished === true) {
          void emit(listeners, "endOfTurn", {
            reason: "vendor",
            receivedAt: Date.now(),
            type: "endOfTurn",
          });
        }
      });

      socket.addEventListener("close", (event) => {
        if (closed) return;
        closed = true;
        void emit(listeners, "close", {
          code: event.code,
          reason: event.reason || undefined,
          recoverable: false,
          type: "close",
        });
      });

      await openPromise;

      const session: STTAdapterSession = {
        close: async (reason?: string) => {
          if (closed) return;
          closed = true;
          try {
            if (
              socket.readyState === WebSocket.OPEN ||
              socket.readyState === WebSocket.CONNECTING
            ) {
              // Send empty string to signal end-of-stream per Soniox docs
              socket.send("");
              socket.close(1000, reason);
            }
          } catch {}
        },
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
          if (!configSent) {
            pendingAudio.push(bytes);
            return;
          }
          sendAudio(bytes);
        },
      };

      return session;
    },
  };
};

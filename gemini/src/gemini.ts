import type {
  AudioChunk,
  AudioFormat,
  RealtimeAdapter,
  RealtimeSessionEventMap,
  Transcript,
} from "@absolutejs/voice";
import type { GeminiLiveAdapterOptions } from "./types";

type ListenerMap = {
  [K in keyof RealtimeSessionEventMap]: Set<
    (payload: RealtimeSessionEventMap[K]) => void | Promise<void>
  >;
};

type GeminiClientMessage = {
  setup?: Record<string, unknown>;
  clientContent?: Record<string, unknown>;
  realtimeInput?: Record<string, unknown>;
};

type GeminiServerMessage = {
  setupComplete?: Record<string, never>;
  serverContent?: {
    generationComplete?: boolean;
    inputTranscription?: { text?: string };
    interrupted?: boolean;
    modelTurn?: {
      parts?: Array<{
        inlineData?: {
          data?: string;
          mimeType?: string;
        };
        text?: string;
      }>;
      role?: string;
    };
    outputTranscription?: { text?: string };
    turnComplete?: boolean;
  };
  error?: unknown;
  goAway?: { timeLeft?: string };
  [key: string]: unknown;
};

const DEFAULT_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025";
const LIVE_API_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const OUTPUT_AUDIO_FORMAT: AudioFormat = {
  channels: 1,
  container: "raw",
  encoding: "pcm_s16le",
  sampleRateHz: 24000,
};

const createListenerMap = (): ListenerMap => ({
  audio: new Set(),
  close: new Set(),
  endOfTurn: new Set(),
  error: new Set(),
  final: new Set(),
  partial: new Set(),
});

const emit = async <K extends keyof RealtimeSessionEventMap>(
  listeners: ListenerMap,
  event: K,
  payload: RealtimeSessionEventMap[K],
) => {
  for (const listener of listeners[event]) {
    await listener(payload);
  }
};

const omitUndefined = (value: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );

const toUint8Array = (value: AudioChunk) =>
  value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);

const toBase64 = (value: AudioChunk) =>
  Buffer.from(toUint8Array(value)).toString("base64");

const resolveModelName = (model: string) =>
  model.startsWith("models/") ? model : `models/${model}`;

const resolveErrorMessage = (error: unknown): string => {
  if (typeof error === "string" && error.trim()) {
    return error;
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    for (const key of ["message", "reason", "description", "detail"]) {
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

  return "Gemini Live error";
};

const buildTranscript = (
  text: string,
  isFinal: boolean,
  id = `gemini-transcript-${crypto.randomUUID()}`,
): Transcript => ({
  id,
  isFinal,
  text,
  vendor: "gemini",
});

const assertGeminiPCMInput = (format: AudioFormat) => {
  if (
    format.container !== "raw" ||
    format.encoding !== "pcm_s16le" ||
    format.channels !== 1 ||
    (format.sampleRateHz !== 16000 && format.sampleRateHz !== 24000)
  ) {
    throw new Error(
      "Gemini Live audio input currently requires raw pcm_s16le mono at 16kHz or 24kHz.",
    );
  }
};

const audioMimeType = (format: AudioFormat) =>
  `audio/pcm;rate=${String(format.sampleRateHz)}`;

const buildSetupMessage = (
  config: GeminiLiveAdapterOptions,
): GeminiClientMessage => {
  const responseModalities = config.responseModalities ?? ["AUDIO"];
  const voiceName = config.voiceName;
  const generationConfig = omitUndefined({
    maxOutputTokens: config.maxOutputTokens,
    responseModalities,
    speechConfig:
      voiceName && responseModalities.includes("AUDIO")
        ? {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName,
              },
            },
          }
        : undefined,
    temperature: config.temperature,
    topK: config.topK,
    topP: config.topP,
  });

  return {
    setup: omitUndefined({
      generationConfig,
      inputAudioTranscription:
        config.emitInputTranscripts === false ? undefined : {},
      model: resolveModelName(config.model ?? DEFAULT_MODEL),
      outputAudioTranscription:
        config.emitOutputTranscripts === false ? undefined : {},
      realtimeInputConfig: {
        activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
      },
      systemInstruction: config.instructions
        ? {
            parts: [{ text: config.instructions }],
            role: "user",
          }
        : undefined,
    }),
  };
};

const extractText = (message: GeminiServerMessage) => {
  const parts = message.serverContent?.modelTurn?.parts ?? [];
  return parts
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("")
    .trim();
};

const extractAudio = (message: GeminiServerMessage) => {
  const parts = message.serverContent?.modelTurn?.parts ?? [];
  return parts.flatMap((part) => {
    const data = part.inlineData?.data;
    const mimeType = part.inlineData?.mimeType;
    return typeof data === "string" && mimeType?.startsWith("audio/")
      ? [Buffer.from(data, "base64")]
      : [];
  });
};

export const gemini = (config: GeminiLiveAdapterOptions): RealtimeAdapter => ({
  kind: "realtime",
  open: (options) => {
    const listeners = createListenerMap();
    const ws = new WebSocket(config.baseUrl ?? LIVE_API_URL, {
      headers: {
        "x-goog-api-key": config.apiKey,
      },
    } as never);
    const pendingMessages: string[] = [];
    let ready = false;
    let socketOpen = false;
    let closed = false;
    let closeEmitted = false;
    let readyTimeout: ReturnType<typeof setTimeout> | undefined;
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const readyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const clearReadyTimeout = () => {
      if (readyTimeout) {
        clearTimeout(readyTimeout);
        readyTimeout = undefined;
      }
    };

    const failReady = (error: Error) => {
      if (ready || closed) {
        return;
      }

      clearReadyTimeout();
      rejectReady(error);
    };

    const markReady = () => {
      if (ready || closed) {
        return;
      }

      ready = true;
      clearReadyTimeout();
      resolveReady();
    };

    const sendRaw = (message: GeminiClientMessage) => {
      const serialized = JSON.stringify(message);
      if (!socketOpen) {
        pendingMessages.push(serialized);
        return;
      }

      ws.send(serialized);
    };

    const flushPendingMessages = () => {
      while (pendingMessages.length > 0) {
        const next = pendingMessages.shift();
        if (next) {
          ws.send(next);
        }
      }
    };

    const emitClose = async (
      code?: number,
      reason?: string,
      recoverable = false,
    ) => {
      if (closeEmitted) {
        return;
      }

      closeEmitted = true;
      await emit(listeners, "close", {
        code,
        reason,
        recoverable,
        type: "close",
      });
    };

    ws.addEventListener(
      "open",
      () => {
        socketOpen = true;
        sendRaw(buildSetupMessage(config));
        flushPendingMessages();
        readyTimeout = setTimeout(() => {
          failReady(new Error("Gemini Live session did not become ready."));
        }, 8_000);
      },
      { once: true },
    );

    ws.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data)) as GeminiServerMessage;
        const content = message.serverContent;

        if (message.setupComplete) {
          markReady();
          return;
        }

        if (message.error) {
          const error = new Error(resolveErrorMessage(message.error));
          failReady(error);
          void emit(listeners, "error", {
            error,
            recoverable: true,
            type: "error",
          });
          return;
        }

        if (message.goAway) {
          void emit(listeners, "error", {
            error: new Error(
              `Gemini Live session will close soon: ${message.goAway.timeLeft ?? "unknown time left"}`,
            ),
            recoverable: true,
            type: "error",
          });
          return;
        }

        if (!content) {
          return;
        }

        const inputText = content.inputTranscription?.text;
        if (typeof inputText === "string" && inputText.trim()) {
          void emit(listeners, "final", {
            receivedAt: Date.now(),
            transcript: buildTranscript(inputText.trim(), true),
            type: "final",
          });
        }

        const outputText =
          content.outputTranscription?.text ?? extractText(message);
        if (typeof outputText === "string" && outputText.trim()) {
          void emit(listeners, "partial", {
            receivedAt: Date.now(),
            transcript: buildTranscript(outputText.trim(), false),
            type: "partial",
          });
        }

        for (const chunk of extractAudio(message)) {
          void emit(listeners, "audio", {
            chunk,
            format: OUTPUT_AUDIO_FORMAT,
            receivedAt: Date.now(),
            type: "audio",
          });
        }

        if (content.interrupted || content.turnComplete) {
          void emit(listeners, "endOfTurn", {
            receivedAt: Date.now(),
            reason: content.interrupted ? "vendor" : "vendor",
            type: "endOfTurn",
          });
        }
      } catch (error) {
        void emit(listeners, "error", {
          error: new Error(resolveErrorMessage(error)),
          recoverable: true,
          type: "error",
        });
      }
    });

    ws.addEventListener("error", (rawEvent) => {
      const event = rawEvent as Event & { error?: unknown };
      const error = new Error(resolveErrorMessage(event.error ?? event));
      failReady(error);
      void emit(listeners, "error", {
        error,
        recoverable: false,
        type: "error",
      });
    });

    ws.addEventListener("close", (event) => {
      socketOpen = false;
      clearReadyTimeout();
      if (!ready) {
        failReady(
          new Error("Gemini Live session closed before it became ready."),
        );
      }
      void emitClose(
        event.code,
        event.reason || undefined,
        event.code !== 1000,
      );
    });

    if (options.signal) {
      if (options.signal.aborted) {
        closed = true;
        ws.close(1000, "aborted");
      } else {
        options.signal.addEventListener(
          "abort",
          () => {
            if (!closed) {
              closed = true;
              ws.close(1000, "aborted");
            }
          },
          { once: true },
        );
      }
    }

    return {
      close: async (reason?: string) => {
        if (closed) {
          return;
        }

        closed = true;
        clearReadyTimeout();
        sendRaw({
          realtimeInput: {
            audioStreamEnd: true,
          },
        });
        ws.close(1000, reason);
        await emitClose(1000, reason, false);
      },
      on: (event, handler) => {
        listeners[event].add(handler as never);

        return () => {
          listeners[event].delete(handler as never);
        };
      },
      send: async (input: AudioChunk | string) => {
        await readyPromise;
        if (closed) {
          return;
        }

        if (typeof input === "string") {
          const text = input.trim();
          if (!text) {
            return;
          }

          await emit(listeners, "final", {
            receivedAt: Date.now(),
            transcript: buildTranscript(text, true),
            type: "final",
          });
          sendRaw({
            clientContent: {
              turnComplete: true,
              turns: [
                {
                  parts: [{ text }],
                  role: "user",
                },
              ],
            },
          });
          return;
        }

        assertGeminiPCMInput(options.format);
        sendRaw({
          realtimeInput: {
            audio: {
              data: toBase64(input),
              mimeType: audioMimeType(options.format),
            },
          },
        });
      },
    };
  },
});

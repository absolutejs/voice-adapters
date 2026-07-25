import {
  encodeFrame,
  parseFrames,
  parseTrailerPayload,
  type ParsedFrame,
} from "./grpcFrame";
import {
  AUDIO_ENCODING_ALAW,
  AUDIO_ENCODING_LINEAR16,
  AUDIO_ENCODING_MULAW,
  decodeStreamingRecognizeResponse,
  encodeStreamingRecognizeRequest,
  SPEECH_EVENT_END_OF_SINGLE_UTTERANCE,
  SPEECH_EVENT_SPEECH_ACTIVITY_END,
  type EncodingId,
  type StreamingRecognizeRequest,
} from "./streamingProto";
import type {
  STTAdapter,
  STTAdapterSession,
  STTSessionEventMap,
} from "@absolutejs/voice";
import type { GoogleSpeechModel } from "./types";

type ListenerMap = {
  [K in keyof STTSessionEventMap]: Set<
    (payload: STTSessionEventMap[K]) => void | Promise<void>
  >;
};

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

const DEFAULT_AUTHORITY = "speech.googleapis.com";
const DEFAULT_PATH = "/google.cloud.speech.v2.Speech/StreamingRecognize";
const DEFAULT_MODEL: GoogleSpeechModel = "latest_long";

const resolveEncoding = (format: { encoding?: string }): EncodingId => {
  switch (format.encoding) {
    case "pcm_s16le":
      return AUDIO_ENCODING_LINEAR16;
    case "mulaw":
    case "pcm_mulaw":
      return AUDIO_ENCODING_MULAW;
    case "alaw":
    case "pcm_alaw":
      return AUDIO_ENCODING_ALAW;
    default:
      throw new Error(
        `Unsupported audio encoding "${String(format.encoding)}" for @absolutejs/voice-google-speech streaming. ` +
          `Use pcm_s16le, mulaw, or alaw.`,
      );
  }
};

const resolveLanguageCodes = (
  openOptions: { languageStrategy?: unknown },
  configLanguages: readonly string[] | undefined,
  configLanguage: string | undefined,
): string[] => {
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
  if (strategy?.mode === "allow-switching" && strategy.primaryLanguage) {
    return [strategy.primaryLanguage, ...(strategy.secondaryLanguages ?? [])];
  }
  if (strategy?.mode === "auto-detect" && strategy.allowedLanguages?.length) {
    return [...strategy.allowedLanguages];
  }
  if (configLanguages && configLanguages.length > 0) {
    return [...configLanguages];
  }
  return [configLanguage ?? "en-US"];
};

export type GoogleSpeechStreamTransport = {
  close: () => Promise<void> | void;
  onData: (handler: (chunk: Uint8Array) => void) => () => void;
  onEnd: (handler: (trailers: Record<string, string>) => void) => () => void;
  onError: (handler: (error: Error) => void) => () => void;
  send: (frame: Uint8Array) => Promise<void> | void;
};

export type GoogleSpeechStreamTransportFactoryInput = {
  authority: string;
  headers: Record<string, string>;
  path: string;
};

export type GoogleSpeechStreamTransportFactory = (
  input: GoogleSpeechStreamTransportFactoryInput,
) => GoogleSpeechStreamTransport | Promise<GoogleSpeechStreamTransport>;

export type GoogleSpeechStreamOptions = {
  accessToken?: string;
  authority?: string;
  enableSpokenEmojis?: boolean;
  enableSpokenPunctuation?: boolean;
  enableVoiceActivityEvents?: boolean;
  enableWordConfidence?: boolean;
  enableWordTimeOffsets?: boolean;
  enableAutomaticPunctuation?: boolean;
  getAccessToken?: () => Promise<string> | string;
  interimResults?: boolean;
  language?: string;
  languages?: readonly string[];
  location?: string;
  model?: GoogleSpeechModel;
  path?: string;
  profanityFilter?: boolean;
  project: string;
  recognizer?: string;
  transport?: GoogleSpeechStreamTransportFactory;
};

const defaultTransportFactory = async ({
  authority,
  headers,
  path,
}: GoogleSpeechStreamTransportFactoryInput): Promise<GoogleSpeechStreamTransport> => {
  const http2 = (await import("node:http2")) as typeof import("node:http2");
  const session = http2.connect(`https://${authority}`);
  const stream = session.request({
    ":method": "POST",
    ":path": path,
    ...headers,
  });
  const dataHandlers = new Set<(chunk: Uint8Array) => void>();
  const endHandlers = new Set<(trailers: Record<string, string>) => void>();
  const errorHandlers = new Set<(error: Error) => void>();
  let trailers: Record<string, string> = {};
  stream.on("trailers", (headers) => {
    for (const [key, value] of Object.entries(headers ?? {})) {
      if (typeof value === "string") {
        trailers[key.toLowerCase()] = value;
      }
    }
  });
  stream.on("data", (chunk: Buffer | string) => {
    const view: Uint8Array =
      typeof chunk === "string"
        ? new TextEncoder().encode(chunk)
        : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    for (const handler of dataHandlers) handler(view);
  });
  stream.on("end", () => {
    for (const handler of endHandlers) handler(trailers);
  });
  const handleError = (error: Error) => {
    for (const handler of errorHandlers) handler(error);
  };
  stream.on("error", handleError);
  session.on("error", handleError);

  return {
    close: async () => {
      try {
        stream.end();
      } catch {}
      try {
        session.close();
      } catch {}
    },
    onData: (handler) => {
      dataHandlers.add(handler);
      return () => {
        dataHandlers.delete(handler);
      };
    },
    onEnd: (handler) => {
      endHandlers.add(handler);
      return () => {
        endHandlers.delete(handler);
      };
    },
    onError: (handler) => {
      errorHandlers.add(handler);
      return () => {
        errorHandlers.delete(handler);
      };
    },
    send: (frame) => {
      stream.write(frame);
    },
  };
};

export const googleSpeechStream = (
  config: GoogleSpeechStreamOptions,
): STTAdapter => {
  if (!config.accessToken && !config.getAccessToken) {
    throw new Error(
      "@absolutejs/voice-google-speech googleSpeechStream requires accessToken or getAccessToken (OAuth Bearer). API keys are not supported for streaming.",
    );
  }
  if (!config.project) {
    throw new Error(
      "@absolutejs/voice-google-speech googleSpeechStream requires a Google Cloud project id.",
    );
  }

  return {
    kind: "stt",
    open: async (openOptions) => {
      const listeners = createListenerMap();
      const encoding = resolveEncoding(openOptions.format);
      const sampleRateHz = openOptions.format.sampleRateHz ?? 16_000;
      const channels = openOptions.format.channels ?? 1;
      const languageCodes = resolveLanguageCodes(
        openOptions,
        config.languages,
        config.language,
      );
      const location = config.location ?? "global";
      const recognizer =
        config.recognizer ??
        `projects/${config.project}/locations/${location}/recognizers/_`;

      const token = config.getAccessToken
        ? await config.getAccessToken()
        : config.accessToken!;

      const authority = config.authority ?? DEFAULT_AUTHORITY;
      const path = config.path ?? DEFAULT_PATH;
      const transportFactory = config.transport ?? defaultTransportFactory;
      const transport = await transportFactory({
        authority,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/grpc-web+proto",
          te: "trailers",
          "user-agent": "@absolutejs/voice-google-speech",
          "x-grpc-web": "1",
        },
        path,
      });

      let buffer = new Uint8Array(0);
      let closed = false;
      let seq = 0;

      const unbindData = transport.onData((chunk) => {
        const parsed = parseFrames(buffer, chunk);
        const copy = new Uint8Array(parsed.remainder.byteLength);
        copy.set(parsed.remainder);
        buffer = copy;
        for (const frame of parsed.frames) {
          void handleFrame(frame);
        }
      });

      const unbindEnd = transport.onEnd((trailers) => {
        if (closed) return;
        closed = true;
        const status = trailers["grpc-status"] ?? "0";
        const code = Number(status);
        const message = trailers["grpc-message"];
        if (Number.isFinite(code) && code !== 0) {
          void emit(listeners, "error", {
            code: status,
            error: new Error(
              `Google Speech gRPC status ${status}${message ? `: ${message}` : ""}`,
            ),
            recoverable: false,
            type: "error",
          });
        }
        void emit(listeners, "close", {
          reason: message,
          recoverable: false,
          type: "close",
        });
      });

      const unbindError = transport.onError((error) => {
        if (closed) return;
        void emit(listeners, "error", {
          error,
          recoverable: false,
          type: "error",
        });
      });

      const handleFrame = async (frame: ParsedFrame) => {
        if (frame.isTrailer) {
          const trailers = parseTrailerPayload(frame.payload);
          const status = trailers["grpc-status"] ?? "0";
          const code = Number(status);
          if (Number.isFinite(code) && code !== 0) {
            await emit(listeners, "error", {
              code: status,
              error: new Error(
                `Google Speech gRPC status ${status}${trailers["grpc-message"] ? `: ${trailers["grpc-message"]}` : ""}`,
              ),
              recoverable: false,
              type: "error",
            });
          }
          return;
        }
        let response;
        try {
          response = decodeStreamingRecognizeResponse(frame.payload);
        } catch (error) {
          await emit(listeners, "error", {
            error: error instanceof Error ? error : new Error(String(error)),
            recoverable: false,
            type: "error",
          });
          return;
        }
        for (const result of response.results) {
          const alternative = result.alternatives[0];
          if (!alternative?.transcript) continue;
          seq += 1;
          const event: "final" | "partial" = result.isFinal
            ? "final"
            : "partial";
          await emit(listeners, event, {
            receivedAt: Date.now(),
            transcript: {
              confidence: alternative.confidence,
              endedAtMs:
                result.resultEndOffsetSeconds !== undefined
                  ? Math.round(result.resultEndOffsetSeconds * 1_000)
                  : undefined,
              id: `google-speech:stream:${String(seq)}`,
              isFinal: result.isFinal,
              language: result.languageCode,
              text: alternative.transcript,
              vendor: "google-speech",
            },
            type: event,
          } as never);
        }
        if (
          response.speechEventType === SPEECH_EVENT_END_OF_SINGLE_UTTERANCE ||
          response.speechEventType === SPEECH_EVENT_SPEECH_ACTIVITY_END
        ) {
          await emit(listeners, "endOfTurn", {
            reason: "vendor",
            receivedAt: Date.now(),
            type: "endOfTurn",
          });
        }
      };

      const sendRequest = async (request: StreamingRecognizeRequest) => {
        await transport.send(
          encodeFrame(encodeStreamingRecognizeRequest(request)),
        );
      };

      // First message must include the streaming_config.
      await sendRequest({
        recognizer,
        streamingConfig: {
          config: {
            explicitDecodingConfig: {
              audioChannelCount: channels,
              encoding,
              sampleRateHertz: sampleRateHz,
            },
            features: {
              enableAutomaticPunctuation: config.enableAutomaticPunctuation,
              enableSpokenEmojis: config.enableSpokenEmojis,
              enableSpokenPunctuation: config.enableSpokenPunctuation,
              enableWordConfidence: config.enableWordConfidence,
              enableWordTimeOffsets: config.enableWordTimeOffsets,
              profanityFilter: config.profanityFilter,
            },
            languageCodes,
            model: config.model ?? DEFAULT_MODEL,
          },
          streamingFeatures: {
            enableVoiceActivityEvents: config.enableVoiceActivityEvents,
            interimResults: config.interimResults ?? true,
          },
        },
      });

      const session: STTAdapterSession = {
        close: async (reason?: string) => {
          if (closed) return;
          closed = true;
          try {
            await transport.close();
          } catch {}
          unbindData();
          unbindEnd();
          unbindError();
          await emit(listeners, "close", {
            reason,
            recoverable: false,
            type: "close",
          });
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
          await sendRequest({ audio: bytes });
        },
      };

      return session;
    },
  };
};

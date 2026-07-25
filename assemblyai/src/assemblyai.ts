import type {
  STTAdapter,
  STTAdapterOpenOptions,
  STTSessionEventMap,
  Transcript,
} from "@absolutejs/voice";
import type { AssemblyAISTTOptions } from "./types";

type VoicePhraseHintCompat = {
  text: string;
  aliases?: string[];
};

type VoiceLexiconEntryCompat = {
  text: string;
  aliases?: string[];
  language?: string;
  pronunciation?: string;
};

type VoiceLanguageStrategyCompat =
  | {
      mode: "auto-detect";
      allowedLanguages?: string[];
    }
  | {
      mode: "fixed";
      primaryLanguage: string;
      secondaryLanguages?: string[];
    }
  | {
      mode: "allow-switching";
      primaryLanguage?: string;
      secondaryLanguages: string[];
    };

type AssemblyAIAdapterOpenOptions = STTAdapterOpenOptions & {
  languageStrategy?: VoiceLanguageStrategyCompat;
  lexicon?: VoiceLexiconEntryCompat[];
  phraseHints?: VoicePhraseHintCompat[];
};

type ListenerMap = {
  [K in keyof STTSessionEventMap]: Set<
    (payload: STTSessionEventMap[K]) => void | Promise<void>
  >;
};

const SIGNAL_DEDUPE_WINDOW_MS = 2_500;

type AssemblyAITurnWord = {
  confidence?: number;
  end?: number;
  start?: number;
  text?: string;
  word_is_final?: boolean;
};

type AssemblyAITurnMessage = {
  end_of_turn?: boolean;
  end_of_turn_confidence?: number;
  transcript?: string;
  turn_is_formatted?: boolean;
  turn_order?: number;
  type?: string;
  words?: AssemblyAITurnWord[];
};

const STREAMING_URL = "wss://streaming.assemblyai.com/v3/ws";

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

const normalizeTranscriptText = (text: string) =>
  text.trim().toLowerCase().replace(/\s+/g, " ");

const createSignalDeduper = () => ({
  endOfTurnSignals: new Map<string, number>(),
  finalSignals: new Map<string, number>(),
});

const buildTranscriptSignalKey = (transcript: Transcript) =>
  [
    transcript.vendor ?? "unknown",
    normalizeTranscriptText(transcript.text),
    String(transcript.startedAtMs ?? ""),
    String(transcript.endedAtMs ?? ""),
  ].join("|");

const isSignalDuplicate = (
  signals: Map<string, number>,
  key: string,
  now: number,
) => {
  for (const [signature, seenAt] of signals) {
    if (now - seenAt > SIGNAL_DEDUPE_WINDOW_MS) {
      signals.delete(signature);
    }
  }

  const lastSeen = signals.get(key);
  if (lastSeen !== undefined && now - lastSeen <= SIGNAL_DEDUPE_WINDOW_MS) {
    return true;
  }

  signals.set(key, now);
  return false;
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
    for (const key of ["message", "reason", "description"]) {
      const candidate = record[key];
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate;
      }
    }

    try {
      return JSON.stringify(error);
    } catch {}
  }

  return "AssemblyAI stream error";
};

const normalizeWords = (words: AssemblyAITurnWord[] | undefined) => {
  if (!Array.isArray(words) || words.length === 0) {
    return {};
  }

  const first = words[0];
  const last = words.at(-1);

  return {
    endedAtMs: typeof last?.end === "number" ? Math.round(last.end) : undefined,
    startedAtMs:
      typeof first?.start === "number" ? Math.round(first.start) : undefined,
  };
};

const buildTranscript = (payload: AssemblyAITurnMessage): Transcript | null => {
  if (typeof payload.transcript !== "string" || !payload.transcript.trim()) {
    return null;
  }

  const words = Array.isArray(payload.words) ? payload.words : undefined;
  const confidences = (words ?? [])
    .map((word) =>
      typeof word.confidence === "number" ? word.confidence : undefined,
    )
    .filter((value): value is number => value !== undefined);
  const confidence =
    confidences.length > 0
      ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
      : undefined;
  const phase = payload.end_of_turn
    ? payload.turn_is_formatted
      ? "formatted"
      : "final"
    : "partial";
  const turnIdentity =
    payload.turn_order !== undefined
      ? `turn-${payload.turn_order}`
      : `text-${normalizeTranscriptText(payload.transcript)}`;

  return {
    ...normalizeWords(words),
    confidence,
    id: `assemblyai-${turnIdentity}-${phase}`,
    isFinal: payload.end_of_turn === true,
    text: payload.transcript,
    vendor: "assemblyai",
  };
};

const omitUndefined = (value: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );

const collectPhraseHintTerms = (options: AssemblyAIAdapterOpenOptions) =>
  (options.phraseHints ?? []).flatMap((hint) => [
    hint.text,
    ...(hint.aliases ?? []),
  ]);

const collectLexiconTerms = (options: AssemblyAIAdapterOpenOptions) =>
  (options.lexicon ?? []).flatMap((entry) => [
    entry.text,
    ...(entry.aliases ?? []),
  ]);

const isEnglishLanguage = (value: string | undefined) => {
  const normalized = value?.trim().toLowerCase();
  return typeof normalized === "string" && normalized.startsWith("en");
};

const resolveSpeechModel = (
  config: AssemblyAISTTOptions,
  options: AssemblyAIAdapterOpenOptions,
) => {
  if (config.speechModel) {
    return config.speechModel;
  }

  if (
    options.languageStrategy?.mode === "allow-switching" ||
    options.languageStrategy?.mode === "auto-detect"
  ) {
    return "universal-streaming-multi";
  }

  if (
    options.languageStrategy?.mode === "fixed" &&
    !isEnglishLanguage(options.languageStrategy.primaryLanguage)
  ) {
    return "universal-streaming-multi";
  }

  return "u3-rt-pro";
};

const buildUrl = (
  options: AssemblyAISTTOptions,
  input: {
    languageStrategy?: AssemblyAIAdapterOpenOptions["languageStrategy"];
    lexiconTerms?: string[];
    phraseHintTerms?: string[];
    sampleRateHz: number;
  },
) => {
  const keytermsPrompt = [
    ...(options.keytermsPrompt ?? []),
    ...(input.lexiconTerms ?? []),
    ...(input.phraseHintTerms ?? []),
  ].filter((value, index, list) => list.indexOf(value) === index);
  const url = new URL(STREAMING_URL);
  const params = omitUndefined({
    encoding: "pcm_s16le",
    end_of_turn_confidence_threshold: options.endOfTurnConfidenceThreshold,
    format_turns: options.formatTurns,
    keyterms_prompt:
      keytermsPrompt.length > 0 ? JSON.stringify(keytermsPrompt) : undefined,
    max_turn_silence: options.maxTurnSilence,
    min_end_of_turn_silence_when_confident:
      options.minEndOfTurnSilenceWhenConfident,
    sample_rate: input.sampleRateHz,
    speech_model: resolveSpeechModel(options, {
      format: {
        channels: 1,
        container: "raw",
        encoding: "pcm_s16le",
        sampleRateHz: input.sampleRateHz,
      },
      languageStrategy: input.languageStrategy,
      sessionId: "assemblyai-url-builder",
    }),
    token: options.token,
  });

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }

  return url.toString();
};

export const assemblyai = (config: AssemblyAISTTOptions): STTAdapter => ({
  kind: "stt",
  open: (options) => {
    const runtimeOptions = options as AssemblyAIAdapterOpenOptions;
    const listeners = createListenerMap();
    const deduper = createSignalDeduper();
    const ws = new WebSocket(
      buildUrl(config, {
        languageStrategy: runtimeOptions.languageStrategy,
        lexiconTerms: collectLexiconTerms(runtimeOptions),
        phraseHintTerms: collectPhraseHintTerms(runtimeOptions),
        sampleRateHz: runtimeOptions.format.sampleRateHz,
      }),
      {
        headers: {
          Authorization: config.apiKey,
        },
      } as never,
    );
    let opened = false;
    let terminated = false;
    const pendingMessages: Array<ArrayBuffer | ArrayBufferView> = [];
    const waitForOpen = new Promise<void>((resolve, reject) => {
      ws.addEventListener(
        "open",
        () => {
          opened = true;
          while (pendingMessages.length > 0) {
            const next = pendingMessages.shift();
            if (next) {
              ws.send(next);
            }
          }
          resolve();
        },
        { once: true },
      );
      ws.addEventListener(
        "error",
        (rawEvent) => {
          const event = rawEvent as Event & { error?: unknown };
          reject(
            event.error ?? new Error("AssemblyAI websocket failed to open"),
          );
        },
        { once: true },
      );
    });

    ws.addEventListener("message", (event) => {
      try {
        const payload = JSON.parse(String(event.data)) as AssemblyAITurnMessage;
        if (payload.type === "Begin" || payload.type === "Termination") {
          return;
        }

        const transcript = buildTranscript(payload);
        if (!transcript) {
          return;
        }

        if (payload.end_of_turn) {
          const now = Date.now();
          const signal = buildTranscriptSignalKey(transcript);

          if (
            !isSignalDuplicate(deduper.finalSignals, `final:${signal}`, now)
          ) {
            void emit(listeners, "final", {
              receivedAt: now,
              transcript: {
                ...transcript,
                isFinal: true,
              },
              type: "final",
            });
          }

          if (
            !isSignalDuplicate(deduper.endOfTurnSignals, `eot:${signal}`, now)
          ) {
            void emit(listeners, "endOfTurn", {
              receivedAt: now,
              reason: "vendor",
              type: "endOfTurn",
            });
          }

          return;
        }

        void emit(listeners, "partial", {
          receivedAt: Date.now(),
          transcript: {
            ...transcript,
            isFinal: false,
          },
          type: "partial",
        });
      } catch (error) {
        void emit(listeners, "error", {
          error: new Error(resolveErrorMessage(error)),
          recoverable: false,
          type: "error",
        });
      }
    });

    ws.addEventListener("error", (rawEvent) => {
      const event = rawEvent as Event & { error?: unknown };
      void emit(listeners, "error", {
        error:
          event.error instanceof Error
            ? event.error
            : new Error(resolveErrorMessage(event.error ?? event)),
        recoverable: false,
        type: "error",
      });
    });

    ws.addEventListener("close", (event) => {
      void emit(listeners, "close", {
        code: event.code,
        reason: event.reason || undefined,
        recoverable: false,
        type: "close",
      });
    });

    return {
      close: async () => {
        if (terminated) {
          return;
        }

        terminated = true;
        try {
          await waitForOpen;
        } catch {}

        if (opened && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "Terminate" }));
        }

        ws.close();
      },
      on: (event, handler) => {
        listeners[event].add(handler as never);

        return () => {
          listeners[event].delete(handler as never);
        };
      },
      send: async (audio) => {
        if (terminated) {
          return;
        }

        if (opened && ws.readyState === WebSocket.OPEN) {
          ws.send(audio);
          return;
        }

        pendingMessages.push(audio);
        await waitForOpen;
      },
    };
  },
});

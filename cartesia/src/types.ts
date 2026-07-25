export type CartesiaTTSModel =
  "sonic-2" | "sonic-english" | "sonic-multilingual" | "sonic" | (string & {});

export type CartesiaOutputContainer = "mp3" | "raw" | "wav";

export type CartesiaOutputEncoding =
  | "mp3"
  | "mulaw"
  | "pcm_alaw"
  | "pcm_f32le"
  | "pcm_mulaw"
  | "pcm_s16le"
  | "pcm_s24le"
  | "pcm_s32le"
  | "wav"
  | (string & {});

export type CartesiaSampleRate =
  8_000 | 16_000 | 22_050 | 24_000 | 44_100 | 48_000 | (number & {});

export type CartesiaOutputFormat = {
  bitRate?: number;
  container?: CartesiaOutputContainer;
  encoding?: CartesiaOutputEncoding;
  sampleRate?: CartesiaSampleRate;
};

export type CartesiaVoiceMode = "embedding" | "id";

export type CartesiaVoice =
  | {
      __experimentalControls?: Record<string, unknown>;
      embedding?: never;
      id: string;
      mode?: "id";
    }
  | {
      __experimentalControls?: Record<string, unknown>;
      embedding: readonly number[];
      id?: never;
      mode: "embedding";
    };

export type CartesiaTTSTransport = "http" | "sse";

export type CartesiaTTSOptions = {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  language?: string;
  model?: CartesiaTTSModel;
  outputFormat?: CartesiaOutputFormat;
  speed?: number | "slow" | "normal" | "fast";
  transport?: CartesiaTTSTransport;
  version?: string;
  voice: CartesiaVoice | string;
};

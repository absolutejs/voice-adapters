export type NeetsModel = "ar-diff-50k" | "style-tts-2" | "vits" | (string & {});

export type NeetsAudioFormat = "mp3" | "pcm" | "wav" | (string & {});

export type NeetsSampleRate =
  8_000 | 16_000 | 22_050 | 24_000 | 44_100 | (number & {});

export type NeetsLanguage =
  "en-us" | "es-es" | "fr-fr" | "pt-pt" | (string & {});

export type NeetsTTSOptions = {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  format?: NeetsAudioFormat;
  language?: NeetsLanguage;
  model?: NeetsModel;
  sampleRate?: NeetsSampleRate;
  temperature?: number;
  voiceId: string;
};

export type PlayHTVoiceEngine =
  | "Play3.0-mini"
  | "PlayDialog"
  | "PlayHT2.0"
  | "PlayHT2.0-turbo"
  | (string & {});

export type PlayHTOutputFormat =
  "mp3" | "mulaw" | "raw" | "wav" | (string & {});

export type PlayHTSampleRate =
  8_000 | 16_000 | 22_050 | 24_000 | 44_100 | 48_000 | (number & {});

export type PlayHTQuality =
  "draft" | "high" | "low" | "medium" | "premium" | (string & {});

export type PlayHTTTSOptions = {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  language?: string;
  outputFormat?: PlayHTOutputFormat;
  quality?: PlayHTQuality;
  sampleRate?: PlayHTSampleRate;
  speed?: number;
  temperature?: number;
  userId: string;
  voice: string;
  voiceEngine?: PlayHTVoiceEngine;
  voiceGuidance?: number;
};

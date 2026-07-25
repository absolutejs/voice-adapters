export type SmallestModel = "lightning" | "lightning-v2" | (string & {});

export type SmallestSampleRate =
  8_000 | 16_000 | 22_050 | 24_000 | (number & {});

export type SmallestLanguage = "en" | "hi" | (string & {});

export type SmallestTTSOptions = {
  apiKey: string;
  baseUrl?: string;
  consistency?: number;
  enhancement?: number;
  fetch?: typeof fetch;
  language?: SmallestLanguage;
  model?: SmallestModel;
  sampleRate?: SmallestSampleRate;
  similarity?: number;
  speed?: number;
  voiceId: string;
};

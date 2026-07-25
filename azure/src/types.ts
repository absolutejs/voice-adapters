export type AzureTTSOutputFormat =
  | "audio-16khz-32kbitrate-mono-mp3"
  | "audio-16khz-64kbitrate-mono-mp3"
  | "audio-16khz-128kbitrate-mono-mp3"
  | "audio-24khz-48kbitrate-mono-mp3"
  | "audio-24khz-96kbitrate-mono-mp3"
  | "audio-24khz-160kbitrate-mono-mp3"
  | "audio-48khz-96kbitrate-mono-mp3"
  | "audio-48khz-192kbitrate-mono-mp3"
  | "raw-8khz-8bit-mono-alaw"
  | "raw-8khz-8bit-mono-mulaw"
  | "raw-8khz-16bit-mono-pcm"
  | "raw-16khz-16bit-mono-pcm"
  | "raw-22050hz-16bit-mono-pcm"
  | "raw-24khz-16bit-mono-pcm"
  | "raw-44100hz-16bit-mono-pcm"
  | "raw-48khz-16bit-mono-pcm"
  | (string & {});

export type AzureTTSAuth =
  | {
      subscriptionKey: string;
      token?: never;
    }
  | {
      subscriptionKey?: never;
      token: string;
    };

export type AzureTTSProsody = {
  pitch?: string;
  rate?: string;
  volume?: string;
};

export type AzureTTSOptions = AzureTTSAuth & {
  baseUrl?: string;
  endpointPath?: string;
  fetch?: typeof fetch;
  language?: string;
  outputFormat?: AzureTTSOutputFormat;
  prosody?: AzureTTSProsody;
  region?: string;
  styleDegree?: number;
  userAgent?: string;
  voice: string;
  voiceStyle?: string;
};

export type AzureSTTAuth =
  | { subscriptionKey: string; token?: never }
  | { subscriptionKey?: never; token: string };

export type AzureSTTRecognitionMode =
  "conversation" | "dictation" | "interactive";

export type AzureSTTOutputFormat = "detailed" | "simple";

export type AzureSTTProfanityMode = "masked" | "raw" | "removed";

export type AzureSTTOptions = AzureSTTAuth & {
  baseUrl?: string;
  connectTimeoutMs?: number;
  endpointPath?: string;
  format?: AzureSTTOutputFormat;
  language?: string;
  profanity?: AzureSTTProfanityMode;
  recognitionMode?: AzureSTTRecognitionMode;
  region?: string;
  systemName?: string;
  systemVersion?: string;
  webSocket?: {
    factory?: (url: string, headers: Record<string, string>) => WebSocket;
  };
};

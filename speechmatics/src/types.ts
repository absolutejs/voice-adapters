export type SpeechmaticsOperatingPoint = "enhanced" | "standard";

export type SpeechmaticsAudioEncoding = "mulaw" | "pcm_f32le" | "pcm_s16le";

export type SpeechmaticsDiarizationMode =
  "channel" | "channel_and_speaker" | "none" | "speaker";

export type SpeechmaticsRegion = "eu" | "eu2" | "usa" | (string & {});

export type SpeechmaticsSTTOptions = {
  apiKey?: string;
  baseUrl?: string;
  connectTimeoutMs?: number;
  diarization?: SpeechmaticsDiarizationMode;
  enablePartials?: boolean;
  jwt?: string;
  language?: string;
  maxDelay?: number;
  operatingPoint?: SpeechmaticsOperatingPoint;
  punctuationOverrides?: Record<string, unknown>;
  region?: SpeechmaticsRegion;
  speakerChangeSensitivity?: number;
  webSocket?: {
    factory?: (url: string) => WebSocket;
  };
};

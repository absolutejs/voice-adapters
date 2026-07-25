export type ElevenLabsVoiceSettings = {
  stability?: number;
  similarityBoost?: number;
  style?: number;
  speed?: number;
  useSpeakerBoost?: boolean;
};

export type ElevenLabsOutputFormat =
  | "pcm_16000"
  | "pcm_22050"
  | "pcm_24000"
  | "pcm_44100"
  | "mp3_22050_32"
  | "mp3_44100_32"
  | "mp3_44100_64"
  | "mp3_44100_96"
  | "mp3_44100_128"
  | "ulaw_8000"
  | "alaw_8000"
  | (string & {});

export type ElevenLabsTTSModel =
  | "eleven_flash_v2_5"
  | "eleven_flash_v2"
  | "eleven_multilingual_v2"
  | "eleven_turbo_v2_5"
  | "eleven_turbo_v2"
  | "eleven_v3"
  | (string & {});

export type ElevenLabsTTSTransport = "http" | "websocket";

export type ElevenLabsWebSocketOptions = {
  inactivityTimeoutSec?: number;
  autoMode?: boolean;
  syncAlignment?: boolean;
  enableSsmlParsing?: boolean;
  applyTextNormalization?: "auto" | "off" | "on";
  chunkLengthSchedule?: number[];
  keepAliveIntervalMs?: number;
  finalIdleTimeoutMs?: number;
  generationTimeoutMs?: number;
};

export type ElevenLabsTTSOptions = {
  apiKey: string;
  voiceId: string;
  fetch?: typeof fetch;
  modelId?: ElevenLabsTTSModel;
  outputFormat?: ElevenLabsOutputFormat;
  languageCode?: string;
  voiceSettings?: ElevenLabsVoiceSettings;
  seed?: number;
  enableLogging?: boolean;
  optimizeStreamingLatency?: 0 | 1 | 2 | 3 | 4;
  transport?: ElevenLabsTTSTransport;
  websocket?: ElevenLabsWebSocketOptions;
};

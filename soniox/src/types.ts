export type SonioxAudioEncoding = "pcm_alaw" | "pcm_mulaw" | "pcm_s16le";

export type SonioxModel =
  "stt-rt-preview" | "stt-rt-preview-v2" | (string & {});

export type SonioxSTTOptions = {
  apiKey: string;
  baseUrl?: string;
  clientReferenceId?: string;
  connectTimeoutMs?: number;
  context?: string;
  enableEndpointDetection?: boolean;
  enableLanguageIdentification?: boolean;
  enableSpeakerDiarization?: boolean;
  languageHints?: readonly string[];
  model?: SonioxModel;
  webSocket?: {
    factory?: (url: string) => WebSocket;
  };
};

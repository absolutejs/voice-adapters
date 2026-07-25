export type GoogleSpeechModel =
  | "chirp"
  | "chirp_2"
  | "command_and_search"
  | "default"
  | "latest_long"
  | "latest_short"
  | "medical_conversation"
  | "phone_call"
  | "telephony"
  | "telephony_short"
  | "video"
  | (string & {});

export type GoogleSpeechEncoding =
  | "ALAW"
  | "AMR"
  | "AMR_WB"
  | "FLAC"
  | "LINEAR16"
  | "MULAW"
  | "OGG_OPUS"
  | "WEBM_OPUS"
  | (string & {});

export type GoogleSpeechAuth =
  | { accessToken: string; apiKey?: never }
  | { accessToken?: never; apiKey: string };

export type GoogleSpeechSTTOptions = GoogleSpeechAuth & {
  baseUrl?: string;
  diarizationConfig?: Record<string, unknown>;
  enableAutomaticPunctuation?: boolean;
  enableSpeakerDiarization?: boolean;
  enableWordTimeOffsets?: boolean;
  fetch?: typeof fetch;
  flushOnClose?: boolean;
  getAccessToken?: () => Promise<string> | string;
  language?: string;
  maxBufferedBytes?: number;
  model?: GoogleSpeechModel;
  profanityFilter?: boolean;
  speechContexts?: ReadonlyArray<{
    boost?: number;
    phrases: readonly string[];
  }>;
  useEnhanced?: boolean;
};

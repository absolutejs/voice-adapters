export type GeminiLiveModel =
  | "gemini-2.5-flash-native-audio-preview-12-2025"
  | "gemini-live-2.5-flash-preview"
  | "gemini-2.0-flash-live-001"
  | (string & {});

export type GeminiLiveResponseModality = "AUDIO" | "TEXT";

export type GeminiLiveVoiceName =
  "Aoede" | "Charon" | "Fenrir" | "Kore" | "Puck" | (string & {});

export type GeminiLiveAdapterOptions = {
  apiKey: string;
  baseUrl?: string;
  model?: GeminiLiveModel;
  responseModalities?: GeminiLiveResponseModality[];
  voiceName?: GeminiLiveVoiceName;
  instructions?: string;
  temperature?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
  emitInputTranscripts?: boolean;
  emitOutputTranscripts?: boolean;
};

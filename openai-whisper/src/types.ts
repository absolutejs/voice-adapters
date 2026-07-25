export type OpenAIWhisperModel =
  "gpt-4o-mini-transcribe" | "gpt-4o-transcribe" | "whisper-1" | (string & {});

export type OpenAIWhisperResponseFormat = "json" | "text" | "verbose_json";

export type OpenAIWhisperSTTOptions = {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  flushOnClose?: boolean;
  language?: string;
  maxBufferedBytes?: number;
  model?: OpenAIWhisperModel;
  organization?: string;
  prompt?: string;
  responseFormat?: OpenAIWhisperResponseFormat;
  temperature?: number;
};

export type AssemblyAISpeechModel =
  | "u3-rt-pro"
  | "universal-streaming-english"
  | "universal-streaming-multi"
  | (string & {});

export type AssemblyAISTTOptions = {
  apiKey: string;
  speechModel?: AssemblyAISpeechModel;
  formatTurns?: boolean;
  keytermsPrompt?: string[];
  endOfTurnConfidenceThreshold?: number;
  minEndOfTurnSilenceWhenConfident?: number;
  maxTurnSilence?: number;
  token?: string;
};

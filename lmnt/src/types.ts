export type LMNTModel = 'aurora' | 'blizzard' | 'mochi' | (string & {});

export type LMNTAudioFormat = 'mp3' | 'mulaw' | 'raw' | 'wav' | (string & {});

export type LMNTSampleRate = 8_000 | 16_000 | 24_000 | (number & {});

export type LMNTLanguage =
	| 'auto'
	| 'de'
	| 'en'
	| 'es'
	| 'fr'
	| 'hi'
	| 'it'
	| 'ja'
	| 'ko'
	| 'pt'
	| 'zh'
	| (string & {});

export type LMNTTTSOptions = {
	apiKey: string;
	baseUrl?: string;
	conversational?: boolean;
	fetch?: typeof fetch;
	format?: LMNTAudioFormat;
	language?: LMNTLanguage;
	model?: LMNTModel;
	sampleRate?: LMNTSampleRate;
	seed?: number;
	speed?: number;
	temperature?: number;
	topP?: number;
	voice: string;
};

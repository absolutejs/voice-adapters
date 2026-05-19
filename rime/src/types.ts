export type RimeModel = 'arcana' | 'mist' | 'mistv2' | (string & {});

export type RimeAudioFormat = 'mulaw' | 'pcm' | (string & {});

export type RimeSampleRate = 8_000 | 16_000 | 22_050 | 24_000 | (number & {});

export type RimeTTSOptions = {
	apiKey: string;
	baseUrl?: string;
	audioFormat?: RimeAudioFormat;
	fetch?: typeof fetch;
	inlineSpeedAlpha?: number;
	lang?: string;
	modelId?: RimeModel;
	noTextNormalization?: boolean;
	pauseBetweenBrackets?: boolean;
	phonemizeBetweenBrackets?: boolean;
	reduceLatency?: boolean;
	sampleRate?: RimeSampleRate;
	speaker: string;
	speedAlpha?: number;
};

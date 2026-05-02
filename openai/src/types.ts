export type OpenAIRealtimeModel =
	| 'gpt-realtime'
	| 'gpt-realtime-1.5'
	| 'gpt-realtime-mini'
	| 'gpt-audio-1.5'
	| 'gpt-audio-mini'
	| 'gpt-4o-realtime-preview'
	| 'gpt-4o-mini-realtime-preview'
	| (string & {});

export type OpenAIBuiltInVoice =
	| 'alloy'
	| 'ash'
	| 'ballad'
	| 'coral'
	| 'echo'
	| 'sage'
	| 'shimmer'
	| 'verse'
	| 'marin'
	| 'cedar';

export type OpenAICustomVoice = {
	id: string;
};

export type OpenAIRealtimeVoice =
	| OpenAIBuiltInVoice
	| OpenAICustomVoice
	| (string & {});

export type OpenAIInputTranscriptionModel =
	| 'whisper-1'
	| 'gpt-4o-mini-transcribe'
	| 'gpt-4o-transcribe'
	| (string & {});

export type OpenAINoiseReduction = 'near_field' | 'far_field';

export type OpenAIResponseMode = 'audio' | 'text';

export type OpenAIRealtimeAdapterOptions = {
	apiKey: string;
	model?: OpenAIRealtimeModel;
	/**
	 * Emit normalized transcripts for assistant output events (`response.*transcript.*`).
	 * The default is `false`, which keeps the adapter focused on user-input STT.
	 */
	emitResponseTranscripts?: boolean;
	voice?: OpenAIRealtimeVoice;
	instructions?: string;
	inputTranscriptionModel?: OpenAIInputTranscriptionModel | null;
	inputTranscriptionLanguage?: string;
	inputTranscriptionPrompt?: string;
	maxOutputTokens?: number | 'inf';
	autoCommitSilenceMs?: number;
	noiseReduction?: OpenAINoiseReduction;
	responseMode?: OpenAIResponseMode;
	speed?: number;
	temperature?: number;
};

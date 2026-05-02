export type DeepgramModel =
	| 'nova-3'
	| 'nova-2'
	| 'flux'
	| 'flux-general-en'
	| 'flux-general-multi'
	| (string & {});

export type DeepgramSTTOptions = {
	apiKey: string;
	model: DeepgramModel;
	authMode?: 'header' | 'protocol';
	language?: string;
	punctuate?: boolean;
	smartFormat?: boolean;
	interimResults?: boolean;
	endpointing?: number | false;
	utteranceEndMs?: number;
	vadEvents?: boolean;
	diarize?: boolean;
	numerals?: boolean;
	profanityFilter?: boolean;
	redact?: string | string[];
	keyterm?: string | string[];
	keyterms?: string | string[];
	eotThreshold?: number;
	eagerEotThreshold?: number;
	eotTimeoutMs?: number;
	keepAliveMs?: number;
	connectTimeoutMs?: number;
	tag?: string | string[];
	extra?: Record<string, string>;
};

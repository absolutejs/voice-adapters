export type GladiaModel = 'solaria-1' | (string & {});

export type GladiaEncoding = 'wav/alaw' | 'wav/pcm' | 'wav/ulaw';

export type GladiaLanguageConfig = {
	code_switching?: boolean;
	languages?: readonly string[];
};

export type GladiaSTTOptions = {
	apiKey: string;
	baseUrl?: string;
	codeSwitching?: boolean;
	connectTimeoutMs?: number;
	fetch?: typeof fetch;
	languages?: readonly string[];
	model?: GladiaModel;
	punctuationConfig?: Record<string, unknown>;
	realtimeProcessing?: Record<string, unknown>;
	sessionPath?: string;
	webSocket?: {
		factory?: (url: string) => WebSocket;
	};
};

import type {
	STTAdapter,
	STTAdapterSession,
	STTSessionEventMap
} from '@absolutejs/voice';
import type {
	GladiaEncoding,
	GladiaSTTOptions
} from './types';

type ListenerMap = {
	[K in keyof STTSessionEventMap]: Set<
		(payload: STTSessionEventMap[K]) => void | Promise<void>
	>;
};

const DEFAULT_BASE_URL = 'https://api.gladia.io';
const DEFAULT_SESSION_PATH = '/v2/live';
const DEFAULT_LANGUAGE = 'en';
const DEFAULT_CONNECT_TIMEOUT_MS = 8_000;
const DEFAULT_MODEL = 'solaria-1';

// Opportunistic HTTP/2 multiplexing for outbound HTTPS calls (Bun 1.3.14+).
type H2Init = RequestInit & { protocol?: 'http2' };
const isHttpsUrl = (url: string | URL) =>
	typeof url === 'string'
		? url.startsWith('https://')
		: url.protocol === 'https:';
const h2IfHttps = (url: string | URL): H2Init =>
	isHttpsUrl(url) ? { protocol: 'http2' } : {};

const createListenerMap = (): ListenerMap => ({
	close: new Set(),
	endOfTurn: new Set(),
	error: new Set(),
	final: new Set(),
	partial: new Set()
});

const emit = async <K extends keyof STTSessionEventMap>(
	listeners: ListenerMap,
	event: K,
	payload: STTSessionEventMap[K]
) => {
	for (const listener of listeners[event]) {
		await listener(payload);
	}
};

const omitUndefined = (value: Record<string, unknown>) =>
	Object.fromEntries(
		Object.entries(value).filter(([, entry]) => entry !== undefined)
	);

const resolveBaseUrl = (config: GladiaSTTOptions): string =>
	(config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');

const resolveSessionUrl = (config: GladiaSTTOptions): URL => {
	const path = config.sessionPath ?? DEFAULT_SESSION_PATH;
	return new URL(
		`${resolveBaseUrl(config)}${path.startsWith('/') ? path : `/${path}`}`
	);
};

const resolveEncoding = (
	format: { encoding?: string }
): GladiaEncoding => {
	switch (format.encoding) {
		case 'pcm_s16le':
			return 'wav/pcm';
		case 'pcm_mulaw':
		case 'mulaw':
			return 'wav/ulaw';
		case 'pcm_alaw':
		case 'alaw':
			return 'wav/alaw';
		default:
			throw new Error(
				`Unsupported audio encoding "${String(format.encoding)}" for @absolutejs/voice-gladia. ` +
					`Use pcm_s16le, mulaw, or alaw.`
			);
	}
};

const resolveBitDepth = (
	format: { encoding?: string }
): number => {
	switch (format.encoding) {
		case 'pcm_s16le':
			return 16;
		case 'pcm_mulaw':
		case 'mulaw':
		case 'pcm_alaw':
		case 'alaw':
			return 8;
		default:
			return 16;
	}
};

const resolveLanguages = (
	openOptions: { languageStrategy?: unknown },
	config: GladiaSTTOptions
): readonly string[] | undefined => {
	const strategy = openOptions.languageStrategy as
		| {
				allowedLanguages?: string[];
				mode: 'allow-switching' | 'auto-detect' | 'fixed';
				primaryLanguage?: string;
				secondaryLanguages?: string[];
		  }
		| undefined;
	if (strategy?.mode === 'fixed' && strategy.primaryLanguage) {
		return [strategy.primaryLanguage];
	}
	if (strategy?.mode === 'allow-switching') {
		const primary = strategy.primaryLanguage;
		const secondary = strategy.secondaryLanguages ?? [];
		const combined = primary ? [primary, ...secondary] : [...secondary];
		return combined.length > 0 ? combined : config.languages;
	}
	if (strategy?.mode === 'auto-detect' && strategy.allowedLanguages?.length) {
		return strategy.allowedLanguages;
	}
	return config.languages;
};

const buildSessionInitBody = (
	config: GladiaSTTOptions,
	openOptions: {
		format: { channels?: number; encoding?: string; sampleRateHz?: number };
		languageStrategy?: unknown;
	}
) =>
	omitUndefined({
		bit_depth: resolveBitDepth(openOptions.format),
		channels: openOptions.format.channels ?? 1,
		encoding: resolveEncoding(openOptions.format),
		language_config: omitUndefined({
			code_switching: config.codeSwitching,
			languages: resolveLanguages(openOptions, config) ?? [DEFAULT_LANGUAGE]
		}),
		model: config.model ?? DEFAULT_MODEL,
		punctuation_config: config.punctuationConfig,
		realtime_processing: config.realtimeProcessing,
		sample_rate: openOptions.format.sampleRateHz ?? 16_000
	});

type GladiaSessionResponse = {
	id: string;
	url: string;
};

type GladiaUtterance = {
	confidence?: number;
	end?: number;
	language?: string;
	start?: number;
	text?: string;
};

type GladiaTranscriptMessage = {
	data?: {
		is_final?: boolean;
		utterance?: GladiaUtterance;
	};
	type: string;
};

const toUint8Array = (chunk: ArrayBuffer | ArrayBufferView): Uint8Array => {
	if (chunk instanceof Uint8Array) return chunk;
	if (ArrayBuffer.isView(chunk)) {
		return new Uint8Array(
			chunk.buffer,
			chunk.byteOffset,
			chunk.byteLength
		);
	}
	return new Uint8Array(chunk);
};

export const gladia = (config: GladiaSTTOptions): STTAdapter => {
	if (!config.apiKey) {
		throw new Error(
			'@absolutejs/voice-gladia requires an apiKey.'
		);
	}
	resolveBaseUrl(config);
	const fetchImpl = config.fetch ?? globalThis.fetch;

	return {
		kind: 'stt',
		open: async (openOptions) => {
			const listeners = createListenerMap();
			const sessionTarget = resolveSessionUrl(config);
			const sessionResponse = await fetchImpl(sessionTarget, {
				...h2IfHttps(sessionTarget),
				body: JSON.stringify(
					buildSessionInitBody(config, openOptions)
				),
				headers: {
					'Content-Type': 'application/json',
					'X-Gladia-Key': config.apiKey
				},
				method: 'POST'
			});
			if (!sessionResponse.ok) {
				const bodyText = await sessionResponse
					.text()
					.catch(() => '');
				throw new Error(
					`Gladia /v2/live returned ${String(sessionResponse.status)} ${sessionResponse.statusText}${
						bodyText ? `: ${bodyText.slice(0, 200)}` : ''
					}`
				);
			}
			const sessionBody = (await sessionResponse.json()) as GladiaSessionResponse;
			if (!sessionBody?.url) {
				throw new Error(
					'Gladia session response did not include a websocket url.'
				);
			}

			const factory =
				config.webSocket?.factory ??
				((target: string) => new WebSocket(target));
			const socket = factory(sessionBody.url);

			let opened = false;
			let closed = false;
			let seq = 0;
			const pendingAudio: Uint8Array[] = [];
			const connectTimeoutMs =
				config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

			const sendAudio = (audio: Uint8Array) => {
				socket.send(audio);
				seq += 1;
			};

			const flushPending = () => {
				for (const chunk of pendingAudio.splice(
					0,
					pendingAudio.length
				)) {
					sendAudio(chunk);
				}
			};

			const openPromise = new Promise<void>((resolve, reject) => {
				const openTimeout = setTimeout(() => {
					if (opened) return;
					reject(
						new Error(
							`Gladia websocket open timeout after ${String(connectTimeoutMs)}ms`
						)
					);
					try {
						socket.close(1013, 'open-timeout');
					} catch {}
				}, connectTimeoutMs);

				socket.addEventListener(
					'open',
					() => {
						opened = true;
						clearTimeout(openTimeout);
						flushPending();
						resolve();
					},
					{ once: true }
				);

				socket.addEventListener('error', () => {
					clearTimeout(openTimeout);
					if (!opened) {
						reject(
							new Error('Gladia websocket failed to open.')
						);
					}
				});
			});

			socket.addEventListener('message', (event) => {
				if (typeof event.data !== 'string') return;
				let parsed: GladiaTranscriptMessage | undefined;
				try {
					parsed = JSON.parse(event.data) as GladiaTranscriptMessage;
				} catch {
					return;
				}
				if (!parsed) return;
				const type = parsed.type;
				const data = parsed.data;
				if (type === 'transcript' && data?.utterance) {
					const isFinal = data.is_final === true;
					const utterance = data.utterance;
					if (!utterance.text) return;
					const event: keyof STTSessionEventMap = isFinal
						? 'final'
						: 'partial';
					void emit(listeners, event, {
						receivedAt: Date.now(),
						transcript: {
							confidence: utterance.confidence,
							endedAtMs:
								typeof utterance.end === 'number'
									? Math.round(utterance.end * 1_000)
									: undefined,
							id: `gladia:${isFinal ? 'final' : 'partial'}:${String(seq)}`,
							isFinal,
							language: utterance.language,
							startedAtMs:
								typeof utterance.start === 'number'
									? Math.round(utterance.start * 1_000)
									: undefined,
							text: utterance.text,
							vendor: 'gladia'
						},
						type: event as 'final' | 'partial'
					} as never);
				}
				if (type === 'end_of_utterance' || type === 'speech_end') {
					void emit(listeners, 'endOfTurn', {
						reason: 'vendor',
						receivedAt: Date.now(),
						type: 'endOfTurn'
					});
				}
				if (type === 'error') {
					const message =
						(parsed as unknown as { data?: { message?: string } })
							.data?.message ?? 'Gladia error';
					void emit(listeners, 'error', {
						error: new Error(message),
						recoverable: false,
						type: 'error'
					});
				}
			});

			socket.addEventListener('close', (event) => {
				if (closed) return;
				closed = true;
				void emit(listeners, 'close', {
					code: event.code,
					reason: event.reason || undefined,
					recoverable: false,
					type: 'close'
				});
			});

			await openPromise;

			const session: STTAdapterSession = {
				close: async (reason?: string) => {
					if (closed) return;
					closed = true;
					try {
						if (
							socket.readyState === WebSocket.OPEN ||
							socket.readyState === WebSocket.CONNECTING
						) {
							socket.send(
								JSON.stringify({ type: 'stop_recording' })
							);
							socket.close(1000, reason);
						}
					} catch {}
				},
				on: (event, handler) => {
					listeners[event].add(handler as never);
					return () => {
						listeners[event].delete(handler as never);
					};
				},
				send: async (audio) => {
					if (closed) return;
					const bytes = toUint8Array(audio);
					if (bytes.byteLength === 0) return;
					if (!opened) {
						pendingAudio.push(bytes);
						return;
					}
					sendAudio(bytes);
				}
			};

			return session;
		}
	};
};

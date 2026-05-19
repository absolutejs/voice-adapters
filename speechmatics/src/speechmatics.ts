import type {
	STTAdapter,
	STTAdapterSession,
	STTSessionEventMap
} from '@absolutejs/voice';
import type {
	SpeechmaticsAudioEncoding,
	SpeechmaticsSTTOptions
} from './types';

type ListenerMap = {
	[K in keyof STTSessionEventMap]: Set<
		(payload: STTSessionEventMap[K]) => void | Promise<void>
	>;
};

const DEFAULT_CONNECT_TIMEOUT_MS = 8_000;
const DEFAULT_LANGUAGE = 'en';
const DEFAULT_OPERATING_POINT = 'enhanced';

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

const resolveBaseUrl = (config: SpeechmaticsSTTOptions): string => {
	if (config.baseUrl) return config.baseUrl.replace(/\/$/, '');
	const region = config.region ?? 'eu2';
	return `wss://${region}.rt.speechmatics.com`;
};

const resolveSocketUrl = (config: SpeechmaticsSTTOptions): URL => {
	const base = resolveBaseUrl(config);
	const url = new URL(`${base}/v2`);
	const token = config.jwt ?? config.apiKey;
	if (token) {
		url.searchParams.set('jwt', token);
	}
	return url;
};

const resolveEncoding = (
	format: { encoding?: string }
): SpeechmaticsAudioEncoding => {
	switch (format.encoding) {
		case 'pcm_s16le':
			return 'pcm_s16le';
		case 'pcm_f32le':
			return 'pcm_f32le';
		case 'mulaw':
		case 'pcm_mulaw':
			return 'mulaw';
		default:
			throw new Error(
				`Unsupported audio encoding "${String(format.encoding)}" for @absolutejs/voice-speechmatics. ` +
					`Speechmatics real-time accepts pcm_s16le, pcm_f32le, or mulaw.`
			);
	}
};

const resolveLanguage = (
	openOptions: { languageStrategy?: unknown },
	config: SpeechmaticsSTTOptions
): string => {
	const strategy = openOptions.languageStrategy as
		| {
				allowedLanguages?: string[];
				mode: 'allow-switching' | 'auto-detect' | 'fixed';
				primaryLanguage?: string;
				secondaryLanguages?: string[];
		  }
		| undefined;
	if (strategy) {
		if (strategy.mode === 'fixed' && strategy.primaryLanguage) {
			return strategy.primaryLanguage;
		}
		if (strategy.mode === 'allow-switching' && strategy.primaryLanguage) {
			return strategy.primaryLanguage;
		}
		if (
			strategy.mode === 'auto-detect' &&
			strategy.allowedLanguages?.[0]
		) {
			return strategy.allowedLanguages[0];
		}
	}
	return config.language ?? DEFAULT_LANGUAGE;
};

const buildStartRecognitionMessage = (
	config: SpeechmaticsSTTOptions,
	openOptions: {
		format: { channels?: number; encoding?: string; sampleRateHz?: number };
		languageStrategy?: unknown;
	}
) => ({
	audio_format: {
		encoding: resolveEncoding(openOptions.format),
		sample_rate: openOptions.format.sampleRateHz ?? 16_000,
		type: 'raw'
	},
	message: 'StartRecognition',
	transcription_config: {
		diarization: config.diarization,
		enable_partials: config.enablePartials ?? true,
		language: resolveLanguage(openOptions, config),
		max_delay: config.maxDelay,
		operating_point: config.operatingPoint ?? DEFAULT_OPERATING_POINT,
		punctuation_overrides: config.punctuationOverrides,
		speaker_change_sensitivity: config.speakerChangeSensitivity
	}
});

type SpeechmaticsResult = {
	alternatives?: Array<{ confidence?: number; content?: string }>;
	end_time?: number;
	start_time?: number;
	type?: string;
};

type SpeechmaticsMessage = {
	error?: string;
	id?: string;
	language?: string;
	message: string;
	reason?: string;
	results?: SpeechmaticsResult[];
};

const buildTranscriptText = (results: SpeechmaticsResult[]): string => {
	const parts: string[] = [];
	for (const result of results) {
		const content = result.alternatives?.[0]?.content;
		if (!content) continue;
		if (result.type === 'punctuation' && parts.length > 0) {
			parts[parts.length - 1] = `${parts[parts.length - 1]!}${content}`;
		} else {
			parts.push(content);
		}
	}
	return parts.join(' ');
};

const averageConfidence = (
	results: SpeechmaticsResult[]
): number | undefined => {
	const values: number[] = [];
	for (const result of results) {
		const confidence = result.alternatives?.[0]?.confidence;
		if (typeof confidence === 'number') {
			values.push(confidence);
		}
	}
	if (values.length === 0) return undefined;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
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

export const speechmatics = (
	config: SpeechmaticsSTTOptions
): STTAdapter => {
	if (!config.apiKey && !config.jwt) {
		throw new Error(
			'@absolutejs/voice-speechmatics requires either apiKey or jwt.'
		);
	}
	resolveBaseUrl(config);

	return {
		kind: 'stt',
		open: async (openOptions) => {
			const listeners = createListenerMap();
			const language = resolveLanguage(openOptions, config);
			const url = resolveSocketUrl(config);
			const factory =
				config.webSocket?.factory ??
				((target: string) => new WebSocket(target));
			const socket = factory(url.toString());
			const connectTimeoutMs =
				config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

			let opened = false;
			let recognitionStarted = false;
			let closed = false;
			let seq = 0;
			const pendingAudio: Uint8Array[] = [];

			const sendAudio = (audio: Uint8Array) => {
				socket.send(audio);
				seq += 1;
			};

			const flushPending = () => {
				for (const chunk of pendingAudio.splice(0, pendingAudio.length)) {
					sendAudio(chunk);
				}
			};

			const openPromise = new Promise<void>((resolve, reject) => {
				const openTimeout = setTimeout(() => {
					if (recognitionStarted) return;
					reject(
						new Error(
							`Speechmatics websocket open timeout after ${String(connectTimeoutMs)}ms`
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
						try {
							socket.send(
								JSON.stringify(
									buildStartRecognitionMessage(
										config,
										openOptions
									)
								)
							);
						} catch (error) {
							clearTimeout(openTimeout);
							reject(
								error instanceof Error
									? error
									: new Error(String(error))
							);
						}
					},
					{ once: true }
				);

				socket.addEventListener('message', (event) => {
					if (typeof event.data !== 'string') return;
					let parsed: SpeechmaticsMessage | undefined;
					try {
						parsed = JSON.parse(event.data) as SpeechmaticsMessage;
					} catch {
						return;
					}
					if (!parsed?.message) return;
					if (parsed.message === 'RecognitionStarted') {
						recognitionStarted = true;
						clearTimeout(openTimeout);
						flushPending();
						resolve();
						return;
					}
					if (parsed.message === 'Error') {
						const failure = new Error(
							parsed.reason ?? parsed.error ?? 'Speechmatics error'
						);
						if (!recognitionStarted) {
							clearTimeout(openTimeout);
							reject(failure);
							return;
						}
						void emit(listeners, 'error', {
							error: failure,
							recoverable: false,
							type: 'error'
						});
						return;
					}
					if (parsed.message === 'AddPartialTranscript') {
						const results = parsed.results ?? [];
						const text = buildTranscriptText(results);
						if (!text) return;
						void emit(listeners, 'partial', {
							receivedAt: Date.now(),
							transcript: {
								confidence: averageConfidence(results),
								id: `speechmatics:partial:${String(seq)}`,
								isFinal: false,
								language: parsed.language ?? language,
								text,
								vendor: 'speechmatics'
							},
							type: 'partial'
						});
						return;
					}
					if (parsed.message === 'AddTranscript') {
						const results = parsed.results ?? [];
						const text = buildTranscriptText(results);
						if (!text) return;
						void emit(listeners, 'final', {
							receivedAt: Date.now(),
							transcript: {
								confidence: averageConfidence(results),
								id: `speechmatics:final:${String(seq)}`,
								isFinal: true,
								language: parsed.language ?? language,
								text,
								vendor: 'speechmatics'
							},
							type: 'final'
						});
						return;
					}
					if (parsed.message === 'EndOfTranscript') {
						void emit(listeners, 'endOfTurn', {
							reason: 'vendor',
							receivedAt: Date.now(),
							type: 'endOfTurn'
						});
					}
				});

				socket.addEventListener('error', () => {
					clearTimeout(openTimeout);
					if (!recognitionStarted) {
						reject(
							new Error(
								'Speechmatics websocket failed to open.'
							)
						);
					}
				});

				socket.addEventListener('close', (event) => {
					clearTimeout(openTimeout);
					if (closed) return;
					closed = true;
					if (!recognitionStarted) {
						reject(
							new Error(
								`Speechmatics websocket closed before RecognitionStarted (${String(event.code)}).`
							)
						);
					}
					void emit(listeners, 'close', {
						code: event.code,
						reason: event.reason || undefined,
						recoverable: false,
						type: 'close'
					});
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
								JSON.stringify({
									last_seq_no: seq,
									message: 'EndOfStream'
								})
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
					if (!recognitionStarted) {
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

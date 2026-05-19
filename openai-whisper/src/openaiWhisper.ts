import type {
	STTAdapter,
	STTAdapterSession,
	STTSessionEventMap
} from '@absolutejs/voice';
import type { OpenAIWhisperSTTOptions } from './types';

type ListenerMap = {
	[K in keyof STTSessionEventMap]: Set<
		(payload: STTSessionEventMap[K]) => void | Promise<void>
	>;
};

const DEFAULT_BASE_URL = 'https://api.openai.com';
const DEFAULT_ENDPOINT_PATH = '/v1/audio/transcriptions';
const DEFAULT_MODEL: OpenAIWhisperSTTOptions['model'] = 'whisper-1';
const DEFAULT_MAX_BUFFERED_BYTES = 20 * 1024 * 1024; // ~20 MB

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

const concatBuffers = (buffers: readonly Uint8Array[]): Uint8Array => {
	let total = 0;
	for (const buffer of buffers) total += buffer.byteLength;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const buffer of buffers) {
		out.set(buffer, offset);
		offset += buffer.byteLength;
	}
	return out;
};

const resolveBitsPerSample = (encoding: string | undefined): number => {
	if (encoding === 'pcm_s16le') return 16;
	if (encoding === 'mulaw' || encoding === 'pcm_mulaw') return 8;
	if (encoding === 'alaw' || encoding === 'pcm_alaw') return 8;
	if (encoding === 'pcm_s8') return 8;
	return 16;
};

const buildWavBuffer = (
	pcm: Uint8Array,
	sampleRate: number,
	channels: number,
	bitsPerSample: number
): Uint8Array => {
	const header = new ArrayBuffer(44);
	const view = new DataView(header);
	const writeAscii = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i += 1) {
			view.setUint8(offset + i, text.charCodeAt(i));
		}
	};
	const byteRate = (sampleRate * channels * bitsPerSample) / 8;
	const blockAlign = (channels * bitsPerSample) / 8;
	writeAscii(0, 'RIFF');
	view.setUint32(4, 36 + pcm.byteLength, true);
	writeAscii(8, 'WAVE');
	writeAscii(12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, channels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, byteRate, true);
	view.setUint16(32, blockAlign, true);
	view.setUint16(34, bitsPerSample, true);
	writeAscii(36, 'data');
	view.setUint32(40, pcm.byteLength, true);
	const out = new Uint8Array(44 + pcm.byteLength);
	out.set(new Uint8Array(header), 0);
	out.set(pcm, 44);
	return out;
};

const resolveErrorMessage = (error: unknown): string => {
	if (typeof error === 'string' && error.trim()) return error;
	if (error instanceof Error && error.message.trim()) return error.message;
	return 'OpenAI Whisper request failed';
};

const resolveLanguage = (
	openOptions: { languageStrategy?: unknown },
	config: OpenAIWhisperSTTOptions
): string | undefined => {
	const strategy = openOptions.languageStrategy as
		| {
				allowedLanguages?: string[];
				mode: 'allow-switching' | 'auto-detect' | 'fixed';
				primaryLanguage?: string;
				secondaryLanguages?: string[];
		  }
		| undefined;
	if (strategy?.mode === 'fixed' && strategy.primaryLanguage) {
		return strategy.primaryLanguage;
	}
	if (strategy?.mode === 'allow-switching' && strategy.primaryLanguage) {
		return strategy.primaryLanguage;
	}
	if (strategy?.mode === 'auto-detect') return undefined;
	return config.language;
};

const buildEndpointUrl = (config: OpenAIWhisperSTTOptions): URL => {
	const base = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
	return new URL(`${base}${DEFAULT_ENDPOINT_PATH}`);
};

export const openaiWhisper = (
	config: OpenAIWhisperSTTOptions
): STTAdapter => {
	if (!config.apiKey) {
		throw new Error(
			'@absolutejs/voice-openai-whisper requires an apiKey.'
		);
	}
	const fetchImpl = config.fetch ?? globalThis.fetch;
	const maxBufferedBytes =
		config.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
	const flushOnClose = config.flushOnClose ?? true;

	return {
		kind: 'stt',
		open: (openOptions) => {
			const listeners = createListenerMap();
			const sampleRateHz = openOptions.format.sampleRateHz ?? 16_000;
			const channels = openOptions.format.channels ?? 1;
			const bitsPerSample = resolveBitsPerSample(
				openOptions.format.encoding
			);
			const language = resolveLanguage(openOptions, config);
			const model = config.model ?? DEFAULT_MODEL;

			const buffers: Uint8Array[] = [];
			let bufferedBytes = 0;
			let closed = false;
			let flushSeq = 0;

			const flush = async () => {
				if (buffers.length === 0) return;
				const pcm = concatBuffers(buffers);
				buffers.length = 0;
				bufferedBytes = 0;
				const wav = buildWavBuffer(
					pcm,
					sampleRateHz,
					channels,
					bitsPerSample
				);
				const file = new File(
					[wav as unknown as BlobPart],
					`flush-${String(flushSeq)}.wav`,
					{ type: 'audio/wav' }
				);
				flushSeq += 1;
				const form = new FormData();
				form.set('file', file);
				form.set('model', model);
				if (language) form.set('language', language);
				if (config.prompt) form.set('prompt', config.prompt);
				if (config.responseFormat) {
					form.set('response_format', config.responseFormat);
				}
				if (typeof config.temperature === 'number') {
					form.set('temperature', String(config.temperature));
				}
				const target = buildEndpointUrl(config);
				const headers: Record<string, string> = {
					Authorization: `Bearer ${config.apiKey}`
				};
				if (config.organization) {
					headers['OpenAI-Organization'] = config.organization;
				}
				try {
					const response = await fetchImpl(target, {
						...h2IfHttps(target),
						body: form as unknown as BodyInit,
						headers,
						method: 'POST'
					});
					if (!response.ok) {
						const bodyText = await response
							.text()
							.catch(() => '');
						throw new Error(
							`OpenAI Whisper returned ${String(response.status)} ${response.statusText}${
								bodyText ? `: ${bodyText.slice(0, 200)}` : ''
							}`
						);
					}
					const responseFormat = config.responseFormat ?? 'json';
					let text = '';
					if (responseFormat === 'text') {
						text = (await response.text()).trim();
					} else {
						const body = (await response.json()) as {
							text?: string;
						};
						text = (body.text ?? '').trim();
					}
					if (text) {
						await emit(listeners, 'final', {
							receivedAt: Date.now(),
							transcript: {
								id: `openai-whisper:final:${String(flushSeq)}`,
								isFinal: true,
								language,
								text,
								vendor: 'openai-whisper'
							},
							type: 'final'
						});
					}
					await emit(listeners, 'endOfTurn', {
						reason: 'vendor',
						receivedAt: Date.now(),
						type: 'endOfTurn'
					});
				} catch (error) {
					await emit(listeners, 'error', {
						error:
							error instanceof Error
								? error
								: new Error(resolveErrorMessage(error)),
						recoverable: false,
						type: 'error'
					});
				}
			};

			const session: STTAdapterSession & {
				flush: () => Promise<void>;
			} = {
				close: async (reason?: string) => {
					if (closed) return;
					closed = true;
					if (flushOnClose) {
						try {
							await flush();
						} catch {}
					}
					await emit(listeners, 'close', {
						reason,
						recoverable: false,
						type: 'close'
					});
				},
				flush,
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
					if (
						bufferedBytes + bytes.byteLength >
						maxBufferedBytes
					) {
						throw new Error(
							`@absolutejs/voice-openai-whisper buffer overflow: maxBufferedBytes=${String(maxBufferedBytes)}. Call session.flush() between turns.`
						);
					}
					buffers.push(bytes);
					bufferedBytes += bytes.byteLength;
				}
			};

			return session;
		}
	};
};

export type OpenAIWhisperSession = ReturnType<
	ReturnType<typeof openaiWhisper>['open']
> extends Promise<infer S>
	? S & { flush: () => Promise<void> }
	: ReturnType<ReturnType<typeof openaiWhisper>['open']> & {
			flush: () => Promise<void>;
	  };

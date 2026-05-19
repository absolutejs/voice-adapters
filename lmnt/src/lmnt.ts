import type {
	AudioFormat,
	TTSAdapter,
	TTSSessionEventMap
} from '@absolutejs/voice';
import type {
	LMNTAudioFormat,
	LMNTSampleRate,
	LMNTTTSOptions
} from './types';

type ListenerMap = {
	[K in keyof TTSSessionEventMap]: Set<
		(payload: TTSSessionEventMap[K]) => void | Promise<void>
	>;
};

const DEFAULT_BASE_URL = 'https://api.lmnt.com';
const DEFAULT_ENDPOINT_PATH = '/v1/ai/speech/stream';
const DEFAULT_MODEL: LMNTTTSOptions['model'] = 'aurora';
const DEFAULT_FORMAT: LMNTAudioFormat = 'raw';
const DEFAULT_SAMPLE_RATE: LMNTSampleRate = 24_000;

// Opportunistic HTTP/2 multiplexing for outbound HTTPS calls (Bun 1.3.14+).
type H2Init = RequestInit & { protocol?: 'http2' };
const isHttpsUrl = (url: string | URL) =>
	typeof url === 'string'
		? url.startsWith('https://')
		: url.protocol === 'https:';
const h2IfHttps = (url: string | URL): H2Init =>
	isHttpsUrl(url) ? { protocol: 'http2' } : {};

const createListenerMap = (): ListenerMap => ({
	audio: new Set(),
	close: new Set(),
	error: new Set()
});

const emit = async <K extends keyof TTSSessionEventMap>(
	listeners: ListenerMap,
	event: K,
	payload: TTSSessionEventMap[K]
) => {
	for (const listener of listeners[event]) {
		await listener(payload);
	}
};

const omitUndefined = (value: Record<string, unknown>) =>
	Object.fromEntries(
		Object.entries(value).filter(([, entry]) => entry !== undefined)
	);

const resolveBaseUrl = (config: LMNTTTSOptions): string =>
	(config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');

const resolveStreamUrl = (config: LMNTTTSOptions): URL =>
	new URL(`${resolveBaseUrl(config)}${DEFAULT_ENDPOINT_PATH}`);

const resolveAcceptHeader = (format: LMNTAudioFormat): string => {
	switch (format) {
		case 'mp3':
			return 'audio/mpeg';
		case 'wav':
			return 'audio/wav';
		case 'mulaw':
			return 'audio/basic';
		case 'raw':
		default:
			return 'audio/x-raw';
	}
};

const resolveAudioFormat = (config: LMNTTTSOptions): AudioFormat => {
	const format = config.format ?? DEFAULT_FORMAT;
	const sampleRate = config.sampleRate ?? DEFAULT_SAMPLE_RATE;
	if (format === 'raw') {
		return {
			channels: 1,
			container: 'raw',
			encoding: 'pcm_s16le',
			sampleRateHz: sampleRate
		};
	}
	if (format === 'mulaw') {
		return {
			channels: 1,
			container: 'raw',
			encoding: 'mulaw',
			sampleRateHz: 8_000
		} as unknown as AudioFormat;
	}
	throw new Error(
		`Unsupported LMNT format "${String(format)}" for @absolutejs/voice TTS streaming. ` +
			`Use "raw" for PCM playback or "mulaw" for telephony.`
	);
};

const buildHeaders = (
	config: LMNTTTSOptions,
	format: LMNTAudioFormat
): Record<string, string> => ({
	Accept: resolveAcceptHeader(format),
	'Content-Type': 'application/json',
	'X-API-Key': config.apiKey
});

const resolveErrorMessage = (error: unknown): string => {
	if (typeof error === 'string' && error.trim()) return error;
	if (error instanceof Error && error.message.trim()) return error.message;
	return 'LMNT TTS request failed';
};

const buildRequestPayload = (
	config: LMNTTTSOptions,
	text: string
) =>
	omitUndefined({
		conversational: config.conversational,
		format: config.format ?? DEFAULT_FORMAT,
		language: config.language,
		model: config.model ?? DEFAULT_MODEL,
		sample_rate: config.sampleRate ?? DEFAULT_SAMPLE_RATE,
		seed: config.seed,
		speed: config.speed,
		temperature: config.temperature,
		text,
		top_p: config.topP,
		voice: config.voice
	});

export const lmnt = (config: LMNTTTSOptions): TTSAdapter => {
	if (!config.apiKey) {
		throw new Error('@absolutejs/voice-lmnt requires an apiKey.');
	}
	if (!config.voice) {
		throw new Error('@absolutejs/voice-lmnt requires a voice id.');
	}
	const fetchImpl = config.fetch ?? globalThis.fetch;
	const format = config.format ?? DEFAULT_FORMAT;
	const audioFormatDescriptor = resolveAudioFormat(config);

	return {
		kind: 'tts',
		open: () => {
			const listeners = createListenerMap();
			const activeControllers = new Set<AbortController>();
			let closed = false;

			return {
				close: async (reason?: string) => {
					if (closed) return;
					closed = true;
					for (const controller of activeControllers) {
						controller.abort(reason);
					}
					await emit(listeners, 'close', {
						reason,
						recoverable: false,
						type: 'close'
					});
				},
				cancel: async (reason?: string) => {
					if (closed) return;
					for (const controller of activeControllers) {
						controller.abort(reason ?? "cancelled");
					}
					activeControllers.clear();
				},
				on: (event, handler) => {
					listeners[event].add(handler as never);
					return () => {
						listeners[event].delete(handler as never);
					};
				},
				send: async (text: string) => {
					if (closed) return;
					const trimmed = text.trim();
					if (!trimmed) return;
					const controller = new AbortController();
					activeControllers.add(controller);

					try {
						const target = resolveStreamUrl(config);
						const response = await fetchImpl(target, {
							...h2IfHttps(target),
							body: JSON.stringify(
								buildRequestPayload(config, trimmed)
							),
							headers: buildHeaders(config, format),
							method: 'POST',
							signal: controller.signal
						});

						if (!response.ok || !response.body) {
							const bodyText = await response
								.text()
								.catch(() => '');
							throw new Error(
								`LMNT returned ${String(response.status)} ${response.statusText}${
									bodyText ? `: ${bodyText.slice(0, 200)}` : ''
								}`
							);
						}

						const reader = response.body.getReader();
						try {
							while (true) {
								const { done, value } = await reader.read();
								if (done || !value) break;
								await emit(listeners, 'audio', {
									chunk: value,
									format: audioFormatDescriptor,
									receivedAt: Date.now(),
									type: 'audio'
								});
							}
						} finally {
							reader.releaseLock();
						}
					} catch (error) {
						if ((error as Error).name === 'AbortError') return;
						await emit(listeners, 'error', {
							error:
								error instanceof Error
									? error
									: new Error(resolveErrorMessage(error)),
							recoverable: false,
							type: 'error'
						});
					} finally {
						activeControllers.delete(controller);
					}
				}
			};
		}
	};
};

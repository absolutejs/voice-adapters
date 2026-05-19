import type {
	AudioFormat,
	TTSAdapter,
	TTSSessionEventMap
} from '@absolutejs/voice';
import type {
	PlayHTOutputFormat,
	PlayHTSampleRate,
	PlayHTTTSOptions
} from './types';

type ListenerMap = {
	[K in keyof TTSSessionEventMap]: Set<
		(payload: TTSSessionEventMap[K]) => void | Promise<void>
	>;
};

const DEFAULT_BASE_URL = 'https://api.play.ht';
const DEFAULT_ENDPOINT_PATH = '/api/v2/tts/stream';
const DEFAULT_VOICE_ENGINE: PlayHTOutputFormat = 'Play3.0-mini';
const DEFAULT_OUTPUT_FORMAT: PlayHTOutputFormat = 'raw';
const DEFAULT_SAMPLE_RATE: PlayHTSampleRate = 24_000;

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

const resolveBaseUrl = (config: PlayHTTTSOptions): string =>
	(config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');

const resolveStreamUrl = (config: PlayHTTTSOptions): URL =>
	new URL(`${resolveBaseUrl(config)}${DEFAULT_ENDPOINT_PATH}`);

const resolveAcceptHeader = (
	outputFormat: PlayHTOutputFormat
): string => {
	switch (outputFormat) {
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

const resolveAudioFormat = (
	config: PlayHTTTSOptions
): AudioFormat => {
	const outputFormat = config.outputFormat ?? DEFAULT_OUTPUT_FORMAT;
	const sampleRate = config.sampleRate ?? DEFAULT_SAMPLE_RATE;
	if (outputFormat === 'raw') {
		return {
			channels: 1,
			container: 'raw',
			encoding: 'pcm_s16le',
			sampleRateHz: sampleRate
		};
	}
	if (outputFormat === 'mulaw') {
		return {
			channels: 1,
			container: 'raw',
			encoding: 'mulaw',
			sampleRateHz: 8_000
		} as unknown as AudioFormat;
	}
	throw new Error(
		`Unsupported PlayHT output format "${String(outputFormat)}" for @absolutejs/voice TTS streaming. ` +
			`Use "raw" for PCM playback or "mulaw" for telephony.`
	);
};

const buildHeaders = (
	config: PlayHTTTSOptions,
	outputFormat: PlayHTOutputFormat
): Record<string, string> => ({
	Accept: resolveAcceptHeader(outputFormat),
	Authorization: `Bearer ${config.apiKey}`,
	'Content-Type': 'application/json',
	'X-USER-ID': config.userId
});

const resolveErrorMessage = (error: unknown): string => {
	if (typeof error === 'string' && error.trim()) return error;
	if (error instanceof Error && error.message.trim()) return error.message;
	return 'PlayHT TTS request failed';
};

const buildRequestPayload = (
	config: PlayHTTTSOptions,
	text: string
) =>
	omitUndefined({
		language: config.language,
		output_format: config.outputFormat ?? DEFAULT_OUTPUT_FORMAT,
		quality: config.quality,
		sample_rate: config.sampleRate ?? DEFAULT_SAMPLE_RATE,
		speed: config.speed,
		temperature: config.temperature,
		text,
		voice: config.voice,
		voice_engine: config.voiceEngine ?? DEFAULT_VOICE_ENGINE,
		voice_guidance: config.voiceGuidance
	});

export const playht = (config: PlayHTTTSOptions): TTSAdapter => {
	if (!config.apiKey) {
		throw new Error('@absolutejs/voice-playht requires an apiKey.');
	}
	if (!config.userId) {
		throw new Error('@absolutejs/voice-playht requires a userId.');
	}
	if (!config.voice) {
		throw new Error('@absolutejs/voice-playht requires a voice id.');
	}
	const fetchImpl = config.fetch ?? globalThis.fetch;
	const outputFormat = config.outputFormat ?? DEFAULT_OUTPUT_FORMAT;
	const audioFormat = resolveAudioFormat(config);

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
							headers: buildHeaders(config, outputFormat),
							method: 'POST',
							signal: controller.signal
						});

						if (!response.ok || !response.body) {
							const bodyText = await response
								.text()
								.catch(() => '');
							throw new Error(
								`PlayHT returned ${String(response.status)} ${response.statusText}${
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
									format: audioFormat,
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

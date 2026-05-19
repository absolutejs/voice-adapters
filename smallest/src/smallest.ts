import type {
	AudioFormat,
	TTSAdapter,
	TTSSessionEventMap
} from '@absolutejs/voice';
import type {
	SmallestSampleRate,
	SmallestTTSOptions
} from './types';

type ListenerMap = {
	[K in keyof TTSSessionEventMap]: Set<
		(payload: TTSSessionEventMap[K]) => void | Promise<void>
	>;
};

const DEFAULT_BASE_URL = 'https://waves-api.smallest.ai';
const DEFAULT_ENDPOINT_BUILDER = (model: string) =>
	`/api/v1/${model}/get_speech`;
const DEFAULT_MODEL: SmallestTTSOptions['model'] = 'lightning';
const DEFAULT_SAMPLE_RATE: SmallestSampleRate = 24_000;

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

const resolveBaseUrl = (config: SmallestTTSOptions): string =>
	(config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');

const resolveStreamUrl = (config: SmallestTTSOptions): URL => {
	const model = config.model ?? DEFAULT_MODEL;
	return new URL(
		`${resolveBaseUrl(config)}${DEFAULT_ENDPOINT_BUILDER(model)}`
	);
};

const resolveAudioFormat = (config: SmallestTTSOptions): AudioFormat => ({
	channels: 1,
	container: 'raw',
	encoding: 'pcm_s16le',
	sampleRateHz: config.sampleRate ?? DEFAULT_SAMPLE_RATE
});

const buildHeaders = (config: SmallestTTSOptions): Record<string, string> => ({
	Accept: 'audio/pcm',
	Authorization: `Bearer ${config.apiKey}`,
	'Content-Type': 'application/json'
});

const resolveErrorMessage = (error: unknown): string => {
	if (typeof error === 'string' && error.trim()) return error;
	if (error instanceof Error && error.message.trim()) return error.message;
	return 'Smallest TTS request failed';
};

const buildRequestPayload = (
	config: SmallestTTSOptions,
	text: string
) =>
	omitUndefined({
		add_wav_header: false,
		consistency: config.consistency,
		enhancement: config.enhancement,
		language: config.language,
		sample_rate: config.sampleRate ?? DEFAULT_SAMPLE_RATE,
		similarity: config.similarity,
		speed: config.speed,
		text,
		voice_id: config.voiceId
	});

export const smallest = (config: SmallestTTSOptions): TTSAdapter => {
	if (!config.apiKey) {
		throw new Error('@absolutejs/voice-smallest requires an apiKey.');
	}
	if (!config.voiceId) {
		throw new Error('@absolutejs/voice-smallest requires a voiceId.');
	}
	const fetchImpl = config.fetch ?? globalThis.fetch;
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
							headers: buildHeaders(config),
							method: 'POST',
							signal: controller.signal
						});

						if (!response.ok || !response.body) {
							const bodyText = await response
								.text()
								.catch(() => '');
							throw new Error(
								`Smallest returned ${String(response.status)} ${response.statusText}${
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

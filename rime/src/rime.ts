import type {
	AudioFormat,
	TTSAdapter,
	TTSSessionEventMap
} from '@absolutejs/voice';
import type {
	RimeAudioFormat,
	RimeSampleRate,
	RimeTTSOptions
} from './types';

type ListenerMap = {
	[K in keyof TTSSessionEventMap]: Set<
		(payload: TTSSessionEventMap[K]) => void | Promise<void>
	>;
};

const DEFAULT_BASE_URL = 'https://users.rime.ai';
const DEFAULT_ENDPOINT_PATH = '/v1/rime-tts';
const DEFAULT_MODEL: RimeTTSOptions['modelId'] = 'mistv2';
const DEFAULT_AUDIO_FORMAT: RimeAudioFormat = 'pcm';
const DEFAULT_SAMPLE_RATE: RimeSampleRate = 22_050;

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

const resolveBaseUrl = (config: RimeTTSOptions): string =>
	(config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');

const resolveStreamUrl = (config: RimeTTSOptions): URL =>
	new URL(`${resolveBaseUrl(config)}${DEFAULT_ENDPOINT_PATH}`);

const resolveAcceptHeader = (
	audioFormat: RimeAudioFormat
): string => {
	switch (audioFormat) {
		case 'mulaw':
			return 'audio/basic';
		case 'pcm':
		default:
			return 'audio/pcm';
	}
};

const resolveAudioFormat = (config: RimeTTSOptions): AudioFormat => {
	const audioFormat = config.audioFormat ?? DEFAULT_AUDIO_FORMAT;
	const sampleRate = config.sampleRate ?? DEFAULT_SAMPLE_RATE;
	if (audioFormat === 'pcm') {
		return {
			channels: 1,
			container: 'raw',
			encoding: 'pcm_s16le',
			sampleRateHz: sampleRate
		};
	}
	if (audioFormat === 'mulaw') {
		return {
			channels: 1,
			container: 'raw',
			encoding: 'mulaw',
			sampleRateHz: 8_000
		} as unknown as AudioFormat;
	}
	throw new Error(
		`Unsupported Rime audio format "${String(audioFormat)}" for @absolutejs/voice TTS streaming. ` +
			`Use "pcm" for PCM playback or "mulaw" for telephony.`
	);
};

const buildHeaders = (
	config: RimeTTSOptions,
	audioFormat: RimeAudioFormat
): Record<string, string> => ({
	Accept: resolveAcceptHeader(audioFormat),
	Authorization: `Bearer ${config.apiKey}`,
	'Content-Type': 'application/json'
});

const resolveErrorMessage = (error: unknown): string => {
	if (typeof error === 'string' && error.trim()) return error;
	if (error instanceof Error && error.message.trim()) return error.message;
	return 'Rime TTS request failed';
};

const buildRequestPayload = (
	config: RimeTTSOptions,
	text: string
) =>
	omitUndefined({
		audioFormat: config.audioFormat ?? DEFAULT_AUDIO_FORMAT,
		inlineSpeedAlpha: config.inlineSpeedAlpha,
		lang: config.lang,
		modelId: config.modelId ?? DEFAULT_MODEL,
		noTextNormalization: config.noTextNormalization,
		pauseBetweenBrackets: config.pauseBetweenBrackets,
		phonemizeBetweenBrackets: config.phonemizeBetweenBrackets,
		reduceLatency: config.reduceLatency,
		samplingRate: config.sampleRate ?? DEFAULT_SAMPLE_RATE,
		speaker: config.speaker,
		speedAlpha: config.speedAlpha,
		text
	});

export const rime = (config: RimeTTSOptions): TTSAdapter => {
	if (!config.apiKey) {
		throw new Error('@absolutejs/voice-rime requires an apiKey.');
	}
	if (!config.speaker) {
		throw new Error(
			'@absolutejs/voice-rime requires a speaker (e.g. "cove", "marsh", "river").'
		);
	}
	const fetchImpl = config.fetch ?? globalThis.fetch;
	const audioFormat = config.audioFormat ?? DEFAULT_AUDIO_FORMAT;
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
							headers: buildHeaders(config, audioFormat),
							method: 'POST',
							signal: controller.signal
						});

						if (!response.ok || !response.body) {
							const bodyText = await response
								.text()
								.catch(() => '');
							throw new Error(
								`Rime returned ${String(response.status)} ${response.statusText}${
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

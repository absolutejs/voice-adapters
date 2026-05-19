import type {
	AudioFormat,
	TTSAdapter,
	TTSSessionEventMap
} from '@absolutejs/voice';
import type {
	AzureTTSOptions,
	AzureTTSOutputFormat
} from './types';

type ListenerMap = {
	[K in keyof TTSSessionEventMap]: Set<
		(payload: TTSSessionEventMap[K]) => void | Promise<void>
	>;
};

const DEFAULT_OUTPUT_FORMAT: AzureTTSOutputFormat =
	'raw-24khz-16bit-mono-pcm';
const DEFAULT_LANGUAGE = 'en-US';
const DEFAULT_USER_AGENT = '@absolutejs/voice-azure';
const DEFAULT_ENDPOINT_PATH = '/cognitiveservices/v1';

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

const resolveErrorMessage = (error: unknown): string => {
	if (typeof error === 'string' && error.trim()) return error;
	if (error instanceof Error && error.message.trim()) return error.message;
	return 'Azure TTS request failed';
};

const escapeXml = (value: string) =>
	value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&apos;');

const escapeAttr = (value: string) => escapeXml(value);

const parseSampleRate = (
	format: AzureTTSOutputFormat
): number => {
	const match = format.match(/(?:audio|raw)-(\d+)(?:khz|hz)/i);
	if (!match) return 24_000;
	const value = Number(match[1]);
	if (!Number.isFinite(value)) return 24_000;
	return format.toLowerCase().includes('hz') &&
		!format.toLowerCase().includes('khz')
		? value
		: value * 1_000;
};

const resolveRawSampleRate = (
	format: AzureTTSOutputFormat
): number => {
	// Azure raw formats encode sample rate as either Nkhz or Nhz tokens.
	const lower = format.toLowerCase();
	if (lower.startsWith('raw-')) {
		const segment = lower.split('-')[1] ?? '';
		if (segment.endsWith('khz')) {
			const value = Number(segment.slice(0, -3));
			return Number.isFinite(value) ? value * 1_000 : 24_000;
		}
		if (segment.endsWith('hz')) {
			const value = Number(segment.slice(0, -2));
			return Number.isFinite(value) ? value : 24_000;
		}
	}
	return parseSampleRate(format);
};

const resolveAudioFormat = (
	format: AzureTTSOutputFormat
): AudioFormat => {
	const lower = format.toLowerCase();
	if (!lower.startsWith('raw-')) {
		throw new Error(
			`Unsupported Azure output format "${format}" for @absolutejs/voice TTS streaming. ` +
				`Use a "raw-*" format such as raw-24khz-16bit-mono-pcm or raw-8khz-8bit-mono-mulaw.`
		);
	}

	const sampleRateHz = resolveRawSampleRate(format);
	if (lower.endsWith('-mulaw')) {
		return {
			channels: 1,
			container: 'raw',
			encoding: 'mulaw',
			sampleRateHz
		} as unknown as AudioFormat;
	}
	if (lower.endsWith('-alaw')) {
		return {
			channels: 1,
			container: 'raw',
			encoding: 'alaw',
			sampleRateHz
		} as unknown as AudioFormat;
	}
	if (lower.includes('-16bit-') && lower.endsWith('-pcm')) {
		return {
			channels: 1,
			container: 'raw',
			encoding: 'pcm_s16le',
			sampleRateHz
		};
	}
	if (lower.includes('-8bit-') && lower.endsWith('-pcm')) {
		return {
			channels: 1,
			container: 'raw',
			encoding: 'pcm_s8',
			sampleRateHz
		} as unknown as AudioFormat;
	}
	throw new Error(
		`Unrecognized Azure raw format "${format}". Expected -pcm/-mulaw/-alaw suffix.`
	);
};

const resolveBaseUrl = (config: AzureTTSOptions): string => {
	if (config.baseUrl) return config.baseUrl.replace(/\/$/, '');
	if (!config.region) {
		throw new Error(
			'@absolutejs/voice-azure requires either baseUrl or region (e.g. "eastus").'
		);
	}
	return `https://${config.region}.tts.speech.microsoft.com`;
};

const resolveEndpointPath = (config: AzureTTSOptions): string => {
	const path = config.endpointPath ?? DEFAULT_ENDPOINT_PATH;
	return path.startsWith('/') ? path : `/${path}`;
};

const buildHeaders = (
	config: AzureTTSOptions,
	outputFormat: AzureTTSOutputFormat
): Record<string, string> => {
	const headers: Record<string, string> = {
		'Content-Type': 'application/ssml+xml',
		'User-Agent': config.userAgent ?? DEFAULT_USER_AGENT,
		'X-Microsoft-OutputFormat': outputFormat
	};
	if ('token' in config && config.token) {
		headers['Authorization'] = `Bearer ${config.token}`;
	} else if ('subscriptionKey' in config && config.subscriptionKey) {
		headers['Ocp-Apim-Subscription-Key'] = config.subscriptionKey;
	}
	return headers;
};

const buildProsodyAttributes = (
	prosody: AzureTTSOptions['prosody']
): string => {
	if (!prosody) return '';
	const parts: string[] = [];
	if (prosody.rate) parts.push(`rate="${escapeAttr(prosody.rate)}"`);
	if (prosody.pitch) parts.push(`pitch="${escapeAttr(prosody.pitch)}"`);
	if (prosody.volume) parts.push(`volume="${escapeAttr(prosody.volume)}"`);
	return parts.length === 0 ? '' : ` ${parts.join(' ')}`;
};

const buildSsmlPayload = (
	config: AzureTTSOptions,
	text: string
): string => {
	const language = config.language ?? DEFAULT_LANGUAGE;
	const escapedText = escapeXml(text);
	const styleDegreeAttribute =
		config.voiceStyle && typeof config.styleDegree === 'number'
			? ` styledegree="${String(config.styleDegree)}"`
			: '';
	const styledInner = config.voiceStyle
		? `<mstts:express-as style="${escapeAttr(config.voiceStyle)}"${styleDegreeAttribute}>${escapedText}</mstts:express-as>`
		: escapedText;
	const prosodyAttributes = buildProsodyAttributes(config.prosody);
	const innerWithProsody = prosodyAttributes
		? `<prosody${prosodyAttributes}>${styledInner}</prosody>`
		: styledInner;
	const mstssNs = config.voiceStyle
		? ` xmlns:mstts="http://www.w3.org/2001/mstts"`
		: '';
	return (
		`<speak version="1.0" xml:lang="${escapeAttr(language)}"${mstssNs}>` +
		`<voice name="${escapeAttr(config.voice)}">${innerWithProsody}</voice></speak>`
	);
};

const buildTtsUrl = (config: AzureTTSOptions): URL =>
	new URL(`${resolveBaseUrl(config)}${resolveEndpointPath(config)}`);

export const azureTTS = (config: AzureTTSOptions): TTSAdapter => {
	if (
		!('subscriptionKey' in config && config.subscriptionKey) &&
		!('token' in config && config.token)
	) {
		throw new Error(
			'@absolutejs/voice-azure requires either subscriptionKey or token for authentication.'
		);
	}
	if (!config.voice) {
		throw new Error(
			'@absolutejs/voice-azure requires a voice name (e.g. "en-US-JennyNeural").'
		);
	}
	// Resolve base URL eagerly to fail-fast on misconfiguration.
	resolveBaseUrl(config);
	const fetchImpl = config.fetch ?? globalThis.fetch;
	const outputFormat = config.outputFormat ?? DEFAULT_OUTPUT_FORMAT;
	const audioFormat = resolveAudioFormat(outputFormat);

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
						const target = buildTtsUrl(config);
						const response = await fetchImpl(target, {
							...h2IfHttps(target),
							body: buildSsmlPayload(config, trimmed),
							headers: buildHeaders(config, outputFormat),
							method: 'POST',
							signal: controller.signal
						});

						if (!response.ok || !response.body) {
							const bodyText = await response
								.text()
								.catch(() => '');
							throw new Error(
								`Azure TTS returned ${String(response.status)} ${response.statusText}${
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

import { randomUUID } from 'node:crypto';
import type {
	STTAdapter,
	STTAdapterSession,
	STTSessionEventMap
} from '@absolutejs/voice';
import type { AzureSTTOptions } from './types';

type ListenerMap = {
	[K in keyof STTSessionEventMap]: Set<
		(payload: STTSessionEventMap[K]) => void | Promise<void>
	>;
};

const DEFAULT_LANGUAGE = 'en-US';
const DEFAULT_FORMAT = 'detailed';
const DEFAULT_RECOGNITION_MODE = 'conversation';
const DEFAULT_CONNECT_TIMEOUT_MS = 8_000;
const DEFAULT_SYSTEM_NAME = '@absolutejs/voice-azure';
const DEFAULT_SYSTEM_VERSION = '0.0.1';

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

const generateRequestId = () => randomUUID().replace(/-/g, '');

const resolveBaseUrl = (config: AzureSTTOptions): string => {
	if (config.baseUrl) return config.baseUrl.replace(/\/$/, '');
	if (!config.region) {
		throw new Error(
			'@absolutejs/voice-azure STT requires either baseUrl or region (e.g. "eastus").'
		);
	}
	return `wss://${config.region}.stt.speech.microsoft.com`;
};

const resolveEndpointPath = (config: AzureSTTOptions): string => {
	if (config.endpointPath) {
		return config.endpointPath.startsWith('/')
			? config.endpointPath
			: `/${config.endpointPath}`;
	}
	const mode = config.recognitionMode ?? DEFAULT_RECOGNITION_MODE;
	return `/speech/recognition/${mode}/cognitiveservices/v1`;
};

const buildAuthHeaders = (
	config: AzureSTTOptions,
	connectionId: string
): Record<string, string> => {
	const headers: Record<string, string> = {
		'X-ConnectionId': connectionId
	};
	if ('token' in config && config.token) {
		headers['Authorization'] = `Bearer ${config.token}`;
	} else if ('subscriptionKey' in config && config.subscriptionKey) {
		headers['Ocp-Apim-Subscription-Key'] = config.subscriptionKey;
	}
	return headers;
};

const buildHeaderBlock = (entries: Record<string, string>): string =>
	Object.entries(entries)
		.map(([key, value]) => `${key}: ${value}`)
		.join('\r\n');

const buildTextMessage = (
	path: string,
	contentType: string,
	body: string,
	requestId: string
): string => {
	const header = buildHeaderBlock({
		'Content-Type': contentType,
		Path: path,
		'X-RequestId': requestId,
		'X-Timestamp': new Date().toISOString()
	});
	return `${header}\r\n\r\n${body}`;
};

const buildBinaryMessage = (
	path: string,
	contentType: string,
	audio: Uint8Array,
	requestId: string
): Uint8Array => {
	const header = buildHeaderBlock({
		'Content-Type': contentType,
		Path: path,
		'X-RequestId': requestId,
		'X-Timestamp': new Date().toISOString()
	});
	const headerBytes = new TextEncoder().encode(header);
	const out = new Uint8Array(2 + headerBytes.length + audio.byteLength);
	new DataView(out.buffer).setUint16(0, headerBytes.length, false);
	out.set(headerBytes, 2);
	out.set(audio, 2 + headerBytes.length);
	return out;
};

const parseTextMessage = (
	raw: string
): { body: string; headers: Record<string, string> } | undefined => {
	const split = raw.indexOf('\r\n\r\n');
	if (split === -1) return undefined;
	const headerText = raw.slice(0, split);
	const body = raw.slice(split + 4);
	const headers: Record<string, string> = {};
	for (const line of headerText.split('\r\n')) {
		const colon = line.indexOf(':');
		if (colon === -1) continue;
		headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
	}
	return { body, headers };
};

const buildRiffHeader = (
	sampleRate: number,
	channels: number,
	bitsPerSample: number
): Uint8Array => {
	const buffer = new ArrayBuffer(44);
	const view = new DataView(buffer);
	const writeAscii = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i += 1) {
			view.setUint8(offset + i, text.charCodeAt(i));
		}
	};
	const byteRate = (sampleRate * channels * bitsPerSample) / 8;
	const blockAlign = (channels * bitsPerSample) / 8;
	writeAscii(0, 'RIFF');
	view.setUint32(4, 0xffffffff, true);
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
	view.setUint32(40, 0xffffffff, true);
	return new Uint8Array(buffer);
};

const buildSpeechConfigBody = (config: AzureSTTOptions): string =>
	JSON.stringify({
		context: {
			system: {
				name: config.systemName ?? DEFAULT_SYSTEM_NAME,
				version: config.systemVersion ?? DEFAULT_SYSTEM_VERSION
			}
		}
	});

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

export const azureSTT = (config: AzureSTTOptions): STTAdapter => {
	if (
		!('subscriptionKey' in config && config.subscriptionKey) &&
		!('token' in config && config.token)
	) {
		throw new Error(
			'@absolutejs/voice-azure STT requires either subscriptionKey or token for authentication.'
		);
	}
	// Resolve base URL eagerly to fail-fast on misconfiguration.
	resolveBaseUrl(config);

	return {
		kind: 'stt',
		open: async (openOptions) => {
			const listeners = createListenerMap();
			const resolveLanguage = (): string => {
				const strategy = openOptions.languageStrategy;
				if (strategy) {
					if (strategy.mode === 'fixed') return strategy.primaryLanguage;
					if (strategy.mode === 'allow-switching' && strategy.primaryLanguage) {
						return strategy.primaryLanguage;
					}
					if (strategy.mode === 'auto-detect' && strategy.allowedLanguages?.[0]) {
						return strategy.allowedLanguages[0];
					}
				}
				return config.language ?? DEFAULT_LANGUAGE;
			};
			const language = resolveLanguage();
			const format = config.format ?? DEFAULT_FORMAT;
			const connectionId = generateRequestId();
			const turnRequestId = generateRequestId();

			const baseUrl = resolveBaseUrl(config);
			const endpointPath = resolveEndpointPath(config);
			const url = new URL(`${baseUrl}${endpointPath}`);
			url.searchParams.set('language', language);
			url.searchParams.set('format', format);
			if (config.profanity) {
				url.searchParams.set('profanity', config.profanity);
			}

			const headers = buildAuthHeaders(config, connectionId);
			const socketFactory =
				config.webSocket?.factory ??
				((target: string, hdrs: Record<string, string>) =>
					new WebSocket(target, {
						headers: hdrs
					} as unknown as string[]));
			const socket = socketFactory(url.toString(), headers);

			const sampleRateHz = openOptions.format.sampleRateHz ?? 16_000;
			const channels = openOptions.format.channels ?? 1;
			const riffHeader = buildRiffHeader(sampleRateHz, channels, 16);

			let opened = false;
			let closed = false;
			let firstAudioSent = false;
			const pendingAudio: Uint8Array[] = [];
			const connectTimeoutMs =
				config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

			const sendBinary = (path: string, audio: Uint8Array) => {
				const framed = buildBinaryMessage(
					path,
					'audio/x-wav',
					audio,
					turnRequestId
				);
				socket.send(framed);
			};

			const flushPendingAudio = () => {
				if (pendingAudio.length === 0) return;
				const queued = pendingAudio.splice(0, pendingAudio.length);
				if (!firstAudioSent) {
					firstAudioSent = true;
					const head = queued.shift();
					if (head) {
						const merged = new Uint8Array(
							riffHeader.byteLength + head.byteLength
						);
						merged.set(riffHeader, 0);
						merged.set(head, riffHeader.byteLength);
						sendBinary('audio', merged);
					}
				}
				for (const chunk of queued) {
					sendBinary('audio', chunk);
				}
			};

			const openPromise = new Promise<void>((resolve, reject) => {
				const openTimeout = setTimeout(() => {
					if (opened) return;
					reject(
						new Error(
							`Azure STT websocket open timeout after ${String(connectTimeoutMs)}ms`
						)
					);
					try {
						socket.close(1013, 'open-timeout');
					} catch {}
				}, connectTimeoutMs);

				socket.addEventListener(
					'open',
					() => {
						clearTimeout(openTimeout);
						opened = true;
						try {
							socket.send(
								buildTextMessage(
									'speech.config',
									'application/json; charset=utf-8',
									buildSpeechConfigBody(config),
									turnRequestId
								)
							);
							flushPendingAudio();
						} catch (error) {
							reject(
								error instanceof Error
									? error
									: new Error(String(error))
							);
							return;
						}
						resolve();
					},
					{ once: true }
				);

				socket.addEventListener(
					'error',
					() => {
						clearTimeout(openTimeout);
						if (!opened) {
							reject(
								new Error(
									'Azure STT websocket failed to open.'
								)
							);
						}
					},
					{ once: true }
				);
			});

			socket.addEventListener('message', (event) => {
				if (typeof event.data !== 'string') return;
				const parsed = parseTextMessage(event.data);
				if (!parsed) return;
				const path = parsed.headers['Path'];
				if (!path) return;
				const now = Date.now();
				try {
					if (path === 'speech.hypothesis') {
						const body = JSON.parse(parsed.body) as {
							Offset?: number;
							Duration?: number;
							Text?: string;
						};
						if (!body.Text) return;
						void emit(listeners, 'partial', {
							receivedAt: now,
							transcript: {
								id: `${turnRequestId}:partial:${String(body.Offset ?? now)}`,
								isFinal: false,
								language,
								text: body.Text,
								vendor: 'azure'
							},
							type: 'partial'
						});
						return;
					}
					if (path === 'speech.phrase') {
						const body = JSON.parse(parsed.body) as {
							DisplayText?: string;
							Duration?: number;
							NBest?: Array<{
								Confidence?: number;
								Display?: string;
							}>;
							Offset?: number;
							RecognitionStatus?: string;
						};
						if (
							body.RecognitionStatus !== 'Success' ||
							!body.DisplayText
						) {
							return;
						}
						const confidence =
							body.NBest?.[0]?.Confidence ?? undefined;
						void emit(listeners, 'final', {
							receivedAt: now,
							transcript: {
								confidence,
								id: `${turnRequestId}:final:${String(body.Offset ?? now)}`,
								isFinal: true,
								language,
								text: body.DisplayText,
								vendor: 'azure'
							},
							type: 'final'
						});
						return;
					}
					if (path === 'turn.end') {
						void emit(listeners, 'endOfTurn', {
							reason: 'vendor',
							receivedAt: now,
							type: 'endOfTurn'
						});
						return;
					}
				} catch (error) {
					void emit(listeners, 'error', {
						error:
							error instanceof Error
								? error
								: new Error(String(error)),
						recoverable: true,
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

			socket.addEventListener('error', () => {
				if (!opened) return; // openPromise already handles pre-open errors
				void emit(listeners, 'error', {
					error: new Error('Azure STT websocket transport failed.'),
					recoverable: false,
					type: 'error'
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
					if (!firstAudioSent) {
						firstAudioSent = true;
						const merged = new Uint8Array(
							riffHeader.byteLength + bytes.byteLength
						);
						merged.set(riffHeader, 0);
						merged.set(bytes, riffHeader.byteLength);
						sendBinary('audio', merged);
						return;
					}
					sendBinary('audio', bytes);
				}
			};

			return session;
		}
	};
};

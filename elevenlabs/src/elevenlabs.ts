import type {
	AudioFormat,
	TTSAdapter,
	TTSSessionEventMap
} from '@absolutejs/voice';
import type { ElevenLabsOutputFormat, ElevenLabsTTSOptions } from './types';

type ListenerMap = {
	[K in keyof TTSSessionEventMap]: Set<
		(payload: TTSSessionEventMap[K]) => void | Promise<void>
	>;
};

const STREAM_URL = 'https://api.elevenlabs.io/v1/text-to-speech';
const WEBSOCKET_URL = 'wss://api.elevenlabs.io/v1/text-to-speech';

// Opportunistic HTTP/2 multiplexing for outbound HTTPS calls (Bun 1.3.14+).
// The `protocol` option lands in @types/bun 1.3.14; widen locally for now.
type H2Init = RequestInit & { protocol?: 'http2' };
const isHttpsUrl = (url: string | URL) =>
	typeof url === 'string'
		? url.startsWith('https://')
		: url.protocol === 'https:';
const h2IfHttps = (url: string | URL): H2Init =>
	isHttpsUrl(url) ? { protocol: 'http2' } : {};

const DEFAULT_WEBSOCKET_KEEPALIVE_INTERVAL_MS = 15_000;
const DEFAULT_WEBSOCKET_FINAL_IDLE_TIMEOUT_MS = 350;
const DEFAULT_WEBSOCKET_GENERATION_TIMEOUT_MS = 20_000;

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
	if (typeof error === 'string' && error.trim()) {
		return error;
	}

	if (error instanceof Error && error.message.trim()) {
		return error.message;
	}

	if (error && typeof error === 'object') {
		const record = error as Record<string, unknown>;
		if ('error' in record) {
			return resolveErrorMessage(record.error);
		}
		if (record.detail && typeof record.detail === 'object') {
			const detailMessage = resolveErrorMessage(record.detail);
			if (detailMessage !== 'ElevenLabs TTS request failed') {
				return detailMessage;
			}
		}

		const parts = [
			record.code,
			record.status,
			record.message,
			record.reason,
			record.description,
			record.detail
		]
			.filter(
				(part): part is string =>
					typeof part === 'string' && part.trim().length > 0
			)
			.map((part) => part.trim());

		if (parts.length > 0) {
			return [...new Set(parts)].join(': ');
		}

		try {
			return JSON.stringify(error);
		} catch {}
	}

	return 'ElevenLabs TTS request failed';
};

const omitUndefined = (value: Record<string, unknown>) =>
	Object.fromEntries(
		Object.entries(value).filter(([, entry]) => entry !== undefined)
	);

const parseSampleRate = (outputFormat: ElevenLabsOutputFormat) => {
	if (outputFormat.startsWith('pcm_')) {
		return Number(outputFormat.split('_')[1] ?? 16000);
	}

	if (outputFormat.startsWith('ulaw_') || outputFormat.startsWith('alaw_')) {
		return 8000;
	}

	if (outputFormat.startsWith('mp3_')) {
		return Number(outputFormat.split('_')[1] ?? 44100);
	}

	return 16000;
};

const clampInactivityTimeout = (value: number | undefined) => {
	if (!Number.isFinite(value)) {
		return undefined;
	}

	return Math.max(1, Math.min(180, Math.round(value!)));
};

const resolveAudioFormat = (
	outputFormat: ElevenLabsOutputFormat
): AudioFormat => {
	if (outputFormat === 'ulaw_8000') {
		return {
			channels: 1,
			container: 'raw',
			encoding: 'mulaw',
			sampleRateHz: 8_000
		} as unknown as AudioFormat;
	}

	if (outputFormat === 'alaw_8000') {
		return {
			channels: 1,
			container: 'raw',
			encoding: 'alaw',
			sampleRateHz: 8_000
		} as unknown as AudioFormat;
	}

	if (!outputFormat.startsWith('pcm_')) {
		throw new Error(
			`Unsupported ElevenLabs output format "${outputFormat}" for @absolutejs/voice TTS. Use pcm_* for browser playback or ulaw_8000 for telephony.`
		);
	}

	return {
		channels: 1,
		container: 'raw',
		encoding: 'pcm_s16le',
		sampleRateHz: parseSampleRate(outputFormat)
	};
};

const buildHttpUrl = (config: ElevenLabsTTSOptions) => {
	const outputFormat = config.outputFormat ?? 'pcm_16000';
	const url = new URL(
		`${STREAM_URL}/${config.voiceId}/stream`
	);
	url.searchParams.set('output_format', outputFormat);

	if (config.enableLogging !== undefined) {
		url.searchParams.set('enable_logging', String(config.enableLogging));
	}

	if (config.optimizeStreamingLatency !== undefined) {
		url.searchParams.set(
			'optimize_streaming_latency',
			String(config.optimizeStreamingLatency)
		);
	}

	return url;
};

const buildWebSocketUrl = (config: ElevenLabsTTSOptions) => {
	const outputFormat = config.outputFormat ?? 'pcm_16000';
	const url = new URL(
		`${WEBSOCKET_URL}/${config.voiceId}/stream-input`
	);
	url.searchParams.set('output_format', outputFormat);

	if (config.enableLogging !== undefined) {
		url.searchParams.set('enable_logging', String(config.enableLogging));
	}

	if (config.optimizeStreamingLatency !== undefined) {
		url.searchParams.set(
			'optimize_streaming_latency',
			String(config.optimizeStreamingLatency)
		);
	}

	if (config.modelId) {
		url.searchParams.set('model_id', config.modelId);
	}

	if (config.languageCode) {
		url.searchParams.set('language_code', config.languageCode);
	}

	if (config.seed !== undefined) {
		url.searchParams.set('seed', String(config.seed));
	}

	const inactivityTimeout = clampInactivityTimeout(
		config.websocket?.inactivityTimeoutSec
	);
	if (inactivityTimeout !== undefined) {
		url.searchParams.set(
			'inactivity_timeout',
			String(inactivityTimeout)
		);
	}

	if (config.websocket?.autoMode !== undefined) {
		url.searchParams.set('auto_mode', String(config.websocket.autoMode));
	}

	if (config.websocket?.syncAlignment !== undefined) {
		url.searchParams.set(
			'sync_alignment',
			String(config.websocket.syncAlignment)
		);
	}

	if (config.websocket?.enableSsmlParsing !== undefined) {
		url.searchParams.set(
			'enable_ssml_parsing',
			String(config.websocket.enableSsmlParsing)
		);
	}

	if (config.websocket?.applyTextNormalization) {
		url.searchParams.set(
			'apply_text_normalization',
			config.websocket.applyTextNormalization
		);
	}

	return url;
};

const decodeBase64Audio = (value: string) =>
	new Uint8Array(Buffer.from(value, 'base64'));

const withTrailingWhitespace = (value: string) =>
	/\s$/u.test(value) ? value : `${value} `;

const resolveVoiceSettings = (config: ElevenLabsTTSOptions) =>
	config.voiceSettings
		? omitUndefined({
				similarity_boost: config.voiceSettings.similarityBoost,
				speed: config.voiceSettings.speed,
				stability: config.voiceSettings.stability,
				style: config.voiceSettings.style,
				use_speaker_boost: config.voiceSettings.useSpeakerBoost
		  })
		: undefined;

const buildRequestPayload = (config: ElevenLabsTTSOptions, text: string) =>
	omitUndefined({
		language_code: config.languageCode,
		model_id: config.modelId ?? 'eleven_flash_v2_5',
		seed: config.seed,
		text,
		voice_settings: resolveVoiceSettings(config)
	});

export const elevenlabs = (
	config: ElevenLabsTTSOptions
): TTSAdapter => ({
	kind: 'tts',
	open: () => {
		const listeners = createListenerMap();
		const outputFormat = config.outputFormat ?? 'pcm_16000';
		const audioFormat = resolveAudioFormat(outputFormat);
		const activeControllers = new Set<AbortController>();
		let closed = false;

		if (config.transport === 'websocket') {
			type PendingGeneration = {
				audioReceived: boolean;
				idleTimer: ReturnType<typeof setTimeout> | null;
				reject: (error: Error) => void;
				resolve: () => void;
				timeoutTimer: ReturnType<typeof setTimeout> | null;
			};

			let socket: WebSocket | null = null;
			let ready = false;
			let readyResolve: (() => void) | null = null;
			let readyReject: ((error: Error) => void) | null = null;
			const readyPromise = new Promise<void>((resolve, reject) => {
				readyResolve = resolve;
				readyReject = reject;
			});
			let pendingGeneration: PendingGeneration | null = null;
			let sendQueue = Promise.resolve();
			let lastOutboundAt = Date.now();
			const keepAliveIntervalMs = Math.max(
				1_000,
				config.websocket?.keepAliveIntervalMs ??
					DEFAULT_WEBSOCKET_KEEPALIVE_INTERVAL_MS
			);
			const finalIdleTimeoutMs = Math.max(
				50,
				config.websocket?.finalIdleTimeoutMs ??
					DEFAULT_WEBSOCKET_FINAL_IDLE_TIMEOUT_MS
			);
			const generationTimeoutMs = Math.max(
				finalIdleTimeoutMs,
				config.websocket?.generationTimeoutMs ??
					DEFAULT_WEBSOCKET_GENERATION_TIMEOUT_MS
			);
			let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

			const closeSocket = (reason?: string) => {
				if (!socket) {
					return;
				}

				const currentSocket = socket;
				socket = null;
				try {
					currentSocket.close(1000, reason);
				} catch {}
			};

			const rejectPendingGeneration = (error: Error) => {
				if (!pendingGeneration) {
					return;
				}

				const { idleTimer, reject, timeoutTimer } = pendingGeneration;
				if (idleTimer) {
					clearTimeout(idleTimer);
				}
				if (timeoutTimer) {
					clearTimeout(timeoutTimer);
				}
				pendingGeneration = null;
				reject(error);
			};

			const resolvePendingGeneration = () => {
				if (!pendingGeneration) {
					return;
				}

				const { idleTimer, resolve, timeoutTimer } = pendingGeneration;
				if (idleTimer) {
					clearTimeout(idleTimer);
				}
				if (timeoutTimer) {
					clearTimeout(timeoutTimer);
				}
				pendingGeneration = null;
				resolve();
			};

			const schedulePendingGenerationIdleResolve = () => {
				if (!pendingGeneration) {
					return;
				}

				if (pendingGeneration.idleTimer) {
					clearTimeout(pendingGeneration.idleTimer);
				}

				pendingGeneration.idleTimer = setTimeout(() => {
					resolvePendingGeneration();
				}, finalIdleTimeoutMs);
			};

			const rejectReady = (error: Error) => {
				if (!ready) {
					readyReject?.(error);
					readyReject = null;
					readyResolve = null;
				}
			};

			const ws = new WebSocket(buildWebSocketUrl(config));
			socket = ws;

			const sendSocketMessage = (payload: Record<string, unknown>) => {
				if (!socket || socket.readyState !== WebSocket.OPEN) {
					throw new Error(
						'ElevenLabs WebSocket is not open for sending.'
					);
				}

				socket.send(JSON.stringify(payload));
				lastOutboundAt = Date.now();
			};

			const startKeepAlive = () => {
				if (keepAliveTimer) {
					clearInterval(keepAliveTimer);
				}

				keepAliveTimer = setInterval(() => {
					if (
						closed ||
						!socket ||
						socket.readyState !== WebSocket.OPEN ||
						pendingGeneration
					) {
						return;
					}

					if (
						Date.now() - lastOutboundAt <
						keepAliveIntervalMs
					) {
						return;
					}

					try {
						sendSocketMessage({ text: ' ' });
					} catch (error) {
						void emit(listeners, 'error', {
							error:
								error instanceof Error
									? error
									: new Error(resolveErrorMessage(error)),
							recoverable: false,
							type: 'error'
						});
					}
				}, keepAliveIntervalMs);
			};

			ws.addEventListener('open', () => {
				try {
					sendSocketMessage(
						omitUndefined({
							generation_config:
								config.websocket?.chunkLengthSchedule
									? {
											chunk_length_schedule:
												config.websocket.chunkLengthSchedule
									  }
									: undefined,
							text: ' ',
							voice_settings: resolveVoiceSettings(config),
							xi_api_key: config.apiKey
						})
					);
					ready = true;
					readyResolve?.();
					readyResolve = null;
					readyReject = null;
					startKeepAlive();
				} catch (error) {
					const message = new Error(resolveErrorMessage(error));
					rejectReady(message);
					rejectPendingGeneration(message);
					closeSocket(message.message);
				}
			});

			ws.addEventListener('message', (event) => {
				void (async () => {
					try {
						const raw =
							typeof event.data === 'string'
								? event.data
								: String(event.data);
						const message = JSON.parse(raw) as {
							audio?: string;
							error?: unknown;
							isFinal?: boolean;
						};

						if (message.audio) {
							if (pendingGeneration) {
								pendingGeneration.audioReceived = true;
								schedulePendingGenerationIdleResolve();
							}
							await emit(listeners, 'audio', {
								chunk: decodeBase64Audio(message.audio),
								format: audioFormat,
								receivedAt: Date.now(),
								type: 'audio'
							});
						}

						if (message.error) {
							const failure = new Error(
								resolveErrorMessage(message.error)
							);
							rejectPendingGeneration(failure);
							await emit(listeners, 'error', {
								error: failure,
								recoverable: false,
								type: 'error'
							});
							return;
						}

						if (message.isFinal) {
							resolvePendingGeneration();
						}
					} catch (error) {
						const failure =
							error instanceof Error
								? error
								: new Error(resolveErrorMessage(error));
						rejectPendingGeneration(failure);
						await emit(listeners, 'error', {
							error: failure,
							recoverable: false,
							type: 'error'
						});
					}
				})();
			});

			ws.addEventListener('error', () => {
				const failure = new Error(
					'ElevenLabs WebSocket transport failed.'
				);
				rejectReady(failure);
				rejectPendingGeneration(failure);
				void emit(listeners, 'error', {
					error: failure,
					recoverable: false,
					type: 'error'
				});
			});

			ws.addEventListener('close', (event) => {
				if (keepAliveTimer) {
					clearInterval(keepAliveTimer);
					keepAliveTimer = null;
				}

				const reason = event.reason?.trim() || undefined;
				const failure = reason
					? new Error(reason)
					: new Error(
							'ElevenLabs WebSocket closed before generation finished.'
					  );
				rejectReady(failure);
				rejectPendingGeneration(failure);
				void emit(listeners, 'close', {
					code: event.code,
					reason,
					recoverable: false,
					type: 'close'
				});
			});

			return {
				close: async (reason?: string) => {
					if (closed) {
						return;
					}

					closed = true;
					if (keepAliveTimer) {
						clearInterval(keepAliveTimer);
						keepAliveTimer = null;
					}

					try {
						await readyPromise.catch(() => undefined);
						if (socket?.readyState === WebSocket.OPEN) {
							sendSocketMessage({ text: '' });
						}
					} catch {}

					closeSocket(reason);
				},
				cancel: async (reason?: string) => {
					if (closed) {
						return;
					}

					rejectPendingGeneration(
						new Error(reason ?? 'cancelled')
					);

					try {
						if (socket?.readyState === WebSocket.OPEN) {
							sendSocketMessage({ text: '' });
						}
					} catch {}
				},
				on: (event, handler) => {
					listeners[event].add(handler as never);

					return () => {
						listeners[event].delete(handler as never);
					};
				},
				send: async (text: string) => {
					if (closed) {
						return;
					}

					const trimmed = text.trim();
					if (!trimmed) {
						return;
					}

					sendQueue = sendQueue.catch(() => undefined).then(async () => {
						await readyPromise;

						await new Promise<void>((resolve, reject) => {
							if (!socket || socket.readyState !== WebSocket.OPEN) {
								reject(
									new Error(
										'ElevenLabs WebSocket is not open for generation.'
									)
								);
								return;
							}

							pendingGeneration = {
								audioReceived: false,
								idleTimer: null,
								reject,
								resolve,
								timeoutTimer: setTimeout(() => {
									rejectPendingGeneration(
										new Error(
											'ElevenLabs WebSocket generation timed out before completion.'
										)
									);
								}, generationTimeoutMs)
							};

							try {
								sendSocketMessage({
									flush: true,
									text: withTrailingWhitespace(trimmed)
								});
							} catch (error) {
								pendingGeneration = null;
								reject(
									error instanceof Error
										? error
										: new Error(resolveErrorMessage(error))
								);
							}
						});
					});

					return sendQueue;
				}
			};
		}

		return {
			close: async (reason?: string) => {
				if (closed) {
					return;
				}

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
				if (closed) {
					return;
				}
				for (const controller of activeControllers) {
					controller.abort(reason ?? 'cancelled');
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
				if (closed) {
					return;
				}

				const trimmed = text.trim();
				if (!trimmed) {
					return;
				}

				const controller = new AbortController();
				activeControllers.add(controller);

				try {
					const target = buildHttpUrl(config);
					const response = await fetch(target, {
						...h2IfHttps(target),
						body: JSON.stringify(
							buildRequestPayload(config, trimmed)
						),
						headers: {
							'Content-Type': 'application/json',
							'xi-api-key': config.apiKey
						},
						method: 'POST',
						signal: controller.signal
					});

					if (!response.ok || !response.body) {
						throw new Error(
							`ElevenLabs returned ${response.status} ${response.statusText}`
						);
					}

					const reader = response.body.getReader();

					try {
						while (true) {
							const { done, value } = await reader.read();
							if (done || !value) {
								break;
							}

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
					if ((error as Error).name === 'AbortError') {
						return;
					}

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
});

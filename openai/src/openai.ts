import type {
	AudioChunk,
	AudioFormat,
	RealtimeAdapter,
	RealtimeAdapterOpenOptions,
	RealtimeSessionEventMap,
	Transcript
} from '@absolutejs/voice';
import type {
	OpenAIRealtimeAdapterOptions,
	OpenAIRealtimeVoice
} from './types';

type VoicePhraseHintCompat = {
	text: string;
	aliases?: string[];
};

type VoiceLexiconEntryCompat = {
	text: string;
	aliases?: string[];
	language?: string;
	pronunciation?: string;
};

type VoiceLanguageStrategyCompat =
	| {
			mode: 'auto-detect';
			allowedLanguages?: string[];
	  }
	| {
			mode: 'fixed';
			primaryLanguage: string;
			secondaryLanguages?: string[];
	  }
	| {
			mode: 'allow-switching';
			primaryLanguage?: string;
			secondaryLanguages: string[];
	  };

type OpenAIAdapterOpenOptions = RealtimeAdapterOpenOptions & {
	languageStrategy?: VoiceLanguageStrategyCompat;
	lexicon?: VoiceLexiconEntryCompat[];
	phraseHints?: VoicePhraseHintCompat[];
};

type ListenerMap = {
	[K in keyof RealtimeSessionEventMap]: Set<
		(payload: RealtimeSessionEventMap[K]) => void | Promise<void>
	>;
};

type OpenAIRealtimeError = {
	code?: string;
	event_id?: string;
	message?: string;
	param?: string;
	type?: string;
};

type OpenAIServerEvent = {
	type?: string;
	[key: string]: unknown;
};

type OpenAIClientEvent = {
	type: string;
	event_id?: string;
	[key: string]: unknown;
};

type OpenAITranscriptionLogprob = {
	bytes?: number[];
	logprob?: number;
	token?: string;
};

const REALTIME_URL = 'wss://api.openai.com/v1/realtime';
const OUTPUT_AUDIO_FORMAT: AudioFormat = {
	channels: 1,
	container: 'raw',
	encoding: 'pcm_s16le',
	sampleRateHz: 24000
};
const DEFAULT_AUTO_COMMIT_SILENCE_MS = 450;
const DEFAULT_MODEL = 'gpt-realtime-mini';
const DEFAULT_TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe';
const DEFAULT_VOICE: OpenAIRealtimeVoice = 'marin';

const createListenerMap = (): ListenerMap => ({
	close: new Set(),
	endOfTurn: new Set(),
	error: new Set(),
	final: new Set(),
	audio: new Set(),
	partial: new Set()
});

const emit = async <K extends keyof RealtimeSessionEventMap>(
	listeners: ListenerMap,
	event: K,
	payload: RealtimeSessionEventMap[K]
) => {
	for (const listener of listeners[event]) {
		await listener(payload);
	}
};

const omitUndefined = (value: Record<string, unknown>) =>
	Object.fromEntries(
		Object.entries(value).filter(([, entry]) => entry !== undefined)
	);

const resolveErrorMessage = (error: unknown): string => {
	if (typeof error === 'string' && error.trim()) {
		return error;
	}

	if (error instanceof Error && error.message.trim()) {
		return error.message;
	}

	if (error && typeof error === 'object') {
		const record = error as Record<string, unknown>;
		for (const key of ['message', 'reason', 'description', 'detail']) {
			const candidate = record[key];
			if (typeof candidate === 'string' && candidate.trim()) {
				return candidate;
			}
		}

		if ('error' in record) {
			return resolveErrorMessage(record.error);
		}

		try {
			return JSON.stringify(error);
		} catch {}
	}

	return 'OpenAI realtime error';
};

const toUint8Array = (value: AudioChunk) =>
	value instanceof ArrayBuffer
		? new Uint8Array(value)
		: new Uint8Array(value.buffer, value.byteOffset, value.byteLength);

const toBase64 = (value: AudioChunk) =>
	Buffer.from(toUint8Array(value)).toString('base64');

const resolveTextId = () => `openai-text-${crypto.randomUUID()}`;

const buildTextTranscript = (text: string): Transcript => ({
	id: resolveTextId(),
	isFinal: true,
	text,
	vendor: 'openai'
});

const buildAudioTranscript = (
	itemId: string,
	text: string,
	isFinal: boolean,
	logprobs: OpenAITranscriptionLogprob[] = []
): Transcript => {
	const tokens = logprobs.flatMap((entry) =>
		typeof entry.token === 'string' && typeof entry.logprob === 'number'
			? [{
					bytes: Array.isArray(entry.bytes) ? entry.bytes : undefined,
					confidence: Math.max(0, Math.min(1, Math.exp(entry.logprob))),
					logProbability: entry.logprob,
					text: entry.token
			  }]
			: []
	);
	const confidence = tokens.length > 0
		? tokens.reduce((sum, token) => sum + token.confidence, 0) / tokens.length
		: undefined;

	return {
		confidence,
		id: itemId,
		isFinal,
		text,
		tokens: tokens.length > 0 ? tokens : undefined,
		vendor: 'openai'
	};
};

const readTranscriptionLogprobs = (
	value: unknown
): OpenAITranscriptionLogprob[] =>
	Array.isArray(value)
		? value.filter((entry): entry is OpenAITranscriptionLogprob =>
				typeof entry === 'object' && entry !== null
		  )
		: [];

const resolveReadyError = (context: string) =>
	new Error(`OpenAI realtime session ${context} before it became ready`);

const resolveInputTranscriptionLanguage = (
	config: OpenAIRealtimeAdapterOptions,
	options: OpenAIAdapterOpenOptions
) => {
	if (
		typeof config.inputTranscriptionLanguage === 'string' &&
		config.inputTranscriptionLanguage.trim().length > 0
	) {
		return config.inputTranscriptionLanguage.trim();
	}

	if (options.languageStrategy?.mode !== 'fixed') {
		return undefined;
	}

	const language = options.languageStrategy.primaryLanguage.trim();
	return language.length > 0 ? language : undefined;
};

const assertRealtimePCMInput = (format: AudioFormat) => {
	if (
		format.container !== 'raw' ||
		format.encoding !== 'pcm_s16le' ||
		format.sampleRateHz !== 24000 ||
		format.channels !== 1
	) {
		throw new Error(
			'OpenAI Realtime audio input currently requires raw pcm_s16le at 24kHz mono.'
		);
	}
};

const buildPrimarySessionUpdate = (
	config: OpenAIRealtimeAdapterOptions,
	options: OpenAIAdapterOpenOptions
): OpenAIClientEvent => {
	const inputTranscriptionLanguage = resolveInputTranscriptionLanguage(
		config,
		options
	);
	const transcription =
		config.inputTranscriptionModel === null
			? null
			: omitUndefined({
					language: inputTranscriptionLanguage,
					model:
						config.inputTranscriptionModel ??
						DEFAULT_TRANSCRIPTION_MODEL,
					prompt: config.inputTranscriptionPrompt
			  });
	const responseMode = config.responseMode ?? 'audio';

	return {
		event_id: `session-update-primary-${crypto.randomUUID()}`,
			session: omitUndefined({
			include:
				config.inputTranscriptionModel !== null &&
				config.inputTranscriptionLogprobs !== false
					? ['item.input_audio_transcription.logprobs']
					: undefined,
			audio: {
				input: omitUndefined({
					format: {
						rate: 24000,
						type: 'audio/pcm'
					},
					noise_reduction: config.noiseReduction
						? { type: config.noiseReduction }
						: undefined,
					transcription,
					turn_detection: null
				}),
				output:
					responseMode === 'audio'
						? omitUndefined({
								format: {
									rate: 24000,
									type: 'audio/pcm'
								},
								speed: config.speed,
								voice: config.voice ?? DEFAULT_VOICE
						  })
						: undefined
			},
			instructions: config.instructions,
			max_output_tokens: config.maxOutputTokens,
			model: config.model ?? DEFAULT_MODEL,
			output_modalities: [responseMode],
			temperature: config.temperature,
			type: 'realtime'
		}),
		type: 'session.update'
	};
};

const buildResponseCreateEvent = (
	config: OpenAIRealtimeAdapterOptions
): OpenAIClientEvent => {
	const responseMode = config.responseMode ?? 'audio';

	return {
		response: omitUndefined({
			audio:
				responseMode === 'audio'
					? {
							output: omitUndefined({
								format: {
									rate: 24000,
									type: 'audio/pcm'
								},
								voice: config.voice ?? DEFAULT_VOICE
							})
					  }
					: undefined,
			conversation: 'auto',
			max_output_tokens: config.maxOutputTokens,
			output_modalities: [responseMode]
		}),
		type: 'response.create'
	};
};

const toTextTranscript = (text: string): Transcript => ({
	id: resolveTextId(),
	isFinal: true,
	text,
	vendor: 'openai'
});

const buildPhraseHintPrompt = (options: OpenAIAdapterOpenOptions) => {
	const terms = (options.phraseHints ?? []).flatMap((hint) => [
		hint.text,
		...(hint.aliases ?? [])
	]);
	const uniqueTerms = terms.filter(
		(value, index, list) => list.indexOf(value) === index
	);

	if (uniqueTerms.length === 0) {
		return undefined;
	}

	return `Prioritize accurate recovery of these phrases when heard: ${uniqueTerms.join(', ')}.`;
};

const buildLexiconPrompt = (options: OpenAIAdapterOpenOptions) => {
	const entries = (options.lexicon ?? []).flatMap((entry) => {
		const details = [
			entry.text,
			entry.pronunciation ? `pronounced ${entry.pronunciation}` : undefined,
			entry.aliases && entry.aliases.length > 0
				? `may also sound like ${entry.aliases.join(', ')}`
				: undefined,
			entry.language ? `language ${entry.language}` : undefined
		].filter((value): value is string => typeof value === 'string' && value.length > 0);

		return details.length > 0 ? [details.join(' - ')] : [];
	});

	if (entries.length === 0) {
		return undefined;
	}

	return `Use this pronunciation lexicon when transcribing: ${entries.join('; ')}.`;
};

const shouldEmitResponseTranscripts = (
	config: OpenAIRealtimeAdapterOptions
): boolean => {
	return config.emitResponseTranscripts === true;
};

export const openai = (
	config: OpenAIRealtimeAdapterOptions
): RealtimeAdapter => ({
	kind: 'realtime',
		open: (options) => {
			const runtimeOptions = options as OpenAIAdapterOpenOptions;
			const phraseHintPrompt = buildPhraseHintPrompt(runtimeOptions);
			const lexiconPrompt = buildLexiconPrompt(runtimeOptions);
			const runtimeConfig = phraseHintPrompt || lexiconPrompt
				? {
						...config,
						inputTranscriptionPrompt: [
							config.inputTranscriptionPrompt,
							phraseHintPrompt,
							lexiconPrompt
						]
							.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
							.join('\n\n')
				  }
				: config;
			const listeners = createListenerMap();
			const ws = new WebSocket(
				`${REALTIME_URL}?model=${encodeURIComponent(
					runtimeConfig.model ?? DEFAULT_MODEL
				)}`,
				{
					headers: {
						Authorization: `Bearer ${config.apiKey}`
					}
				} as never
			);
			const transcriptBuffers = new Map<string, string>();
			const transcriptLogprobs = new Map<string, OpenAITranscriptionLogprob[]>();
			const committedTranscripts = new Map<string, string>();
			const pendingMessages: Array<string | ArrayBufferView | ArrayBuffer> = [];
		const autoCommitSilenceMs =
			runtimeConfig.autoCommitSilenceMs ?? DEFAULT_AUTO_COMMIT_SILENCE_MS;
		const primaryUpdate = buildPrimarySessionUpdate(runtimeConfig, runtimeOptions);
		let ready = false;
		let socketOpen = false;
		let closed = false;
		let pendingAudioInput = false;
		let closeEmitted = false;
		let readyTimeout: ReturnType<typeof setTimeout> | undefined;
		let audioCommitTimer: ReturnType<typeof setTimeout> | undefined;

		let resolveReady!: () => void;
		let rejectReady!: (error: Error) => void;
		const readyPromise = new Promise<void>((resolve, reject) => {
			resolveReady = resolve;
			rejectReady = reject;
		});

		const clearReadyTimeout = () => {
			if (readyTimeout) {
				clearTimeout(readyTimeout);
				readyTimeout = undefined;
			}
		};

		const failReady = (error: Error) => {
			if (ready || closed) {
				return;
			}

			clearReadyTimeout();
			rejectReady(error);
		};

		const markReady = () => {
			if (ready || closed) {
				return;
			}

			ready = true;
			clearReadyTimeout();
			resolveReady();
		};

		const sendRaw = (payload: OpenAIClientEvent) => {
			const serialized = JSON.stringify(payload);
			if (!socketOpen) {
				pendingMessages.push(serialized);
				return;
			}

			ws.send(serialized);
		};

		const flushPendingMessages = () => {
			while (pendingMessages.length > 0) {
				const next = pendingMessages.shift();
				if (next) {
					ws.send(next);
				}
			}
		};

		const schedulePrimaryTimeout = () => {
			clearReadyTimeout();
			readyTimeout = setTimeout(() => {
				if (ready || closed) {
					return;
				}

				failReady(
					new Error(
						'OpenAI realtime session did not become ready.'
					)
				);
			}, 8_000);
		};

			const emitClose = async (
			code?: number,
			reason?: string,
			recoverable = false
		) => {
			if (closeEmitted) {
				return;
			}

			closeEmitted = true;
			await emit(listeners, 'close', {
				code,
				reason,
				recoverable,
				type: 'close'
			});
		};

			const commitBufferedAudio = async () => {
			if (closed || !pendingAudioInput) {
				return;
			}

			pendingAudioInput = false;
			sendRaw({
				type: 'input_audio_buffer.commit'
			});
			sendRaw(buildResponseCreateEvent(runtimeConfig));
		};

			const resetAudioCommitTimer = () => {
			if (audioCommitTimer) {
				clearTimeout(audioCommitTimer);
			}

			audioCommitTimer = setTimeout(() => {
				void commitBufferedAudio();
			}, autoCommitSilenceMs);
		};

			ws.addEventListener(
				'open',
			() => {
				socketOpen = true;
				sendRaw(primaryUpdate);
				flushPendingMessages();
				schedulePrimaryTimeout();
			},
			{ once: true }
		);

			ws.addEventListener('message', (event) => {
				try {
					const payload = JSON.parse(String(event.data)) as OpenAIServerEvent;
					const emitResponseSTT = shouldEmitResponseTranscripts(runtimeConfig);

						switch (payload.type) {
							case 'response.audio_transcript.delta':
							case 'response.output_text.delta': {
								if (!emitResponseSTT) {
									return;
								}

								const delta =
									typeof payload.delta === 'string'
										? payload.delta
										: undefined;

							if (!delta) {
								return;
							}

							void emit(listeners, 'partial', {
								receivedAt: Date.now(),
								transcript: toTextTranscript(delta),
								type: 'partial'
							});
							return;
						}
							case 'response.audio_transcript.done':
							case 'response.output_text.done': {
								if (!emitResponseSTT) {
									return;
								}

								const transcript =
									typeof payload.transcript === 'string'
										? payload.transcript
									: undefined;

							if (!transcript) {
								return;
							}

								void emit(listeners, 'final', {
									receivedAt: Date.now(),
									transcript: toTextTranscript(transcript),
									type: 'final'
								});
							void emit(listeners, 'endOfTurn', {
								receivedAt: Date.now(),
								reason: 'vendor',
								type: 'endOfTurn'
							});
							return;
						}
							case 'response.output_audio_transcript.delta': {
								if (!emitResponseSTT) {
									return;
								}

								const delta =
									typeof payload.delta === 'string'
										? payload.delta
									: undefined;

							if (!delta) {
								return;
							}

							void emit(listeners, 'partial', {
								receivedAt: Date.now(),
								transcript: toTextTranscript(delta),
								type: 'partial'
							});
							return;
						}
							case 'response.output_audio_transcript.done': {
								if (!emitResponseSTT) {
									return;
								}

								const transcript =
									typeof payload.transcript === 'string'
										? payload.transcript
									: undefined;

							if (!transcript) {
								return;
							}

							void emit(listeners, 'final', {
								receivedAt: Date.now(),
								transcript: toTextTranscript(transcript),
								type: 'final'
							});
							void emit(listeners, 'endOfTurn', {
								receivedAt: Date.now(),
								reason: 'vendor',
								type: 'endOfTurn'
							});
							return;
						}
						case 'session.created':
							markReady();
							return;
						case 'session.updated':
							markReady();
							return;
							case 'conversation.item.input_audio_transcription.delta': {
						const itemId =
							typeof payload.item_id === 'string'
								? payload.item_id
								: undefined;
								const delta =
									typeof payload.delta === 'string'
										? payload.delta
										: undefined;

						if (!itemId || !delta) {
							return;
						}

						const text = (transcriptBuffers.get(itemId) ?? '') + delta;
						transcriptBuffers.set(itemId, text);
						const deltaLogprobs = readTranscriptionLogprobs(payload.logprobs);
						if (deltaLogprobs.length > 0) {
							transcriptLogprobs.set(itemId, [
								...(transcriptLogprobs.get(itemId) ?? []),
								...deltaLogprobs
							]);
						}
						void emit(listeners, 'partial', {
							receivedAt: Date.now(),
							transcript: buildAudioTranscript(
								itemId,
								text,
								false,
								transcriptLogprobs.get(itemId)
							),
							type: 'partial'
						});
						return;
					}
							case 'conversation.item.input_audio_transcription.completed': {
								const itemId =
									typeof payload.item_id === 'string'
										? payload.item_id
										: undefined;
						const transcript =
							typeof payload.transcript === 'string'
								? payload.transcript
									: undefined;

								if (!itemId || !transcript) {
									return;
								}

								if (committedTranscripts.has(itemId)) {
									return;
								}

								committedTranscripts.set(itemId, transcript);
								transcriptBuffers.set(itemId, transcript);
								const completedLogprobs = readTranscriptionLogprobs(payload.logprobs);
								if (completedLogprobs.length > 0) {
									transcriptLogprobs.set(itemId, completedLogprobs);
								}
								void emit(listeners, 'final', {
									receivedAt: Date.now(),
									transcript: buildAudioTranscript(
										itemId,
										transcript,
										true,
										transcriptLogprobs.get(itemId)
									),
									type: 'final'
								});
						void emit(listeners, 'endOfTurn', {
							receivedAt: Date.now(),
							reason: 'vendor',
							type: 'endOfTurn'
						});
						return;
					}
					case 'conversation.item.input_audio_transcription.failed': {
						const errorPayload =
							payload.error && typeof payload.error === 'object'
								? (payload.error as OpenAIRealtimeError)
								: undefined;
						const error = new Error(
							resolveErrorMessage(errorPayload ?? payload)
						);
						void emit(listeners, 'error', {
							code: errorPayload?.code,
							error,
							recoverable: true,
							type: 'error'
						});
						return;
					}
					case 'response.output_audio.delta': {
						const delta =
							typeof payload.delta === 'string'
								? payload.delta
								: undefined;

						if (!delta) {
							return;
						}

						void emit(listeners, 'audio', {
							chunk: Buffer.from(delta, 'base64'),
							format: OUTPUT_AUDIO_FORMAT,
							receivedAt: Date.now(),
							type: 'audio'
						});
						return;
					}
					case 'error': {
						const error =
							payload.error && typeof payload.error === 'object'
								? (payload.error as OpenAIRealtimeError)
								: {};
						const message = resolveErrorMessage(error);
						const eventId = error.event_id;

						void emit(listeners, 'error', {
							code: error.code,
							error: new Error(message),
							recoverable: true,
							type: 'error'
						});

						if (!ready && eventId === primaryUpdate.event_id) {
							failReady(new Error(message));
						}
						return;
					}
					default:
						return;
				}
			} catch (error) {
				void emit(listeners, 'error', {
					error: new Error(resolveErrorMessage(error)),
					recoverable: true,
					type: 'error'
				});
			}
		});

		ws.addEventListener('error', (rawEvent) => {
			const event = rawEvent as Event & { error?: unknown };
			const error = new Error(resolveErrorMessage(event.error ?? event));
			failReady(error);
			void emit(listeners, 'error', {
				error,
				recoverable: false,
				type: 'error'
			});
		});

		ws.addEventListener('close', (event) => {
			socketOpen = false;
			clearReadyTimeout();
			if (!ready) {
				failReady(resolveReadyError('closed'));
			}
			void emitClose(
				event.code,
				event.reason || undefined,
				event.code !== 1000
			);
		});

		if (options.signal) {
			if (options.signal.aborted) {
				closed = true;
				ws.close(1000, 'aborted');
			} else {
				options.signal.addEventListener(
					'abort',
					() => {
						if (!closed) {
							closed = true;
							ws.close(1000, 'aborted');
						}
					},
					{ once: true }
				);
			}
		}

		return {
			close: async (reason?: string) => {
				if (closed) {
					return;
				}

				closed = true;
				clearReadyTimeout();
				if (audioCommitTimer) {
					clearTimeout(audioCommitTimer);
					audioCommitTimer = undefined;
				}

				if (pendingAudioInput) {
					try {
						await commitBufferedAudio();
					} catch {}
				}

				ws.close(1000, reason);
				await emitClose(1000, reason, false);
			},
			on: (event, handler) => {
				listeners[event].add(handler as never);

				return () => {
					listeners[event].delete(handler as never);
				};
			},
			send: async (input: AudioChunk | string) => {
				await readyPromise;
				if (closed) {
					return;
				}

				if (typeof input === 'string') {
					const text = input.trim();
					if (!text) {
						return;
					}

					await emit(listeners, 'final', {
						receivedAt: Date.now(),
						transcript: buildTextTranscript(text),
						type: 'final'
					});
					await emit(listeners, 'endOfTurn', {
						receivedAt: Date.now(),
						reason: 'manual',
						type: 'endOfTurn'
					});

					sendRaw({
						item: {
							content: [
								{
									text,
									type: 'input_text'
								}
							],
							role: 'user',
							type: 'message'
						},
						type: 'conversation.item.create'
					});
					sendRaw(buildResponseCreateEvent(config));
					return;
				}

				assertRealtimePCMInput(options.format);
				sendRaw({
					audio: toBase64(input),
					type: 'input_audio_buffer.append'
				});
				pendingAudioInput = true;
				resetAudioCommitTimer();
			}
		};
	}
});

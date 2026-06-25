import type {
	STTAdapter,
	STTAdapterOpenOptions,
	STTSessionEventMap,
	Transcript
} from '@absolutejs/voice';
import type { DeepgramResolvedSTTOptions, DeepgramSTTOptions } from './types';

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

type DeepgramAdapterOpenOptions = STTAdapterOpenOptions & {
	languageStrategy?: VoiceLanguageStrategyCompat;
	lexicon?: VoiceLexiconEntryCompat[];
	phraseHints?: VoicePhraseHintCompat[];
};

type ListenerMap = {
	[K in keyof STTSessionEventMap]: Set<
		(payload: STTSessionEventMap[K]) => void | Promise<void>
	>;
};

type DeepgramResultsMessage = {
	channel?: {
		alternatives?: Array<{
			confidence?: number;
			transcript?: string;
			words?: Array<{
				end?: number;
				start?: number;
			}>;
		}>;
	};
	is_final?: boolean;
	language?: string;
	speech_final?: boolean;
	type?: string;
};

type DeepgramFluxTurnInfoMessage = {
	audio_window_end?: number;
	audio_window_start?: number;
	end_of_turn_confidence?: number;
	event?: 'Update' | 'EagerEndOfTurn' | 'TurnResumed' | 'EndOfTurn';
	request_id?: string;
	sequence_id?: number;
	transcript?: string;
	type?: 'TurnInfo';
	words?: Array<{
		confidence?: number;
		word?: string;
	}>;
};

type DeepgramMessage =
	| DeepgramResultsMessage
	| DeepgramFluxTurnInfoMessage
	| {
			description?: string;
			code?: string;
			type?:
				| 'UtteranceEnd'
				| 'EndOfTurn'
				| 'EagerEndOfTurn'
				| 'TurnResumed'
				| 'Connected'
				| 'ConfigureSuccess'
				| 'ConfigureFailure'
				| 'FatalError'
				| 'Error';
	  };

const LISTEN_V1_URL = 'wss://api.deepgram.com/v1/listen';
const LISTEN_V2_URL = 'wss://api.deepgram.com/v2/listen';

const createListenerMap = (): ListenerMap => ({
	close: new Set(),
	endOfTurn: new Set(),
	error: new Set(),
	final: new Set(),
	partial: new Set()
});

const DEDUPE_WINDOW_MS = 2_500;

const createSignalDeduper = () => ({
	endOfTurnSignals: new Map<string, number>(),
	finalSignals: new Map<string, number>()
});

const normalizeTranscriptText = (text: string) =>
	text.trim().toLowerCase().replace(/\s+/g, ' ');

const isSignalDuplicate = (
	signals: Map<string, number>,
	key: string,
	now: number
) => {
	for (const [signature, seenAt] of signals) {
		if (now - seenAt > DEDUPE_WINDOW_MS) {
			signals.delete(signature);
		}
	}

	const lastSeen = signals.get(key);
	if (lastSeen !== undefined && now - lastSeen <= DEDUPE_WINDOW_MS) {
		return true;
	}

	signals.set(key, now);
	return false;
};

const buildTranscriptSignalKey = (transcript: Transcript) =>
	[
		transcript.vendor ?? 'unknown',
		normalizeTranscriptText(transcript.text),
		String(transcript.startedAtMs ?? ''),
		String(transcript.endedAtMs ?? '')
	].join('|');

const toRecord = (value: unknown): Record<string, unknown> | null =>
	typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;

const readStringField = (value: unknown): string | undefined =>
	typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

type DeepgramErrorDetails = {
	code?: string;
	message: string;
	requestId?: string;
};

const readField = (
	record: Record<string, unknown>,
	keys: ReadonlyArray<string>
): string | undefined => {
	for (const key of keys) {
		const value = record[key];
		const direct = readStringField(value);
		if (direct) {
			return direct;
		}

		const nested = toRecord(value);
		if (nested) {
			const nestedMessage = readField(nested, keys);
			if (nestedMessage) {
				return nestedMessage;
			}
		}
	}

	return undefined;
};

const resolveErrorDetails = (error: unknown): DeepgramErrorDetails => {
	if (typeof error === 'string' && error.trim()) {
		return {
			message: error.trim()
		};
	}

	if (error instanceof Error && error.message.trim()) {
		return {
			message: error.message
		};
	}

	const record = toRecord(error);
	if (!record) {
		return {
			message: 'Deepgram stream error'
		};
	}

	const message =
		readField(record, ['message', 'reason', 'description']) ??
		'Deepgram stream error';
	const code = readField(record, ['code', 'error_code', 'status_code']);
	const requestId = readField(record, [
		'request_id',
		'requestId',
		'request-id'
	]);

	return {
		code,
		message,
		requestId
	};
};

const isNil = (value: unknown): value is null | undefined => value == null;

const collectPhraseHintTerms = (options: DeepgramAdapterOpenOptions) =>
	(options.phraseHints ?? []).flatMap((hint) => [
		hint.text,
		...(hint.aliases ?? [])
	]);

const collectLexiconTerms = (options: DeepgramAdapterOpenOptions) =>
	(options.lexicon ?? []).flatMap((entry) => [
		entry.text,
		...(entry.aliases ?? [])
	]);

const normalizeKeyterms = (
	value: DeepgramSTTOptions['keyterms'] | DeepgramSTTOptions['keyterm']
) =>
	value === undefined ? [] : Array.isArray(value) ? value : [value];

// Deepgram caps keyterm prompting at 500 tokens PER REQUEST — shared across
// Nova-3 monolingual, Nova-3 multilingual, and Flux
// (https://developers.deepgram.com/docs/keyterm). There is no per-keyterm count
// limit; the only ceiling is total tokens. So rather than an arbitrarily small
// fixed count, we admit as many relevance-ranked terms as fit under a token
// budget (with a safety margin below 500). Tokens are estimated at ~4 chars/token
// — Deepgram's own guidance ("500 tokens ≈ 100 words") is the same ballpark. A
// generous hard count cap stays as a backstop against pathological inputs.
const MAX_KEYTERM_TOKEN_BUDGET = 450;
const MAX_KEYTERM_COUNT = 200;
const MAX_KEYTERM_LENGTH = 48;
const estimateKeytermTokens = (term: string) =>
	Math.max(1, Math.ceil(term.trim().length / 4));

const countScripts = (value: string) => {
	const scripts = new Set<string>();
	if (/\p{Script=Latin}/u.test(value)) {
		scripts.add('latin');
	}
	if (/\p{Script=Devanagari}/u.test(value)) {
		scripts.add('devanagari');
	}
	return scripts.size;
};

const scoreKeytermCandidate = (value: string) => {
	const normalized = value.trim();
	return (
		(countScripts(normalized) >= 2 ? 40 : 0) +
		(normalized.includes(' ') ? 20 : 0) +
		(/[^\x00-\x7F]/u.test(normalized) ? 10 : 0) +
		(normalized.includes("'") ? 5 : 0) +
		Math.min(normalized.length, 20)
	);
};

const selectKeyterms = (terms: string[]) => {
	const ranked = terms
		.map((term) => term.trim())
		.filter((term) => term.length >= 2 && term.length <= MAX_KEYTERM_LENGTH)
		.filter((term, index, list) => list.indexOf(term) === index)
		.sort(
			(left, right) =>
				scoreKeytermCandidate(right) - scoreKeytermCandidate(left)
		);
	// Greedily admit the highest-scored terms while staying under Deepgram's
	// per-request token ceiling, so a large dictionary is honored in full instead
	// of being truncated to a handful.
	const selected: string[] = [];
	let tokenBudget = MAX_KEYTERM_TOKEN_BUDGET;
	for (const term of ranked) {
		if (selected.length >= MAX_KEYTERM_COUNT) {
			break;
		}
		const cost = estimateKeytermTokens(term);
		if (cost > tokenBudget) {
			continue;
		}
		selected.push(term);
		tokenBudget -= cost;
	}
	return selected;
};

const formatErrorMessage = (details: DeepgramErrorDetails): string => {
	const parts = [
		details.code ? `code=${details.code}` : undefined,
		details.requestId ? `requestId=${details.requestId}` : undefined
	].filter((value): value is string => typeof value === 'string');

	if (parts.length === 0) {
		return details.message;
	}

	return `${details.message} (${parts.join(', ')})`;
};

const resolveCloseReason = (code: number, reason?: string): string | undefined => {
	const normalized = reason?.trim();
	if (normalized) {
		return normalized;
	}

	if (code === 1006) {
		return 'transport closed before handshake';
	}

	if (code === 1000) {
		return undefined;
	}

	return `websocket closed with code ${code}`;
};

const emit = async <K extends keyof STTSessionEventMap>(
	listeners: ListenerMap,
	event: K,
	payload: STTSessionEventMap[K]
) => {
	for (const listener of listeners[event]) {
		await listener(payload);
	}
};

const normalizeWords = (
	words:
		| Array<{
				end?: number;
				speaker?: number;
				start?: number;
		  }>
		| undefined
) => {
	if (!Array.isArray(words) || words.length === 0) {
		return {};
	}

	const first = words[0];
	const last = words.at(-1);
	const speakerCounts = new Map<number, number>();

	for (const word of words) {
		if (typeof word.speaker !== 'number') {
			continue;
		}

		speakerCounts.set(word.speaker, (speakerCounts.get(word.speaker) ?? 0) + 1);
	}

	const speaker = [...speakerCounts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];

	return {
		endedAtMs:
			typeof last?.end === 'number' ? Math.round(last.end * 1000) : undefined,
		speaker,
		startedAtMs:
			typeof first?.start === 'number'
				? Math.round(first.start * 1000)
				: undefined
	};
};

const buildTranscript = (payload: DeepgramResultsMessage): Transcript | null => {
	const alternative = payload.channel?.alternatives?.[0];

	if (!alternative || typeof alternative.transcript !== 'string') {
		return null;
	}

	return {
		...normalizeWords(alternative.words),
		confidence:
			typeof alternative.confidence === 'number'
				? alternative.confidence
				: undefined,
		id: crypto.randomUUID(),
		isFinal: payload.is_final === true,
		language: payload.language,
		text: alternative.transcript,
		vendor: 'deepgram'
	};
};

const buildFluxTranscript = (
	payload: DeepgramFluxTurnInfoMessage
): Transcript | null => {
	if (typeof payload.transcript !== 'string' || !payload.transcript.trim()) {
		return null;
	}

	const confidences = (payload.words ?? [])
		.map((word) =>
			typeof word.confidence === 'number' ? word.confidence : undefined
		)
		.filter((value): value is number => value !== undefined);
	const confidence =
		confidences.length > 0
			? confidences.reduce((sum, value) => sum + value, 0) /
				confidences.length
			: payload.end_of_turn_confidence;

	return {
		confidence,
		endedAtMs:
			typeof payload.audio_window_end === 'number'
				? Math.round(payload.audio_window_end * 1000)
				: undefined,
		id:
			typeof payload.sequence_id === 'number'
				? `flux-${payload.sequence_id}`
				: crypto.randomUUID(),
		isFinal: payload.event === 'EndOfTurn',
		startedAtMs:
			typeof payload.audio_window_start === 'number'
				? Math.round(payload.audio_window_start * 1000)
				: undefined,
		text: payload.transcript,
		vendor: 'deepgram'
	};
};

const omitUndefined = (value: Record<string, unknown>) =>
	Object.fromEntries(
		Object.entries(value).filter(([, entry]) => entry !== undefined)
	);

const normalizeLanguageCode = (value: string | undefined) => {
	const normalized = value?.trim();
	return normalized && normalized.length > 0 ? normalized : undefined;
};

const resolveStrategyLanguage = (options: DeepgramAdapterOpenOptions) => {
	if (options.languageStrategy?.mode !== 'fixed') {
		return undefined;
	}

	return normalizeLanguageCode(options.languageStrategy.primaryLanguage);
};

const resolveDeepgramModel = (
	config: DeepgramResolvedSTTOptions,
	options: DeepgramAdapterOpenOptions
) => {
	if (config.model !== 'flux') {
		return config.model;
	}

	if (
		options.languageStrategy?.mode === 'allow-switching' ||
		options.languageStrategy?.mode === 'auto-detect'
	) {
		return 'flux-general-multi';
	}

	const language = normalizeLanguageCode(
		options.languageStrategy?.mode === 'fixed'
			? options.languageStrategy.primaryLanguage
			: config.language
	);

	if (!language || language.startsWith('en')) {
		return 'flux-general-en';
	}

	return 'flux-general-multi';
};

type DeepgramOpenContext = Pick<DeepgramAdapterOpenOptions, 'languageStrategy' | 'lexicon' | 'sessionId'> & {
	format: Pick<STTAdapterOpenOptions['format'], 'channels' | 'sampleRateHz'>;
};

const buildLiveOptions = (
	config: DeepgramResolvedSTTOptions,
	format: { channels: number; sampleRateHz: number },
	options: DeepgramAdapterOpenOptions
) => {
	const model = resolveDeepgramModel(config, options);
	const isFlux = String(model).startsWith('flux');
	const language =
		normalizeLanguageCode(config.language) ?? resolveStrategyLanguage(options);
	const liveOptions: Record<string, unknown> = {
		encoding: 'linear16',
		model,
		sample_rate: format.sampleRateHz
	};

	if (!isFlux) {
		liveOptions.channels = format.channels;
		if (config.punctuate !== undefined) {
			liveOptions.punctuate = config.punctuate;
		}

		if (config.smartFormat !== undefined) {
			liveOptions.smart_format = config.smartFormat;
		}

		if (config.interimResults !== undefined) {
			liveOptions.interim_results = config.interimResults;
		}

		if (config.endpointing !== undefined) {
			liveOptions.endpointing = config.endpointing;
		}

		if (language) {
			liveOptions.language = language;
		}

		if (config.utteranceEndMs !== undefined) {
			liveOptions.utterance_end_ms = config.utteranceEndMs;
		}

		if (config.vadEvents !== undefined) {
			liveOptions.vad_events = config.vadEvents;
		}
	} else {
		liveOptions.eager_eot_threshold = config.eagerEotThreshold ?? 0.8;
		liveOptions.eot_threshold = config.eotThreshold ?? 0.82;
		liveOptions.eot_timeout_ms = config.eotTimeoutMs ?? 1_200;
	}

	if (!isFlux && config.diarize !== undefined) {
		liveOptions.diarize = config.diarize;
	}

	if (!isFlux && config.numerals !== undefined) {
		liveOptions.numerals = config.numerals;
	}

	if (!isFlux && config.profanityFilter !== undefined) {
		liveOptions.profanity_filter = config.profanityFilter;
	}

	if (!isFlux && config.redact !== undefined) {
		liveOptions.redact = config.redact;
	}

	if (config.tag !== undefined) {
		liveOptions.tag = config.tag;
	}

	if (config.extra) {
		liveOptions.extra = config.extra;
	}

	const keyterm = config.keyterms ?? config.keyterm;
	if (keyterm !== undefined) {
		liveOptions.keyterm = keyterm;
	}

	return omitUndefined(liveOptions);
};

const buildUrl = (
	config: DeepgramResolvedSTTOptions,
	input: {
		context: DeepgramOpenContext;
		phraseHintTerms?: string[];
	}
) => {
	const context: DeepgramAdapterOpenOptions = {
		format: {
			channels: input.context.format.channels,
			container: 'raw',
			encoding: 'pcm_s16le',
			sampleRateHz: input.context.format.sampleRateHz
		},
		languageStrategy: input.context.languageStrategy,
		lexicon: input.context.lexicon,
		sessionId: input.context.sessionId
	};
	const url = new URL(
		String(resolveDeepgramModel(config, context)).startsWith('flux')
			? LISTEN_V2_URL
			: LISTEN_V1_URL
	);
	const keytermTerms = [
		...normalizeKeyterms(config.keyterms ?? config.keyterm),
		...collectLexiconTerms(context),
		...(input.phraseHintTerms ?? [])
	];
	const selectedKeyterms = selectKeyterms(keytermTerms);
	const options = buildLiveOptions(
		{
			...config,
			keyterms: selectedKeyterms.length > 0 ? selectedKeyterms : config.keyterms
		},
		input.context.format,
		context
	);

	for (const [key, value] of Object.entries(options)) {
		if (isNil(value)) {
			continue;
		}

		if (Array.isArray(value)) {
			for (const entry of value) {
				url.searchParams.append(key, String(entry));
			}
			continue;
		}

		if (value && typeof value === "object") {
			url.searchParams.set(key, JSON.stringify(value));
			continue;
		}

		url.searchParams.set(key, String(value));
	}

	return url.toString();
};

type DeepgramAuthMode = 'header' | 'protocol';

const createTransport = async (
	url: string,
	apiKey: string,
	authMode: DeepgramAuthMode = 'header'
): Promise<WebSocket> => {
	const globalWebSocket = globalThis.WebSocket;
	if (typeof globalWebSocket === 'function') {
		if (authMode === 'protocol') {
			return new globalWebSocket(url, ['token', apiKey] as never) as unknown as WebSocket;
		}

		return new globalWebSocket(url, {
			headers: {
				Authorization: `Token ${apiKey}`
			}
		} as never) as unknown as WebSocket;
	}

	const headers = {
		Authorization: `Token ${apiKey}`
	};

	return new WebSocket(url, { headers } as never);
};

const resolveOpenFailure = (
	error: unknown,
	url: string,
	timeoutMs: number
) => {
	const details = resolveErrorDetails(error);
	return new Error(
		`${formatErrorMessage(details)} (url=${url}, timeoutMs=${timeoutMs})`
	);
};

export const deepgram = (config: DeepgramSTTOptions): STTAdapter => ({
	kind: 'stt',
	open: async (options) => {
		const runtimeOptions = options as DeepgramAdapterOpenOptions;
		const emitsNativeEndOfTurn = String(config.model).startsWith('flux');
		const listeners = createListenerMap();
		const url = buildUrl(config, {
			context: {
				format: {
					channels: runtimeOptions.format.channels,
					sampleRateHz: runtimeOptions.format.sampleRateHz
				},
				languageStrategy: runtimeOptions.languageStrategy,
				lexicon: runtimeOptions.lexicon,
				sessionId: runtimeOptions.sessionId
			},
			phraseHintTerms: collectPhraseHintTerms(runtimeOptions),
		});
		const connection = await createTransport(
			url,
			config.apiKey,
			config.authMode
		);
		const connectTimeoutMs = config.connectTimeoutMs ?? 8_000;
			const keepAliveMs = config.keepAliveMs ?? 4000;
			const pendingAudio: Array<ArrayBuffer | ArrayBufferView> = [];
			const deduper = createSignalDeduper();
			let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
			let openTimeout: ReturnType<typeof setTimeout> | null = null;
			let opened = false;
			let closed = false;
		let openError = false;

		const clearKeepAlive = () => {
			if (!keepAliveTimer) {
				return;
			}

			clearInterval(keepAliveTimer);
			keepAliveTimer = null;
		};
		
		const clearOpenTimeout = () => {
			if (!openTimeout) {
				return;
			}

			clearTimeout(openTimeout);
			openTimeout = null;
		};

		const failOpen = (error: unknown): Error => {
			if (openError || opened || closed) {
				return new Error('Deepgram websocket failed to open');
			}

			openError = true;
			clearOpenTimeout();
			return resolveOpenFailure(error, url, connectTimeoutMs);
		};

		const openReadyState =
			typeof WebSocket.OPEN === 'number' ? WebSocket.OPEN : 1;
		const waitForOpen = new Promise<void>((resolve, reject) => {
			openTimeout = setTimeout(() => {
				const message = `Deepgram websocket open timeout after ${connectTimeoutMs}ms`;
				clearOpenTimeout();
				const error = failOpen(new Error(message));
				reject(error);
				connection.close(1013, message);
			}, connectTimeoutMs);

			const handleOpen = () => {
				if (opened || closed) {
					return;
				}

				opened = true;
				clearOpenTimeout();
				const keepAliveEnabled = !String(config.model).startsWith('flux');

				while (pendingAudio.length > 0) {
					const next = pendingAudio.shift();
					if (next) {
						connection.send(next);
					}
				}

				clearKeepAlive();
				if (!keepAliveEnabled) {
					resolve();
					return;
				}

				keepAliveTimer = setInterval(() => {
					if (connection.readyState !== openReadyState) {
						clearKeepAlive();
						return;
					}

					connection.send(JSON.stringify({ type: 'KeepAlive' }));
				}, keepAliveMs);

				resolve();
			};

			connection.addEventListener('open', handleOpen, { once: true });
			if (connection.readyState === openReadyState) {
				handleOpen();
			}
			connection.addEventListener(
				'error',
				(rawEvent) => {
					const event = rawEvent as Event & { error?: unknown };
					const error = resolveErrorDetails(
						event.error ?? new Error('Deepgram websocket failed to open')
					);
					const openFailure = failOpen(error);
					reject(openFailure);
				},
				{ once: true }
			);
		});

		connection.addEventListener('message', (event) => {
			if (typeof event.data !== 'string') {
				return;
			}

			try {
				const payload = JSON.parse(event.data) as DeepgramMessage;
				const type =
					typeof payload.type === 'string' ? payload.type : 'Results';

				if (emitsNativeEndOfTurn && type === 'TurnInfo') {
					const turnInfo = payload as DeepgramFluxTurnInfoMessage;
					const transcript = buildFluxTranscript(turnInfo);
					if (!transcript) {
						return;
					}

					if (turnInfo.event === 'EndOfTurn') {
						const now = Date.now();
						const signal = buildTranscriptSignalKey(transcript);

						if (!isSignalDuplicate(deduper.finalSignals, signal, now)) {
							void emit(listeners, 'final', {
								receivedAt: now,
								transcript: {
									...transcript,
									isFinal: true
								},
								type: 'final'
							});
						}

						if (
							!isSignalDuplicate(
								deduper.endOfTurnSignals,
								`eot:${signal}`,
								now
							)
						) {
							void emit(listeners, 'endOfTurn', {
								receivedAt: now,
								reason: 'vendor',
								type: 'endOfTurn'
							});
						}
						return;
					}

					if (
						turnInfo.event === 'Update' ||
						turnInfo.event === 'EagerEndOfTurn' ||
						turnInfo.event === 'TurnResumed'
					) {
						void emit(listeners, 'partial', {
							receivedAt: Date.now(),
							transcript: {
								...transcript,
								isFinal: false
							},
							type: 'partial'
						});
					}

					return;
				}

				if (
					emitsNativeEndOfTurn &&
					(type === 'UtteranceEnd' ||
						type === 'EndOfTurn' ||
						type === 'EagerEndOfTurn')
				) {
					const now = Date.now();
					const signal = `${type}:${JSON.stringify(payload)}`;
					if (isSignalDuplicate(deduper.endOfTurnSignals, signal, now)) {
						return;
					}

					void emit(listeners, 'endOfTurn', {
						receivedAt: now,
						reason: 'vendor',
						type: 'endOfTurn'
					});

					return;
				}

				if (
					type === 'TurnResumed' ||
					type === 'Connected' ||
					type === 'ConfigureSuccess' ||
					type === 'Metadata' ||
					type === 'SpeechStarted'
				) {
					return;
				}

				if (
					type === 'ConfigureFailure' ||
					type === 'FatalError' ||
					type === 'Error'
				) {
					const details = resolveErrorDetails(payload);
					void emit(listeners, 'error', {
						code: details.code,
						error: new Error(formatErrorMessage(details)),
						recoverable: false,
						type: 'error'
					});
					return;
				}

				const transcript = buildTranscript(payload as DeepgramResultsMessage);
				if (!transcript || !transcript.text.trim()) {
					return;
				}

				if ((payload as DeepgramResultsMessage).is_final === true) {
					const now = Date.now();
					const signal = buildTranscriptSignalKey(transcript);

					if (
						!isSignalDuplicate(deduper.finalSignals, `final:${signal}`, now)
					) {
						void emit(listeners, 'final', {
							receivedAt: now,
							transcript: {
								...transcript,
								isFinal: true
							},
							type: 'final'
						});
					}

					if (
						(payload as DeepgramResultsMessage).speech_final === true &&
						!isSignalDuplicate(
							deduper.endOfTurnSignals,
							`speech-final:${signal}`,
							now
						)
					) {
						void emit(listeners, 'endOfTurn', {
							receivedAt: now,
							reason: 'vendor',
							type: 'endOfTurn'
						});
					}
				} else {
					void emit(listeners, 'partial', {
						receivedAt: Date.now(),
						transcript: {
							...transcript,
							isFinal: false
						},
						type: 'partial'
					});
				}
			} catch (error) {
				const details = resolveErrorDetails(error);
				void emit(listeners, 'error', {
					code: details.code,
					error: new Error(formatErrorMessage(details)),
					recoverable: false,
					type: 'error'
				});
			}
		});

		connection.addEventListener('error', (rawEvent) => {
			const event = rawEvent as Event & { error?: unknown };
			const details = resolveErrorDetails(event.error ?? event);
			void emit(listeners, 'error', {
				code: details.code,
				error:
					event.error instanceof Error
						? event.error
						: new Error(formatErrorMessage(details)),
				recoverable: false,
				type: 'error'
			});
		});

		connection.addEventListener('close', (event) => {
			closed = true;
			clearKeepAlive();
			clearOpenTimeout();

			void emit(listeners, 'close', {
				code: event.code,
				reason: resolveCloseReason(event.code, event.reason),
				recoverable:
					event.code === 1006 || event.code === 1011 || event.code === 1012,
				type: 'close'
			});
		});

		await waitForOpen;

		return {
			close: async () => {
				if (closed) {
					return;
				}

				clearKeepAlive();

				if (opened && connection.readyState === WebSocket.OPEN) {
					connection.send(JSON.stringify({ type: 'CloseStream' }));
					connection.close(1000, 'closed');
				}
			},
			on: (event, handler) => {
				listeners[event].add(handler as never);

				return () => {
					listeners[event].delete(handler as never);
				};
			},
			send: async (audio) => {
				if (closed) {
					return;
				}

				if (opened && connection.readyState === WebSocket.OPEN) {
					connection.send(audio);
					return;
				}

				pendingAudio.push(audio);
				await waitForOpen;
			}
		};
	}
});

// Hand-rolled encode/decode for the subset of google.cloud.speech.v2 messages
// that @absolutejs/voice-google-speech streaming actually uses. Field numbers
// match the published .proto definitions.

import {
	concatProto,
	decodeFloat,
	decodeLengthDelimited,
	decodeString,
	decodeTag,
	decodeVarint,
	encodeBool,
	encodeEnum,
	encodeFloat,
	encodeInt32,
	encodeString,
	encodeSubMessage,
	skipField,
	WIRE_I32,
	WIRE_LEN,
	WIRE_VARINT,
	type DecodeCursor
} from './protobuf';

// google.cloud.speech.v2.ExplicitDecodingConfig.AudioEncoding
export const AUDIO_ENCODING_LINEAR16 = 1;
export const AUDIO_ENCODING_MULAW = 2;
export const AUDIO_ENCODING_ALAW = 3;

export type EncodingId =
	| typeof AUDIO_ENCODING_ALAW
	| typeof AUDIO_ENCODING_LINEAR16
	| typeof AUDIO_ENCODING_MULAW;

export type ExplicitDecodingConfig = {
	audioChannelCount?: number;
	encoding: EncodingId;
	sampleRateHertz: number;
};

export type RecognitionFeatures = {
	enableAutomaticPunctuation?: boolean;
	enableSpokenEmojis?: boolean;
	enableSpokenPunctuation?: boolean;
	enableWordConfidence?: boolean;
	enableWordTimeOffsets?: boolean;
	profanityFilter?: boolean;
};

export type RecognitionConfig = {
	explicitDecodingConfig: ExplicitDecodingConfig;
	features?: RecognitionFeatures;
	languageCodes?: readonly string[];
	model?: string;
};

export type StreamingRecognitionFeatures = {
	enableVoiceActivityEvents?: boolean;
	interimResults?: boolean;
};

export type StreamingRecognitionConfig = {
	config: RecognitionConfig;
	streamingFeatures?: StreamingRecognitionFeatures;
};

export type StreamingRecognizeRequest =
	| {
			audio: Uint8Array;
			recognizer?: string;
			streamingConfig?: never;
	  }
	| {
			audio?: never;
			recognizer?: string;
			streamingConfig: StreamingRecognitionConfig;
	  };

const encodeExplicitDecodingConfig = (
	config: ExplicitDecodingConfig
): Uint8Array =>
	concatProto([
		encodeEnum(1, config.encoding), // encoding
		encodeInt32(2, config.sampleRateHertz), // sample_rate_hertz
		encodeInt32(3, config.audioChannelCount ?? 0) // audio_channel_count
	]);

const encodeRecognitionFeatures = (
	features: RecognitionFeatures
): Uint8Array =>
	concatProto([
		encodeBool(1, features.profanityFilter), // profanity_filter
		encodeBool(2, features.enableWordTimeOffsets), // enable_word_time_offsets
		encodeBool(3, features.enableWordConfidence), // enable_word_confidence
		encodeBool(4, features.enableAutomaticPunctuation), // enable_automatic_punctuation
		encodeBool(5, features.enableSpokenPunctuation), // enable_spoken_punctuation
		encodeBool(6, features.enableSpokenEmojis) // enable_spoken_emojis
	]);

const encodeRecognitionConfig = (
	config: RecognitionConfig
): Uint8Array => {
	const parts: Uint8Array[] = [
		encodeSubMessage(8, encodeExplicitDecodingConfig(config.explicitDecodingConfig)) // explicit_decoding_config
	];
	if (config.features) {
		parts.push(encodeSubMessage(2, encodeRecognitionFeatures(config.features))); // features
	}
	if (config.model) {
		parts.push(encodeString(9, config.model)); // model
	}
	if (config.languageCodes) {
		for (const code of config.languageCodes) {
			parts.push(encodeString(10, code)); // language_codes (repeated)
		}
	}
	return concatProto(parts);
};

const encodeStreamingRecognitionFeatures = (
	features: StreamingRecognitionFeatures
): Uint8Array =>
	concatProto([
		encodeBool(1, features.enableVoiceActivityEvents), // enable_voice_activity_events
		encodeBool(2, features.interimResults) // interim_results
	]);

const encodeStreamingRecognitionConfig = (
	config: StreamingRecognitionConfig
): Uint8Array => {
	const parts: Uint8Array[] = [
		encodeSubMessage(1, encodeRecognitionConfig(config.config)) // config
	];
	if (config.streamingFeatures) {
		parts.push(
			encodeSubMessage(
				5,
				encodeStreamingRecognitionFeatures(config.streamingFeatures)
			)
		); // streaming_features
	}
	return concatProto(parts);
};

export const encodeStreamingRecognizeRequest = (
	request: StreamingRecognizeRequest
): Uint8Array => {
	const parts: Uint8Array[] = [];
	if (request.recognizer) {
		parts.push(encodeString(3, request.recognizer)); // recognizer
	}
	if ('streamingConfig' in request && request.streamingConfig) {
		parts.push(
			encodeSubMessage(
				6,
				encodeStreamingRecognitionConfig(request.streamingConfig)
			)
		); // streaming_config
	}
	if ('audio' in request && request.audio !== undefined) {
		parts.push(
			encodeSubMessage(5, request.audio)
		); // audio (bytes)
	}
	return concatProto(parts);
};

// Response decoders

export type SpeechRecognitionAlternative = {
	confidence?: number;
	transcript?: string;
};

export type StreamingRecognitionResult = {
	alternatives: SpeechRecognitionAlternative[];
	isFinal: boolean;
	languageCode?: string;
	resultEndOffsetSeconds?: number;
};

export type StreamingRecognizeResponse = {
	results: StreamingRecognitionResult[];
	speechEventType?: number;
};

const decodeAlternative = (bytes: Uint8Array): SpeechRecognitionAlternative => {
	const cursor: DecodeCursor = { bytes, offset: 0 };
	const alternative: SpeechRecognitionAlternative = {};
	while (cursor.offset < cursor.bytes.byteLength) {
		const { fieldNumber, wireType } = decodeTag(cursor);
		if (fieldNumber === 1 && wireType === WIRE_LEN) {
			alternative.transcript = decodeString(cursor);
			continue;
		}
		if (fieldNumber === 2 && wireType === WIRE_I32) {
			alternative.confidence = decodeFloat(cursor);
			continue;
		}
		skipField(cursor, wireType);
	}
	return alternative;
};

const decodeDuration = (bytes: Uint8Array): number => {
	const cursor: DecodeCursor = { bytes, offset: 0 };
	let seconds = 0;
	let nanos = 0;
	while (cursor.offset < cursor.bytes.byteLength) {
		const { fieldNumber, wireType } = decodeTag(cursor);
		if (fieldNumber === 1 && wireType === WIRE_VARINT) {
			seconds = decodeVarint(cursor);
			continue;
		}
		if (fieldNumber === 2 && wireType === WIRE_VARINT) {
			nanos = decodeVarint(cursor);
			continue;
		}
		skipField(cursor, wireType);
	}
	return seconds + nanos / 1_000_000_000;
};

const decodeStreamingResult = (
	bytes: Uint8Array
): StreamingRecognitionResult => {
	const cursor: DecodeCursor = { bytes, offset: 0 };
	const result: StreamingRecognitionResult = {
		alternatives: [],
		isFinal: false
	};
	while (cursor.offset < cursor.bytes.byteLength) {
		const { fieldNumber, wireType } = decodeTag(cursor);
		if (fieldNumber === 1 && wireType === WIRE_LEN) {
			result.alternatives.push(decodeAlternative(decodeLengthDelimited(cursor)));
			continue;
		}
		if (fieldNumber === 4 && wireType === WIRE_LEN) {
			result.resultEndOffsetSeconds = decodeDuration(
				decodeLengthDelimited(cursor)
			);
			continue;
		}
		if (fieldNumber === 5 && wireType === WIRE_VARINT) {
			result.isFinal = decodeVarint(cursor) !== 0;
			continue;
		}
		if (fieldNumber === 6 && wireType === WIRE_LEN) {
			result.languageCode = decodeString(cursor);
			continue;
		}
		skipField(cursor, wireType);
	}
	return result;
};

export const decodeStreamingRecognizeResponse = (
	bytes: Uint8Array
): StreamingRecognizeResponse => {
	const cursor: DecodeCursor = { bytes, offset: 0 };
	const response: StreamingRecognizeResponse = { results: [] };
	while (cursor.offset < cursor.bytes.byteLength) {
		const { fieldNumber, wireType } = decodeTag(cursor);
		if (fieldNumber === 6 && wireType === WIRE_LEN) {
			response.results.push(
				decodeStreamingResult(decodeLengthDelimited(cursor))
			);
			continue;
		}
		if (fieldNumber === 4 && wireType === WIRE_VARINT) {
			response.speechEventType = decodeVarint(cursor);
			continue;
		}
		skipField(cursor, wireType);
	}
	return response;
};

// google.cloud.speech.v2.SpeechEventType
export const SPEECH_EVENT_END_OF_SINGLE_UTTERANCE = 1;
export const SPEECH_EVENT_SPEECH_ACTIVITY_BEGIN = 2;
export const SPEECH_EVENT_SPEECH_ACTIVITY_END = 3;

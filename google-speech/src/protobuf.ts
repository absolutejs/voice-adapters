// Hand-rolled protobuf wire format helpers targeted at Google Cloud Speech v2
// StreamingRecognizeRequest / StreamingRecognizeResponse. Only the wire-types
// and fields actually used by those messages are implemented.
//
// Wire type reference (proto3):
//   0  VARINT  (int32, int64, bool, enum)
//   2  LEN     (string, bytes, sub-message, packed repeated)
//   5  I32     (float, fixed32)

export const WIRE_VARINT = 0;
export const WIRE_LEN = 2;
export const WIRE_I32 = 5;

export const encodeVarint = (value: number): Uint8Array => {
	if (!Number.isFinite(value) || value < 0) {
		throw new Error(`encodeVarint requires a non-negative finite number, got ${String(value)}.`);
	}
	const bytes: number[] = [];
	let remaining = value;
	while (remaining > 0x7f) {
		bytes.push((remaining & 0x7f) | 0x80);
		remaining = Math.floor(remaining / 128);
	}
	bytes.push(remaining & 0x7f);
	return new Uint8Array(bytes);
};

export const encodeTag = (
	fieldNumber: number,
	wireType: number
): Uint8Array => encodeVarint(fieldNumber * 8 + wireType);

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
	let total = 0;
	for (const part of parts) total += part.byteLength;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.byteLength;
	}
	return out;
};

export const encodeLengthDelimited = (
	fieldNumber: number,
	payload: Uint8Array
): Uint8Array =>
	concat([
		encodeTag(fieldNumber, WIRE_LEN),
		encodeVarint(payload.byteLength),
		payload
	]);

export const encodeString = (
	fieldNumber: number,
	value: string | undefined
): Uint8Array => {
	if (value === undefined || value.length === 0) return new Uint8Array(0);
	return encodeLengthDelimited(fieldNumber, new TextEncoder().encode(value));
};

export const encodeBytes = (
	fieldNumber: number,
	value: Uint8Array | undefined
): Uint8Array => {
	if (!value) return new Uint8Array(0);
	return encodeLengthDelimited(fieldNumber, value);
};

export const encodeInt32 = (
	fieldNumber: number,
	value: number | undefined
): Uint8Array => {
	if (value === undefined || value === 0) return new Uint8Array(0);
	return concat([encodeTag(fieldNumber, WIRE_VARINT), encodeVarint(value)]);
};

export const encodeEnum = (
	fieldNumber: number,
	value: number | undefined
): Uint8Array => {
	if (value === undefined || value === 0) return new Uint8Array(0);
	return concat([encodeTag(fieldNumber, WIRE_VARINT), encodeVarint(value)]);
};

export const encodeBool = (
	fieldNumber: number,
	value: boolean | undefined
): Uint8Array => {
	if (!value) return new Uint8Array(0);
	return concat([encodeTag(fieldNumber, WIRE_VARINT), encodeVarint(1)]);
};

export const encodeFloat = (
	fieldNumber: number,
	value: number | undefined
): Uint8Array => {
	if (value === undefined) return new Uint8Array(0);
	const buffer = new ArrayBuffer(4);
	new DataView(buffer).setFloat32(0, value, true);
	return concat([
		encodeTag(fieldNumber, WIRE_I32),
		new Uint8Array(buffer)
	]);
};

export const encodeSubMessage = (
	fieldNumber: number,
	body: Uint8Array | undefined
): Uint8Array => {
	if (!body || body.byteLength === 0) {
		// Even an empty sub-message must be encoded as a zero-length LEN field
		// when explicitly set, because proto3 readers use field presence to
		// distinguish "field is set with default values" from "field is unset"
		// for sub-messages.
		return encodeLengthDelimited(fieldNumber, new Uint8Array(0));
	}
	return encodeLengthDelimited(fieldNumber, body);
};

export const concatProto = concat;

export type DecodeCursor = {
	bytes: Uint8Array;
	offset: number;
};

export const decodeVarint = (cursor: DecodeCursor): number => {
	let result = 0;
	let multiplier = 1;
	let byte = 0;
	do {
		if (cursor.offset >= cursor.bytes.byteLength) {
			throw new Error('decodeVarint reached end of buffer.');
		}
		byte = cursor.bytes[cursor.offset]!;
		cursor.offset += 1;
		result += (byte & 0x7f) * multiplier;
		multiplier *= 128;
	} while (byte & 0x80);
	return result;
};

export const decodeTag = (
	cursor: DecodeCursor
): { fieldNumber: number; wireType: number } => {
	const value = decodeVarint(cursor);
	return {
		fieldNumber: Math.floor(value / 8),
		wireType: value % 8
	};
};

export const decodeLengthDelimited = (cursor: DecodeCursor): Uint8Array => {
	const length = decodeVarint(cursor);
	if (cursor.offset + length > cursor.bytes.byteLength) {
		throw new Error('decodeLengthDelimited length exceeds buffer.');
	}
	const slice = cursor.bytes.subarray(
		cursor.offset,
		cursor.offset + length
	);
	cursor.offset += length;
	return slice;
};

export const decodeString = (cursor: DecodeCursor): string =>
	new TextDecoder().decode(decodeLengthDelimited(cursor));

export const decodeFloat = (cursor: DecodeCursor): number => {
	if (cursor.offset + 4 > cursor.bytes.byteLength) {
		throw new Error('decodeFloat needs 4 bytes.');
	}
	const view = new DataView(
		cursor.bytes.buffer,
		cursor.bytes.byteOffset + cursor.offset,
		4
	);
	const value = view.getFloat32(0, true);
	cursor.offset += 4;
	return value;
};

export const skipField = (cursor: DecodeCursor, wireType: number): void => {
	if (wireType === WIRE_VARINT) {
		decodeVarint(cursor);
		return;
	}
	if (wireType === WIRE_LEN) {
		decodeLengthDelimited(cursor);
		return;
	}
	if (wireType === WIRE_I32) {
		cursor.offset += 4;
		return;
	}
	if (wireType === 1) {
		// I64 — not used by the response schema but skip gracefully if Google ever adds one.
		cursor.offset += 8;
		return;
	}
	throw new Error(`Unsupported protobuf wire type ${String(wireType)}.`);
};

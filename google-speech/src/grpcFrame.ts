// gRPC / gRPC-Web on-the-wire message framing.
//
// Every message — data and trailers — is prefixed with a 5-byte header:
//   byte[0] = compression flag (bit 7 set indicates a trailer frame in
//             gRPC-Web; lower bits are reserved for compression)
//   byte[1..4] = big-endian uint32 message length
//   byte[5..]  = payload bytes
//
// Standard gRPC over HTTP/2 also frames data messages this way; trailers are
// delivered as HTTP/2 trailers (separate from the body). We support both
// modes: the framer is identical for data, and trailer detection is done by
// inspecting the high bit of the flag byte (only set by gRPC-Web bodies).

export const GRPC_TRAILER_FLAG = 0x80;

export const encodeFrame = (payload: Uint8Array): Uint8Array => {
	const out = new Uint8Array(5 + payload.byteLength);
	out[0] = 0; // no compression
	new DataView(out.buffer).setUint32(1, payload.byteLength, false);
	out.set(payload, 5);
	return out;
};

export type ParsedFrame = {
	isTrailer: boolean;
	payload: Uint8Array;
};

export type FrameParserResult = {
	frames: ParsedFrame[];
	remainder: Uint8Array;
};

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
	const out = new Uint8Array(a.byteLength + b.byteLength);
	out.set(a, 0);
	out.set(b, a.byteLength);
	return out;
};

export const parseFrames = (
	buffer: Uint8Array,
	incoming: Uint8Array
): FrameParserResult => {
	const view = concat(buffer, incoming);
	const frames: ParsedFrame[] = [];
	let offset = 0;
	while (true) {
		if (view.byteLength - offset < 5) break;
		const flag = view[offset]!;
		const length = new DataView(
			view.buffer,
			view.byteOffset + offset + 1,
			4
		).getUint32(0, false);
		if (view.byteLength - offset - 5 < length) break;
		const payload = view.subarray(offset + 5, offset + 5 + length);
		frames.push({
			isTrailer: (flag & GRPC_TRAILER_FLAG) !== 0,
			payload
		});
		offset += 5 + length;
	}
	return {
		frames,
		remainder: view.subarray(offset)
	};
};

export const parseTrailerPayload = (
	payload: Uint8Array
): Record<string, string> => {
	const text = new TextDecoder().decode(payload);
	const entries: Record<string, string> = {};
	for (const line of text.split(/\r\n/)) {
		const colon = line.indexOf(':');
		if (colon === -1) continue;
		const key = line.slice(0, colon).trim().toLowerCase();
		const value = line.slice(colon + 1).trim();
		if (key.length === 0) continue;
		entries[key] = value;
	}
	return entries;
};

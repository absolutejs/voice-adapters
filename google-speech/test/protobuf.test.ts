import { describe, expect, test } from "bun:test";
import {
  decodeStreamingRecognizeResponse,
  encodeStreamingRecognizeRequest,
} from "../src/streamingProto";

const concat = (...parts: Uint8Array[]) => {
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

const varint = (value: number): Uint8Array => {
  const bytes: number[] = [];
  let remaining = value;
  while (remaining > 0x7f) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(remaining & 0x7f);
  return new Uint8Array(bytes);
};

const tag = (field: number, wire: number) => varint(field * 8 + wire);

const lenField = (field: number, payload: Uint8Array) =>
  concat(tag(field, 2), varint(payload.byteLength), payload);

const stringField = (field: number, value: string) =>
  lenField(field, new TextEncoder().encode(value));

const float32 = (field: number, value: number): Uint8Array => {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, value, true);
  return concat(tag(field, 5), new Uint8Array(buf));
};

const boolField = (field: number, value: boolean) =>
  concat(tag(field, 0), varint(value ? 1 : 0));

describe("protobuf encoders + decoders", () => {
  test("encodeStreamingRecognizeRequest emits recognizer + streaming_config + nested fields", () => {
    const encoded = encodeStreamingRecognizeRequest({
      recognizer: "projects/p/locations/global/recognizers/_",
      streamingConfig: {
        config: {
          explicitDecodingConfig: {
            audioChannelCount: 1,
            encoding: 1, // LINEAR16
            sampleRateHertz: 16_000,
          },
          languageCodes: ["en-US", "es-ES"],
          model: "latest_long",
        },
        streamingFeatures: {
          enableVoiceActivityEvents: true,
          interimResults: true,
        },
      },
    });
    // Just sanity: the encoded bytes should include the model + language codes + audio config bytes
    const text = new TextDecoder().decode(encoded);
    expect(text).toContain("projects/p/locations/global/recognizers/_");
    expect(text).toContain("latest_long");
    expect(text).toContain("en-US");
    expect(text).toContain("es-ES");
  });

  test("encodeStreamingRecognizeRequest emits audio bytes under field 5", () => {
    const encoded = encodeStreamingRecognizeRequest({
      audio: new Uint8Array([0x10, 0x11, 0x12]),
    });
    // Field 5 LEN-prefixed: tag (5<<3|2)=42 -> 0x2a, then length 3, then bytes
    expect(Array.from(encoded.slice(0, 5))).toEqual([
      0x2a, 0x03, 0x10, 0x11, 0x12,
    ]);
  });

  test("decodeStreamingRecognizeResponse decodes a hand-built response with partial + final results", () => {
    // Build an alternative: transcript "hello" + confidence 0.9
    const alternativeBytes = concat(stringField(1, "hello"), float32(2, 0.9));
    // Build a partial result: alternatives + is_final=false (omitted) + language_code "en-us"
    const partialResultBytes = concat(
      lenField(1, alternativeBytes),
      stringField(6, "en-us"),
    );
    // Build a final result: same alt + is_final=true
    const finalResultBytes = concat(
      lenField(1, alternativeBytes),
      boolField(5, true),
      stringField(6, "en-us"),
    );
    // Response: results (field 6, repeated)
    const responseBytes = concat(
      lenField(6, partialResultBytes),
      lenField(6, finalResultBytes),
    );
    const decoded = decodeStreamingRecognizeResponse(responseBytes);
    expect(decoded.results).toHaveLength(2);
    expect(decoded.results[0]?.alternatives[0]?.transcript).toBe("hello");
    expect(decoded.results[0]?.alternatives[0]?.confidence).toBeCloseTo(0.9, 3);
    expect(decoded.results[0]?.isFinal).toBe(false);
    expect(decoded.results[1]?.isFinal).toBe(true);
    expect(decoded.results[1]?.languageCode).toBe("en-us");
  });

  test("decodeStreamingRecognizeResponse handles speech_event_type for endOfTurn signalling", () => {
    // Response with only speech_event_type = 3 (SPEECH_ACTIVITY_END), no results
    const responseBytes = concat(tag(4, 0), varint(3));
    const decoded = decodeStreamingRecognizeResponse(responseBytes);
    expect(decoded.results).toHaveLength(0);
    expect(decoded.speechEventType).toBe(3);
  });

  test("decodeStreamingRecognizeResponse skips unknown fields without throwing", () => {
    // Field 99 wire type 0 (varint) with value 42 should be silently skipped
    const responseBytes = concat(tag(99, 0), varint(42));
    const decoded = decodeStreamingRecognizeResponse(responseBytes);
    expect(decoded.results).toEqual([]);
  });
});

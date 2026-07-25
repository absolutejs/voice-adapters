import { describe, expect, test } from "bun:test";
import {
  encodeFrame,
  parseFrames,
  parseTrailerPayload,
} from "../src/grpcFrame";

describe("gRPC framing", () => {
  test("encodeFrame prefixes payload with 5-byte header [flag=0, big-endian length]", () => {
    const frame = encodeFrame(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    expect(Array.from(frame.slice(0, 5))).toEqual([0, 0, 0, 0, 4]);
    expect(Array.from(frame.slice(5))).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  test("parseFrames splits two complete back-to-back frames from one buffer", () => {
    const buffer = new Uint8Array(0);
    const incoming = new Uint8Array([
      ...Array.from(encodeFrame(new Uint8Array([1]))),
      ...Array.from(encodeFrame(new Uint8Array([2, 3]))),
    ]);
    const result = parseFrames(buffer, incoming);
    expect(result.frames).toHaveLength(2);
    expect(Array.from(result.frames[0]!.payload)).toEqual([1]);
    expect(Array.from(result.frames[1]!.payload)).toEqual([2, 3]);
    expect(result.remainder.byteLength).toBe(0);
  });

  test("parseFrames buffers partial frames across chunks", () => {
    const fullFrame = encodeFrame(new Uint8Array([7, 8, 9, 10]));
    const firstHalf = fullFrame.slice(0, 6); // header + 1 byte of payload
    const secondHalf = fullFrame.slice(6);
    const first = parseFrames(new Uint8Array(0), firstHalf);
    expect(first.frames).toHaveLength(0);
    expect(first.remainder.byteLength).toBeGreaterThan(0);
    const second = parseFrames(first.remainder, secondHalf);
    expect(second.frames).toHaveLength(1);
    expect(Array.from(second.frames[0]!.payload)).toEqual([7, 8, 9, 10]);
  });

  test("parseFrames flags trailer frames when high bit of flag byte is set", () => {
    const trailerBody = new TextEncoder().encode("grpc-status: 13\r\n");
    const frame = new Uint8Array(5 + trailerBody.byteLength);
    frame[0] = 0x80;
    new DataView(frame.buffer).setUint32(1, trailerBody.byteLength, false);
    frame.set(trailerBody, 5);
    const result = parseFrames(new Uint8Array(0), frame);
    expect(result.frames).toHaveLength(1);
    expect(result.frames[0]?.isTrailer).toBe(true);
    const headers = parseTrailerPayload(result.frames[0]!.payload);
    expect(headers["grpc-status"]).toBe("13");
  });
});

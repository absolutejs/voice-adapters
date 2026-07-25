import { describe, expect, test } from "bun:test";
import { encodeFrame } from "../src/grpcFrame";
import { googleSpeechStream } from "../src";

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

const buildAlternative = (text: string, confidence?: number) =>
  concat(
    stringField(1, text),
    confidence !== undefined ? float32(2, confidence) : new Uint8Array(0),
  );

const buildStreamingResult = (
  text: string,
  options: {
    isFinal?: boolean;
    languageCode?: string;
    confidence?: number;
  } = {},
) => {
  const parts: Uint8Array[] = [
    lenField(1, buildAlternative(text, options.confidence)),
  ];
  if (options.isFinal) parts.push(boolField(5, true));
  if (options.languageCode) parts.push(stringField(6, options.languageCode));
  return concat(...parts);
};

const buildStreamingResponse = (
  results: Array<{
    text: string;
    isFinal?: boolean;
    languageCode?: string;
    confidence?: number;
  }>,
  speechEventType?: number,
) => {
  const parts: Uint8Array[] = [];
  for (const result of results) {
    parts.push(lenField(6, buildStreamingResult(result.text, result)));
  }
  if (speechEventType !== undefined) {
    parts.push(concat(tag(4, 0), varint(speechEventType)));
  }
  return concat(...parts);
};

type FakeTransport = ReturnType<typeof buildFakeTransport>;

const buildFakeTransport = () => {
  const sent: Uint8Array[] = [];
  const dataHandlers = new Set<(chunk: Uint8Array) => void>();
  const endHandlers = new Set<(trailers: Record<string, string>) => void>();
  const errorHandlers = new Set<(error: Error) => void>();
  let closed = false;
  let closedReason: { code: number; message?: string } | undefined;

  const transport = {
    close: () => {
      closed = true;
    },
    onData: (handler: (chunk: Uint8Array) => void) => {
      dataHandlers.add(handler);
      return () => dataHandlers.delete(handler);
    },
    onEnd: (handler: (trailers: Record<string, string>) => void) => {
      endHandlers.add(handler);
      return () => endHandlers.delete(handler);
    },
    onError: (handler: (error: Error) => void) => {
      errorHandlers.add(handler);
      return () => errorHandlers.delete(handler);
    },
    send: (frame: Uint8Array) => {
      sent.push(frame);
    },
  };

  return {
    closed: () => closed,
    closedReason: () => closedReason,
    emitData: (chunk: Uint8Array) => {
      for (const handler of dataHandlers) handler(chunk);
    },
    emitEnd: (trailers: Record<string, string> = { "grpc-status": "0" }) => {
      for (const handler of endHandlers) handler(trailers);
    },
    emitError: (error: Error) => {
      for (const handler of errorHandlers) handler(error);
    },
    sent,
    transport,
  };
};

const baseOptions = {
  accessToken: "ya29.token",
  project: "test-project",
} as const;

const baseFormat = {
  channels: 1 as const,
  container: "raw" as const,
  encoding: "pcm_s16le" as const,
  sampleRateHz: 16_000,
};

const openSession = async (
  configOverrides: Record<string, unknown> = {},
  openOverrides: Record<string, unknown> = {},
) => {
  const fake = buildFakeTransport();
  const adapter = googleSpeechStream({
    ...baseOptions,
    transport: () => fake.transport,
    ...configOverrides,
  } as Parameters<typeof googleSpeechStream>[0]);
  const session = await adapter.open({
    format: baseFormat,
    sessionId: "s",
    ...openOverrides,
  });
  return { fake, session };
};

describe("googleSpeechStream end-to-end", () => {
  test("first frame sent on open is the streaming_config request", async () => {
    const { fake, session } = await openSession();
    expect(fake.sent).toHaveLength(1);
    // Frame is [5-byte header][protobuf body]. Body should include the
    // recognizer string AND the language code AND the model name.
    const body = fake.sent[0]!.slice(5);
    const text = new TextDecoder().decode(body);
    expect(text).toContain(
      "projects/test-project/locations/global/recognizers/_",
    );
    expect(text).toContain("en-US");
    expect(text).toContain("latest_long");
    await session.close();
  });

  test("subsequent send() calls wrap audio bytes in framed StreamingRecognizeRequest payloads", async () => {
    const { fake, session } = await openSession();
    await session.send(new Uint8Array([1, 2, 3, 4]));
    expect(fake.sent).toHaveLength(2);
    // Second frame body should contain the four audio bytes
    const body = fake.sent[1]!.slice(5);
    const last = body.slice(-4);
    expect(Array.from(last)).toEqual([1, 2, 3, 4]);
    await session.close();
  });

  test("decodes partial and final results into the right events", async () => {
    const { fake, session } = await openSession();
    const partials: string[] = [];
    const finals: { text: string; confidence?: number }[] = [];
    session.on("partial", (event) => partials.push(event.transcript.text));
    session.on("final", (event) =>
      finals.push({
        confidence: event.transcript.confidence,
        text: event.transcript.text,
      }),
    );
    const partialFrame = encodeFrame(
      buildStreamingResponse([{ confidence: 0.85, text: "hello" }]),
    );
    const finalFrame = encodeFrame(
      buildStreamingResponse([
        {
          confidence: 0.95,
          isFinal: true,
          languageCode: "en-us",
          text: "Hello world.",
        },
      ]),
    );
    fake.emitData(partialFrame);
    fake.emitData(finalFrame);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(partials).toEqual(["hello"]);
    expect(finals).toHaveLength(1);
    expect(finals[0]?.text).toBe("Hello world.");
    expect(finals[0]?.confidence).toBeCloseTo(0.95, 3);
    await session.close();
  });

  test("emits endOfTurn when speech_event_type is SPEECH_ACTIVITY_END", async () => {
    const { fake, session } = await openSession();
    const turns: string[] = [];
    session.on("endOfTurn", (event) => turns.push(event.reason));
    fake.emitData(encodeFrame(buildStreamingResponse([], 3)));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(turns).toEqual(["vendor"]);
    await session.close();
  });

  test("reassembles frames split across multiple data chunks", async () => {
    const { fake, session } = await openSession();
    const finals: string[] = [];
    session.on("final", (event) => finals.push(event.transcript.text));
    const fullFrame = encodeFrame(
      buildStreamingResponse([
        { confidence: 0.9, isFinal: true, text: "split frame" },
      ]),
    );
    fake.emitData(fullFrame.slice(0, 4)); // partial header
    fake.emitData(fullFrame.slice(4, 8)); // header end + 3 bytes payload
    fake.emitData(fullFrame.slice(8)); // rest of payload
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(finals).toEqual(["split frame"]);
    await session.close();
  });

  test("language-strategy allow-switching threads primary + secondary into language_codes", async () => {
    const { fake, session } = await openSession(
      {},
      {
        languageStrategy: {
          mode: "allow-switching",
          primaryLanguage: "en-US",
          secondaryLanguages: ["hi-IN", "es-US"],
        },
      },
    );
    const body = new TextDecoder().decode(fake.sent[0]!.slice(5));
    expect(body).toContain("en-US");
    expect(body).toContain("hi-IN");
    expect(body).toContain("es-US");
    await session.close();
  });

  test("grpc trailer with non-zero status emits an error event", async () => {
    const { fake, session } = await openSession();
    const errors: { code?: string; message: string }[] = [];
    session.on("error", (event) =>
      errors.push({ code: event.code, message: event.error.message }),
    );
    fake.emitEnd({
      "grpc-message": "bad audio config",
      "grpc-status": "3",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toEqual([
      {
        code: "3",
        message: "Google Speech gRPC status 3: bad audio config",
      },
    ]);
  });

  test("uses async getAccessToken hook for OAuth refresh", async () => {
    let refreshes = 0;
    await openSession({
      accessToken: undefined,
      getAccessToken: async () => {
        refreshes += 1;
        return "fresh-token";
      },
    });
    expect(refreshes).toBe(1);
  });

  test("rejects unsupported encodings", async () => {
    const fake = buildFakeTransport();
    const adapter = googleSpeechStream({
      ...baseOptions,
      transport: () => fake.transport,
    } as Parameters<typeof googleSpeechStream>[0]);
    await expect(
      adapter.open({
        format: {
          channels: 1,
          container: "raw",
          encoding: "opus" as never,
          sampleRateHz: 48_000,
        },
        sessionId: "s",
      }),
    ).rejects.toThrow(/Unsupported audio encoding/);
  });

  test("requires accessToken or getAccessToken at construction", () => {
    expect(() =>
      googleSpeechStream({
        project: "test",
      } as unknown as Parameters<typeof googleSpeechStream>[0]),
    ).toThrow(/accessToken or getAccessToken/);
  });

  test("requires a project id at construction", () => {
    expect(() =>
      googleSpeechStream({
        accessToken: "t",
      } as unknown as Parameters<typeof googleSpeechStream>[0]),
    ).toThrow(/project id/);
  });
});

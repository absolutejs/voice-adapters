import { describe, expect, test } from "bun:test";
import { cartesia } from "../src";

type Recorded = {
  body: unknown;
  headers: Record<string, string>;
  method: string;
  url: string;
};

const collectHeaders = (init: Headers | undefined) => {
  const out: Record<string, string> = {};
  init?.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
};

const buildFetchStub = (
  respond: (request: Request) => Response | Promise<Response>,
) => {
  const calls: Recorded[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request =
      input instanceof Request
        ? input
        : new Request(input as URL | string, init);
    const cloned = request.clone();
    const body = await cloned
      .text()
      .then((text) => (text ? JSON.parse(text) : undefined))
      .catch(() => undefined);
    calls.push({
      body,
      headers: collectHeaders(request.headers),
      method: request.method,
      url: request.url,
    });
    return respond(request);
  };
  return { calls, fetchImpl };
};

const buildSseBody = (chunks: readonly Uint8Array[]) => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        const base64 = Buffer.from(chunk).toString("base64");
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ data: base64, type: "chunk" })}\n\n`,
          ),
        );
      }
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ type: "done" })}\n\n`),
      );
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream" },
    status: 200,
  });
};

const buildBytesBody = (chunks: readonly Uint8Array[]) => {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
};

const collectAudio = (
  session: ReturnType<ReturnType<typeof cartesia>["open"]> extends Promise<
    infer S
  >
    ? S
    : ReturnType<ReturnType<typeof cartesia>["open"]>,
) => {
  const chunks: Uint8Array[] = [];
  session.on("audio", (event) => {
    const chunk = event.chunk;
    chunks.push(
      chunk instanceof Uint8Array
        ? chunk
        : new Uint8Array(chunk as ArrayBufferLike),
    );
  });
  return chunks;
};

const openSession = async (adapter: ReturnType<typeof cartesia>) => {
  const session = await adapter.open({ sessionId: "session-1" });
  return session;
};

describe("cartesia TTS adapter", () => {
  test("SSE transport posts an authenticated request with the configured voice and model", async () => {
    const { calls, fetchImpl } = buildFetchStub(() =>
      buildSseBody([new Uint8Array([1, 2, 3])]),
    );
    const adapter = cartesia({
      apiKey: "test-key",
      fetch: fetchImpl,
      model: "sonic-2",
      outputFormat: {
        container: "raw",
        encoding: "pcm_s16le",
        sampleRate: 24_000,
      },
      voice: "voice-abc",
    });
    const session = await openSession(adapter);
    const chunks = collectAudio(session);
    await session.send("hello world");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://api.cartesia.ai/tts/sse");
    expect(calls[0]?.headers["x-api-key"]).toBe("test-key");
    expect(calls[0]?.headers["cartesia-version"]).toBe("2024-11-13");
    expect(calls[0]?.body).toMatchObject({
      model_id: "sonic-2",
      output_format: {
        container: "raw",
        encoding: "pcm_s16le",
        sample_rate: 24_000,
      },
      transcript: "hello world",
      voice: { id: "voice-abc", mode: "id" },
    });
    expect(chunks).toHaveLength(1);
    expect(Array.from(chunks[0]!)).toEqual([1, 2, 3]);
    await session.close();
  });

  test("bytes transport streams chunks straight from the response body", async () => {
    const { calls, fetchImpl } = buildFetchStub(() =>
      buildBytesBody([new Uint8Array([10, 11]), new Uint8Array([12, 13])]),
    );
    const adapter = cartesia({
      apiKey: "test-key",
      fetch: fetchImpl,
      transport: "http",
      voice: "voice-abc",
    });
    const session = await openSession(adapter);
    const chunks = collectAudio(session);
    await session.send("hi");
    expect(calls[0]?.url).toBe("https://api.cartesia.ai/tts/bytes");
    expect(chunks).toHaveLength(2);
    expect(Array.from(chunks[0]!)).toEqual([10, 11]);
    expect(Array.from(chunks[1]!)).toEqual([12, 13]);
    await session.close();
  });

  test("emits an error event on non-2xx responses without throwing", async () => {
    const { fetchImpl } = buildFetchStub(
      () =>
        new Response("quota exceeded", {
          status: 429,
          statusText: "Too Many Requests",
        }),
    );
    const adapter = cartesia({
      apiKey: "test-key",
      fetch: fetchImpl,
      voice: "voice-abc",
    });
    const session = await openSession(adapter);
    const errors: string[] = [];
    session.on("error", (event) => {
      errors.push(event.error.message);
    });
    await session.send("hello");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Cartesia returned 429");
    expect(errors[0]).toContain("quota exceeded");
    await session.close();
  });

  test("skips network on whitespace-only input", async () => {
    const { calls, fetchImpl } = buildFetchStub(() =>
      buildSseBody([new Uint8Array([1])]),
    );
    const adapter = cartesia({
      apiKey: "test-key",
      fetch: fetchImpl,
      voice: "voice-abc",
    });
    const session = await openSession(adapter);
    await session.send("   ");
    expect(calls).toHaveLength(0);
    await session.close();
  });

  test("emits a close event with the supplied reason and refuses further sends", async () => {
    const { calls, fetchImpl } = buildFetchStub(() =>
      buildSseBody([new Uint8Array([1])]),
    );
    const adapter = cartesia({
      apiKey: "test-key",
      fetch: fetchImpl,
      voice: "voice-abc",
    });
    const session = await openSession(adapter);
    const reasons: (string | undefined)[] = [];
    session.on("close", (event) => {
      reasons.push(event.reason);
    });
    await session.close("done");
    await session.send("should be ignored");
    expect(reasons).toEqual(["done"]);
    expect(calls).toHaveLength(0);
  });

  test("rejects unsupported output containers at adapter construction", () => {
    expect(() =>
      cartesia({
        apiKey: "test-key",
        outputFormat: { container: "mp3" },
        voice: "voice-abc",
      }),
    ).toThrow(/output_format.container = "raw"/);
  });

  test("honors a CartesiaVoice with embedding mode in the payload", async () => {
    const { calls, fetchImpl } = buildFetchStub(() =>
      buildSseBody([new Uint8Array([1])]),
    );
    const adapter = cartesia({
      apiKey: "test-key",
      fetch: fetchImpl,
      voice: { embedding: [0.1, 0.2, 0.3], mode: "embedding" },
    });
    const session = await openSession(adapter);
    await session.send("hi");
    expect(calls[0]?.body).toMatchObject({
      voice: { embedding: [0.1, 0.2, 0.3], mode: "embedding" },
    });
    await session.close();
  });
});

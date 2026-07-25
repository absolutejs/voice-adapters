import { describe, expect, test } from "bun:test";
import { smallest } from "../src";

type Recorded = {
  body: unknown;
  headers: Record<string, string>;
  method: string;
  url: string;
};

const collectHeaders = (headers: Headers) => {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
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
  session: Awaited<ReturnType<ReturnType<typeof smallest>["open"]>>,
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

describe("smallest TTS adapter", () => {
  test("posts to /api/v1/lightning/get_speech with bearer auth and streams audio body", async () => {
    const { calls, fetchImpl } = buildFetchStub(() =>
      buildBytesBody([new Uint8Array([1, 2, 3])]),
    );
    const adapter = smallest({
      apiKey: "sm-key",
      fetch: fetchImpl,
      voiceId: "george",
    });
    const session = await adapter.open({ sessionId: "s" });
    const chunks = collectAudio(session);
    await session.send("Hello Smallest");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://waves-api.smallest.ai/api/v1/lightning/get_speech",
    );
    expect(calls[0]?.headers["authorization"]).toBe("Bearer sm-key");
    expect(calls[0]?.body).toMatchObject({
      add_wav_header: false,
      sample_rate: 24_000,
      text: "Hello Smallest",
      voice_id: "george",
    });
    expect(chunks).toHaveLength(1);
    await session.close();
  });

  test("routes to the model-specific endpoint when model is overridden", async () => {
    const { calls, fetchImpl } = buildFetchStub(() =>
      buildBytesBody([new Uint8Array([0])]),
    );
    const adapter = smallest({
      apiKey: "k",
      fetch: fetchImpl,
      model: "lightning-v2",
      voiceId: "george",
    });
    const session = await adapter.open({ sessionId: "s" });
    await session.send("hi");
    expect(calls[0]?.url).toBe(
      "https://waves-api.smallest.ai/api/v1/lightning-v2/get_speech",
    );
    await session.close();
  });

  test("forwards speed, similarity, consistency, enhancement, language, sampleRate overrides", async () => {
    const { calls, fetchImpl } = buildFetchStub(() =>
      buildBytesBody([new Uint8Array([0])]),
    );
    const adapter = smallest({
      apiKey: "k",
      consistency: 0.6,
      enhancement: 1,
      fetch: fetchImpl,
      language: "hi",
      sampleRate: 16_000,
      similarity: 0.8,
      speed: 1.1,
      voiceId: "george",
    });
    const session = await adapter.open({ sessionId: "s" });
    await session.send("namaste");
    expect(calls[0]?.body).toMatchObject({
      consistency: 0.6,
      enhancement: 1,
      language: "hi",
      sample_rate: 16_000,
      similarity: 0.8,
      speed: 1.1,
    });
    await session.close();
  });

  test("emits error on non-2xx", async () => {
    const { fetchImpl } = buildFetchStub(
      () =>
        new Response("forbidden", {
          status: 403,
          statusText: "Forbidden",
        }),
    );
    const adapter = smallest({
      apiKey: "k",
      fetch: fetchImpl,
      voiceId: "v",
    });
    const session = await adapter.open({ sessionId: "s" });
    const errors: string[] = [];
    session.on("error", (event) => errors.push(event.error.message));
    await session.send("hi");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Smallest returned 403");
    await session.close();
  });

  test("requires apiKey and voiceId at construction", () => {
    expect(() =>
      smallest({ voiceId: "v" } as unknown as Parameters<typeof smallest>[0]),
    ).toThrow(/apiKey/);
    expect(() =>
      smallest({ apiKey: "k" } as unknown as Parameters<typeof smallest>[0]),
    ).toThrow(/voiceId/);
  });
});

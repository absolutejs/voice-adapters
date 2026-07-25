import { describe, expect, test } from "bun:test";
import { openaiWhisper } from "../src";

type Recorded = {
  body?: FormData;
  headers: Record<string, string>;
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
    const form = await cloned.formData().catch(() => undefined);
    calls.push({
      body: form,
      headers: collectHeaders(request.headers),
      url: request.url,
    });
    return respond(request);
  };
  return { calls, fetchImpl };
};

const jsonResponse = (text: string) =>
  new Response(JSON.stringify({ text }), {
    headers: { "content-type": "application/json" },
    status: 200,
  });

describe("openai-whisper STT adapter", () => {
  test("accumulates audio sends and POSTs a WAV-wrapped form on flush", async () => {
    const { calls, fetchImpl } = buildFetchStub(() =>
      jsonResponse("Hello world."),
    );
    const adapter = openaiWhisper({
      apiKey: "sk-test",
      fetch: fetchImpl,
      language: "en",
    });
    const session = await adapter.open({
      format: {
        channels: 1,
        container: "raw",
        encoding: "pcm_s16le",
        sampleRateHz: 16_000,
      },
      sessionId: "s",
    });
    const finals: string[] = [];
    session.on("final", (event) => finals.push(event.transcript.text));
    await session.send(new Uint8Array([1, 2, 3, 4]));
    await session.send(new Uint8Array([5, 6, 7, 8]));
    expect(calls).toHaveLength(0);
    await session.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://api.openai.com/v1/audio/transcriptions",
    );
    expect(calls[0]?.headers["authorization"]).toBe("Bearer sk-test");
    expect(calls[0]?.body?.get("model")).toBe("whisper-1");
    expect(calls[0]?.body?.get("language")).toBe("en");
    const file = calls[0]?.body?.get("file") as File | null;
    expect(file).not.toBeNull();
    expect(file?.name).toContain(".wav");
    expect(file?.type).toMatch(/^audio\/x?-?wav$/);
    // 44-byte WAV header + 8 bytes audio
    expect(file?.size).toBe(44 + 8);
    expect(finals).toEqual(["Hello world."]);
    await session.close();
  });

  test("close() flushes by default and emits endOfTurn", async () => {
    const { calls, fetchImpl } = buildFetchStub(() =>
      jsonResponse("flush text"),
    );
    const adapter = openaiWhisper({
      apiKey: "sk-test",
      fetch: fetchImpl,
    });
    const session = await adapter.open({
      format: {
        channels: 1,
        container: "raw",
        encoding: "pcm_s16le",
        sampleRateHz: 16_000,
      },
      sessionId: "s",
    });
    const turns: string[] = [];
    session.on("endOfTurn", (event) => turns.push(event.reason));
    await session.send(new Uint8Array([1, 1, 1, 1]));
    await session.close();
    expect(calls).toHaveLength(1);
    expect(turns).toEqual(["vendor"]);
  });

  test("honors flushOnClose=false and skips the final POST", async () => {
    const { calls, fetchImpl } = buildFetchStub(() => jsonResponse("ignored"));
    const adapter = openaiWhisper({
      apiKey: "sk-test",
      fetch: fetchImpl,
      flushOnClose: false,
    });
    const session = await adapter.open({
      format: {
        channels: 1,
        container: "raw",
        encoding: "pcm_s16le",
        sampleRateHz: 16_000,
      },
      sessionId: "s",
    });
    await session.send(new Uint8Array([1, 2, 3]));
    await session.close();
    expect(calls).toHaveLength(0);
  });

  test("forwards languageStrategy primaryLanguage as the language field", async () => {
    const { calls, fetchImpl } = buildFetchStub(() => jsonResponse("hola"));
    const adapter = openaiWhisper({
      apiKey: "sk-test",
      fetch: fetchImpl,
    });
    const session = await adapter.open({
      format: {
        channels: 1,
        container: "raw",
        encoding: "pcm_s16le",
        sampleRateHz: 16_000,
      },
      languageStrategy: {
        mode: "fixed",
        primaryLanguage: "es",
      },
      sessionId: "s",
    });
    await session.send(new Uint8Array([1, 2]));
    await session.flush();
    expect(calls[0]?.body?.get("language")).toBe("es");
    await session.close();
  });

  test("supports the gpt-4o-mini-transcribe and gpt-4o-transcribe models", async () => {
    const { calls, fetchImpl } = buildFetchStub(() => jsonResponse("hi"));
    const adapter = openaiWhisper({
      apiKey: "sk-test",
      fetch: fetchImpl,
      model: "gpt-4o-mini-transcribe",
    });
    const session = await adapter.open({
      format: {
        channels: 1,
        container: "raw",
        encoding: "pcm_s16le",
        sampleRateHz: 16_000,
      },
      sessionId: "s",
    });
    await session.send(new Uint8Array([1]));
    await session.flush();
    expect(calls[0]?.body?.get("model")).toBe("gpt-4o-mini-transcribe");
    await session.close();
  });

  test("emits an error on non-2xx responses", async () => {
    const { fetchImpl } = buildFetchStub(
      () =>
        new Response("rate limited", {
          status: 429,
          statusText: "Too Many Requests",
        }),
    );
    const adapter = openaiWhisper({
      apiKey: "sk-test",
      fetch: fetchImpl,
    });
    const session = await adapter.open({
      format: {
        channels: 1,
        container: "raw",
        encoding: "pcm_s16le",
        sampleRateHz: 16_000,
      },
      sessionId: "s",
    });
    const errors: string[] = [];
    session.on("error", (event) => errors.push(event.error.message));
    await session.send(new Uint8Array([1, 2]));
    await session.flush();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("OpenAI Whisper returned 429");
    await session.close();
  });

  test("throws when buffered audio exceeds maxBufferedBytes", async () => {
    const { fetchImpl } = buildFetchStub(() => jsonResponse(""));
    const adapter = openaiWhisper({
      apiKey: "sk-test",
      fetch: fetchImpl,
      maxBufferedBytes: 8,
    });
    const session = await adapter.open({
      format: {
        channels: 1,
        container: "raw",
        encoding: "pcm_s16le",
        sampleRateHz: 16_000,
      },
      sessionId: "s",
    });
    await expect(session.send(new Uint8Array(16))).rejects.toThrow(
      /buffer overflow/,
    );
    await session.close();
  });

  test("requires apiKey at construction", () => {
    expect(() =>
      openaiWhisper({} as unknown as Parameters<typeof openaiWhisper>[0]),
    ).toThrow(/apiKey/);
  });
});

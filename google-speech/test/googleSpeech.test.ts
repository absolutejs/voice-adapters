import { describe, expect, test } from "bun:test";
import { googleSpeech } from "../src";

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

const jsonResponse = (results: unknown) =>
  new Response(JSON.stringify({ results }), {
    headers: { "content-type": "application/json" },
    status: 200,
  });

const baseFormat = {
  channels: 1 as const,
  container: "raw" as const,
  encoding: "pcm_s16le" as const,
  sampleRateHz: 16_000,
};

describe("googleSpeech STT adapter", () => {
  test("flush() posts JSON with config + base64 audio under the API key query param", async () => {
    const { calls, fetchImpl } = buildFetchStub(() =>
      jsonResponse([
        {
          alternatives: [{ confidence: 0.92, transcript: "Hello" }],
          languageCode: "en-us",
        },
      ]),
    );
    const adapter = googleSpeech({
      apiKey: "g-key",
      fetch: fetchImpl,
    });
    const session = await adapter.open({
      format: baseFormat,
      sessionId: "s",
    });
    const finals: { text: string; confidence?: number }[] = [];
    session.on("final", (event) =>
      finals.push({
        confidence: event.transcript.confidence,
        text: event.transcript.text,
      }),
    );
    await session.send(new Uint8Array([1, 2, 3, 4]));
    await session.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://speech.googleapis.com/v1/speech:recognize?key=g-key",
    );
    expect(calls[0]?.headers["authorization"]).toBeUndefined();
    expect(calls[0]?.body).toMatchObject({
      audio: { content: Buffer.from([1, 2, 3, 4]).toString("base64") },
      config: {
        audioChannelCount: 1,
        encoding: "LINEAR16",
        languageCode: "en-US",
        model: "default",
        sampleRateHertz: 16_000,
      },
    });
    expect(finals).toEqual([{ confidence: 0.92, text: "Hello" }]);
    await session.close();
  });

  test("supports OAuth bearer token via accessToken", async () => {
    const { calls, fetchImpl } = buildFetchStub(() => jsonResponse([]));
    const adapter = googleSpeech({
      accessToken: "ya29.token",
      fetch: fetchImpl,
    });
    const session = await adapter.open({
      format: baseFormat,
      sessionId: "s",
    });
    await session.send(new Uint8Array([1, 2]));
    await session.flush();
    expect(calls[0]?.headers["authorization"]).toBe("Bearer ya29.token");
    expect(calls[0]?.url).toBe(
      "https://speech.googleapis.com/v1/speech:recognize",
    );
    await session.close();
  });

  test("supports getAccessToken async refresh hook", async () => {
    const { calls, fetchImpl } = buildFetchStub(() => jsonResponse([]));
    let refreshes = 0;
    const adapter = googleSpeech({
      fetch: fetchImpl,
      getAccessToken: async () => {
        refreshes += 1;
        return `fresh-${String(refreshes)}`;
      },
    } as Parameters<typeof googleSpeech>[0]);
    const session = await adapter.open({
      format: baseFormat,
      sessionId: "s",
    });
    await session.send(new Uint8Array([1]));
    await session.flush();
    await session.send(new Uint8Array([2]));
    await session.flush();
    expect(calls).toHaveLength(2);
    expect(calls[0]?.headers["authorization"]).toBe("Bearer fresh-1");
    expect(calls[1]?.headers["authorization"]).toBe("Bearer fresh-2");
    await session.close();
  });

  test("emits endOfTurn after each flush even when transcript is empty", async () => {
    const { fetchImpl } = buildFetchStub(() => jsonResponse([]));
    const adapter = googleSpeech({
      apiKey: "g-key",
      fetch: fetchImpl,
    });
    const session = await adapter.open({
      format: baseFormat,
      sessionId: "s",
    });
    const turns: string[] = [];
    session.on("endOfTurn", (event) => turns.push(event.reason));
    await session.send(new Uint8Array([1, 2]));
    await session.flush();
    expect(turns).toEqual(["vendor"]);
    await session.close();
  });

  test("languageStrategy primary + secondary maps to alternativeLanguageCodes", async () => {
    const { calls, fetchImpl } = buildFetchStub(() => jsonResponse([]));
    const adapter = googleSpeech({
      apiKey: "g-key",
      fetch: fetchImpl,
    });
    const session = await adapter.open({
      format: baseFormat,
      languageStrategy: {
        mode: "allow-switching",
        primaryLanguage: "en-US",
        secondaryLanguages: ["hi-IN", "es-US"],
      },
      sessionId: "s",
    });
    await session.send(new Uint8Array([1]));
    await session.flush();
    expect(calls[0]?.body).toMatchObject({
      config: {
        alternativeLanguageCodes: ["hi-IN", "es-US"],
        languageCode: "en-US",
      },
    });
    await session.close();
  });

  test("rejects unsupported encodings", async () => {
    const { fetchImpl } = buildFetchStub(() => jsonResponse([]));
    const adapter = googleSpeech({
      apiKey: "g-key",
      fetch: fetchImpl,
    });
    expect(() =>
      adapter.open({
        format: {
          channels: 1,
          container: "raw",
          encoding: "opus" as never,
          sampleRateHz: 48_000,
        },
        sessionId: "s",
      }),
    ).toThrow(/Unsupported audio encoding/);
  });

  test("emits an error on non-2xx responses", async () => {
    const { fetchImpl } = buildFetchStub(
      () =>
        new Response("quota", {
          status: 429,
          statusText: "Too Many Requests",
        }),
    );
    const adapter = googleSpeech({
      apiKey: "g-key",
      fetch: fetchImpl,
    });
    const session = await adapter.open({
      format: baseFormat,
      sessionId: "s",
    });
    const errors: string[] = [];
    session.on("error", (event) => errors.push(event.error.message));
    await session.send(new Uint8Array([1, 2]));
    await session.flush();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Google Speech returned 429");
    await session.close();
  });

  test("overflow guard throws when buffered audio exceeds maxBufferedBytes", async () => {
    const { fetchImpl } = buildFetchStub(() => jsonResponse([]));
    const adapter = googleSpeech({
      apiKey: "g-key",
      fetch: fetchImpl,
      maxBufferedBytes: 8,
    });
    const session = await adapter.open({
      format: baseFormat,
      sessionId: "s",
    });
    await expect(session.send(new Uint8Array(16))).rejects.toThrow(
      /buffer overflow/,
    );
    await session.close();
  });

  test("requires one of apiKey, accessToken, or getAccessToken", () => {
    expect(() =>
      googleSpeech({} as unknown as Parameters<typeof googleSpeech>[0]),
    ).toThrow(/apiKey, accessToken, or getAccessToken/);
  });
});

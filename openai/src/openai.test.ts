import { describe, expect, test } from "bun:test";
import { openai } from ".";

type WebSocketListener = (event: { [key: string]: unknown }) => void;

class MockWebSocket {
  static lastInstance: MockWebSocket | null = null;
  static instances: MockWebSocket[] = [];

  static reset() {
    MockWebSocket.lastInstance = null;
    MockWebSocket.instances = [];
  }

  readyState = 1;
  url: string;
  protocol = "";
  sent: string[] = [];
  private listeners = new Map<string, Set<WebSocketListener>>();

  constructor(url: string, _options?: unknown) {
    this.url = url;
    MockWebSocket.instances.push(this);
    MockWebSocket.lastInstance = this;

    queueMicrotask(() => {
      this.emit("open", {});
    });
  }

  addEventListener(
    event: string,
    handler: WebSocketListener,
    options?: { once?: boolean },
  ) {
    let normalized = this.listeners.get(event);
    if (!normalized) {
      normalized = new Set();
      this.listeners.set(event, normalized);
    }

    const listener: WebSocketListener = options?.once
      ? (value) => {
          this.listeners.get(event)?.delete(listener);
          handler(value);
        }
      : handler;

    normalized.add(listener);
  }

  removeEventListener(event: string, handler: WebSocketListener) {
    this.listeners.get(event)?.delete(handler);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code?: number, reason?: string) {
    this.readyState = 3;
    this.emit("close", { code, reason });
  }

  emitMessage(payload: Record<string, unknown>) {
    this.emit("message", { data: JSON.stringify(payload) });
  }

  private emit(type: string, event: { [key: string]: unknown }) {
    for (const handler of this.listeners.get(type) ?? new Set()) {
      handler({ ...event, type });
    }
  }
}

type OpenAIRealtimeTestSession = {
  restore: () => void;
  session: Awaited<ReturnType<ReturnType<typeof openai>["open"]>>;
  socket: MockWebSocket;
};

const openRealtimeSession = async (
  emitResponseTranscripts?: boolean,
): Promise<OpenAIRealtimeTestSession> => {
  const originalSocket = globalThis.WebSocket;
  MockWebSocket.reset();

  globalThis.WebSocket = MockWebSocket as never;

  const sessionPromise = openai({
    apiKey: "test-key",
    model: "gpt-realtime-mini",
    emitResponseTranscripts,
  }).open({
    format: {
      channels: 1,
      container: "raw",
      encoding: "pcm_s16le",
      sampleRateHz: 24_000,
    },
    sessionId: "openai-unit",
  });

  await Bun.sleep(0);
  const socket = MockWebSocket.lastInstance!;
  if (!socket) {
    globalThis.WebSocket = originalSocket;
    throw new Error("Mock WebSocket was not created.");
  }

  socket.emitMessage({ type: "session.updated" });
  const session = await sessionPromise;

  return {
    restore: () => {
      globalThis.WebSocket = originalSocket;
    },
    session,
    socket,
  };
};

const withOpenAIRealtimeSession = async (
  emitResponseTranscripts: boolean | undefined,
  callback: (
    session: OpenAIRealtimeTestSession["session"],
    socket: MockWebSocket,
  ) => Promise<void>,
) => {
  const { restore, session, socket } = await openRealtimeSession(
    emitResponseTranscripts,
  );
  try {
    await callback(session, socket);
  } finally {
    await session.close("unit-complete");
    restore();
  }
};

describe("openai adapter", () => {
  test("requests and preserves input transcription log probabilities", async () => {
    await withOpenAIRealtimeSession(undefined, async (session, socket) => {
      const finalEvents: Array<{
        transcript: { confidence?: number; tokens?: unknown[] };
      }> = [];
      session.on("final", (event) => {
        finalEvents.push(event);
      });

      const update = socket.sent
        .map((entry) => JSON.parse(entry))
        .find((entry) => entry.type === "session.update");
      expect(update.session.include).toEqual([
        "item.input_audio_transcription.logprobs",
      ]);

      socket.emitMessage({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "item-logprobs",
        transcript: "OnSpark",
        logprobs: [
          { token: "On", logprob: Math.log(0.8), bytes: [79, 110] },
          { token: "Spark", logprob: Math.log(0.6) },
        ],
      });

      expect(finalEvents).toHaveLength(1);
      expect(finalEvents[0]?.transcript.confidence).toBeCloseTo(0.7);
      expect(finalEvents[0]?.transcript.tokens).toEqual([
        {
          bytes: [79, 110],
          confidence: 0.8,
          logProbability: Math.log(0.8),
          text: "On",
        },
        {
          bytes: undefined,
          confidence: 0.6,
          logProbability: Math.log(0.6),
          text: "Spark",
        },
      ]);
    });
  });

  test("deduplicates input audio completion turns", async () => {
    await withOpenAIRealtimeSession(undefined, async (session, socket) => {
      const finalEvents: Array<unknown> = [];
      const endOfTurnEvents: Array<unknown> = [];

      const unsubscribe = [
        session.on("final", (event) => {
          finalEvents.push(event);
        }),
        session.on("endOfTurn", (event) => {
          endOfTurnEvents.push(event);
        }),
      ];

      socket.emitMessage({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "item-1",
        transcript: "hello world",
      });
      socket.emitMessage({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "item-1",
        transcript: "hello world",
      });

      expect(finalEvents).toHaveLength(1);
      expect(endOfTurnEvents).toHaveLength(1);

      for (const unsubscribeFromEvent of unsubscribe) {
        unsubscribeFromEvent();
      }
    });
  });

  test("defaults to ignoring response transcript events", async () => {
    await withOpenAIRealtimeSession(false, async (session, socket) => {
      const finalEvents: Array<unknown> = [];

      session.on("final", (event) => {
        finalEvents.push(event);
      });

      socket.emitMessage({
        type: "response.output_text.delta",
        delta: "hello",
      });
      socket.emitMessage({
        type: "response.output_text.done",
        transcript: "hello",
      });

      expect(finalEvents).toHaveLength(0);
    });
  });

  test("emits response transcript events when explicitly enabled", async () => {
    await withOpenAIRealtimeSession(true, async (session, socket) => {
      const finalEvents: Array<unknown> = [];
      const endOfTurnEvents: Array<unknown> = [];

      session.on("final", (event) => {
        finalEvents.push(event);
      });
      session.on("endOfTurn", (event) => {
        endOfTurnEvents.push(event);
      });

      socket.emitMessage({
        type: "response.output_text.delta",
        delta: "hello",
      });
      socket.emitMessage({
        type: "response.output_text.done",
        transcript: "hello",
      });

      expect(finalEvents).toHaveLength(1);
      expect(endOfTurnEvents).toHaveLength(1);
    });
  });
});

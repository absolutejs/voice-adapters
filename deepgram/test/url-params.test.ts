import { describe, expect, test } from "bun:test";
import { deepgram } from "../src";

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
  private listeners = new Map<string, Set<WebSocketListener>>();

  constructor(url: string) {
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

  send() {
    //
  }

  close(code?: number, reason?: string) {
    this.readyState = 3;
    this.emit("close", { code, reason });
  }

  private emit(type: string, event: { [key: string]: unknown }) {
    for (const handler of this.listeners.get(type) ?? new Set()) {
      handler({ ...event, type });
    }
  }
}

describe("deepgram adapter", () => {
  test("maps model-improvement opt-out into the websocket URL", async () => {
    const originalSocket = globalThis.WebSocket;
    MockWebSocket.reset();
    try {
      globalThis.WebSocket = MockWebSocket as never;

      const session = await deepgram({
        apiKey: "test-key",
        mipOptOut: true,
        model: "nova-3",
      }).open({
        format: {
          channels: 1,
          container: "raw",
          encoding: "pcm_s16le",
          sampleRateHz: 16000,
        },
        sessionId: "unit-mip-opt-out",
      });
      await session.close("unit");

      expect(MockWebSocket.lastInstance).not.toBeNull();
      const url = new URL(MockWebSocket.lastInstance!.url);
      expect(url.searchParams.get("mip_opt_out")).toBe("true");
    } finally {
      globalThis.WebSocket = originalSocket;
    }
  });

  test("omits model-improvement preference when it is not configured", async () => {
    const originalSocket = globalThis.WebSocket;
    MockWebSocket.reset();
    try {
      globalThis.WebSocket = MockWebSocket as never;

      const session = await deepgram({
        apiKey: "test-key",
        model: "flux-general-en",
      }).open({
        format: {
          channels: 1,
          container: "raw",
          encoding: "pcm_s16le",
          sampleRateHz: 16000,
        },
        sessionId: "unit-mip-default",
      });
      await session.close("unit");

      expect(MockWebSocket.lastInstance).not.toBeNull();
      const url = new URL(MockWebSocket.lastInstance!.url);
      expect(url.searchParams.get("mip_opt_out")).toBeNull();
    } finally {
      globalThis.WebSocket = originalSocket;
    }
  });

  test("does not include undefined query params in websocket URL", async () => {
    const originalSocket = globalThis.WebSocket;
    MockWebSocket.reset();
    try {
      globalThis.WebSocket = MockWebSocket as never;

      const session = await deepgram({
        apiKey: "test-key",
        model: "nova-3",
        punctuate: true,
        smartFormat: true,
      }).open({
        format: {
          channels: 1,
          container: "raw",
          encoding: "pcm_s16le",
          sampleRateHz: 16000,
        },
        sessionId: "unit-1",
      });
      await session.close("unit");

      expect(MockWebSocket.lastInstance).not.toBeNull();
      const url = new URL(MockWebSocket.lastInstance!.url);
      const language = url.searchParams.get("language");
      const channels = url.searchParams.get("channels");

      expect(language).toBeNull();
      expect(channels).toBe("1");
    } finally {
      globalThis.WebSocket = originalSocket;
    }
  });

  test("applies Flux conversation defaults when thresholds are omitted", async () => {
    const originalSocket = globalThis.WebSocket;
    MockWebSocket.reset();
    try {
      globalThis.WebSocket = MockWebSocket as never;

      const session = await deepgram({
        apiKey: "test-key",
        model: "flux-general-en",
      }).open({
        format: {
          channels: 1,
          container: "raw",
          encoding: "pcm_s16le",
          sampleRateHz: 16000,
        },
        sessionId: "unit-flux-defaults",
      });
      await session.close("unit");

      expect(MockWebSocket.lastInstance).not.toBeNull();
      const url = new URL(MockWebSocket.lastInstance!.url);

      expect(url.searchParams.get("eager_eot_threshold")).toBe("0.8");
      expect(url.searchParams.get("eot_threshold")).toBe("0.82");
      expect(url.searchParams.get("eot_timeout_ms")).toBe("1200");
    } finally {
      globalThis.WebSocket = originalSocket;
    }
  });

  test("promotes flux to multilingual model for fixed non-English language strategies", async () => {
    const originalSocket = globalThis.WebSocket;
    MockWebSocket.reset();
    try {
      globalThis.WebSocket = MockWebSocket as never;

      const session = await deepgram({
        apiKey: "test-key",
        model: "flux",
      }).open({
        format: {
          channels: 1,
          container: "raw",
          encoding: "pcm_s16le",
          sampleRateHz: 16000,
        },
        languageStrategy: {
          mode: "fixed",
          primaryLanguage: "fr",
        },
        sessionId: "unit-flux-fixed-fr",
      });
      await session.close("unit");

      expect(MockWebSocket.lastInstance).not.toBeNull();
      const url = new URL(MockWebSocket.lastInstance!.url);

      expect(url.searchParams.get("model")).toBe("flux-general-multi");
    } finally {
      globalThis.WebSocket = originalSocket;
    }
  });

  test("promotes flux to multilingual model for switching language strategies", async () => {
    const originalSocket = globalThis.WebSocket;
    MockWebSocket.reset();
    try {
      globalThis.WebSocket = MockWebSocket as never;

      const session = await deepgram({
        apiKey: "test-key",
        model: "flux",
      }).open({
        format: {
          channels: 1,
          container: "raw",
          encoding: "pcm_s16le",
          sampleRateHz: 16000,
        },
        languageStrategy: {
          mode: "allow-switching",
          primaryLanguage: "ca",
          secondaryLanguages: ["es"],
        },
        sessionId: "unit-flux-switching",
      });
      await session.close("unit");

      expect(MockWebSocket.lastInstance).not.toBeNull();
      const url = new URL(MockWebSocket.lastInstance!.url);

      expect(url.searchParams.get("model")).toBe("flux-general-multi");
    } finally {
      globalThis.WebSocket = originalSocket;
    }
  });

  test("merges phrase hints from open options into keyterms", async () => {
    const originalSocket = globalThis.WebSocket;
    MockWebSocket.reset();
    try {
      globalThis.WebSocket = MockWebSocket as never;

      const session = await deepgram({
        apiKey: "test-key",
        keyterms: ["support"],
        model: "nova-3",
      }).open({
        format: {
          channels: 1,
          container: "raw",
          encoding: "pcm_s16le",
          sampleRateHz: 16000,
        },
        phraseHints: [
          {
            aliases: ["absolute js"],
            text: "AbsoluteJS",
          },
        ],
        sessionId: "unit-phrase-hints",
      });
      await session.close("unit");

      expect(MockWebSocket.lastInstance).not.toBeNull();
      const url = new URL(MockWebSocket.lastInstance!.url);
      const keyterms = url.searchParams.getAll("keyterm");

      expect(keyterms).toContain("support");
      expect(keyterms).toContain("AbsoluteJS");
      expect(keyterms).toContain("absolute js");
    } finally {
      globalThis.WebSocket = originalSocket;
    }
  });

  test("merges lexicon entries from open options into keyterms", async () => {
    const originalSocket = globalThis.WebSocket;
    MockWebSocket.reset();
    try {
      globalThis.WebSocket = MockWebSocket as never;

      const session = await deepgram({
        apiKey: "test-key",
        keyterms: ["support"],
        model: "nova-3",
      }).open({
        format: {
          channels: 1,
          container: "raw",
          encoding: "pcm_s16le",
          sampleRateHz: 16000,
        },
        lexicon: [
          {
            aliases: ["absoloot js"],
            pronunciation: "ab-so-lute jay ess",
            text: "AbsoluteJS",
          },
        ],
        sessionId: "unit-lexicon",
      });
      await session.close("unit");

      expect(MockWebSocket.lastInstance).not.toBeNull();
      const url = new URL(MockWebSocket.lastInstance!.url);
      const keyterms = url.searchParams.getAll("keyterm");

      expect(keyterms).toContain("support");
      expect(keyterms).toContain("AbsoluteJS");
      expect(keyterms).toContain("absoloot js");
    } finally {
      globalThis.WebSocket = originalSocket;
    }
  });

  test("uses Nova-2 keywords instead of unsupported keyterms", async () => {
    const originalSocket = globalThis.WebSocket;
    MockWebSocket.reset();
    try {
      globalThis.WebSocket = MockWebSocket as never;

      const session = await deepgram({
        apiKey: "test-key",
        keyterms: ["support"],
        model: "nova-2",
      }).open({
        format: {
          channels: 1,
          container: "raw",
          encoding: "pcm_s16le",
          sampleRateHz: 16000,
        },
        lexicon: [
          {
            aliases: ["on spark"],
            text: "onSpark",
          },
        ],
        sessionId: "unit-nova-2-keywords",
      });
      await session.close("unit");

      expect(MockWebSocket.lastInstance).not.toBeNull();
      const url = new URL(MockWebSocket.lastInstance!.url);
      const keywords = url.searchParams.getAll("keywords");

      expect(keywords).toContain("support");
      expect(keywords).toContain("onSpark");
      expect(keywords).toContain("on spark");
      expect(url.searchParams.has("keyterm")).toBe(false);
    } finally {
      globalThis.WebSocket = originalSocket;
    }
  });

  test("caps oversized keyterm lists to a transport-safe subset", async () => {
    const originalSocket = globalThis.WebSocket;
    MockWebSocket.reset();
    try {
      globalThis.WebSocket = MockWebSocket as never;

      const session = await deepgram({
        apiKey: "test-key",
        model: "nova-3",
      }).open({
        format: {
          channels: 1,
          container: "raw",
          encoding: "pcm_s16le",
          sampleRateHz: 16000,
        },
        lexicon: Array.from({ length: 300 }, (_, index) => ({
          text:
            index === 0
              ? "complain कर लो"
              : index === 1
                ? "future opportunities"
                : `very long benchmark keyterm ${index}`,
        })),
        sessionId: "unit-keyterm-cap",
      });
      await session.close("unit");

      expect(MockWebSocket.lastInstance).not.toBeNull();
      const url = new URL(MockWebSocket.lastInstance!.url);
      const keyterms = url.searchParams.getAll("keyterm");

      // An oversized dictionary is admitted up to Deepgram's 500-token-per-
      // request ceiling (not an arbitrary fixed count): far more than the old
      // 16, while total estimated tokens stay safely under the budget.
      const estimatedTokens = keyterms.reduce(
        (sum, term) => sum + Math.max(1, Math.ceil(term.trim().length / 4)),
        0,
      );
      expect(keyterms.length).toBeGreaterThan(16);
      expect(estimatedTokens).toBeLessThanOrEqual(450);
      // Highest-relevance terms (multi-script, multi-word) survive the budget.
      expect(keyterms).toContain("complain कर लो");
      expect(keyterms).toContain("future opportunities");
    } finally {
      globalThis.WebSocket = originalSocket;
    }
  });
});

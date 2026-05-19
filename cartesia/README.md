# `@absolutejs/voice-cartesia`

Cartesia text-to-speech adapter for `@absolutejs/voice`.

Wraps Cartesia's `/tts/sse` (default) and `/tts/bytes` HTTP endpoints behind the `TTSAdapter` seam exposed by `@absolutejs/voice`. Streams audio chunks straight from the response body so the voice runtime can start playback as soon as Cartesia returns the first frame.

## Install

```sh
bun add @absolutejs/voice-cartesia
```

This package declares `@absolutejs/voice` as a runtime dependency.

## Use

```ts
import { voice } from "@absolutejs/voice";
import { cartesia } from "@absolutejs/voice-cartesia";

const app = voice({
  // ... stt + other voice options ...
  tts: cartesia({
    apiKey: process.env.CARTESIA_API_KEY!,
    model: "sonic-2",
    outputFormat: {
      container: "raw",
      encoding: "pcm_s16le",
      sampleRate: 24_000,
    },
    voice: "a0e99841-438c-4a64-b679-ae501e7d6091",
  }),
});
```

For telephony (8 kHz μ-law):

```ts
cartesia({
  apiKey,
  voice: voiceId,
  outputFormat: {
    container: "raw",
    encoding: "pcm_mulaw",
    sampleRate: 8_000,
  },
});
```

## Options

| Option | Required | Default | Notes |
| --- | --- | --- | --- |
| `apiKey` | yes | — | Cartesia API key. |
| `voice` | yes | — | Either a voice id string (shorthand for `{ id, mode: "id" }`) or `{ embedding, mode: "embedding" }` for live cloning. |
| `model` | no | `"sonic-2"` | Cartesia model id. |
| `outputFormat.container` | no | `"raw"` | Must be `"raw"` for streaming. |
| `outputFormat.encoding` | no | `"pcm_s16le"` | `pcm_s16le`, `pcm_f32le`, `pcm_mulaw` (telephony), or `pcm_alaw`. |
| `outputFormat.sampleRate` | no | `24_000` | 8 / 16 / 22_050 / 24 / 44.1 / 48 kHz. |
| `language` | no | — | Forwarded to Cartesia. |
| `speed` | no | — | `slow` / `normal` / `fast` or a numeric multiplier. |
| `transport` | no | `"sse"` | `"sse"` (server-sent events with base64 frames) or `"http"` (raw chunked bytes). |
| `version` | no | `"2024-11-13"` | `Cartesia-Version` header. |
| `baseUrl` | no | `"https://api.cartesia.ai"` | Override for self-hosted or staging environments. |
| `fetch` | no | `globalThis.fetch` | Inject for tests; opportunistic HTTP/2 multiplexing is enabled for HTTPS targets. |

## Notes

- Only the `raw` container is supported because the voice runtime needs framed PCM/μ-law/α-law to feed transports. If you need `mp3` or `wav` for offline files, use the Cartesia SDK directly.
- The adapter aborts the in-flight HTTP request on `session.close(reason)` and refuses further `send()` calls. No reconnect/keep-alive is needed for HTTP transports.
- Whitespace-only `send()` is a no-op (no network call, matching the ElevenLabs adapter).

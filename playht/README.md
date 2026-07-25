# `@absolutejs/voice-playht`

PlayHT text-to-speech adapter for `@absolutejs/voice`.

Wraps PlayHT's `/api/v2/tts/stream` HTTP endpoint behind the `TTSAdapter` seam so the voice runtime can stream Play3.0-mini / PlayDialog / PlayHT2.0-turbo audio out as soon as the first byte arrives.

## Install

```sh
bun add @absolutejs/voice-playht
```

`@absolutejs/voice` is a runtime dependency.

## Use

```ts
import { voice } from "@absolutejs/voice";
import { playht } from "@absolutejs/voice-playht";

const app = voice({
  // ... stt + other voice options ...
  tts: playht({
    apiKey: process.env.PLAYHT_API_KEY!,
    userId: process.env.PLAYHT_USER_ID!,
    voice: "s3://voice-cloning-zero-shot/.../jennifer.json",
    // optional:
    voiceEngine: "Play3.0-mini", // default
    outputFormat: "raw", // default
    sampleRate: 24_000, // default
    language: "english",
    quality: "premium",
    speed: 1.0,
    temperature: 1.0,
    voiceGuidance: 1.5,
  }),
});
```

For telephony at 8 kHz μ-law:

```ts
playht({
  apiKey,
  userId,
  voice,
  outputFormat: "mulaw", // PlayHT serves μ-law @ 8 kHz
});
```

## Options

| Option                                                         | Required | Default               | Notes                                                                                                                             |
| -------------------------------------------------------------- | -------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `apiKey`                                                       | yes      | —                     | PlayHT API key, sent as `Authorization: Bearer <key>`.                                                                            |
| `userId`                                                       | yes      | —                     | PlayHT user id, sent as `X-USER-ID`.                                                                                              |
| `voice`                                                        | yes      | —                     | Voice id string (`s3://...json` for stock voices, or your own cloned voice id).                                                   |
| `voiceEngine`                                                  | no       | `Play3.0-mini`        | `Play3.0-mini` / `PlayDialog` / `PlayHT2.0-turbo` / `PlayHT2.0`.                                                                  |
| `outputFormat`                                                 | no       | `raw`                 | Must be `raw` (PCM s16le) or `mulaw` (telephony @ 8 kHz). `mp3`/`wav` are rejected because they aren't streamable frame-by-frame. |
| `sampleRate`                                                   | no       | `24_000`              | Ignored for `mulaw` (PlayHT forces 8 kHz).                                                                                        |
| `language`, `quality`, `speed`, `temperature`, `voiceGuidance` | no       | —                     | Forwarded as-is to PlayHT.                                                                                                        |
| `baseUrl`                                                      | no       | `https://api.play.ht` | Override for staging / enterprise hosts.                                                                                          |
| `fetch`                                                        | no       | `globalThis.fetch`    | Inject for tests; opportunistic HTTP/2 multiplexing is enabled for HTTPS targets.                                                 |

## Notes

- `session.close(reason)` aborts in-flight requests and refuses further `send()` calls.
- Whitespace-only `send()` is a no-op (matches the Cartesia / ElevenLabs / Azure adapters).
- This adapter does not currently use PlayHT's WebSocket streaming endpoint; for low TTFB, the HTTP streaming endpoint is good enough. Open an issue if you need WebSocket.

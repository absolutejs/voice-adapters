# `@absolutejs/voice-lmnt`

LMNT text-to-speech adapter for `@absolutejs/voice`.

Wraps LMNT's `/v1/ai/speech/stream` HTTP endpoint behind voice's `TTSAdapter` seam for fast, low-latency TTS using the aurora / blizzard / mochi models.

## Install

```sh
bun add @absolutejs/voice-lmnt
```

`@absolutejs/voice` is a runtime dependency.

## Use

```ts
import { voice } from "@absolutejs/voice";
import { lmnt } from "@absolutejs/voice-lmnt";

const app = voice({
  tts: lmnt({
    apiKey: process.env.LMNT_API_KEY!,
    voice: "lily",
    // optional:
    model: "aurora",            // default; or 'blizzard' / 'mochi'
    format: "raw",              // default; or 'mulaw' for telephony
    sampleRate: 24_000,         // default
    language: "en",             // 'auto' to detect
    speed: 1.0,
    temperature: 0.6,
    topP: 0.95,
    conversational: true,
  }),
});
```

For telephony at 8 kHz μ-law:

```ts
lmnt({ apiKey, voice: "lily", format: "mulaw" });
```

## Options

| Option | Required | Default | Notes |
| --- | --- | --- | --- |
| `apiKey` | yes | — | LMNT API key, sent as `X-API-Key`. |
| `voice` | yes | — | LMNT voice id. |
| `model` | no | `aurora` | LMNT model id. |
| `format` | no | `raw` | Must be `raw` (PCM s16le) or `mulaw` (telephony @ 8 kHz). `mp3` / `wav` are rejected because they aren't streamable frame-by-frame. |
| `sampleRate` | no | `24_000` | Ignored for `mulaw`. |
| `language` | no | — | BCP-47-ish code, or `auto`. |
| `speed`, `temperature`, `topP`, `seed`, `conversational` | no | — | Forwarded to LMNT. |
| `baseUrl` | no | `https://api.lmnt.com` | Override for staging hosts. |
| `fetch` | no | `globalThis.fetch` | Inject for tests; opportunistic HTTP/2 multiplexing on outbound HTTPS. |

## Notes

- Whitespace-only `send()` is a no-op.
- `session.close(reason)` aborts in-flight requests and refuses further sends.
- This adapter uses LMNT's HTTP streaming endpoint. If you need their WebSocket transport, open an issue.

# `@absolutejs/voice-rime`

Rime text-to-speech adapter for `@absolutejs/voice`.

Wraps Rime's `/v1/rime-tts` HTTP streaming endpoint behind voice's `TTSAdapter` seam. Supports the mist / mistv2 / arcana voice models for fast, conversational TTS.

## Install

```sh
bun add @absolutejs/voice-rime
```

`@absolutejs/voice` is a runtime dependency.

## Use

```ts
import { voice } from "@absolutejs/voice";
import { rime } from "@absolutejs/voice-rime";

const app = voice({
  // ... stt + other voice options ...
  tts: rime({
    apiKey: process.env.RIME_API_KEY!,
    speaker: "cove",
    // optional:
    modelId: "mistv2",           // default; or 'mist' / 'arcana'
    audioFormat: "pcm",          // default; or 'mulaw' for telephony
    sampleRate: 22_050,          // default
    speedAlpha: 1.0,
    lang: "eng",
    reduceLatency: true,
    pauseBetweenBrackets: true,
    phonemizeBetweenBrackets: true,
  }),
});
```

For telephony at 8 kHz μ-law:

```ts
rime({
  apiKey,
  speaker: "cove",
  audioFormat: "mulaw",
});
```

## Options

| Option | Required | Default | Notes |
| --- | --- | --- | --- |
| `apiKey` | yes | — | Rime API key, sent as `Authorization: Bearer <key>`. |
| `speaker` | yes | — | Rime speaker id (`cove`, `marsh`, `river`, etc.). |
| `modelId` | no | `mistv2` | `mist`, `mistv2`, `arcana`, or a future Rime model id. |
| `audioFormat` | no | `pcm` | Must be `pcm` (PCM s16le) or `mulaw` (telephony @ 8 kHz). |
| `sampleRate` | no | `22050` | Ignored for `mulaw`. |
| `lang` | no | — | Language hint (`eng`, etc.). |
| `speedAlpha`, `inlineSpeedAlpha` | no | — | Forwarded to Rime. |
| `reduceLatency`, `pauseBetweenBrackets`, `phonemizeBetweenBrackets`, `noTextNormalization` | no | — | Forwarded as boolean controls. |
| `baseUrl` | no | `https://users.rime.ai` | Override for staging hosts. |
| `fetch` | no | `globalThis.fetch` | Inject for tests; opportunistic HTTP/2 multiplexing on outbound HTTPS. |

## Notes

- Whitespace-only `send()` is a no-op.
- `session.close(reason)` aborts in-flight requests and refuses further sends.
- This adapter targets Rime's HTTP streaming endpoint. If you need their WebSocket transport, open an issue.

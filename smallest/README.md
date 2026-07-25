# `@absolutejs/voice-smallest`

Smallest AI text-to-speech adapter for `@absolutejs/voice`.

Wraps Smallest AI's `/api/v1/{model}/get_speech` HTTP endpoint behind voice's `TTSAdapter` seam. Lightning + Lightning-v2 models, English + Hindi.

## Install

```sh
bun add @absolutejs/voice-smallest
```

`@absolutejs/voice` is a runtime dependency.

## Use

```ts
import { voice } from "@absolutejs/voice";
import { smallest } from "@absolutejs/voice-smallest";

const app = voice({
  tts: smallest({
    apiKey: process.env.SMALLEST_API_KEY!,
    voiceId: "george",
    // optional:
    model: "lightning", // default; or 'lightning-v2'
    sampleRate: 24_000, // default
    language: "en",
    speed: 1.0,
    similarity: 0.5,
    consistency: 0.5,
    enhancement: 1,
  }),
});
```

## Options

| Option                                              | Required | Default                         | Notes                                                                    |
| --------------------------------------------------- | -------- | ------------------------------- | ------------------------------------------------------------------------ |
| `apiKey`                                            | yes      | —                               | Smallest API key, sent as `Authorization: Bearer <key>`.                 |
| `voiceId`                                           | yes      | —                               | Smallest voice id.                                                       |
| `model`                                             | no       | `lightning`                     | Selects the URL path segment (`/api/v1/{model}/get_speech`).             |
| `sampleRate`                                        | no       | `24_000`                        | Forwarded as `sample_rate`. Adapter emits PCM s16le frames at this rate. |
| `language`                                          | no       | —                               | `en`, `hi`.                                                              |
| `speed`, `similarity`, `consistency`, `enhancement` | no       | —                               | Forwarded to Smallest.                                                   |
| `baseUrl`                                           | no       | `https://waves-api.smallest.ai` | Override for staging.                                                    |
| `fetch`                                             | no       | `globalThis.fetch`              | Inject for tests; opportunistic HTTP/2 multiplexing on outbound HTTPS.   |

## Notes

- Whitespace-only `send()` is a no-op.
- Adapter requests `add_wav_header: false` so the body is raw PCM.
- `session.close(reason)` aborts in-flight requests and refuses further sends.

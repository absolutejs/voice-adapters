# `@absolutejs/voice-neets`

Neets text-to-speech adapter for `@absolutejs/voice`.

Wraps Neets's `/v1/tts` HTTP endpoint for low-cost TTS using their ar-diff-50k / style-tts-2 / vits models. Streams audio body straight through to voice's runtime.

## Install

```sh
bun add @absolutejs/voice-neets
```

`@absolutejs/voice` is a runtime dependency.

## Use

```ts
import { voice } from "@absolutejs/voice";
import { neets } from "@absolutejs/voice-neets";

const app = voice({
  tts: neets({
    apiKey: process.env.NEETS_API_KEY!,
    voiceId: "us-male-2",
    // optional:
    model: "ar-diff-50k", // default; or 'style-tts-2' / 'vits'
    format: "pcm", // default; only "pcm" is supported for streaming
    sampleRate: 22_050, // default
    language: "en-us",
    temperature: 0.7,
  }),
});
```

## Options

| Option        | Required | Default                | Notes                                                                                    |
| ------------- | -------- | ---------------------- | ---------------------------------------------------------------------------------------- |
| `apiKey`      | yes      | —                      | Neets API key, sent as `X-API-Key`.                                                      |
| `voiceId`     | yes      | —                      | Neets voice id.                                                                          |
| `model`       | no       | `ar-diff-50k`          | `ar-diff-50k`, `style-tts-2`, `vits`, or a future Neets model id.                        |
| `format`      | no       | `pcm`                  | Must be `pcm`. `mp3` / `wav` are rejected because they aren't streamable frame-by-frame. |
| `sampleRate`  | no       | `22050`                | Forwarded as `sample_rate`.                                                              |
| `language`    | no       | —                      | Forwarded as `language` (e.g. `en-us`, `es-es`).                                         |
| `temperature` | no       | —                      | Forwarded inside `params`.                                                               |
| `baseUrl`     | no       | `https://api.neets.ai` | Override for staging.                                                                    |
| `fetch`       | no       | `globalThis.fetch`     | Inject for tests; opportunistic HTTP/2 multiplexing on outbound HTTPS.                   |

## Notes

- Whitespace-only `send()` is a no-op.
- `session.close(reason)` aborts in-flight requests and refuses further sends.

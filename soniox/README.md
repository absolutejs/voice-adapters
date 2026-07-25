# `@absolutejs/voice-soniox`

Soniox real-time speech-to-text adapter for `@absolutejs/voice`.

Speaks Soniox's real-time WebSocket protocol directly: connect → send a JSON start-config message carrying the `api_key` and audio shape → stream binary audio frames → consume token-by-token transcript messages with `is_final` flags → emit `partial` / `final` / `endOfTurn` events. No Soniox SDK dep.

## Install

```sh
bun add @absolutejs/voice-soniox
```

`@absolutejs/voice` is a runtime dependency.

## Use

```ts
import { voice } from "@absolutejs/voice";
import { soniox } from "@absolutejs/voice-soniox";

const app = voice({
  stt: soniox({
    apiKey: process.env.SONIOX_API_KEY!,
    // optional:
    model: "stt-rt-preview", // default
    languageHints: ["en", "es"],
    enableLanguageIdentification: true,
    enableSpeakerDiarization: true,
    enableEndpointDetection: true,
    context: "Customer support call about billing.",
  }),
  // ... tts + other options ...
});
```

For mixed-language callers, pair with `languageStrategy`:

```ts
soniox({
  apiKey,
  enableLanguageIdentification: true,
});
// open(...) with languageStrategy: { mode: 'allow-switching', primaryLanguage: 'en', secondaryLanguages: ['hi'] }
```

## Options

| Option                         | Required | Default                   | Notes                                                                                |
| ------------------------------ | -------- | ------------------------- | ------------------------------------------------------------------------------------ |
| `apiKey`                       | yes      | —                         | Soniox API key (sent in the start-config message body, not as a header).             |
| `model`                        | no       | `stt-rt-preview`          | Soniox real-time model id.                                                           |
| `languageHints`                | no       | —                         | Seed list, overridden when `STTAdapterOpenOptions.languageStrategy` resolves a list. |
| `enableLanguageIdentification` | no       | —                         | Tag each token with the detected language.                                           |
| `enableSpeakerDiarization`     | no       | —                         | Tag each token with a speaker id.                                                    |
| `enableEndpointDetection`      | no       | —                         | Surface `finished: true` end-of-utterance hints (→ `endOfTurn`).                     |
| `context`                      | no       | —                         | Context string passed to Soniox to bias recognition.                                 |
| `clientReferenceId`            | no       | —                         | Caller-defined id forwarded to Soniox for billing analytics.                         |
| `baseUrl`                      | no       | `wss://stt-rt.soniox.com` | Override for staging / enterprise endpoints.                                         |
| `connectTimeoutMs`             | no       | `8000`                    | WebSocket open + config timeout.                                                     |
| `webSocket.factory`            | no       | `new WebSocket(url)`      | Inject a fake socket for tests.                                                      |

## Notes

- Audio sent before the start-config is sent is buffered and flushed once the socket is open.
- Tokens are bucketed by `is_final` per message: non-final tokens combine into a `partial` event, final tokens into a `final` event (a single message can produce both).
- Average per-token confidence is lifted onto the transcript; `start_ms` / `end_ms` are forwarded as `startedAtMs` / `endedAtMs`; per-token `language` and `speaker` are lifted from the first / lead token in the bucket.
- `finished: true` messages emit `endOfTurn` with `reason: "vendor"`.
- `session.close(reason)` sends the documented empty-string end-of-stream sentinel and then closes the socket cleanly.
- Supported encodings on `STTAdapterOpenOptions.format.encoding`: `pcm_s16le`, `mulaw` / `pcm_mulaw`, `alaw` / `pcm_alaw`.

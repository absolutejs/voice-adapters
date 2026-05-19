# `@absolutejs/voice-gladia`

Gladia real-time speech-to-text adapter for `@absolutejs/voice`.

Implements Gladia's two-step v2 live handshake directly (no Gladia SDK dep): POST `/v2/live` to create a session and receive a one-time WebSocket URL, connect, stream binary PCM/μ-law/A-law audio, and consume `transcript` / `end_of_utterance` JSON messages. Excellent at multilingual code-switch (Hindi-English, Catalan-Spanish, etc.) thanks to Gladia's language model.

## Install

```sh
bun add @absolutejs/voice-gladia
```

`@absolutejs/voice` is a runtime dependency.

## Use

```ts
import { voice } from "@absolutejs/voice";
import { gladia } from "@absolutejs/voice-gladia";

const app = voice({
  stt: gladia({
    apiKey: process.env.GLADIA_API_KEY!,
    // optional:
    model: "solaria-1",
    languages: ["en"],         // language detection seed
    codeSwitching: true,       // for multilingual callers
    realtimeProcessing: { sentences: true },
  }),
  // ... tts + other options ...
});
```

For mixed Hindi/English callers (CoSHE-style), pair with `languageStrategy`:

```ts
app.use({
  stt: gladia({ apiKey, codeSwitching: true }),
  // and at open() time:
  // languageStrategy: { mode: 'allow-switching', primaryLanguage: 'en', secondaryLanguages: ['hi'] }
});
```

## Options

| Option | Required | Default | Notes |
| --- | --- | --- | --- |
| `apiKey` | yes | — | Gladia API key, sent as `X-Gladia-Key`. |
| `model` | no | `solaria-1` | Gladia model id. |
| `languages` | no | — | Default language list, overridden when `STTAdapterOpenOptions.languageStrategy` resolves a list. |
| `codeSwitching` | no | — | Enable mid-utterance language switching. |
| `realtimeProcessing` | no | — | Forwarded to Gladia's `realtime_processing` config (sentences, diarization, etc.). |
| `punctuationConfig` | no | — | Forwarded to `punctuation_config`. |
| `baseUrl` | no | `https://api.gladia.io` | Override for staging / enterprise endpoints. |
| `sessionPath` | no | `/v2/live` | Override if you proxy Gladia behind a gateway. |
| `connectTimeoutMs` | no | `8000` | Time to wait for the WebSocket `open` event. |
| `fetch` | no | `globalThis.fetch` | Inject for tests; opportunistic HTTP/2 multiplexing on outbound HTTPS. |
| `webSocket.factory` | no | `new WebSocket(url)` | Inject a fake socket for tests. |

## Notes

- Audio sent before the WebSocket open completes is buffered and flushed once the socket is ready.
- `transcript` messages → `partial` when `data.is_final !== true`, `final` otherwise. Confidence + per-utterance `start` / `end` (converted to ms) are lifted onto the transcript.
- `end_of_utterance` / `speech_end` → `endOfTurn` with `reason: "vendor"`.
- `session.close(reason)` sends `{ "type": "stop_recording" }` and then closes the socket cleanly.
- Supported encodings on `STTAdapterOpenOptions.format.encoding`: `pcm_s16le` → `wav/pcm`, `mulaw` / `pcm_mulaw` → `wav/ulaw`, `alaw` / `pcm_alaw` → `wav/alaw`.

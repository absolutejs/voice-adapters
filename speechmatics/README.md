# `@absolutejs/voice-speechmatics`

Speechmatics real-time speech-to-text adapter for `@absolutejs/voice`.

Speaks Speechmatics' v2 WebSocket protocol directly: connect → `StartRecognition` → binary audio frames → `AddPartialTranscript` / `AddTranscript` / `EndOfTranscript` → `EndOfStream`. No Speechmatics SDK dependency.

## Install

```sh
bun add @absolutejs/voice-speechmatics
```

`@absolutejs/voice` is a runtime dependency.

## Use

```ts
import { voice } from "@absolutejs/voice";
import { speechmatics } from "@absolutejs/voice-speechmatics";

const app = voice({
  stt: speechmatics({
    apiKey: process.env.SPEECHMATICS_API_KEY!,
    region: "eu2",                       // 'eu' | 'eu2' | 'usa'
    language: "en",
    operatingPoint: "enhanced",          // or 'standard' for lower latency
    enablePartials: true,
    diarization: "speaker",              // optional
  }),
  // ... tts + other options ...
});
```

For pre-issued JWT tokens (e.g., short-lived browser sessions):

```ts
speechmatics({ region: "eu2", jwt: shortLivedJwt, language: "en" });
```

## Options

| Option | Required | Default | Notes |
| --- | --- | --- | --- |
| `apiKey` / `jwt` | one of | — | API key or pre-issued JWT; passed as `?jwt=<token>` on the WebSocket URL per the Speechmatics protocol. |
| `region` | no | `eu2` | `eu`, `eu2`, `usa`, or any region prefix that resolves to `wss://{region}.rt.speechmatics.com`. |
| `baseUrl` | no | `wss://{region}.rt.speechmatics.com` | Override for private/staging endpoints. |
| `language` | no | `en` | BCP-47 code. Overridden when `STTAdapterOpenOptions.languageStrategy` fixes a language. |
| `operatingPoint` | no | `enhanced` | `enhanced` (higher quality) or `standard` (lower latency). |
| `enablePartials` | no | `true` | Stream partial hypotheses. |
| `diarization` | no | — | `speaker`, `channel`, `channel_and_speaker`, or `none`. |
| `maxDelay`, `speakerChangeSensitivity`, `punctuationOverrides` | no | — | Forwarded to `transcription_config`. |
| `connectTimeoutMs` | no | `8000` | Time to wait for the `RecognitionStarted` ACK. |
| `webSocket.factory` | no | `new WebSocket(url)` | Inject a fake socket for tests. |

## Notes

- Audio sent before the `RecognitionStarted` ACK is buffered and flushed once recognition starts.
- `AddPartialTranscript` → `partial` event, `AddTranscript` → `final` event, `EndOfTranscript` → `endOfTurn`.
- Punctuation tokens are joined to the preceding word (`Hello`, `world`, `.` → `Hello world.`).
- Average per-token confidence is lifted onto the transcript.
- `session.close(reason)` sends `EndOfStream` with the last `seq_no` and then closes the socket cleanly.
- Supported encodings on `STTAdapterOpenOptions.format.encoding`: `pcm_s16le`, `pcm_f32le`, `mulaw` / `pcm_mulaw`.

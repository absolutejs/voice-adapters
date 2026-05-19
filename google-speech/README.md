# `@absolutejs/voice-google-speech`

Google Cloud Speech-to-Text adapter for `@absolutejs/voice`. Ships two complementary modes — pick whichever fits your latency / cost / infrastructure tradeoffs:

- **`googleSpeech(...)`** — buffered-batch via REST `/v1/speech:recognize`. Accumulate PCM, POST on `flush()` / `close()`, get one final transcript per turn. Good for post-call analysis and short utterances; simplest auth (API key, OAuth, or refresh hook).
- **`googleSpeechStream(...)`** — real-time bidirectional streaming via Google Speech v2 `StreamingRecognize`. Speaks gRPC over HTTP/2 directly (`node:http2`) with hand-rolled protobuf wire-format for the request/response messages and gRPC-Web framing. **No `@grpc/grpc-js` dependency.** Use this when you want partial transcripts as the caller is speaking.

## Install

```sh
bun add @absolutejs/voice-google-speech
```

`@absolutejs/voice` is a runtime dependency.

## Streaming (`googleSpeechStream`)

```ts
import { voice } from "@absolutejs/voice";
import { googleSpeechStream } from "@absolutejs/voice-google-speech";

const app = voice({
  stt: googleSpeechStream({
    project: process.env.GOOGLE_PROJECT_ID!,
    accessToken: await mintBearerToken(),
    // optional:
    location: "global",                     // default
    model: "latest_long",                   // default; or 'latest_short' / 'chirp_2' / 'telephony' / ...
    language: "en-US",
    languages: ["en-US"],                   // used unless languageStrategy overrides
    interimResults: true,                   // default — partial transcripts emitted
    enableVoiceActivityEvents: true,        // surface SPEECH_ACTIVITY_END as endOfTurn
    enableAutomaticPunctuation: true,
    enableWordConfidence: true,
  }),
});
```

OAuth refresh (preferred for long-running deployments):

```ts
googleSpeechStream({
  project,
  getAccessToken: async () => await refreshGoogleAccessToken(),
});
```

### What this adapter does protocol-wise

- Opens a single HTTP/2 stream against `https://speech.googleapis.com/google.cloud.speech.v2.Speech/StreamingRecognize`.
- Headers: `Authorization: Bearer <token>`, `Content-Type: application/grpc-web+proto`, `X-Grpc-Web: 1`, `TE: trailers`.
- Sends the first message as a `StreamingRecognizeRequest` carrying `recognizer = projects/{project}/locations/{location}/recognizers/_` and a `streaming_config` derived from `STTAdapterOpenOptions.format` + your options.
- Each call to `session.send(audio)` encodes a `StreamingRecognizeRequest { audio = <bytes> }`, wraps it in a 5-byte gRPC frame, and writes it to the HTTP/2 stream.
- Reads `StreamingRecognizeResponse` frames as they arrive, decodes `results[].alternatives[0]`, and emits `partial` events while `is_final = false`, `final` events when `is_final = true`. `result_end_offset` is lifted to `transcript.endedAtMs`, `language_code` to `transcript.language`, `confidence` to `transcript.confidence`.
- `speech_event_type` values of `END_OF_SINGLE_UTTERANCE` or `SPEECH_ACTIVITY_END` emit an `endOfTurn` (`reason: "vendor"`).
- Trailer frame (gRPC-Web high-bit flag) or HTTP/2 trailer with non-zero `grpc-status` emits an `error` event with `code = <status>` and message `"Google Speech gRPC status <code>: <message>"`.

### Streaming options

| Option | Required | Default | Notes |
| --- | --- | --- | --- |
| `accessToken` / `getAccessToken` | one of | — | OAuth Bearer token (or async refresh hook). API keys are **not** supported on the streaming RPC; use the buffered-batch `googleSpeech(...)` for API-key flows. |
| `project` | yes | — | Google Cloud project id; combined with `location` to form the `recognizer` resource path. |
| `location` | no | `global` | Override for regional Speech endpoints. |
| `model` | no | `latest_long` | Any Speech v2 model id (`latest_long`, `latest_short`, `chirp`, `chirp_2`, `telephony`, `telephony_short`, etc.). |
| `language` / `languages` | no | `en-US` | Used unless `STTAdapterOpenOptions.languageStrategy` resolves a list (`fixed` → single language; `allow-switching` → primary + secondaries; `auto-detect` → allowed list). |
| `interimResults` | no | `true` | Whether Google emits partial hypotheses. |
| `enableVoiceActivityEvents` | no | — | When `true`, Google emits speech-activity event types — mapped to `endOfTurn`. |
| `enableAutomaticPunctuation`, `enableWordTimeOffsets`, `enableWordConfidence`, `enableSpokenPunctuation`, `enableSpokenEmojis`, `profanityFilter` | no | — | Forwarded into `RecognitionConfig.features`. |
| `authority`, `path` | no | `speech.googleapis.com`, `/google.cloud.speech.v2.Speech/StreamingRecognize` | Override for sovereign clouds / proxies. |
| `transport` | no | `node:http2`-backed default | Pluggable transport factory — used by the test suite to inject a fake socket. |

## Buffered-batch (`googleSpeech`)

See the existing buffered-batch section for the REST-based API key / OAuth flow. The streaming and batch exports can coexist in the same project; pick per-route.

## Notes & limitations

- Bun's `fetch` is half-duplex (request body must finish before the response body starts), which is why the streaming adapter uses `node:http2` directly instead of `fetch`. Bun's `node:http2` polyfill supports the bidirectional pattern this adapter needs.
- The protobuf encoder/decoder is hand-rolled and covers only the fields actually used by `StreamingRecognizeRequest`/`StreamingRecognizeResponse`. If Google adds new fields you want surfaced (alternatives beyond [0], word-level timing, channel tags, etc.), open an issue.
- For `STTAdapterOpenOptions.format.encoding`: `pcm_s16le` → `LINEAR16`, `mulaw` / `pcm_mulaw` → `MULAW`, `alaw` / `pcm_alaw` → `ALAW`. Other encodings are rejected at open time.
- `session.close(reason)` ends the request stream cleanly and emits `close`. Any in-flight transcripts that arrive after close are dropped.

## Roadmap

- **OAuth helpers** — currently you mint your own access tokens. A small helper that exchanges a service-account JSON key for short-lived tokens would smooth the onboarding path.
- **Async long-running recognize** via `/v2/{recognizer}:batchRecognize` for very long audio (>60s). Lower priority for voice-agent workloads but useful for post-call summary.
- **Adaptation / boost phrases** support in the streaming config.

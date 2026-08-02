# `@absolutejs/voice-openai-whisper`

Buffered OpenAI transcription adapter for `@absolutejs/voice`. It collects raw
audio for a turn, wraps PCM input in a WAV container, and sends one transcription
request when you flush or close the session.

## Install

```bash
bun add @absolutejs/voice @absolutejs/voice-openai-whisper
```

## Setup

```ts
import { openaiWhisper } from "@absolutejs/voice-openai-whisper";

const stt = openaiWhisper({
  apiKey: process.env.OPENAI_API_KEY!,
  model: "gpt-4o-mini-transcribe",
  language: "en",
});

const session = stt.open({
  format: {
    channels: 1,
    encoding: "pcm_s16le",
    sampleRateHz: 16_000,
  },
});

session.on("final", ({ transcript }) => {
  console.log(transcript.text);
});

await session.send(audioChunk);
await session.flush();
await session.close("turn-complete");
```

## Buffering behavior

This is a batch adapter, not a realtime streaming transport. `send()` appends
audio to the current turn. `flush()` transcribes the accumulated buffer and emits
`final` followed by `endOfTurn`. Closing flushes by default; set
`flushOnClose: false` when the caller owns that lifecycle explicitly.

The default buffer ceiling is 20 MiB. Set `maxBufferedBytes` to a lower bound for
latency or memory control, and flush between turns. Exceeding the bound throws
before more audio is retained.

## Options

- `apiKey` — required OpenAI API key.
- `model` — defaults to `whisper-1`; transcription models are accepted.
- `language` — optional language hint; fixed language strategies from voice core
  take precedence.
- `prompt`, `temperature`, and `responseFormat` — forwarded to the transcription
  endpoint.
- `organization` — sends the `OpenAI-Organization` header.
- `baseUrl` — targets an OpenAI-compatible endpoint.
- `fetch` — injects a custom fetch implementation for policy, tracing, or tests.
- `flushOnClose` and `maxBufferedBytes` — control buffering lifecycle.

## Errors and events

HTTP failures and malformed provider responses emit a non-recoverable `error`.
Successful responses emit normalized `final` and `endOfTurn` events through the
standard `@absolutejs/voice` `STTAdapter` contract. The adapter does not emit
partial transcripts because the provider request happens only at flush time.

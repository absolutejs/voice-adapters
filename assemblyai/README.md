# `@absolutejs/voice-assemblyai`

AssemblyAI speech-to-text adapter for `@absolutejs/voice`.

## Install

```bash
bun add @absolutejs/voice @absolutejs/voice-assemblyai
```

## Setup

```ts
import { assemblyai } from "@absolutejs/voice-assemblyai";

const stt = assemblyai({
  apiKey: process.env.ASSEMBLYAI_API_KEY!,
  speechModel: "universal-streaming-english",
  formatTurns: true,
});
```

The adapter accepts `16kHz` mono `pcm_s16le` audio from core and sends it to AssemblyAI's official streaming WebSocket API.

## What It Maps

- streaming `Turn` with `end_of_turn=false` -> `partial`
- streaming `Turn` with `end_of_turn=true` -> `final`
- streaming `Turn` with `end_of_turn=true` -> normalized `endOfTurn`
- websocket errors -> normalized `error`
- websocket close -> normalized `close`

AssemblyAI's streaming output is immutable, so the adapter treats in-progress turns as partial updates and the terminal turn message as the final transcript for that turn.

## Options

Supported options include:

- `apiKey`
- `speechModel`
- `formatTurns`
- `keytermsPrompt`
- `endOfTurnConfidenceThreshold`
- `minEndOfTurnSilenceWhenConfident`
- `maxTurnSilence`
- `token`

## API Key

Set `ASSEMBLYAI_API_KEY` in your runtime environment, or pass the key explicitly in the adapter config.

AssemblyAI references used for this adapter design:

- https://www.assemblyai.com/docs/speech-to-text/streaming
- https://www.assemblyai.com/docs/streaming/universal-streaming
- https://www.assemblyai.com/docs/universal-streaming/turn-detection

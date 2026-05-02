# `@absolutejs/voice-openai`

OpenAI realtime adapter for `@absolutejs/voice`.

## Install

```ts
bun add @absolutejs/voice @absolutejs/voice-openai
```

## Setup

```ts
import { openai } from '@absolutejs/voice-openai';

const realtime = openai({
	apiKey: process.env.OPENAI_API_KEY!,
	model: 'gpt-realtime-mini',
	voice: 'marin',
	instructions: 'Be concise and clear.',
	inputTranscriptionModel: 'gpt-4o-mini-transcribe'
});
```

This adapter uses OpenAI's official Realtime WebSocket API and normalizes it into the core `RealtimeAdapter` contract.

## What It Maps

- `conversation.item.input_audio_transcription.delta` -> `partial`
- `conversation.item.input_audio_transcription.completed` -> `final`
- completed input transcription -> normalized `endOfTurn`
- `response.output_audio.delta` -> `audio`
- realtime `error` events -> normalized `error`
- websocket close -> normalized `close`

For string input, the adapter emits a local final transcript immediately and then requests an OpenAI response. For audio input, it buffers PCM audio and commits the turn after a short inactivity window.

The response transcript events (`response.audio_transcript.*`, `response.output_audio_transcript.*`, `response.output_text.*`) are disabled by default to keep the adapter focused on user-input STT. Enable them only if your application intentionally consumes assistant output transcripts.

## Input Audio Format

OpenAI Realtime currently expects `pcm16` audio at `24kHz` mono for streaming audio input. This adapter enforces that requirement when you call `send(audio)`.

Output audio is normalized as raw `pcm_s16le` at `24kHz` mono.

## Options

Supported options include:

- `apiKey`
- `model`
- `emitResponseTranscripts`
- `voice`
- `instructions`
- `inputTranscriptionModel`
- `inputTranscriptionLanguage`
- `inputTranscriptionPrompt`
- `maxOutputTokens`
- `autoCommitSilenceMs`
- `noiseReduction`
- `responseMode`
- `speed`
- `temperature`

## API Key

Set `OPENAI_API_KEY` in your runtime environment, or pass the key explicitly in the adapter config.

OpenAI references used for this adapter design:

- https://developers.openai.com/api/reference/resources/realtime
- https://developers.openai.com/api/docs/models

# `@absolutejs/voice-elevenlabs`

ElevenLabs text-to-speech adapter for `@absolutejs/voice`.

## Install

```bash
bun add @absolutejs/voice @absolutejs/voice-elevenlabs
```

## Setup

```ts
import { elevenlabs } from '@absolutejs/voice-elevenlabs';

const tts = elevenlabs({
	apiKey: process.env.ELEVENLABS_API_KEY!,
	voiceId: 'JBFqnCBsd6RMkjVDRZzb',
	modelId: 'eleven_flash_v2_5',
	outputFormat: 'pcm_16000'
});
```

The adapter uses ElevenLabs' official streaming text-to-speech endpoint and emits normalized `audio` events with PCM chunks.

If you need a warm persistent TTS session for lower turn startup latency, you can opt into ElevenLabs' WebSocket transport:

```ts
const tts = elevenlabs({
	apiKey: process.env.ELEVENLABS_API_KEY!,
	voiceId: 'JBFqnCBsd6RMkjVDRZzb',
	modelId: 'eleven_flash_v2_5',
	outputFormat: 'ulaw_8000',
	transport: 'websocket',
	websocket: {
		autoMode: true,
		inactivityTimeoutSec: 180
	}
});
```

## What It Maps

- HTTP chunked audio stream -> `audio`
- warm WebSocket stream-input session -> `audio`
- request failures -> normalized `error`
- adapter close -> normalized `close`

This adapter currently supports PCM output formats for compatibility with `@absolutejs/voice` audio events.

## Options

Supported options include:

- `apiKey`
- `voiceId`
- `modelId`
- `outputFormat`
- `languageCode`
- `voiceSettings`
- `seed`
- `enableLogging`
- `optimizeStreamingLatency`
- `transport`
- `websocket`

## API Key

Set `ELEVENLABS_API_KEY` in your runtime environment, or pass the key explicitly in the adapter config.

ElevenLabs references used for this adapter design:

- https://elevenlabs.io/docs/api-reference/text-to-speech
- https://elevenlabs.io/docs/api-reference/streaming
- https://elevenlabs.io/docs/capabilities/text-to-speech

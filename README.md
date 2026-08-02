# AbsoluteJS Voice Adapters

Provider adapters for `@absolutejs/voice`.

## Speech to text

- `@absolutejs/voice-assemblyai`
- `@absolutejs/voice-deepgram`
- `@absolutejs/voice-gladia`
- `@absolutejs/voice-google-speech`
- `@absolutejs/voice-openai-whisper`
- `@absolutejs/voice-soniox`
- `@absolutejs/voice-speechmatics`

## Text to speech

- `@absolutejs/voice-azure`
- `@absolutejs/voice-cartesia`
- `@absolutejs/voice-elevenlabs`
- `@absolutejs/voice-lmnt`
- `@absolutejs/voice-neets`
- `@absolutejs/voice-playht`
- `@absolutejs/voice-rime`
- `@absolutejs/voice-smallest`

## Realtime speech-to-speech

- `@absolutejs/voice-gemini`
- `@absolutejs/voice-openai`

Each adapter remains an independently versioned npm package. This repository is the source monorepo.

## Installation

Install the core voice contracts and only the providers used by a deployment:

```sh
bun add @absolutejs/voice @absolutejs/voice-deepgram @absolutejs/voice-elevenlabs
```

Each adapter page documents credentials, supported streaming modes, audio formats, provider-specific options, limitations, and a minimal construction example.

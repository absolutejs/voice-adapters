# `@absolutejs/voice-deepgram`

Flux sessions implement the provider-neutral `session.configure(...)` contract,
allowing keyterms and language hints to be refreshed during a live stream. Nova
sessions keep their opening configuration because Deepgram's Configure control
message is a Flux capability.

Deepgram speech-to-text adapter for `@absolutejs/voice`.

## Install

```bash
bun add @absolutejs/voice @absolutejs/voice-deepgram
```

## Setup

```ts
import { deepgram } from "@absolutejs/voice-deepgram";

const stt = deepgram({
  apiKey: process.env.DEEPGRAM_API_KEY!,
  model: "nova-3",
  language: "en-US",
  mipOptOut: true,
  punctuate: true,
  smartFormat: true,
});
```

The adapter accepts `16kHz` mono `pcm_s16le` audio from core and forwards it to Deepgram without transcoding.

## What It Maps

The adapter normalizes Deepgram events into the core `STTAdapter` contract.

- `Results` with `is_final=false` -> `partial`
- `Results` with `is_final=true` -> `final`
- `speech_final=true` -> normalized `endOfTurn`
- `UtteranceEnd` -> normalized `endOfTurn`
- Flux `EndOfTurn` or `EagerEndOfTurn` -> normalized `endOfTurn`
- transport errors -> normalized `error`
- socket close -> normalized `close`

## Options

Supported options include:

- `apiKey`
- `model`
- `language`
- `punctuate`
- `smartFormat`
- `interimResults`
- `endpointing`
- `utteranceEndMs`
- `vadEvents`
- `diarize`
- `numerals`
- `profanityFilter`
- `redact`
- `keyterm` or `keyterms` (emitted as Nova-2 `keywords`, or as Nova-3/Flux
  `keyterm`, according to the selected model)
- `eotThreshold`
- `eagerEotThreshold`
- `eotTimeoutMs`
- `keepAliveMs`
- `connectTimeoutMs`
- `mipOptOut` (maps to Deepgram's `mip_opt_out` request option)
- `tag`
- `extra`

### Diagnostics

`error` events now include `code` when available from Deepgram and include request identifiers when present.
If the websocket fails to authenticate or cannot open, the adapter throws with:

- transport details (or close reason)
- the websocket URL (query params only)
- effective timeout used for open handshake

Nova models typically use `endpointing`, `utteranceEndMs`, and `vadEvents`.

Flux models typically use:

- `eotThreshold`
- `eagerEotThreshold`
- `eotTimeoutMs`

If you omit those Flux options, the adapter now applies conversation-oriented defaults:

- `eagerEotThreshold: 0.8`
- `eotThreshold: 0.82`
- `eotTimeoutMs: 1200`

## API Key

Set `DEEPGRAM_API_KEY` in your runtime environment, or pass the key explicitly in the adapter config.

Deepgram references used for this adapter design:

- https://developers.deepgram.com/docs/audio-keep-alive
- https://developers.deepgram.com/docs/utterance-end
- https://developers.deepgram.com/docs/endpointing
- https://developers.deepgram.com/docs/flux/configuration
- https://developers.deepgram.com/docs/listening-to-audio-streaming-over-websocket

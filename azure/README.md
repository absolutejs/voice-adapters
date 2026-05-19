# `@absolutejs/voice-azure`

Azure Speech (Cognitive Services) adapter for `@absolutejs/voice` — Neural TTS over REST plus streaming STT over Azure's WebSocket Unified Speech Protocol.

## Install

```sh
bun add @absolutejs/voice-azure
```

`@absolutejs/voice` is a runtime dependency.

## TTS

```ts
import { voice } from "@absolutejs/voice";
import { azureTTS } from "@absolutejs/voice-azure";

const app = voice({
  // ... stt + other voice options ...
  tts: azureTTS({
    region: "eastus",
    subscriptionKey: process.env.AZURE_SPEECH_KEY!,
    voice: "en-US-JennyNeural",
    // optional:
    outputFormat: "raw-24khz-16bit-mono-pcm", // default
    language: "en-US",                         // default
    voiceStyle: "cheerful",
    styleDegree: 1.5,
    prosody: { rate: "fast", pitch: "+5%" },
  }),
});
```

For telephony bridges, use a μ-law raw format at 8 kHz:

```ts
azureTTS({
  region,
  subscriptionKey,
  voice: "en-US-AriaNeural",
  outputFormat: "raw-8khz-8bit-mono-mulaw",
});
```

Bearer-token auth (10-minute Azure auth tokens) is also supported:

```ts
azureTTS({ region, token, voice });
```

## Options

| Option | Required | Default | Notes |
| --- | --- | --- | --- |
| `subscriptionKey` / `token` | one of | — | Subscription key sent as `Ocp-Apim-Subscription-Key`, or short-lived bearer token sent as `Authorization`. |
| `voice` | yes | — | Azure voice name, e.g. `en-US-JennyNeural`, `fr-FR-DeniseNeural`. |
| `region` | yes\* | — | Azure region (`eastus`, `westus`, `francecentral`, …). \* Or pass `baseUrl` directly. |
| `baseUrl` | no | `https://{region}.tts.speech.microsoft.com` | Override for sovereign clouds or Azure private endpoints. |
| `endpointPath` | no | `/cognitiveservices/v1` | Override if you front the service with a gateway. |
| `outputFormat` | no | `raw-24khz-16bit-mono-pcm` | Must be a `raw-*` format (mp3/wav variants are rejected because they aren't streamable frame-by-frame). |
| `language` | no | `en-US` | Used in the SSML `xml:lang` attribute. |
| `voiceStyle` | no | — | Azure neural style (`cheerful`, `empathetic`, `customerservice`, …). |
| `styleDegree` | no | — | Only applied when `voiceStyle` is set (0..2 typically). |
| `prosody` | no | — | `{ rate, pitch, volume }` — strings forwarded to the SSML `<prosody>` element. |
| `userAgent` | no | `@absolutejs/voice-azure` | Sent as `User-Agent`. |
| `fetch` | no | `globalThis.fetch` | Inject for tests; opportunistic HTTP/2 multiplexing is enabled for HTTPS targets. |

## Notes

- Only `raw-*` output formats are supported because the voice runtime needs framed PCM/μ-law/α-law to feed transports without buffering the whole response. If you need MP3/WAV for offline assets, call the Azure REST API directly.
- The adapter aborts the in-flight HTTP request on `session.close(reason)` and refuses further `send()` calls.
- Whitespace-only `send()` is a no-op (matches the ElevenLabs and Cartesia adapters).
- Bearer tokens expire after 10 minutes by default — refresh externally and pass the new value into a fresh adapter, or stick with `subscriptionKey` for long-running deployments.

## STT

```ts
import { voice } from "@absolutejs/voice";
import { azureSTT, azureTTS } from "@absolutejs/voice-azure";

const app = voice({
  stt: azureSTT({
    region: "eastus",
    subscriptionKey: process.env.AZURE_SPEECH_KEY!,
    language: "en-US",
    // optional:
    recognitionMode: "conversation", // 'conversation' | 'dictation' | 'interactive'
    format: "detailed",              // 'detailed' | 'simple'
    profanity: "masked",             // 'masked' | 'raw' | 'removed'
  }),
  tts: azureTTS({ region: "eastus", subscriptionKey, voice: "en-US-JennyNeural" }),
});
```

The STT adapter speaks Azure's WebSocket Unified Speech Protocol directly (no Microsoft SDK dependency):

- Connects to `wss://{region}.stt.speech.microsoft.com/speech/recognition/{mode}/cognitiveservices/v1`
- Authenticates via `Ocp-Apim-Subscription-Key` or `Authorization: Bearer <token>` header.
- Sends a `speech.config` text frame with system metadata on open, then queues any audio sent before the socket finished opening.
- Prepends a 44-byte RIFF/WAV header to the first audio chunk (using the format declared in `STTAdapterOpenOptions.format`) and ships subsequent chunks as raw PCM under the same `audio/x-wav` content type.
- Maps `speech.hypothesis` → `partial` events, `speech.phrase` → `final` events (`RecognitionStatus === "Success"` only, with `NBest[0].Confidence` lifted onto the transcript), and `turn.end` → `endOfTurn` with `reason: "vendor"`.

### STT options

| Option | Required | Default | Notes |
| --- | --- | --- | --- |
| `subscriptionKey` / `token` | one of | — | Same auth choices as TTS. |
| `region` | yes\* | — | Azure region. \* Or pass `baseUrl`. |
| `baseUrl` | no | `wss://{region}.stt.speech.microsoft.com` | Override for sovereign clouds, private endpoints, or test stubs. |
| `endpointPath` | no | `/speech/recognition/{mode}/cognitiveservices/v1` | Override if you front the service with a gateway. |
| `recognitionMode` | no | `conversation` | `conversation` / `dictation` / `interactive`. |
| `format` | no | `detailed` | `detailed` keeps confidence; `simple` is leaner. |
| `language` | no | `en-US` | Used when `STTAdapterOpenOptions.languageStrategy` doesn't fix one. |
| `profanity` | no | — | Forwarded as `?profanity=...`. |
| `systemName` / `systemVersion` | no | `@absolutejs/voice-azure` / `0.0.1` | Sent in the speech.config telemetry blob. |
| `connectTimeoutMs` | no | `8000` | Open-handshake timeout. |
| `webSocket.factory` | no | `new WebSocket(url, { headers })` | Inject a fake socket for tests. |

## Roadmap

- **Custom voices / endpoint id** — once a paying customer asks.
- **Speaker recognition / pronunciation assessment** — out of scope for the voice-agent path; covered better by direct Azure SDK use.
- **Translation Speech** — could be added if multilingual voice agents need on-the-fly translation as part of the pipeline.

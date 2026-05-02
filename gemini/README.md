# @absolutejs/voice-gemini

Gemini Live realtime adapter for `@absolutejs/voice`.

```ts
import { gemini } from "@absolutejs/voice-gemini";

const realtime = gemini({
	apiKey: process.env.GEMINI_API_KEY!,
	model: "gemini-2.5-flash-native-audio-preview-12-2025",
});
```

The adapter targets the Google AI Gemini Live WebSocket API and normalizes input transcripts, output transcripts, assistant audio, turn completion, and errors into the shared `RealtimeAdapter` contract.

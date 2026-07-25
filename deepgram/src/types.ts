// Deepgram speech-to-text has two operating modes that take different knobs.
// Conflating them in one flat options bag silently no-ops the wrong knob (e.g.
// `endpointing` on a flux model, `eotThreshold` on a nova model). The public
// options are discriminated by `model` so a wrong-mode knob is a COMPILE ERROR.
// See dealroom docs/voice-stt-config-redesign.md.

// Flux: fused STT + conversational turn-taking (native end-of-turn). 1:1 calls.
export type DeepgramFluxModel =
  "flux" | "flux-general-en" | "flux-general-multi";

// Nova: transcription with speaker diarization + word-gap endpointing.
// Multi-speaker meetings. Extend explicitly as Deepgram ships new nova models.
export type DeepgramNovaModel = "nova-3" | "nova-2";

export type DeepgramModel = DeepgramFluxModel | DeepgramNovaModel;

// Transport / auth / vocabulary — valid in both modes.
type DeepgramSharedOptions = {
  apiKey: string;
  authMode?: "header" | "protocol";
  // Honored as a query param on nova; on flux it selects the model variant
  // (flux-general-en vs flux-general-multi) — meaningful in both modes.
  language?: string;
  keyterm?: string | string[];
  keyterms?: string | string[];
  keepAliveMs?: number;
  connectTimeoutMs?: number;
  tag?: string | string[];
  extra?: Record<string, string>;
};

// Conversational mode (flux): native end-of-turn confidence thresholds.
export type DeepgramConversationalOptions = DeepgramSharedOptions & {
  model: DeepgramFluxModel;
  eotThreshold?: number;
  eagerEotThreshold?: number;
  eotTimeoutMs?: number;
};

// Transcription mode (nova): diarization, endpointing, formatting, redaction.
export type DeepgramTranscriptionOptions = DeepgramSharedOptions & {
  model: DeepgramNovaModel;
  interimResults?: boolean;
  endpointing?: number | false;
  utteranceEndMs?: number;
  vadEvents?: boolean;
  diarize?: boolean;
  punctuate?: boolean;
  smartFormat?: boolean;
  numerals?: boolean;
  profanityFilter?: boolean;
  redact?: string | string[];
};

export type DeepgramSTTOptions =
  DeepgramConversationalOptions | DeepgramTranscriptionOptions;

// Internal structural superset: every union arm is assignable to this, so the
// adapter implementation reads any field without re-narrowing. The runtime
// already gates which fields it sends by `isFlux`, so reading an absent field is
// simply `undefined`. NOT exported — callers must use the discriminated union.
export type DeepgramResolvedSTTOptions = DeepgramSharedOptions & {
  model: DeepgramModel;
  interimResults?: boolean;
  endpointing?: number | false;
  utteranceEndMs?: number;
  vadEvents?: boolean;
  diarize?: boolean;
  punctuate?: boolean;
  smartFormat?: boolean;
  numerals?: boolean;
  profanityFilter?: boolean;
  redact?: string | string[];
  eotThreshold?: number;
  eagerEotThreshold?: number;
  eotTimeoutMs?: number;
};

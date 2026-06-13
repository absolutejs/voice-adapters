import { expect, test } from 'bun:test';
import { deepgram } from '../src';
import type { DeepgramSTTOptions } from '../src';

// These assertions are enforced by `bun run typecheck` (tsc). The runtime body
// only exists so `bun test` also surfaces the file. The point is the TYPES: a
// knob from the wrong mode must NOT compile.

// Conversational (flux) accepts flux EOT thresholds.
const conversational: DeepgramSTTOptions = {
	apiKey: 'x',
	eagerEotThreshold: 0.7,
	eotThreshold: 0.8,
	eotTimeoutMs: 3000,
	model: 'flux-general-multi',
};

// Transcription (nova) accepts diarization + endpointing.
const transcription: DeepgramSTTOptions = {
	apiKey: 'x',
	diarize: true,
	endpointing: 400,
	model: 'nova-2',
	utteranceEndMs: 1100,
};

// @ts-expect-error endpointing is a nova-only knob — not valid on a flux model.
const fluxWithEndpointing: DeepgramSTTOptions = {
	apiKey: 'x',
	endpointing: 400,
	model: 'flux',
};

// @ts-expect-error eotThreshold is a flux-only knob — not valid on a nova model.
const novaWithEot: DeepgramSTTOptions = {
	apiKey: 'x',
	eotThreshold: 0.8,
	model: 'nova-3',
};

// @ts-expect-error diarize is a nova-only knob — flux cannot diarize.
const fluxWithDiarize: DeepgramSTTOptions = {
	apiKey: 'x',
	diarize: true,
	model: 'flux-general-en',
};

test('discriminated options compile for the right mode', () => {
	expect(typeof deepgram).toBe('function');
	expect(conversational.model).toBe('flux-general-multi');
	expect(transcription.model).toBe('nova-2');
	// reference the negative-case bindings so they are not unused
	expect([fluxWithEndpointing, novaWithEot, fluxWithDiarize]).toHaveLength(3);
});

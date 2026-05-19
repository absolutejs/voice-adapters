import { describe, expect, test } from 'bun:test';
import { playht } from '../src';

type Recorded = {
	body: unknown;
	headers: Record<string, string>;
	method: string;
	url: string;
};

const collectHeaders = (headers: Headers) => {
	const out: Record<string, string> = {};
	headers.forEach((value, key) => {
		out[key.toLowerCase()] = value;
	});
	return out;
};

const buildFetchStub = (
	respond: (request: Request) => Response | Promise<Response>
) => {
	const calls: Recorded[] = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		const request =
			input instanceof Request
				? input
				: new Request(input as URL | string, init);
		const cloned = request.clone();
		const body = await cloned
			.text()
			.then((text) => (text ? JSON.parse(text) : undefined))
			.catch(() => undefined);
		calls.push({
			body,
			headers: collectHeaders(request.headers),
			method: request.method,
			url: request.url
		});
		return respond(request);
	};
	return { calls, fetchImpl };
};

const buildBytesBody = (chunks: readonly Uint8Array[]) => {
	const stream = new ReadableStream({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(chunk);
			}
			controller.close();
		}
	});
	return new Response(stream, { status: 200 });
};

const collectAudio = (
	session: Awaited<ReturnType<ReturnType<typeof playht>['open']>>
) => {
	const chunks: Uint8Array[] = [];
	session.on('audio', (event) => {
		const chunk = event.chunk;
		chunks.push(
			chunk instanceof Uint8Array
				? chunk
				: new Uint8Array(chunk as ArrayBufferLike)
		);
	});
	return chunks;
};

describe('playht TTS adapter', () => {
	test('posts JSON to /api/v2/tts/stream with bearer auth and X-USER-ID', async () => {
		const { calls, fetchImpl } = buildFetchStub(() =>
			buildBytesBody([new Uint8Array([1, 2, 3])])
		);
		const adapter = playht({
			apiKey: 'play-key',
			fetch: fetchImpl,
			userId: 'user-123',
			voice: 's3://voices/jennifer.json'
		});
		const session = await adapter.open({ sessionId: 's' });
		const chunks = collectAudio(session);
		await session.send('Hello PlayHT');
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe('https://api.play.ht/api/v2/tts/stream');
		expect(calls[0]?.method).toBe('POST');
		expect(calls[0]?.headers['authorization']).toBe('Bearer play-key');
		expect(calls[0]?.headers['x-user-id']).toBe('user-123');
		expect(calls[0]?.headers['accept']).toBe('audio/x-raw');
		expect(calls[0]?.body).toMatchObject({
			output_format: 'raw',
			sample_rate: 24_000,
			text: 'Hello PlayHT',
			voice: 's3://voices/jennifer.json',
			voice_engine: 'Play3.0-mini'
		});
		expect(chunks).toHaveLength(1);
		await session.close();
	});

	test('honors mulaw telephony format with 8 kHz', () => {
		const adapter = playht({
			apiKey: 'play-key',
			outputFormat: 'mulaw',
			userId: 'user-123',
			voice: 's3://voices/jennifer.json'
		});
		expect(adapter.kind).toBe('tts');
	});

	test('rejects mp3 / wav output formats with a clear error', () => {
		expect(() =>
			playht({
				apiKey: 'play-key',
				outputFormat: 'mp3',
				userId: 'user-123',
				voice: 's3://voices/jennifer.json'
			})
		).toThrow(/raw" for PCM playback or "mulaw" for telephony/);
		expect(() =>
			playht({
				apiKey: 'play-key',
				outputFormat: 'wav',
				userId: 'user-123',
				voice: 's3://voices/jennifer.json'
			})
		).toThrow();
	});

	test('forwards quality, speed, temperature, voiceGuidance, voiceEngine, language overrides', async () => {
		const { calls, fetchImpl } = buildFetchStub(() =>
			buildBytesBody([new Uint8Array([0])])
		);
		const adapter = playht({
			apiKey: 'play-key',
			fetch: fetchImpl,
			language: 'spanish',
			quality: 'premium',
			sampleRate: 16_000,
			speed: 1.1,
			temperature: 0.7,
			userId: 'user-123',
			voice: 's3://voices/diego.json',
			voiceEngine: 'PlayDialog',
			voiceGuidance: 1.5
		});
		const session = await adapter.open({ sessionId: 's' });
		await session.send('hola');
		expect(calls[0]?.body).toMatchObject({
			language: 'spanish',
			output_format: 'raw',
			quality: 'premium',
			sample_rate: 16_000,
			speed: 1.1,
			temperature: 0.7,
			voice_engine: 'PlayDialog',
			voice_guidance: 1.5
		});
		await session.close();
	});

	test('emits an error on non-2xx response', async () => {
		const { fetchImpl } = buildFetchStub(
			() =>
				new Response('quota exceeded', {
					status: 402,
					statusText: 'Payment Required'
				})
		);
		const adapter = playht({
			apiKey: 'play-key',
			fetch: fetchImpl,
			userId: 'user-123',
			voice: 's3://voices/jennifer.json'
		});
		const session = await adapter.open({ sessionId: 's' });
		const errors: string[] = [];
		session.on('error', (event) => errors.push(event.error.message));
		await session.send('hi');
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('PlayHT returned 402');
		expect(errors[0]).toContain('quota exceeded');
		await session.close();
	});

	test('whitespace-only send is a no-op', async () => {
		const { calls, fetchImpl } = buildFetchStub(() =>
			buildBytesBody([new Uint8Array([0])])
		);
		const adapter = playht({
			apiKey: 'play-key',
			fetch: fetchImpl,
			userId: 'user-123',
			voice: 's3://voices/jennifer.json'
		});
		const session = await adapter.open({ sessionId: 's' });
		await session.send('   ');
		expect(calls).toHaveLength(0);
		await session.close();
	});

	test('requires apiKey, userId, and voice at construction', () => {
		expect(() =>
			playht({ userId: 'u', voice: 'v' } as unknown as Parameters<typeof playht>[0])
		).toThrow(/apiKey/);
		expect(() =>
			playht({ apiKey: 'k', voice: 'v' } as unknown as Parameters<typeof playht>[0])
		).toThrow(/userId/);
		expect(() =>
			playht({ apiKey: 'k', userId: 'u' } as unknown as Parameters<typeof playht>[0])
		).toThrow(/voice/);
	});
});

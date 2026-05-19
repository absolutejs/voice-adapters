import { describe, expect, test } from 'bun:test';
import { lmnt } from '../src';

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
	session: Awaited<ReturnType<ReturnType<typeof lmnt>['open']>>
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

describe('lmnt TTS adapter', () => {
	test('posts to /v1/ai/speech/stream with X-API-Key and streams audio body', async () => {
		const { calls, fetchImpl } = buildFetchStub(() =>
			buildBytesBody([new Uint8Array([1, 2, 3])])
		);
		const adapter = lmnt({
			apiKey: 'lmnt-key',
			fetch: fetchImpl,
			voice: 'lily'
		});
		const session = await adapter.open({ sessionId: 's' });
		const chunks = collectAudio(session);
		await session.send('Hello LMNT');
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(
			'https://api.lmnt.com/v1/ai/speech/stream'
		);
		expect(calls[0]?.headers['x-api-key']).toBe('lmnt-key');
		expect(calls[0]?.headers['accept']).toBe('audio/x-raw');
		expect(calls[0]?.body).toMatchObject({
			format: 'raw',
			model: 'aurora',
			sample_rate: 24_000,
			text: 'Hello LMNT',
			voice: 'lily'
		});
		expect(chunks).toHaveLength(1);
		await session.close();
	});

	test('rejects mp3 / wav format with a clear error', () => {
		expect(() =>
			lmnt({ apiKey: 'k', format: 'mp3', voice: 'lily' })
		).toThrow(/"raw" for PCM playback or "mulaw" for telephony/);
	});

	test('forwards speed, temperature, top_p, seed, conversational, language overrides', async () => {
		const { calls, fetchImpl } = buildFetchStub(() =>
			buildBytesBody([new Uint8Array([0])])
		);
		const adapter = lmnt({
			apiKey: 'lmnt-key',
			conversational: true,
			fetch: fetchImpl,
			language: 'es',
			model: 'blizzard',
			sampleRate: 16_000,
			seed: 123,
			speed: 1.05,
			temperature: 0.6,
			topP: 0.95,
			voice: 'lily'
		});
		const session = await adapter.open({ sessionId: 's' });
		await session.send('hola');
		expect(calls[0]?.body).toMatchObject({
			conversational: true,
			language: 'es',
			model: 'blizzard',
			sample_rate: 16_000,
			seed: 123,
			speed: 1.05,
			temperature: 0.6,
			top_p: 0.95
		});
		await session.close();
	});

	test('emits error on non-2xx response', async () => {
		const { fetchImpl } = buildFetchStub(
			() =>
				new Response('forbidden', {
					status: 403,
					statusText: 'Forbidden'
				})
		);
		const adapter = lmnt({
			apiKey: 'lmnt-key',
			fetch: fetchImpl,
			voice: 'lily'
		});
		const session = await adapter.open({ sessionId: 's' });
		const errors: string[] = [];
		session.on('error', (event) => errors.push(event.error.message));
		await session.send('hi');
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('LMNT returned 403');
		await session.close();
	});

	test('requires apiKey and voice at construction', () => {
		expect(() =>
			lmnt({ voice: 'lily' } as unknown as Parameters<typeof lmnt>[0])
		).toThrow(/apiKey/);
		expect(() =>
			lmnt({ apiKey: 'k' } as unknown as Parameters<typeof lmnt>[0])
		).toThrow(/voice/);
	});
});

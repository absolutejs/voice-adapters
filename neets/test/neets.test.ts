import { describe, expect, test } from 'bun:test';
import { neets } from '../src';

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
	session: Awaited<ReturnType<ReturnType<typeof neets>['open']>>
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

describe('neets TTS adapter', () => {
	test('posts to /v1/tts with X-API-Key and streams audio body', async () => {
		const { calls, fetchImpl } = buildFetchStub(() =>
			buildBytesBody([new Uint8Array([1, 2, 3])])
		);
		const adapter = neets({
			apiKey: 'neets-key',
			fetch: fetchImpl,
			voiceId: 'us-male-2'
		});
		const session = await adapter.open({ sessionId: 's' });
		const chunks = collectAudio(session);
		await session.send('Hello Neets');
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe('https://api.neets.ai/v1/tts');
		expect(calls[0]?.headers['x-api-key']).toBe('neets-key');
		expect(calls[0]?.headers['accept']).toBe('audio/pcm');
		expect(calls[0]?.body).toMatchObject({
			fmt: 'pcm',
			params: { model: 'ar-diff-50k' },
			sample_rate: 22_050,
			text: 'Hello Neets',
			voice_id: 'us-male-2'
		});
		expect(chunks).toHaveLength(1);
		await session.close();
	});

	test('rejects mp3 / wav formats with clear error', () => {
		expect(() =>
			neets({ apiKey: 'k', format: 'mp3', voiceId: 'v' })
		).toThrow(/"pcm"/);
		expect(() =>
			neets({ apiKey: 'k', format: 'wav', voiceId: 'v' })
		).toThrow();
	});

	test('forwards model, language, temperature, sampleRate overrides', async () => {
		const { calls, fetchImpl } = buildFetchStub(() =>
			buildBytesBody([new Uint8Array([0])])
		);
		const adapter = neets({
			apiKey: 'k',
			fetch: fetchImpl,
			language: 'es-es',
			model: 'style-tts-2',
			sampleRate: 16_000,
			temperature: 0.8,
			voiceId: 'es-female-1'
		});
		const session = await adapter.open({ sessionId: 's' });
		await session.send('hola');
		expect(calls[0]?.body).toMatchObject({
			language: 'es-es',
			params: {
				model: 'style-tts-2',
				temperature: 0.8
			},
			sample_rate: 16_000
		});
		await session.close();
	});

	test('emits error on non-2xx', async () => {
		const { fetchImpl } = buildFetchStub(
			() =>
				new Response('rate limited', {
					status: 429,
					statusText: 'Too Many Requests'
				})
		);
		const adapter = neets({
			apiKey: 'k',
			fetch: fetchImpl,
			voiceId: 'v'
		});
		const session = await adapter.open({ sessionId: 's' });
		const errors: string[] = [];
		session.on('error', (event) => errors.push(event.error.message));
		await session.send('hi');
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('Neets returned 429');
		await session.close();
	});

	test('requires apiKey and voiceId at construction', () => {
		expect(() =>
			neets({ voiceId: 'v' } as unknown as Parameters<typeof neets>[0])
		).toThrow(/apiKey/);
		expect(() =>
			neets({ apiKey: 'k' } as unknown as Parameters<typeof neets>[0])
		).toThrow(/voiceId/);
	});
});

import { describe, expect, test } from 'bun:test';
import { rime } from '../src';

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
	session: Awaited<ReturnType<ReturnType<typeof rime>['open']>>
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

describe('rime TTS adapter', () => {
	test('posts JSON to /v1/rime-tts with bearer auth and streams audio body', async () => {
		const { calls, fetchImpl } = buildFetchStub(() =>
			buildBytesBody([new Uint8Array([1, 2, 3])])
		);
		const adapter = rime({
			apiKey: 'rime-key',
			fetch: fetchImpl,
			speaker: 'cove'
		});
		const session = await adapter.open({ sessionId: 's' });
		const chunks = collectAudio(session);
		await session.send('Hello Rime');
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe('https://users.rime.ai/v1/rime-tts');
		expect(calls[0]?.method).toBe('POST');
		expect(calls[0]?.headers['authorization']).toBe('Bearer rime-key');
		expect(calls[0]?.headers['accept']).toBe('audio/pcm');
		expect(calls[0]?.body).toMatchObject({
			audioFormat: 'pcm',
			modelId: 'mistv2',
			samplingRate: 22_050,
			speaker: 'cove',
			text: 'Hello Rime'
		});
		expect(chunks).toHaveLength(1);
		await session.close();
	});

	test('rejects unsupported audio formats with clear error', () => {
		expect(() =>
			rime({
				apiKey: 'rime-key',
				audioFormat: 'wav',
				speaker: 'cove'
			})
		).toThrow(/"pcm" for PCM playback or "mulaw" for telephony/);
	});

	test('forwards speedAlpha, inlineSpeedAlpha, lang, reduceLatency, phonemize overrides', async () => {
		const { calls, fetchImpl } = buildFetchStub(() =>
			buildBytesBody([new Uint8Array([0])])
		);
		const adapter = rime({
			apiKey: 'rime-key',
			fetch: fetchImpl,
			inlineSpeedAlpha: 1.1,
			lang: 'eng',
			modelId: 'arcana',
			phonemizeBetweenBrackets: true,
			reduceLatency: true,
			speaker: 'marsh',
			speedAlpha: 0.9
		});
		const session = await adapter.open({ sessionId: 's' });
		await session.send('hello');
		expect(calls[0]?.body).toMatchObject({
			inlineSpeedAlpha: 1.1,
			lang: 'eng',
			modelId: 'arcana',
			phonemizeBetweenBrackets: true,
			reduceLatency: true,
			speedAlpha: 0.9
		});
		await session.close();
	});

	test('emits error on non-2xx', async () => {
		const { fetchImpl } = buildFetchStub(
			() =>
				new Response('unauthorized', {
					status: 401,
					statusText: 'Unauthorized'
				})
		);
		const adapter = rime({
			apiKey: 'rime-key',
			fetch: fetchImpl,
			speaker: 'cove'
		});
		const session = await adapter.open({ sessionId: 's' });
		const errors: string[] = [];
		session.on('error', (event) => errors.push(event.error.message));
		await session.send('hi');
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('Rime returned 401');
		await session.close();
	});

	test('whitespace-only send is a no-op', async () => {
		const { calls, fetchImpl } = buildFetchStub(() =>
			buildBytesBody([new Uint8Array([0])])
		);
		const adapter = rime({
			apiKey: 'rime-key',
			fetch: fetchImpl,
			speaker: 'cove'
		});
		const session = await adapter.open({ sessionId: 's' });
		await session.send('   ');
		expect(calls).toHaveLength(0);
		await session.close();
	});

	test('requires apiKey and speaker at construction', () => {
		expect(() =>
			rime({ speaker: 'cove' } as unknown as Parameters<typeof rime>[0])
		).toThrow(/apiKey/);
		expect(() =>
			rime({ apiKey: 'k' } as unknown as Parameters<typeof rime>[0])
		).toThrow(/speaker/);
	});
});

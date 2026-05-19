import { describe, expect, test } from 'bun:test';
import { azureTTS } from '../src';

type Recorded = {
	body: string;
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
		const body = await cloned.text().catch(() => '');
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
	session: Awaited<ReturnType<ReturnType<typeof azureTTS>['open']>>
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

describe('azureTTS adapter', () => {
	test('posts SSML with subscription key, default format, and streams response body', async () => {
		const { calls, fetchImpl } = buildFetchStub(() =>
			buildBytesBody([new Uint8Array([1, 2, 3])])
		);
		const adapter = azureTTS({
			fetch: fetchImpl,
			region: 'eastus',
			subscriptionKey: 'sub-key',
			voice: 'en-US-JennyNeural'
		});
		const session = await adapter.open({ sessionId: 'session-1' });
		const chunks = collectAudio(session);
		await session.send('Hello world');
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(
			'https://eastus.tts.speech.microsoft.com/cognitiveservices/v1'
		);
		expect(calls[0]?.method).toBe('POST');
		expect(calls[0]?.headers['ocp-apim-subscription-key']).toBe('sub-key');
		expect(calls[0]?.headers['x-microsoft-outputformat']).toBe(
			'raw-24khz-16bit-mono-pcm'
		);
		expect(calls[0]?.headers['content-type']).toBe('application/ssml+xml');
		expect(calls[0]?.body).toContain('<voice name="en-US-JennyNeural">');
		expect(calls[0]?.body).toContain('Hello world');
		expect(chunks).toHaveLength(1);
		expect(Array.from(chunks[0]!)).toEqual([1, 2, 3]);
		await session.close();
	});

	test('escapes XML in caller text and voice style metadata', async () => {
		const { calls, fetchImpl } = buildFetchStub(() =>
			buildBytesBody([new Uint8Array([0])])
		);
		const adapter = azureTTS({
			fetch: fetchImpl,
			outputFormat: 'raw-16khz-16bit-mono-pcm',
			region: 'westus',
			styleDegree: 1.5,
			subscriptionKey: 'sub-key',
			voice: 'en-US-JennyNeural',
			voiceStyle: 'cheerful'
		});
		const session = await adapter.open({ sessionId: 's' });
		await session.send('5 < 6 & "ok"');
		expect(calls[0]?.body).toContain(
			'<mstts:express-as style="cheerful" styledegree="1.5">'
		);
		expect(calls[0]?.body).toContain('5 &lt; 6 &amp; &quot;ok&quot;');
		expect(calls[0]?.body).toContain(
			'xmlns:mstts="http://www.w3.org/2001/mstts"'
		);
		await session.close();
	});

	test('supports prosody and language overrides', async () => {
		const { calls, fetchImpl } = buildFetchStub(() =>
			buildBytesBody([new Uint8Array([0])])
		);
		const adapter = azureTTS({
			fetch: fetchImpl,
			language: 'fr-FR',
			prosody: { pitch: '+5%', rate: 'fast' },
			region: 'francecentral',
			subscriptionKey: 'sub-key',
			voice: 'fr-FR-DeniseNeural'
		});
		const session = await adapter.open({ sessionId: 's' });
		await session.send('Bonjour');
		expect(calls[0]?.body).toContain('xml:lang="fr-FR"');
		expect(calls[0]?.body).toContain(
			'<prosody rate="fast" pitch="+5%">Bonjour</prosody>'
		);
		await session.close();
	});

	test('uses bearer token when token is provided', async () => {
		const { calls, fetchImpl } = buildFetchStub(() =>
			buildBytesBody([new Uint8Array([0])])
		);
		const adapter = azureTTS({
			fetch: fetchImpl,
			region: 'eastus',
			token: 'short-lived-token',
			voice: 'en-US-JennyNeural'
		});
		const session = await adapter.open({ sessionId: 's' });
		await session.send('hi');
		expect(calls[0]?.headers['authorization']).toBe('Bearer short-lived-token');
		expect(calls[0]?.headers['ocp-apim-subscription-key']).toBeUndefined();
		await session.close();
	});

	test('emits an error event on non-2xx responses', async () => {
		const { fetchImpl } = buildFetchStub(
			() =>
				new Response('quota exceeded', {
					status: 429,
					statusText: 'Too Many Requests'
				})
		);
		const adapter = azureTTS({
			fetch: fetchImpl,
			region: 'eastus',
			subscriptionKey: 'sub-key',
			voice: 'en-US-JennyNeural'
		});
		const session = await adapter.open({ sessionId: 's' });
		const errors: string[] = [];
		session.on('error', (event) => errors.push(event.error.message));
		await session.send('hi');
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('Azure TTS returned 429');
		expect(errors[0]).toContain('quota exceeded');
		await session.close();
	});

	test('rejects audio-* (non-raw) output formats with a clear error', () => {
		expect(() =>
			azureTTS({
				outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
				region: 'eastus',
				subscriptionKey: 'sub-key',
				voice: 'en-US-JennyNeural'
			})
		).toThrow(/raw-\*/);
	});

	test('requires either subscriptionKey or token', () => {
		expect(() =>
			azureTTS({
				region: 'eastus',
				voice: 'en-US-JennyNeural'
			} as unknown as Parameters<typeof azureTTS>[0])
		).toThrow(/subscriptionKey or token/);
	});

	test('requires region when no baseUrl is provided', () => {
		expect(() =>
			azureTTS({
				subscriptionKey: 'sub-key',
				voice: 'en-US-JennyNeural'
			} as unknown as Parameters<typeof azureTTS>[0])
		).toThrow(/baseUrl or region/);
	});

	test('honors mulaw and alaw raw telephony formats', () => {
		expect(() =>
			azureTTS({
				outputFormat: 'raw-8khz-8bit-mono-mulaw',
				region: 'eastus',
				subscriptionKey: 'sub-key',
				voice: 'en-US-JennyNeural'
			})
		).not.toThrow();
		expect(() =>
			azureTTS({
				outputFormat: 'raw-8khz-8bit-mono-alaw',
				region: 'eastus',
				subscriptionKey: 'sub-key',
				voice: 'en-US-JennyNeural'
			})
		).not.toThrow();
	});

	test('whitespace-only send is a no-op', async () => {
		const { calls, fetchImpl } = buildFetchStub(() =>
			buildBytesBody([new Uint8Array([0])])
		);
		const adapter = azureTTS({
			fetch: fetchImpl,
			region: 'eastus',
			subscriptionKey: 'sub-key',
			voice: 'en-US-JennyNeural'
		});
		const session = await adapter.open({ sessionId: 's' });
		await session.send('   ');
		expect(calls).toHaveLength(0);
		await session.close();
	});
});

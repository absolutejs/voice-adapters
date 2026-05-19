import { afterEach, describe, expect, test } from 'bun:test';
import { gladia } from '../src';

class FakeWebSocket extends EventTarget {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: FakeWebSocket[] = [];

	readonly url: string;
	readyState = FakeWebSocket.CONNECTING;
	sentText: string[] = [];
	sentBinary: Uint8Array[] = [];

	constructor(url: string) {
		super();
		this.url = url;
		FakeWebSocket.instances.push(this);
	}

	send(data: string | ArrayBufferLike | ArrayBufferView | Blob) {
		if (typeof data === 'string') {
			this.sentText.push(data);
			return;
		}
		const view = ArrayBuffer.isView(data)
			? new Uint8Array(
					data.buffer.slice(
						data.byteOffset,
						data.byteOffset + data.byteLength
					)
			  )
			: new Uint8Array(data as ArrayBuffer);
		this.sentBinary.push(view);
	}

	close(code?: number, reason?: string) {
		this.readyState = FakeWebSocket.CLOSED;
		this.dispatchEvent(new CloseEvent('close', { code, reason }));
	}

	openSocket() {
		this.readyState = FakeWebSocket.OPEN;
		this.dispatchEvent(new Event('open'));
	}

	receiveText(payload: Record<string, unknown>) {
		this.dispatchEvent(
			new MessageEvent('message', { data: JSON.stringify(payload) })
		);
	}
}

type Recorded = {
	body: unknown;
	headers: Record<string, string>;
	url: string;
};

const collectHeaders = (headers: Headers) => {
	const out: Record<string, string> = {};
	headers.forEach((value, key) => {
		out[key.toLowerCase()] = value;
	});
	return out;
};

const buildHttpStub = (
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
			url: request.url
		});
		return respond(request);
	};
	return { calls, fetchImpl };
};

const sessionResponse = (overrides: Record<string, unknown> = {}) =>
	new Response(
		JSON.stringify({
			id: 'session-id',
			url: 'wss://api.gladia.io/v2/live/session-id',
			...overrides
		}),
		{
			headers: { 'content-type': 'application/json' },
			status: 200
		}
	);

const openSession = async (
	configOverrides: Partial<Parameters<typeof gladia>[0]> = {},
	openOverrides: {
		format?: { channels?: number; encoding?: string; sampleRateHz?: number };
		languageStrategy?: unknown;
	} = {},
	httpStub = buildHttpStub(() => sessionResponse())
) => {
	const adapter = gladia({
		apiKey: 'gladia-key',
		fetch: httpStub.fetchImpl,
		webSocket: {
			factory: (url) => new FakeWebSocket(url) as unknown as WebSocket
		},
		...configOverrides
	} as Parameters<typeof gladia>[0]);
	const promise = adapter.open({
		format: {
			channels: 1,
			container: 'raw',
			encoding: 'pcm_s16le',
			sampleRateHz: 16_000,
			...(openOverrides.format ?? {})
		},
		languageStrategy: openOverrides.languageStrategy as never,
		sessionId: 's'
	});
	// Give the HTTP POST a tick to land before the socket opens
	await new Promise((resolve) => setTimeout(resolve, 0));
	const socket =
		FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
	socket.openSocket();
	const session = await promise;
	return { httpStub, session, socket };
};

afterEach(() => {
	FakeWebSocket.instances = [];
});

describe('gladia STT adapter', () => {
	test('POSTs session config to /v2/live with X-Gladia-Key then opens the socket URL it returns', async () => {
		const { httpStub, socket, session } = await openSession();
		expect(httpStub.calls).toHaveLength(1);
		expect(httpStub.calls[0]?.url).toBe('https://api.gladia.io/v2/live');
		expect(httpStub.calls[0]?.headers['x-gladia-key']).toBe('gladia-key');
		expect(httpStub.calls[0]?.body).toMatchObject({
			bit_depth: 16,
			channels: 1,
			encoding: 'wav/pcm',
			language_config: { languages: ['en'] },
			model: 'solaria-1',
			sample_rate: 16_000
		});
		expect(socket.url).toBe(
			'wss://api.gladia.io/v2/live/session-id'
		);
		await session.close();
	});

	test('streams audio chunks as binary frames once the socket is open', async () => {
		const { socket, session } = await openSession();
		await session.send(new Uint8Array([1, 2, 3]));
		expect(socket.sentBinary).toHaveLength(1);
		expect(Array.from(socket.sentBinary[0]!)).toEqual([1, 2, 3]);
		await session.close();
	});

	test('queues audio sent before the socket open completes', async () => {
		const httpStub = buildHttpStub(() => sessionResponse());
		const adapter = gladia({
			apiKey: 'gladia-key',
			fetch: httpStub.fetchImpl,
			webSocket: {
				factory: (url) =>
					new FakeWebSocket(url) as unknown as WebSocket
			}
		});
		const promise = adapter.open({
			format: {
				channels: 1,
				container: 'raw',
				encoding: 'pcm_s16le',
				sampleRateHz: 16_000
			},
			sessionId: 's'
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		const socket =
			FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
		queueMicrotask(() => socket.openSocket());
		const session = await promise;
		await session.send(new Uint8Array([7, 8, 9]));
		expect(socket.sentBinary.length).toBeGreaterThan(0);
		await session.close();
	});

	test('maps transcript messages to partial and final events with confidence + timing', async () => {
		const { socket, session } = await openSession();
		const partials: { confidence?: number; text: string }[] = [];
		const finals: {
			endedAtMs?: number;
			startedAtMs?: number;
			text: string;
		}[] = [];
		session.on('partial', (event) =>
			partials.push({
				confidence: event.transcript.confidence,
				text: event.transcript.text
			})
		);
		session.on('final', (event) =>
			finals.push({
				endedAtMs: event.transcript.endedAtMs,
				startedAtMs: event.transcript.startedAtMs,
				text: event.transcript.text
			})
		);
		socket.receiveText({
			data: {
				is_final: false,
				utterance: { confidence: 0.72, text: 'hello' }
			},
			type: 'transcript'
		});
		socket.receiveText({
			data: {
				is_final: true,
				utterance: {
					confidence: 0.94,
					end: 1.5,
					start: 0.5,
					text: 'Hello world.'
				}
			},
			type: 'transcript'
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(partials).toEqual([{ confidence: 0.72, text: 'hello' }]);
		expect(finals).toEqual([
			{ endedAtMs: 1_500, startedAtMs: 500, text: 'Hello world.' }
		]);
		await session.close();
	});

	test('emits endOfTurn on end_of_utterance / speech_end', async () => {
		const { socket, session } = await openSession();
		const reasons: string[] = [];
		session.on('endOfTurn', (event) => reasons.push(event.reason));
		socket.receiveText({ type: 'end_of_utterance' });
		socket.receiveText({ type: 'speech_end' });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(reasons).toEqual(['vendor', 'vendor']);
		await session.close();
	});

	test('honors languageStrategy allow-switching with secondary languages', async () => {
		const { httpStub, session } = await openSession(
			{ codeSwitching: true },
			{
				languageStrategy: {
					mode: 'allow-switching',
					primaryLanguage: 'en',
					secondaryLanguages: ['hi']
				}
			}
		);
		expect(httpStub.calls[0]?.body).toMatchObject({
			language_config: {
				code_switching: true,
				languages: ['en', 'hi']
			}
		});
		await session.close();
	});

	test('rejects unsupported encodings before opening the socket', async () => {
		const httpStub = buildHttpStub(() => sessionResponse());
		const adapter = gladia({
			apiKey: 'gladia-key',
			fetch: httpStub.fetchImpl,
			webSocket: {
				factory: (url) =>
					new FakeWebSocket(url) as unknown as WebSocket
			}
		});
		await expect(
			adapter.open({
				format: {
					channels: 1,
					container: 'raw',
					encoding: 'opus' as never,
					sampleRateHz: 48_000
				},
				sessionId: 's'
			})
		).rejects.toThrow(/Unsupported audio encoding/);
	});

	test('surfaces a clear error if /v2/live returns non-2xx', async () => {
		const httpStub = buildHttpStub(
			() =>
				new Response('quota exhausted', {
					status: 402,
					statusText: 'Payment Required'
				})
		);
		const adapter = gladia({
			apiKey: 'gladia-key',
			fetch: httpStub.fetchImpl,
			webSocket: {
				factory: (url) =>
					new FakeWebSocket(url) as unknown as WebSocket
			}
		});
		await expect(
			adapter.open({
				format: {
					channels: 1,
					container: 'raw',
					encoding: 'pcm_s16le',
					sampleRateHz: 16_000
				},
				sessionId: 's'
			})
		).rejects.toThrow(/Gladia \/v2\/live returned 402/);
	});

	test('requires an apiKey at construction', () => {
		expect(() =>
			gladia({} as unknown as Parameters<typeof gladia>[0])
		).toThrow(/apiKey/);
	});
});

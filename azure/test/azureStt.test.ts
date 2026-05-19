import { afterEach, describe, expect, test } from 'bun:test';
import { azureSTT } from '../src';

class FakeWebSocket extends EventTarget {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: FakeWebSocket[] = [];

	readonly headers: Record<string, string>;
	readonly url: string;
	readyState = FakeWebSocket.CONNECTING;
	sentText: string[] = [];
	sentBinary: Uint8Array[] = [];
	closeCalls: { code?: number; reason?: string }[] = [];

	constructor(url: string, headers: Record<string, string>) {
		super();
		this.url = url;
		this.headers = headers;
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
		this.closeCalls.push({ code, reason });
		this.readyState = FakeWebSocket.CLOSED;
		this.dispatchEvent(new CloseEvent('close', { code, reason }));
	}

	openSocket() {
		this.readyState = FakeWebSocket.OPEN;
		this.dispatchEvent(new Event('open'));
	}

	receiveText(payload: string) {
		this.dispatchEvent(new MessageEvent('message', { data: payload }));
	}
}

const buildResponse = (
	path: string,
	body: Record<string, unknown>,
	requestId: string
) =>
	`Content-Type: application/json; charset=utf-8\r\n` +
	`Path: ${path}\r\n` +
	`X-RequestId: ${requestId}\r\n` +
	`X-Timestamp: 2026-01-01T00:00:00.000Z\r\n` +
	`\r\n${JSON.stringify(body)}`;

const baseConfig = {
	region: 'eastus',
	subscriptionKey: 'sub-key'
} as const;

const openSession = async (
	overrides: Partial<Parameters<typeof azureSTT>[0]> = {}
) => {
	const adapter = azureSTT({
		...baseConfig,
		webSocket: {
			factory: (url, headers) =>
				new FakeWebSocket(url, headers) as unknown as WebSocket
		},
		...overrides
	} as Parameters<typeof azureSTT>[0]);
	const sessionPromise = adapter.open({
		format: {
			channels: 1,
			container: 'raw',
			encoding: 'pcm_s16le',
			sampleRateHz: 16_000
		},
		sessionId: 'session-1'
	});
	const socket =
		FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
	socket.openSocket();
	const session = await sessionPromise;
	return { session, socket };
};

afterEach(() => {
	FakeWebSocket.instances = [];
});

describe('azureSTT adapter', () => {
	test('opens with the right URL, headers, and sends a speech.config text frame', async () => {
		const { socket, session } = await openSession();
		expect(socket.url).toContain(
			'wss://eastus.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1'
		);
		expect(socket.url).toContain('language=en-US');
		expect(socket.url).toContain('format=detailed');
		expect(socket.headers['Ocp-Apim-Subscription-Key']).toBe('sub-key');
		expect(socket.headers['X-ConnectionId']).toMatch(/^[0-9a-f]{32}$/);
		expect(socket.sentText).toHaveLength(1);
		expect(socket.sentText[0]).toContain('Path: speech.config');
		expect(socket.sentText[0]).toContain(
			'"name":"@absolutejs/voice-azure"'
		);
		await session.close();
	});

	test('prepends RIFF header to first audio chunk and frames subsequent chunks raw', async () => {
		const { socket, session } = await openSession();
		await session.send(new Uint8Array([1, 2, 3, 4]));
		await session.send(new Uint8Array([5, 6, 7, 8]));
		expect(socket.sentBinary).toHaveLength(2);
		const first = socket.sentBinary[0]!;
		// header-len prefix is 2 bytes (big endian), then ASCII header, then RIFF+audio
		const headerLen = new DataView(first.buffer).getUint16(0, false);
		const text = new TextDecoder().decode(
			first.slice(2, 2 + headerLen)
		);
		expect(text).toContain('Path: audio');
		expect(text).toContain('Content-Type: audio/x-wav');
		const body = first.slice(2 + headerLen);
		expect(new TextDecoder().decode(body.slice(0, 4))).toBe('RIFF');
		expect(body.byteLength).toBe(44 + 4);
		const second = socket.sentBinary[1]!;
		const secondHeaderLen = new DataView(second.buffer).getUint16(
			0,
			false
		);
		const secondBody = second.slice(2 + secondHeaderLen);
		// second chunk should NOT include another RIFF header
		expect(new TextDecoder().decode(secondBody.slice(0, 4))).not.toBe(
			'RIFF'
		);
		expect(Array.from(secondBody)).toEqual([5, 6, 7, 8]);
		await session.close();
	});

	test('emits partial and final transcript events from speech.hypothesis / speech.phrase', async () => {
		const { socket, session } = await openSession();
		const partials: string[] = [];
		const finals: { text: string; confidence?: number }[] = [];
		session.on('partial', (event) => {
			partials.push(event.transcript.text);
		});
		session.on('final', (event) => {
			finals.push({
				confidence: event.transcript.confidence,
				text: event.transcript.text
			});
		});
		const requestId = socket.sentText[0]!
			.match(/X-RequestId: ([0-9a-f]+)/)![1]!;
		socket.receiveText(
			buildResponse(
				'speech.hypothesis',
				{ Duration: 1_000, Offset: 0, Text: 'hello' },
				requestId
			)
		);
		socket.receiveText(
			buildResponse(
				'speech.phrase',
				{
					DisplayText: 'Hello world.',
					Duration: 2_000,
					NBest: [{ Confidence: 0.93, Display: 'Hello world.' }],
					Offset: 0,
					RecognitionStatus: 'Success'
				},
				requestId
			)
		);
		// Give microtasks a chance to drain
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(partials).toEqual(['hello']);
		expect(finals).toEqual([{ confidence: 0.93, text: 'Hello world.' }]);
		await session.close();
	});

	test('emits endOfTurn on turn.end', async () => {
		const { socket, session } = await openSession();
		const turns: string[] = [];
		session.on('endOfTurn', (event) => {
			turns.push(event.reason);
		});
		const requestId = socket.sentText[0]!
			.match(/X-RequestId: ([0-9a-f]+)/)![1]!;
		socket.receiveText(buildResponse('turn.end', {}, requestId));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(turns).toEqual(['vendor']);
		await session.close();
	});

	test('queues audio sent before open completes', async () => {
		const adapter = azureSTT({
			...baseConfig,
			webSocket: {
				factory: (url, headers) =>
					new FakeWebSocket(url, headers) as unknown as WebSocket
			}
		} as Parameters<typeof azureSTT>[0]);
		const sessionPromise = adapter.open({
			format: {
				channels: 1,
				container: 'raw',
				encoding: 'pcm_s16le',
				sampleRateHz: 16_000
			},
			sessionId: 's'
		});
		const socket =
			FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
		// Open happens after we've sent — fire it on the next microtask
		queueMicrotask(() => socket.openSocket());
		const session = await sessionPromise;
		// Now send audio AFTER open
		await session.send(new Uint8Array([9, 9, 9]));
		expect(socket.sentBinary.length).toBeGreaterThan(0);
		await session.close();
	});

	test('throws when constructed without a key or token', () => {
		expect(() =>
			azureSTT({ region: 'eastus' } as unknown as Parameters<typeof azureSTT>[0])
		).toThrow(/subscriptionKey or token/);
	});

	test('honors languageStrategy primaryLanguage', async () => {
		const adapter = azureSTT({
			...baseConfig,
			webSocket: {
				factory: (url, headers) =>
					new FakeWebSocket(url, headers) as unknown as WebSocket
			}
		} as Parameters<typeof azureSTT>[0]);
		const sessionPromise = adapter.open({
			format: {
				channels: 1,
				container: 'raw',
				encoding: 'pcm_s16le',
				sampleRateHz: 16_000
			},
			languageStrategy: { mode: 'fixed', primaryLanguage: 'fr-FR' },
			sessionId: 's'
		});
		const socket =
			FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
		socket.openSocket();
		await sessionPromise;
		expect(socket.url).toContain('language=fr-FR');
	});

	test('forwards bearer token instead of subscription key', async () => {
		const adapter = azureSTT({
			region: 'eastus',
			token: 'short-token',
			webSocket: {
				factory: (url, headers) =>
					new FakeWebSocket(url, headers) as unknown as WebSocket
			}
		} as Parameters<typeof azureSTT>[0]);
		const sessionPromise = adapter.open({
			format: {
				channels: 1,
				container: 'raw',
				encoding: 'pcm_s16le',
				sampleRateHz: 16_000
			},
			sessionId: 's'
		});
		const socket =
			FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
		socket.openSocket();
		await sessionPromise;
		expect(socket.headers['Authorization']).toBe('Bearer short-token');
		expect(socket.headers['Ocp-Apim-Subscription-Key']).toBeUndefined();
	});
});

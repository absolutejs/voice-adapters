import { afterEach, describe, expect, test } from 'bun:test';
import { speechmatics } from '../src';

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

const baseConfig = {
	apiKey: 'sm-key',
	webSocket: {
		factory: (url: string) =>
			new FakeWebSocket(url) as unknown as WebSocket
	}
} as const;

afterEach(() => {
	FakeWebSocket.instances = [];
});

const openSession = async (
	configOverrides: Partial<Parameters<typeof speechmatics>[0]> = {},
	openOverrides: {
		format?: { channels?: number; encoding?: string; sampleRateHz?: number };
		languageStrategy?: unknown;
	} = {}
) => {
	const adapter = speechmatics({
		...baseConfig,
		...configOverrides
	} as Parameters<typeof speechmatics>[0]);
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
	const socket =
		FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
	socket.openSocket();
	socket.receiveText({ message: 'RecognitionStarted' });
	const session = await promise;
	return { session, socket };
};

describe('speechmatics STT adapter', () => {
	test('connects with JWT param + sends StartRecognition with PCM config', async () => {
		const { socket, session } = await openSession();
		expect(socket.url).toContain('wss://eu2.rt.speechmatics.com/v2');
		expect(socket.url).toContain('jwt=sm-key');
		expect(socket.sentText).toHaveLength(1);
		const start = JSON.parse(socket.sentText[0]!);
		expect(start).toMatchObject({
			audio_format: {
				encoding: 'pcm_s16le',
				sample_rate: 16_000,
				type: 'raw'
			},
			message: 'StartRecognition',
			transcription_config: {
				enable_partials: true,
				language: 'en',
				operating_point: 'enhanced'
			}
		});
		await session.close();
	});

	test('routes audio chunks as binary WebSocket frames', async () => {
		const { socket, session } = await openSession();
		await session.send(new Uint8Array([1, 2, 3, 4]));
		await session.send(new Uint8Array([5, 6, 7, 8]));
		expect(socket.sentBinary).toHaveLength(2);
		expect(Array.from(socket.sentBinary[0]!)).toEqual([1, 2, 3, 4]);
		expect(Array.from(socket.sentBinary[1]!)).toEqual([5, 6, 7, 8]);
		await session.close();
	});

	test('queues audio sent before RecognitionStarted', async () => {
		const adapter = speechmatics({
			...baseConfig
		} as Parameters<typeof speechmatics>[0]);
		const promise = adapter.open({
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
		// Now drive open completion later — send audio before RecognitionStarted
		queueMicrotask(() => socket.receiveText({ message: 'RecognitionStarted' }));
		const session = await promise;
		await session.send(new Uint8Array([1, 2, 3]));
		expect(socket.sentBinary.length).toBeGreaterThan(0);
		await session.close();
	});

	test('emits partial transcript on AddPartialTranscript', async () => {
		const { socket, session } = await openSession();
		const partials: { text: string; confidence?: number }[] = [];
		session.on('partial', (event) =>
			partials.push({
				confidence: event.transcript.confidence,
				text: event.transcript.text
			})
		);
		socket.receiveText({
			message: 'AddPartialTranscript',
			results: [
				{
					alternatives: [{ confidence: 0.9, content: 'hello' }],
					type: 'word'
				},
				{
					alternatives: [{ confidence: 0.95, content: 'world' }],
					type: 'word'
				}
			]
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(partials).toEqual([
			{ confidence: (0.9 + 0.95) / 2, text: 'hello world' }
		]);
		await session.close();
	});

	test('emits final transcript with punctuation joined to preceding word', async () => {
		const { socket, session } = await openSession();
		const finals: string[] = [];
		session.on('final', (event) => finals.push(event.transcript.text));
		socket.receiveText({
			message: 'AddTranscript',
			results: [
				{
					alternatives: [{ confidence: 0.92, content: 'Hello' }],
					type: 'word'
				},
				{
					alternatives: [{ confidence: 0.92, content: 'world' }],
					type: 'word'
				},
				{
					alternatives: [{ content: '.' }],
					type: 'punctuation'
				}
			]
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(finals).toEqual(['Hello world.']);
		await session.close();
	});

	test('emits endOfTurn on EndOfTranscript', async () => {
		const { socket, session } = await openSession();
		const reasons: string[] = [];
		session.on('endOfTurn', (event) => reasons.push(event.reason));
		socket.receiveText({ message: 'EndOfTranscript' });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(reasons).toEqual(['vendor']);
		await session.close();
	});

	test('honors languageStrategy primaryLanguage in StartRecognition', async () => {
		const { socket, session } = await openSession(
			{},
			{
				languageStrategy: {
					mode: 'fixed',
					primaryLanguage: 'es'
				}
			}
		);
		const start = JSON.parse(socket.sentText[0]!);
		expect(start.transcription_config.language).toBe('es');
		await session.close();
	});

	test('rejects unsupported audio encoding', async () => {
		const adapter = speechmatics({
			...baseConfig
		} as Parameters<typeof speechmatics>[0]);
		const promise = adapter.open({
			format: {
				channels: 1,
				container: 'raw',
				encoding: 'opus' as never,
				sampleRateHz: 48_000
			},
			sessionId: 's'
		});
		const socket =
			FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
		socket.openSocket();
		await expect(promise).rejects.toThrow(/Unsupported audio encoding/);
	});

	test('requires apiKey or jwt at construction', () => {
		expect(() =>
			speechmatics({} as unknown as Parameters<typeof speechmatics>[0])
		).toThrow(/apiKey or jwt/);
	});
});

import { afterEach, describe, expect, test } from 'bun:test';
import { soniox } from '../src';

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
	apiKey: 'soniox-key',
	webSocket: {
		factory: (url: string) =>
			new FakeWebSocket(url) as unknown as WebSocket
	}
} as const;

afterEach(() => {
	FakeWebSocket.instances = [];
});

const openSession = async (
	configOverrides: Partial<Parameters<typeof soniox>[0]> = {},
	openOverrides: {
		format?: { channels?: number; encoding?: string; sampleRateHz?: number };
		languageStrategy?: unknown;
	} = {}
) => {
	const adapter = soniox({
		...baseConfig,
		...configOverrides
	} as Parameters<typeof soniox>[0]);
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
	const session = await promise;
	return { session, socket };
};

describe('soniox STT adapter', () => {
	test('connects to /transcribe-websocket and sends start config carrying api_key', async () => {
		const { socket, session } = await openSession();
		expect(socket.url).toBe(
			'wss://stt-rt.soniox.com/transcribe-websocket'
		);
		expect(socket.sentText).toHaveLength(1);
		const start = JSON.parse(socket.sentText[0]!);
		expect(start).toMatchObject({
			api_key: 'soniox-key',
			audio_format: 'pcm_s16le',
			model: 'stt-rt-preview',
			num_channels: 1,
			sample_rate: 16_000
		});
		await session.close();
	});

	test('streams audio chunks as binary frames', async () => {
		const { socket, session } = await openSession();
		await session.send(new Uint8Array([1, 2, 3]));
		await session.send(new Uint8Array([4, 5, 6]));
		expect(socket.sentBinary).toHaveLength(2);
		expect(Array.from(socket.sentBinary[1]!)).toEqual([4, 5, 6]);
		await session.close();
	});

	test('queues audio sent before the open completes', async () => {
		const adapter = soniox({
			...baseConfig
		} as Parameters<typeof soniox>[0]);
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
		queueMicrotask(() => socket.openSocket());
		const session = await promise;
		await session.send(new Uint8Array([9, 9, 9]));
		expect(socket.sentBinary.length).toBeGreaterThan(0);
		await session.close();
	});

	test('maps non-final tokens to partial events and final tokens to final events', async () => {
		const { socket, session } = await openSession();
		const partials: string[] = [];
		const finals: { text: string; confidence?: number }[] = [];
		session.on('partial', (event) =>
			partials.push(event.transcript.text)
		);
		session.on('final', (event) =>
			finals.push({
				confidence: event.transcript.confidence,
				text: event.transcript.text
			})
		);
		socket.receiveText({
			tokens: [
				{ is_final: false, text: 'hello' }
			]
		});
		socket.receiveText({
			tokens: [
				{ confidence: 0.91, is_final: true, text: 'Hello' },
				{ confidence: 0.93, is_final: true, text: ' world.' }
			]
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(partials).toEqual(['hello']);
		expect(finals).toEqual([
			{ confidence: (0.91 + 0.93) / 2, text: 'Hello world.' }
		]);
		await session.close();
	});

	test('emits endOfTurn when message has finished:true', async () => {
		const { socket, session } = await openSession();
		const reasons: string[] = [];
		session.on('endOfTurn', (event) => reasons.push(event.reason));
		socket.receiveText({ finished: true });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(reasons).toEqual(['vendor']);
		await session.close();
	});

	test('forwards languageStrategy primaryLanguage as a language hint', async () => {
		const { socket, session } = await openSession(
			{ enableLanguageIdentification: true },
			{
				languageStrategy: {
					mode: 'fixed',
					primaryLanguage: 'hi'
				}
			}
		);
		const start = JSON.parse(socket.sentText[0]!);
		expect(start.language_hints).toEqual(['hi']);
		expect(start.enable_language_identification).toBe(true);
		await session.close();
	});

	test('emits error events for messages with error_code', async () => {
		const { socket, session } = await openSession();
		const errors: { code?: string; message: string }[] = [];
		session.on('error', (event) =>
			errors.push({ code: event.code, message: event.error.message })
		);
		socket.receiveText({
			error_code: 'INVALID_CONFIG',
			error_message: 'bad sample rate'
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(errors).toEqual([
			{ code: 'INVALID_CONFIG', message: 'bad sample rate' }
		]);
		await session.close();
	});

	test('requires apiKey at construction', () => {
		expect(() =>
			soniox({} as unknown as Parameters<typeof soniox>[0])
		).toThrow(/apiKey/);
	});
});

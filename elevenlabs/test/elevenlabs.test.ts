import { afterEach, describe, expect, test } from 'bun:test';
import { elevenlabs } from '../src';

class FakeWebSocket extends EventTarget {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: FakeWebSocket[] = [];

	readonly url: string;
	readyState = FakeWebSocket.CONNECTING;
	sent: string[] = [];

	constructor(url: string | URL) {
		super();
		this.url = String(url);
		FakeWebSocket.instances.push(this);
		queueMicrotask(() => {
			this.readyState = FakeWebSocket.OPEN;
			this.dispatchEvent(new Event('open'));
		});
	}

	send(data: string) {
		this.sent.push(data);
	}

	close(code = 1000, reason?: string) {
		this.readyState = FakeWebSocket.CLOSED;
		this.dispatchEvent(
			new CloseEvent('close', {
				code,
				reason
			})
		);
	}

	receive(payload: Record<string, unknown>) {
		this.dispatchEvent(
			new MessageEvent('message', {
				data: JSON.stringify(payload)
			})
		);
	}
}

const OriginalWebSocket = globalThis.WebSocket;

afterEach(() => {
	globalThis.WebSocket = OriginalWebSocket;
	FakeWebSocket.instances = [];
});

const waitFor = async (
	check: () => boolean,
	timeoutMs = 250
) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) {
			return;
		}
		await Bun.sleep(5);
	}

	if (!check()) {
		throw new Error('Timed out waiting for websocket test condition.');
	}
};

describe('elevenlabs websocket transport', () => {
	test('initializes a warm websocket session and flushes a turn', async () => {
		globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

		const adapter = elevenlabs({
			apiKey: 'test-api-key',
			modelId: 'eleven_flash_v2_5',
			outputFormat: 'ulaw_8000',
			transport: 'websocket',
			voiceId: 'voice_123',
			voiceSettings: {
				similarityBoost: 0.8,
				stability: 0.5
			},
			websocket: {
				autoMode: true,
				chunkLengthSchedule: [50, 120],
				inactivityTimeoutSec: 30
			}
		});
		const session = await adapter.open({
			sessionId: 'ws-test'
		});
		const socket = FakeWebSocket.instances[0];
		expect(socket).toBeDefined();
		expect(socket.url).toContain('/stream-input');
		expect(socket.url).toContain('output_format=ulaw_8000');
		expect(socket.url).toContain('auto_mode=true');
		expect(socket.url).toContain('inactivity_timeout=30');

		await Promise.resolve();

		expect(socket.sent).toHaveLength(1);
		expect(JSON.parse(socket.sent[0]!)).toEqual({
			generation_config: {
				chunk_length_schedule: [50, 120]
			},
			text: ' ',
			voice_settings: {
				similarity_boost: 0.8,
				stability: 0.5
			},
			xi_api_key: 'test-api-key'
		});

		const chunks: Uint8Array[] = [];
		const unsubscribe = session.on('audio', (event) => {
			chunks.push(
				event.chunk instanceof Uint8Array
					? event.chunk
					: new Uint8Array(event.chunk)
			);
			expect(event.format.encoding).toBe('mulaw');
			expect(event.format.sampleRateHz).toBe(8000);
		});

		const sendPromise = session.send('Hello world');
		await waitFor(() => socket.sent.length >= 2);
		expect(JSON.parse(socket.sent[1]!)).toEqual({
			flush: true,
			text: 'Hello world '
		});

		socket.receive({
			audio: Buffer.from('abc').toString('base64'),
			isFinal: false
		});
		await Promise.resolve();
		expect(chunks).toHaveLength(1);
		expect(Buffer.from(chunks[0]!).toString()).toBe('abc');

		socket.receive({
			isFinal: true
		});
		await sendPromise;

		unsubscribe();
		await session.close('done');
		expect(JSON.parse(socket.sent[2]!)).toEqual({
			text: ''
		});
	});

	test('resolves a websocket turn after audio goes idle even without isFinal', async () => {
		globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

		const adapter = elevenlabs({
			apiKey: 'test-api-key',
			outputFormat: 'pcm_16000',
			transport: 'websocket',
			voiceId: 'voice_123',
			websocket: {
				finalIdleTimeoutMs: 20,
				generationTimeoutMs: 250
			}
		});
		const session = await adapter.open({
			sessionId: 'ws-idle-test'
		});
		const socket = FakeWebSocket.instances[0]!;

		await Promise.resolve();

		const sendPromise = session.send('Idle finalize');
		await waitFor(() => socket.sent.length >= 2);
		socket.receive({
			audio: Buffer.from('abc').toString('base64'),
			isFinal: false
		});

		await sendPromise;
		await session.close('done');
	});

	test('preserves provider error code, status, and message in websocket errors', async () => {
		globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

		const adapter = elevenlabs({
			apiKey: 'test-api-key',
			outputFormat: 'pcm_16000',
			transport: 'websocket',
			voiceId: 'voice_123'
		});
		const session = await adapter.open({
			sessionId: 'ws-error-test'
		});
		const socket = FakeWebSocket.instances[0]!;
		const errors: string[] = [];
		session.on('error', (event) => {
			errors.push(event.error.message);
		});

		await Promise.resolve();

		const sendPromise = session.send('Needs a paid plan');
		await waitFor(() => socket.sent.length >= 2);
		socket.receive({
			error: {
				code: 'paid_plan_required',
				message: 'payment_required',
				status: 'payment_required',
				detail:
					'Free users cannot use library voices via the API. Please upgrade your subscription to use this voice.'
			}
		});

		await expect(sendPromise).rejects.toThrow(
			'paid_plan_required: payment_required: Free users cannot use library voices via the API. Please upgrade your subscription to use this voice.'
		);
		expect(errors).toEqual([
			'paid_plan_required: payment_required: Free users cannot use library voices via the API. Please upgrade your subscription to use this voice.'
		]);
		await session.close('done');
	});
});

describe('elevenlabs http transport', () => {
	test('preserves provider error body in HTTP streaming errors', async () => {
		const adapter = elevenlabs({
			apiKey: 'test-api-key',
			fetch: Object.assign(
				() =>
					Promise.resolve(
						new Response(
							JSON.stringify({
								detail: {
									message: 'payment_required',
									status: 'paid_plan_required'
								}
							}),
							{
								status: 402,
								statusText: 'Payment Required'
							}
						)
					) as ReturnType<typeof fetch>,
				{ preconnect: fetch.preconnect }
			) as typeof fetch,
			outputFormat: 'pcm_16000',
			transport: 'http',
			voiceId: 'voice_123'
		});
		const session = await adapter.open();
		const errors: string[] = [];
		session.on('error', (event) => {
			errors.push(event.error.message);
		});

		await session.send('Needs a paid plan');

		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('402 Payment Required');
		expect(errors[0]).toContain('payment_required');
		expect(errors[0]).toContain('paid_plan_required');
	});
});

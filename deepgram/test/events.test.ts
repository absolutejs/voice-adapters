import { describe, expect, test } from 'bun:test';
import { deepgram } from '../src';

type WebSocketListener = (event: { [key: string]: unknown }) => void;

class MockWebSocket {
	static lastInstance: MockWebSocket | null = null;
	static instances: MockWebSocket[] = [];

	static reset() {
		MockWebSocket.lastInstance = null;
		MockWebSocket.instances = [];
	}

	readyState = 1;
	init: unknown;
	url: string;
	protocol = '';
	sent: unknown[] = [];
	private listeners = new Map<string, Set<WebSocketListener>>();

	constructor(url: string, init?: unknown) {
		this.url = url;
		this.init = init;
		MockWebSocket.instances.push(this);
		MockWebSocket.lastInstance = this;

		queueMicrotask(() => {
			this.emit('open', {});
		});
	}

	addEventListener(
		event: string,
		handler: WebSocketListener,
		options?: { once?: boolean }
	) {
		let normalized = this.listeners.get(event);
		if (!normalized) {
			normalized = new Set();
			this.listeners.set(event, normalized);
		}

		const listener: WebSocketListener = options?.once
			? (value) => {
					this.listeners.get(event)?.delete(listener);
					handler(value);
			  }
			: handler;

		normalized.add(listener);
	}

	removeEventListener(event: string, handler: WebSocketListener) {
		this.listeners.get(event)?.delete(handler);
	}

	send(data: unknown) {
		this.sent.push(data);
	}

	close(code?: number, reason?: string) {
		this.readyState = 3;
		this.emit('close', { code, reason });
	}

	emitMessage(payload: Record<string, unknown>) {
		this.emit('message', { data: JSON.stringify(payload) });
	}

	private emit(type: string, event: { [key: string]: unknown }) {
		for (const listener of this.listeners.get(type) ?? new Set()) {
			listener({ ...event, type });
		}
	}
}

const withDeepgramSession = async <T>(
	model = 'nova-3',
	callback: (
		session: Awaited<ReturnType<ReturnType<typeof deepgram>['open']>>,
		socket: MockWebSocket
	) => Promise<T>
) => {
	const originalSocket = globalThis.WebSocket;
	MockWebSocket.reset();

	try {
		globalThis.WebSocket = MockWebSocket as never;

		const session = await deepgram({
			apiKey: 'test-key',
			model,
			punctuate: true,
			smartFormat: true
		}).open({
			format: {
				channels: 1,
				container: 'raw',
				encoding: 'pcm_s16le',
				sampleRateHz: 16000
			},
			sessionId: `dg-event-${model}`
		});

		const socket = MockWebSocket.lastInstance;
		if (!socket) {
			throw new Error('Mock WebSocket was not created.');
		}

		try {
			return await callback(session, socket);
		} finally {
			await session.close('unit-test');
		}
	} finally {
		globalThis.WebSocket = originalSocket;
	}
};

describe('deepgram adapter', () => {
	test('uses header auth by default', async () => {
		await withDeepgramSession('nova-3', async () => {
			expect(MockWebSocket.lastInstance).not.toBeNull();
			expect(MockWebSocket.lastInstance?.init).toEqual({
				headers: {
					Authorization: 'Token test-key'
				}
			});
		});
	});

	test('uses protocol auth when configured', async () => {
		const originalSocket = globalThis.WebSocket;
		MockWebSocket.reset();

		try {
			globalThis.WebSocket = MockWebSocket as never;

			const session = await deepgram({
				apiKey: 'test-key',
				authMode: 'protocol',
				model: 'nova-3',
				punctuate: true,
				smartFormat: true
			}).open({
				format: {
					channels: 1,
					container: 'raw',
					encoding: 'pcm_s16le',
					sampleRateHz: 16000
				},
				sessionId: 'dg-auth-protocol'
			});

			expect(MockWebSocket.lastInstance).not.toBeNull();
			expect(MockWebSocket.lastInstance?.init).toEqual([
				'token',
				'test-key'
			]);

			await session.close('unit-test');
		} finally {
			globalThis.WebSocket = originalSocket;
		}
	});

	test('deduplicates duplicate non-flux final + end-of-turn events', async () => {
		await withDeepgramSession('nova-3', async (session, socket) => {
			const finals: Array<unknown> = [];
			const ends: Array<unknown> = [];

			session.on('final', () => {
				finals.push(1);
			});
			session.on('endOfTurn', () => {
				ends.push(1);
			});

			const message = {
				channel: {
					alternatives: [{ transcript: 'hello there', confidence: 0.99 }]
				},
				is_final: true,
				language: 'en',
				speech_final: true,
				type: 'Results'
			};

			socket.emitMessage(message);
			socket.emitMessage(message);
			await Bun.sleep(1);

			expect(finals).toHaveLength(1);
			expect(ends).toHaveLength(1);
		});
	});

	test('deduplicates duplicate Flux end-of-turn events', async () => {
		await withDeepgramSession('flux-general-en', async (session, socket) => {
			const finals: Array<unknown> = [];
			const ends: Array<unknown> = [];

			session.on('final', () => {
				finals.push(1);
			});
			session.on('endOfTurn', () => {
				ends.push(1);
			});

			const message = {
				audio_window_end: 1.25,
				audio_window_start: 0.4,
				end_of_turn_confidence: 0.83,
				event: 'EndOfTurn',
				request_id: 'request-id',
				sequence_id: 7,
				transcript: 'I am testing this feature',
				type: 'TurnInfo'
			};

			socket.emitMessage(message);
			socket.emitMessage(message);
			await Bun.sleep(1);

			expect(finals).toHaveLength(1);
			expect(ends).toHaveLength(1);
		});
	});

	// Regression: both model families idle-drop the socket on silence
	// (code=INACTIVE_CLIENT → zero-turn call). nova (v1) accepts the KeepAlive
	// CONTROL message; Flux (v2) REJECTS it ("unknown variant `KeepAlive`"), so
	// Flux must instead be kept warm with binary SILENCE frames — and must NEVER
	// be sent the KeepAlive message.
	const openIdleSession = async (model: string) => {
		MockWebSocket.reset();
		const session = await deepgram({
			apiKey: 'test-key',
			keepAliveMs: 15,
			model
		}).open({
			format: {
				channels: 1,
				container: 'raw',
				encoding: 'pcm_s16le',
				sampleRateHz: 16000
			},
			sessionId: `dg-keepalive-${model}`
		});
		const socket = MockWebSocket.lastInstance;
		if (!socket) {
			throw new Error('Mock WebSocket was not created.');
		}
		await Bun.sleep(60);
		const keepAliveMessages = socket.sent.filter(
			(payload) => typeof payload === 'string' && payload.includes('KeepAlive')
		);
		const binaryFrames = socket.sent.filter(
			(payload) => payload instanceof Uint8Array
		);
		await session.close('unit-test');

		return { binaryFrames, keepAliveMessages };
	};

	test('nova keeps the socket alive with the KeepAlive control message', async () => {
		const original = globalThis.WebSocket;
		try {
			globalThis.WebSocket = MockWebSocket as never;
			const { keepAliveMessages } = await openIdleSession('nova-3');
			expect(keepAliveMessages.length).toBeGreaterThan(0);
		} finally {
			globalThis.WebSocket = original;
		}
	});

	test('Flux keeps the socket alive with silence frames, never KeepAlive', async () => {
		const original = globalThis.WebSocket;
		try {
			globalThis.WebSocket = MockWebSocket as never;
			const { binaryFrames, keepAliveMessages } =
				await openIdleSession('flux-general-multi');
			expect(keepAliveMessages).toHaveLength(0);
			expect(binaryFrames.length).toBeGreaterThan(0);
		} finally {
			globalThis.WebSocket = original;
		}
	});
});

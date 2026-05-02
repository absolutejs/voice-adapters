import { describe, expect, test } from 'bun:test';
import { assemblyai } from '../src';

type WebSocketListener = (event: { [key: string]: unknown }) => void;

class MockWebSocket {
	static lastInstance: MockWebSocket | null = null;
	static instances: MockWebSocket[] = [];

	static reset() {
		MockWebSocket.lastInstance = null;
		MockWebSocket.instances = [];
	}

	readyState = 1;
	url: string;
	protocol = '';
	private listeners = new Map<string, Set<WebSocketListener>>();

	constructor(url: string) {
		this.url = url;
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
		// no-op for mock input sends
	}

	close(code?: number, reason?: string) {
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

const withAssemblyAISession = async <T>(
	callback: (
		session: Awaited<ReturnType<ReturnType<typeof assemblyai>['open']>>,
		socket: MockWebSocket
	) => Promise<T>
) => {
	const originalSocket = globalThis.WebSocket;
	MockWebSocket.reset();

	try {
		globalThis.WebSocket = MockWebSocket as never;

		const session = await assemblyai({
			apiKey: 'test-key'
		}).open({
			format: {
				channels: 1,
				container: 'raw',
				encoding: 'pcm_s16le',
				sampleRateHz: 16_000
			},
			sessionId: 'assemblyai-events'
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

describe('assemblyai adapter', () => {
	test('deduplicates duplicate final and endOfTurn payloads', async () => {
		await withAssemblyAISession(async (session, socket) => {
			const finals: Array<unknown> = [];
			const ends: Array<unknown> = [];

			session.on('final', () => finals.push(1));
			session.on('endOfTurn', () => ends.push(1));

			const payload = {
				end_of_turn: true,
				end_of_turn_confidence: 0.91,
				transcript: 'hello world',
				turn_is_formatted: true,
				turn_order: 7
			};

			socket.emitMessage(payload);
			socket.emitMessage(payload);
			await Bun.sleep(1);

			expect(finals).toHaveLength(1);
			expect(ends).toHaveLength(1);
		});
	});

	test('does not suppress unique turns', async () => {
		await withAssemblyAISession(async (session, socket) => {
			const finals: Array<unknown> = [];

			session.on('final', () => finals.push(1));

			socket.emitMessage({
				end_of_turn: true,
				end_of_turn_confidence: 0.91,
				transcript: 'first turn',
				turn_is_formatted: true,
				turn_order: 11
			});
			socket.emitMessage({
				end_of_turn: true,
				end_of_turn_confidence: 0.91,
				transcript: 'second turn',
				turn_is_formatted: true,
				turn_order: 12
			});

			await Bun.sleep(1);
			expect(finals).toHaveLength(2);
		});
	});
});

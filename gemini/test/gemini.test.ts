import { describe, expect, test } from 'bun:test';
import { gemini } from '../src';

type WebSocketListener = (event: { [key: string]: unknown }) => void;

class MockWebSocket {
	static lastInstance: MockWebSocket | null = null;
	static instances: MockWebSocket[] = [];

	static reset() {
		MockWebSocket.lastInstance = null;
		MockWebSocket.instances = [];
	}

	readyState = 1;
	sent: string[] = [];
	url: string;
	options?: unknown;
	private listeners = new Map<string, Set<WebSocketListener>>();

	constructor(url: string, options?: unknown) {
		this.url = url;
		this.options = options;
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

	send(data: string) {
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
		for (const handler of this.listeners.get(type) ?? new Set()) {
			handler({ ...event, type });
		}
	}
}

const openGeminiSession = async () => {
	const originalSocket = globalThis.WebSocket;
	MockWebSocket.reset();
	globalThis.WebSocket = MockWebSocket as never;

	const sessionPromise = gemini({
		apiKey: 'test-key',
		model: 'gemini-2.5-flash-native-audio-preview-12-2025'
	}).open({
		format: {
			channels: 1,
			container: 'raw',
			encoding: 'pcm_s16le',
			sampleRateHz: 24_000
		},
		sessionId: 'gemini-unit'
	});

	await Bun.sleep(0);
	const socket = MockWebSocket.lastInstance!;
	socket.emitMessage({ setupComplete: {} });
	const session = await sessionPromise;

	return {
		restore: () => {
			globalThis.WebSocket = originalSocket;
		},
		session,
		socket
	};
};

describe('gemini adapter', () => {
	test('sends Live API setup with API key header', async () => {
		const { restore, session, socket } = await openGeminiSession();
		try {
			expect(socket.url).toContain('BidiGenerateContent');
			expect(JSON.stringify(socket.options)).toContain('x-goog-api-key');
			expect(JSON.parse(socket.sent[0] ?? '{}')).toEqual({
				setup: expect.objectContaining({
					model: 'models/gemini-2.5-flash-native-audio-preview-12-2025'
				})
			});
		} finally {
			await session.close('unit-complete');
			restore();
		}
	});

	test('sends text as completed client content', async () => {
		const { restore, session, socket } = await openGeminiSession();
		try {
			const finalEvents: Array<unknown> = [];
			session.on('final', (event) => {
				finalEvents.push(event);
			});

			await session.send('hello world');
			const last = JSON.parse(socket.sent.at(-1) ?? '{}');

			expect(finalEvents).toHaveLength(1);
			expect(last).toEqual({
				clientContent: {
					turnComplete: true,
					turns: [
						{
							parts: [{ text: 'hello world' }],
							role: 'user'
						}
					]
				}
			});
		} finally {
			await session.close('unit-complete');
			restore();
		}
	});

	test('emits transcripts, audio, and end-of-turn from server content', async () => {
		const { restore, session, socket } = await openGeminiSession();
		try {
			const partialEvents: Array<unknown> = [];
			const finalEvents: Array<unknown> = [];
			const audioEvents: Array<unknown> = [];
			const endEvents: Array<unknown> = [];

			session.on('partial', (event) => {
				partialEvents.push(event);
			});
			session.on('final', (event) => {
				finalEvents.push(event);
			});
			session.on('audio', (event) => {
				audioEvents.push(event);
			});
			session.on('endOfTurn', (event) => {
				endEvents.push(event);
			});

			socket.emitMessage({
				serverContent: {
					inputTranscription: { text: 'user said hello' },
					modelTurn: {
						parts: [
							{ text: 'assistant text' },
							{
								inlineData: {
									data: Buffer.from(new Uint8Array([1, 2, 3])).toString(
										'base64'
									),
									mimeType: 'audio/pcm;rate=24000'
								}
							}
						]
					},
					turnComplete: true
				}
			});

			expect(finalEvents).toHaveLength(1);
			expect(partialEvents).toHaveLength(1);
			expect(audioEvents).toHaveLength(1);
			expect(endEvents).toHaveLength(1);
		} finally {
			await session.close('unit-complete');
			restore();
		}
	});
});

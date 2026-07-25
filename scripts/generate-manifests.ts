#!/usr/bin/env bun
/* Shared manifest authoring for every vendor adapter in this monorepo.
 *
 * Each package's `src/manifest.ts` is near-identical: identity boilerplate, a
 * `defineImplementation` per adapter contract (voice/stt, voice/tts,
 * voice/realtime), an env-keyed wiring snippet, and package.json plumbing.
 * The per-package tsconfigs (`include: ["src/**\/*"]`, dist-relative
 * declaration output) cannot import a helper module across package roots
 * without breaking their d.ts layout, so the sharing lives here instead: ONE
 * declarative vendor table, and this script writes each vendor's
 * `src/manifest.ts` (checked in, drift-checked against the vendor's real
 * options type by its own tsc) and syncs its package.json manifest wiring.
 *
 *   bun scripts/generate-manifests.ts
 */
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { format } from 'prettier';

const CHECK_MODE = process.argv.includes('--check');
const mismatches: string[] = [];

type VendorContract = 'voice/realtime' | 'voice/stt' | 'voice/tts';

type VendorEnvVar = {
	/** Env key the host stores the credential under, e.g. DEEPGRAM_API_KEY. */
	key: string;
	/** Option name the factory expects, e.g. apiKey / subscriptionKey. */
	configKey: string;
	description: string;
	docsUrl?: string;
	example?: string;
	secret?: boolean;
};

type VendorSettingsField = {
	key: string;
	title: string;
	description: string;
	type: 'boolean' | 'integer' | 'string';
	required?: boolean;
	default?: boolean | number | string;
	examples?: string[];
	/** Closed union in the vendor's options type → Type.Union of literals. */
	literals?: string[];
};

type VendorImplementation = {
	contract: VendorContract;
	factory: string;
	/** Exported options type in the vendor's src/types.ts. */
	optionsType: string;
	title: string;
	env: VendorEnvVar[];
	settings: VendorSettingsField[];
};

type Vendor = {
	dir: string;
	name: string;
	tagline: string;
	description: string;
	implementations: VendorImplementation[];
};

const VENDORS: Vendor[] = [
	{
		description:
			'AssemblyAI real-time speech-to-text adapter implementing `voice/stt` for `@absolutejs/voice` — universal streaming models with vendor end-of-turn detection and key-term prompting.',
		dir: 'assemblyai',
		implementations: [
			{
				contract: 'voice/stt',
				env: [
					{
						configKey: 'apiKey',
						description: 'AssemblyAI API key',
						docsUrl: 'https://www.assemblyai.com/app/api-keys',
						key: 'ASSEMBLYAI_API_KEY',
						secret: true
					}
				],
				factory: 'assemblyai',
				optionsType: 'AssemblyAISTTOptions',
				settings: [
					{
						description:
							'Which AssemblyAI streaming model transcribes your calls.',
						examples: ['universal-streaming-english', 'u3-rt-pro'],
						key: 'speechModel',
						title: 'Speech model',
						type: 'string'
					},
					{
						description:
							'Return neatly punctuated, formatted turns instead of raw words.',
						key: 'formatTurns',
						title: 'Format turns',
						type: 'boolean'
					}
				],
				title: 'AssemblyAI speech-to-text'
			}
		],
		name: '@absolutejs/voice-assemblyai',
		tagline: 'Turn callers’ speech into text with AssemblyAI.'
	},
	{
		description:
			'Azure Speech adapters for `@absolutejs/voice`: `azureSTT` (real-time WebSocket recognition) implements `voice/stt` and `azureTTS` (neural voices over REST) implements `voice/tts`, both off one Azure Speech resource key.',
		dir: 'azure',
		implementations: [
			{
				contract: 'voice/stt',
				env: [
					{
						configKey: 'subscriptionKey',
						description: 'Azure Speech resource key',
						docsUrl:
							'https://portal.azure.com/#browse/Microsoft.CognitiveServices%2Faccounts',
						key: 'AZURE_SPEECH_KEY',
						secret: true
					}
				],
				factory: 'azureSTT',
				optionsType: 'AzureSTTOptions',
				settings: [
					{
						description:
							'Azure region your Speech resource lives in.',
						examples: ['eastus'],
						key: 'region',
						title: 'Azure region',
						type: 'string'
					},
					{
						description: 'Language callers are expected to speak.',
						examples: ['en-US'],
						key: 'language',
						title: 'Spoken language',
						type: 'string'
					}
				],
				title: 'Azure speech-to-text'
			},
			{
				contract: 'voice/tts',
				env: [
					{
						configKey: 'subscriptionKey',
						description: 'Azure Speech resource key',
						docsUrl:
							'https://portal.azure.com/#browse/Microsoft.CognitiveServices%2Faccounts',
						key: 'AZURE_SPEECH_KEY',
						secret: true
					}
				],
				factory: 'azureTTS',
				optionsType: 'AzureTTSOptions',
				settings: [
					{
						description:
							'Which Azure neural voice speaks the assistant’s replies.',
						examples: ['en-US-JennyNeural'],
						key: 'voice',
						required: true,
						title: 'Voice',
						type: 'string'
					},
					{
						description:
							'Azure region your Speech resource lives in.',
						examples: ['eastus'],
						key: 'region',
						title: 'Azure region',
						type: 'string'
					},
					{
						description: 'Language the assistant speaks.',
						examples: ['en-US'],
						key: 'language',
						title: 'Spoken language',
						type: 'string'
					}
				],
				title: 'Azure text-to-speech'
			}
		],
		name: '@absolutejs/voice-azure',
		tagline: 'Hear callers and speak replies through Azure Speech.'
	},
	{
		description:
			'Cartesia Sonic text-to-speech adapter implementing `voice/tts` for `@absolutejs/voice` — low-latency streamed audio over WebSocket or HTTP.',
		dir: 'cartesia',
		implementations: [
			{
				contract: 'voice/tts',
				env: [
					{
						configKey: 'apiKey',
						description: 'Cartesia API key',
						docsUrl: 'https://play.cartesia.ai/keys',
						key: 'CARTESIA_API_KEY',
						secret: true
					}
				],
				factory: 'cartesia',
				optionsType: 'CartesiaTTSOptions',
				settings: [
					{
						description:
							'Voice id from the Cartesia voice library that speaks the assistant’s replies.',
						key: 'voice',
						required: true,
						title: 'Voice',
						type: 'string'
					},
					{
						description: 'Which Sonic model generates the speech.',
						examples: ['sonic-2'],
						key: 'model',
						title: 'Speech model',
						type: 'string'
					},
					{
						description: 'Language the assistant speaks.',
						examples: ['en'],
						key: 'language',
						title: 'Spoken language',
						type: 'string'
					}
				],
				title: 'Cartesia text-to-speech'
			}
		],
		name: '@absolutejs/voice-cartesia',
		tagline: 'Give your voice assistant a natural Cartesia voice.'
	},
	{
		description:
			'Deepgram real-time speech-to-text adapter implementing `voice/stt` for `@absolutejs/voice` — conversational Flux models with native end-of-turn detection, key terms, and keep-alive handling.',
		dir: 'deepgram',
		implementations: [
			{
				contract: 'voice/stt',
				env: [
					{
						configKey: 'apiKey',
						description: 'Deepgram API key',
						docsUrl: 'https://console.deepgram.com',
						key: 'DEEPGRAM_API_KEY',
						secret: true
					}
				],
				factory: 'deepgram',
				optionsType: 'DeepgramConversationalOptions',
				settings: [
					{
						default: 'flux-general-en',
						description:
							'Which conversational Flux model transcribes your calls. Multi handles more languages.',
						key: 'model',
						literals: [
							'flux',
							'flux-general-en',
							'flux-general-multi'
						],
						required: true,
						title: 'Speech model',
						type: 'string'
					},
					{
						description: 'Language callers are expected to speak.',
						examples: ['en'],
						key: 'language',
						title: 'Spoken language',
						type: 'string'
					}
				],
				title: 'Deepgram speech-to-text (Flux)'
			}
		],
		name: '@absolutejs/voice-deepgram',
		tagline: 'Turn callers’ speech into text with Deepgram.'
	},
	{
		description:
			'ElevenLabs text-to-speech adapter implementing `voice/tts` for `@absolutejs/voice` — streamed low-latency audio over WebSocket or HTTP with the full voice library.',
		dir: 'elevenlabs',
		implementations: [
			{
				contract: 'voice/tts',
				env: [
					{
						configKey: 'apiKey',
						description: 'ElevenLabs API key',
						docsUrl: 'https://elevenlabs.io/app/settings/api-keys',
						key: 'ELEVENLABS_API_KEY',
						secret: true
					}
				],
				factory: 'elevenlabs',
				optionsType: 'ElevenLabsTTSOptions',
				settings: [
					{
						description:
							'Voice id from your ElevenLabs voice library that speaks the assistant’s replies.',
						examples: ['21m00Tcm4TlvDq8ikWAM'],
						key: 'voiceId',
						required: true,
						title: 'Voice',
						type: 'string'
					},
					{
						description:
							'Which ElevenLabs model generates the speech. Flash is fastest for live calls.',
						examples: ['eleven_flash_v2_5'],
						key: 'modelId',
						title: 'Speech model',
						type: 'string'
					}
				],
				title: 'ElevenLabs text-to-speech'
			}
		],
		name: '@absolutejs/voice-elevenlabs',
		tagline: 'Give your voice assistant a natural ElevenLabs voice.'
	},
	{
		description:
			'Gemini Live speech-to-speech adapter implementing `voice/realtime` for `@absolutejs/voice` — one Google model listens and talks in a single stream, replacing separate STT and TTS.',
		dir: 'gemini',
		implementations: [
			{
				contract: 'voice/realtime',
				env: [
					{
						configKey: 'apiKey',
						description: 'Google AI Studio API key for Gemini',
						docsUrl: 'https://aistudio.google.com/apikey',
						key: 'GEMINI_API_KEY',
						secret: true
					}
				],
				factory: 'gemini',
				optionsType: 'GeminiLiveAdapterOptions',
				settings: [
					{
						description:
							'Which Gemini Live model handles your calls.',
						examples: ['gemini-live-2.5-flash-preview'],
						key: 'model',
						title: 'Model',
						type: 'string'
					},
					{
						description:
							'Which built-in Gemini voice the assistant speaks with.',
						examples: ['Kore'],
						key: 'voiceName',
						title: 'Voice',
						type: 'string'
					},
					{
						description:
							'How the assistant should behave: its role, tone, and guardrails.',
						key: 'instructions',
						title: 'Assistant instructions',
						type: 'string'
					}
				],
				title: 'Gemini Live speech-to-speech'
			}
		],
		name: '@absolutejs/voice-gemini',
		tagline: 'Let one Gemini model listen and talk on your calls.'
	},
	{
		description:
			'Gladia real-time speech-to-text adapter implementing `voice/stt` for `@absolutejs/voice` — Solaria models with code-switching for multilingual callers.',
		dir: 'gladia',
		implementations: [
			{
				contract: 'voice/stt',
				env: [
					{
						configKey: 'apiKey',
						description: 'Gladia API key',
						docsUrl: 'https://app.gladia.io/account',
						key: 'GLADIA_API_KEY',
						secret: true
					}
				],
				factory: 'gladia',
				optionsType: 'GladiaSTTOptions',
				settings: [
					{
						description:
							'Which Gladia model transcribes your calls.',
						examples: ['solaria-1'],
						key: 'model',
						title: 'Speech model',
						type: 'string'
					},
					{
						description:
							'Follow callers who switch languages mid-sentence.',
						key: 'codeSwitching',
						title: 'Handle language switching',
						type: 'boolean'
					}
				],
				title: 'Gladia speech-to-text'
			}
		],
		name: '@absolutejs/voice-gladia',
		tagline: 'Turn callers’ speech into text with Gladia.'
	},
	{
		description:
			'Google Cloud Speech-to-Text adapters implementing `voice/stt` for `@absolutejs/voice`: `googleSpeech` (buffered REST, simplest auth) wired here, plus `googleSpeechStream` (gRPC streaming partials, token auth) for real-time transcripts.',
		dir: 'google-speech',
		implementations: [
			{
				contract: 'voice/stt',
				env: [
					{
						configKey: 'apiKey',
						description: 'Google Cloud API key with Speech-to-Text enabled',
						docsUrl:
							'https://console.cloud.google.com/apis/credentials',
						key: 'GOOGLE_SPEECH_API_KEY',
						secret: true
					}
				],
				factory: 'googleSpeech',
				optionsType: 'GoogleSpeechSTTOptions',
				settings: [
					{
						description: 'Language callers are expected to speak.',
						examples: ['en-US'],
						key: 'language',
						title: 'Spoken language',
						type: 'string'
					},
					{
						description:
							'Which Google recognition model transcribes your calls.',
						examples: ['latest_long'],
						key: 'model',
						title: 'Speech model',
						type: 'string'
					},
					{
						description:
							'Add punctuation to transcripts automatically.',
						key: 'enableAutomaticPunctuation',
						title: 'Automatic punctuation',
						type: 'boolean'
					}
				],
				title: 'Google Cloud speech-to-text (buffered REST)'
			}
		],
		name: '@absolutejs/voice-google-speech',
		tagline: 'Turn callers’ speech into text with Google Cloud.'
	},
	{
		description:
			'LMNT text-to-speech adapter implementing `voice/tts` for `@absolutejs/voice` — streamed low-latency speech with conversational styling.',
		dir: 'lmnt',
		implementations: [
			{
				contract: 'voice/tts',
				env: [
					{
						configKey: 'apiKey',
						description: 'LMNT API key',
						docsUrl: 'https://app.lmnt.com/account',
						key: 'LMNT_API_KEY',
						secret: true
					}
				],
				factory: 'lmnt',
				optionsType: 'LMNTTTSOptions',
				settings: [
					{
						description:
							'Voice id from the LMNT voice library that speaks the assistant’s replies.',
						examples: ['lily'],
						key: 'voice',
						required: true,
						title: 'Voice',
						type: 'string'
					},
					{
						description: 'Which LMNT model generates the speech.',
						examples: ['blizzard'],
						key: 'model',
						title: 'Speech model',
						type: 'string'
					},
					{
						description: 'Language the assistant speaks.',
						examples: ['en'],
						key: 'language',
						title: 'Spoken language',
						type: 'string'
					}
				],
				title: 'LMNT text-to-speech'
			}
		],
		name: '@absolutejs/voice-lmnt',
		tagline: 'Give your voice assistant a natural LMNT voice.'
	},
	{
		description:
			'Neets.ai text-to-speech adapter implementing `voice/tts` for `@absolutejs/voice` — budget-friendly streamed speech.',
		dir: 'neets',
		implementations: [
			{
				contract: 'voice/tts',
				env: [
					{
						configKey: 'apiKey',
						description: 'Neets.ai API key',
						docsUrl: 'https://neets.ai',
						key: 'NEETS_API_KEY',
						secret: true
					}
				],
				factory: 'neets',
				optionsType: 'NeetsTTSOptions',
				settings: [
					{
						description:
							'Voice id from the Neets.ai voice library that speaks the assistant’s replies.',
						key: 'voiceId',
						required: true,
						title: 'Voice',
						type: 'string'
					},
					{
						description:
							'Which Neets.ai model generates the speech.',
						examples: ['style-tts-2'],
						key: 'model',
						title: 'Speech model',
						type: 'string'
					}
				],
				title: 'Neets.ai text-to-speech'
			}
		],
		name: '@absolutejs/voice-neets',
		tagline: 'Give your voice assistant a Neets.ai voice.'
	},
	{
		description:
			'OpenAI Realtime speech-to-speech adapter implementing `voice/realtime` for `@absolutejs/voice` — one model listens and talks over the official Realtime WebSocket API, replacing separate STT and TTS.',
		dir: 'openai',
		implementations: [
			{
				contract: 'voice/realtime',
				env: [
					{
						configKey: 'apiKey',
						description: 'OpenAI API key',
						docsUrl: 'https://platform.openai.com/api-keys',
						key: 'OPENAI_API_KEY',
						secret: true
					}
				],
				factory: 'openai',
				optionsType: 'OpenAIRealtimeAdapterOptions',
				settings: [
					{
						description:
							'Which OpenAI Realtime model handles your calls.',
						examples: ['gpt-realtime-mini'],
						key: 'model',
						title: 'Model',
						type: 'string'
					},
					{
						description:
							'Which built-in OpenAI voice the assistant speaks with.',
						examples: ['marin'],
						key: 'voice',
						title: 'Voice',
						type: 'string'
					},
					{
						description:
							'How the assistant should behave: its role, tone, and guardrails.',
						key: 'instructions',
						title: 'Assistant instructions',
						type: 'string'
					}
				],
				title: 'OpenAI Realtime speech-to-speech'
			}
		],
		name: '@absolutejs/voice-openai',
		tagline: 'Let one OpenAI model listen and talk on your calls.'
	},
	{
		description:
			'OpenAI Whisper / gpt-4o-transcribe buffered speech-to-text adapter implementing `voice/stt` for `@absolutejs/voice` — accumulates audio per turn and transcribes on flush, a simple low-cost lane for post-turn transcripts.',
		dir: 'openai-whisper',
		implementations: [
			{
				contract: 'voice/stt',
				env: [
					{
						configKey: 'apiKey',
						description: 'OpenAI API key',
						docsUrl: 'https://platform.openai.com/api-keys',
						key: 'OPENAI_API_KEY',
						secret: true
					}
				],
				factory: 'openaiWhisper',
				optionsType: 'OpenAIWhisperSTTOptions',
				settings: [
					{
						description:
							'Which OpenAI transcription model transcribes your calls.',
						examples: ['gpt-4o-mini-transcribe'],
						key: 'model',
						title: 'Speech model',
						type: 'string'
					},
					{
						description: 'Language callers are expected to speak.',
						examples: ['en'],
						key: 'language',
						title: 'Spoken language',
						type: 'string'
					}
				],
				title: 'OpenAI Whisper speech-to-text (buffered)'
			}
		],
		name: '@absolutejs/voice-openai-whisper',
		tagline: 'Turn callers’ speech into text with OpenAI Whisper.'
	},
	{
		description:
			'PlayHT text-to-speech adapter implementing `voice/tts` for `@absolutejs/voice` — streamed speech across the PlayHT voice engines.',
		dir: 'playht',
		implementations: [
			{
				contract: 'voice/tts',
				env: [
					{
						configKey: 'apiKey',
						description: 'PlayHT API key',
						docsUrl: 'https://play.ht/app/api-access',
						key: 'PLAYHT_API_KEY',
						secret: true
					},
					{
						configKey: 'userId',
						description: 'PlayHT user id (shown next to your API key)',
						docsUrl: 'https://play.ht/app/api-access',
						key: 'PLAYHT_USER_ID'
					}
				],
				factory: 'playht',
				optionsType: 'PlayHTTTSOptions',
				settings: [
					{
						description:
							'Voice id or manifest URL from the PlayHT voice library that speaks the assistant’s replies.',
						key: 'voice',
						required: true,
						title: 'Voice',
						type: 'string'
					},
					{
						description:
							'Which PlayHT voice engine generates the speech.',
						examples: ['Play3.0-mini'],
						key: 'voiceEngine',
						title: 'Voice engine',
						type: 'string'
					}
				],
				title: 'PlayHT text-to-speech'
			}
		],
		name: '@absolutejs/voice-playht',
		tagline: 'Give your voice assistant a natural PlayHT voice.'
	},
	{
		description:
			'Rime text-to-speech adapter implementing `voice/tts` for `@absolutejs/voice` — fast conversational speech tuned for phone calls.',
		dir: 'rime',
		implementations: [
			{
				contract: 'voice/tts',
				env: [
					{
						configKey: 'apiKey',
						description: 'Rime API key',
						docsUrl: 'https://rime.ai',
						key: 'RIME_API_KEY',
						secret: true
					}
				],
				factory: 'rime',
				optionsType: 'RimeTTSOptions',
				settings: [
					{
						description:
							'Speaker from the Rime voice library that speaks the assistant’s replies.',
						examples: ['luna'],
						key: 'speaker',
						required: true,
						title: 'Voice',
						type: 'string'
					},
					{
						description: 'Which Rime model generates the speech.',
						examples: ['mistv2'],
						key: 'modelId',
						title: 'Speech model',
						type: 'string'
					},
					{
						description: 'Language the assistant speaks.',
						examples: ['eng'],
						key: 'lang',
						title: 'Spoken language',
						type: 'string'
					}
				],
				title: 'Rime text-to-speech'
			}
		],
		name: '@absolutejs/voice-rime',
		tagline: 'Give your voice assistant a natural Rime voice.'
	},
	{
		description:
			'Smallest.ai Waves text-to-speech adapter implementing `voice/tts` for `@absolutejs/voice` — lightning-fast streamed speech.',
		dir: 'smallest',
		implementations: [
			{
				contract: 'voice/tts',
				env: [
					{
						configKey: 'apiKey',
						description: 'Smallest.ai API key',
						docsUrl: 'https://waves.smallest.ai',
						key: 'SMALLEST_API_KEY',
						secret: true
					}
				],
				factory: 'smallest',
				optionsType: 'SmallestTTSOptions',
				settings: [
					{
						description:
							'Voice id from the Waves voice library that speaks the assistant’s replies.',
						examples: ['emily'],
						key: 'voiceId',
						required: true,
						title: 'Voice',
						type: 'string'
					},
					{
						description:
							'Which Waves model generates the speech.',
						examples: ['lightning-v2'],
						key: 'model',
						title: 'Speech model',
						type: 'string'
					},
					{
						description: 'Language the assistant speaks.',
						examples: ['en'],
						key: 'language',
						title: 'Spoken language',
						type: 'string'
					}
				],
				title: 'Smallest.ai text-to-speech'
			}
		],
		name: '@absolutejs/voice-smallest',
		tagline: 'Give your voice assistant a Smallest.ai voice.'
	},
	{
		description:
			'Soniox real-time speech-to-text adapter implementing `voice/stt` for `@absolutejs/voice` — endpoint detection, language identification, and speaker diarization.',
		dir: 'soniox',
		implementations: [
			{
				contract: 'voice/stt',
				env: [
					{
						configKey: 'apiKey',
						description: 'Soniox API key',
						docsUrl: 'https://console.soniox.com',
						key: 'SONIOX_API_KEY',
						secret: true
					}
				],
				factory: 'soniox',
				optionsType: 'SonioxSTTOptions',
				settings: [
					{
						description:
							'Which Soniox model transcribes your calls.',
						examples: ['stt-rt-preview'],
						key: 'model',
						title: 'Speech model',
						type: 'string'
					},
					{
						description:
							'Detect which language each caller is speaking.',
						key: 'enableLanguageIdentification',
						title: 'Identify languages',
						type: 'boolean'
					},
					{
						description:
							'Label which speaker said what when several people are on the call.',
						key: 'enableSpeakerDiarization',
						title: 'Tell speakers apart',
						type: 'boolean'
					}
				],
				title: 'Soniox speech-to-text'
			}
		],
		name: '@absolutejs/voice-soniox',
		tagline: 'Turn callers’ speech into text with Soniox.'
	},
	{
		description:
			'Speechmatics real-time speech-to-text adapter implementing `voice/stt` for `@absolutejs/voice` — accuracy-focused recognition with diarization and regional endpoints.',
		dir: 'speechmatics',
		implementations: [
			{
				contract: 'voice/stt',
				env: [
					{
						configKey: 'apiKey',
						description: 'Speechmatics API key',
						docsUrl: 'https://portal.speechmatics.com',
						key: 'SPEECHMATICS_API_KEY',
						secret: true
					}
				],
				factory: 'speechmatics',
				optionsType: 'SpeechmaticsSTTOptions',
				settings: [
					{
						description: 'Language callers are expected to speak.',
						examples: ['en'],
						key: 'language',
						title: 'Spoken language',
						type: 'string'
					},
					{
						description:
							'Enhanced is more accurate; standard is faster and cheaper.',
						key: 'operatingPoint',
						literals: ['enhanced', 'standard'],
						title: 'Accuracy mode',
						type: 'string'
					},
					{
						description:
							'Which Speechmatics region handles your audio.',
						examples: ['eu2'],
						key: 'region',
						title: 'Region',
						type: 'string'
					}
				],
				title: 'Speechmatics speech-to-text'
			}
		],
		name: '@absolutejs/voice-speechmatics',
		tagline: 'Turn callers’ speech into text with Speechmatics.'
	}
];

const quote = (value: string) => `'${value.replaceAll("'", "\\'")}'`;

const indent = (depth: number) => '\t'.repeat(depth);

const renderSchemaOptions = (
	field: VendorSettingsField,
	depth: number
): string => {
	const entries: string[] = [];
	if (field.default !== undefined)
		entries.push(
			`default: ${
				typeof field.default === 'string'
					? quote(field.default)
					: String(field.default)
			}`
		);
	entries.push(
		field.description.length > 55
			? `description:\n${indent(depth + 1)}${quote(field.description)}`
			: `description: ${quote(field.description)}`
	);
	if (field.examples)
		entries.push(
			`examples: [${field.examples.map(quote).join(', ')}]`
		);
	entries.push(`title: ${quote(field.title)}`);

	return `{\n${entries
		.map((entry) => `${indent(depth)}${entry}`)
		.join(',\n')}\n${indent(depth - 1)}}`;
};

const renderFieldSchema = (
	field: VendorSettingsField,
	depth: number
): string => {
	if (field.literals) {
		const literals = field.literals
			.map((literal) => `${indent(depth + 1)}Type.Literal(${quote(literal)})`)
			.join(',\n');

		return `Type.Union(\n${indent(depth)}[\n${literals}\n${indent(
			depth
		)}],\n${indent(depth)}${renderSchemaOptions(field, depth + 1)}\n${indent(
			depth - 1
		)})`;
	}
	const constructor =
		field.type === 'boolean'
			? 'Type.Boolean'
			: field.type === 'integer'
				? 'Type.Integer'
				: 'Type.String';

	return `${constructor}(${renderSchemaOptions(field, depth)})`;
};

const renderSettings = (
	fields: VendorSettingsField[],
	depth: number
): string => {
	const properties = fields
		.map((field) => {
			const schema = field.required
				? renderFieldSchema(field, depth + 2)
				: `Type.Optional(\n${indent(depth + 2)}${renderFieldSchema(
						field,
						depth + 3
					)}\n${indent(depth + 1)})`;

			return `${indent(depth + 1)}${field.key}: ${schema}`;
		})
		.join(',\n');

	return `Type.Object({\n${properties}\n${indent(depth)}})`;
};

const renderEnv = (env: VendorEnvVar[], depth: number): string =>
	env
		.map((variable) => {
			const entries: string[] = [];
			entries.push(`description: ${quote(variable.description)}`);
			if (variable.docsUrl)
				entries.push(`docsUrl: ${quote(variable.docsUrl)}`);
			if (variable.example)
				entries.push(`example: ${quote(variable.example)}`);
			entries.push(`key: ${quote(variable.key)}`);
			if (variable.secret) entries.push('secret: true');

			return `${indent(depth + 2)}{\n${entries
				.map((entry) => `${indent(depth + 3)}${entry}`)
				.join(',\n')}\n${indent(depth + 2)}}`;
		})
		.join(',\n');

const renderImplementation = (
	vendor: Vendor,
	implementation: VendorImplementation
): string => {
	const envAssignments = implementation.env
		.map(
			(variable) =>
				`${variable.configKey}: \${env.${variable.key}} ?? ''`
		)
		.join(', ');
	const spread =
		implementation.settings.length > 0 ? ', ...${settings}' : '';
	const wiringCode = `${implementation.factory}({ ${envAssignments}${spread} })`;
	const lines: string[] = [];
	lines.push(
		`\t\tdefineImplementation<${implementation.optionsType}>()({`
	);
	lines.push(`\t\t\tcontract: ${quote(implementation.contract)},`);
	lines.push(`\t\t\tfactory: ${quote(implementation.factory)},`);
	lines.push(`\t\t\tfrom: ${quote(vendor.name)},`);
	lines.push('\t\t\trequires: {');
	lines.push('\t\t\t\tenv: [');
	lines.push(renderEnv(implementation.env, 3));
	lines.push('\t\t\t\t]');
	lines.push('\t\t\t},');
	if (implementation.settings.length > 0)
		lines.push(
			`\t\t\tsettings: ${renderSettings(implementation.settings, 3)},`
		);
	lines.push(`\t\t\ttitle: ${quote(implementation.title)},`);
	lines.push('\t\t\twiring: {');
	lines.push(`\t\t\t\tcode: ${quote(wiringCode)},`);
	lines.push('\t\t\t\timports: [');
	lines.push(
		`\t\t\t\t\t{ from: ${quote(vendor.name)}, names: [${quote(
			implementation.factory
		)}] }`
	);
	lines.push('\t\t\t\t]');
	lines.push('\t\t\t}');
	lines.push('\t\t})');

	return lines.join('\n');
};

const renderManifest = (vendor: Vendor): string => {
	const optionImports = [
		...new Set(
			vendor.implementations.map(
				(implementation) => implementation.optionsType
			)
		)
	].sort();
	const implementations = vendor.implementations
		.map((implementation) => renderImplementation(vendor, implementation))
		.join(',\n');

	return `/* GENERATED by scripts/generate-manifests.ts — edit the vendor table there
 * and re-run \`bun scripts/generate-manifests.ts\`. The options-type imports keep
 * each settings schema drift-checked against this package's real config type. */
import { defineImplementation, defineManifest } from '@absolutejs/manifest';
import { Type } from '@sinclair/typebox';
import type { ${optionImports.join(', ')} } from './types';

export const manifest = defineManifest<Record<never, never>>()({
	contract: 2,
	identity: {
		category: 'voice',
		description:
			${quote(vendor.description)},
		docsUrl: ${quote(`https://github.com/absolutejs/voice-adapters/tree/main/${vendor.dir}`)},
		name: ${quote(vendor.name)},
		tagline: ${quote(vendor.tagline)}
	},
	implements: [
${implementations}
	],
	settings: Type.Object({}),
	wiring: []
});
`;
};

type PackageJsonShape = {
	version: string;
	scripts: Record<string, string>;
	exports: Record<string, unknown>;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	repository?: {
		directory?: string;
		type: string;
		url: string;
	};
	absolutejs?: {
		manifestContract: number;
		runtimePeers?: Record<string, unknown>;
	};
};

const syncPackageJson = async (vendorDir: string) => {
	const path = join(import.meta.dir, '..', vendorDir, 'package.json');
	const current = await readFile(path, 'utf8');
	const pkg: PackageJsonShape = JSON.parse(current);
	if (!pkg.scripts.build.includes('./src/manifest.ts'))
		pkg.scripts.build = pkg.scripts.build.replace(
			'bun build ./src/index.ts',
			'bun build ./src/index.ts ./src/manifest.ts'
		);
	if (!pkg.scripts.build.includes('absolute-manifest emit'))
		pkg.scripts.build = `${pkg.scripts.build} && absolute-manifest emit`;
	if (!pkg.scripts.build.includes('--external @absolutejs/manifest'))
		pkg.scripts.build = pkg.scripts.build.replace(
			'--external @absolutejs/voice',
			"--external @absolutejs/manifest --external '@absolutejs/manifest/*' --external @absolutejs/voice --external '@absolutejs/voice/*' --external @sinclair/typebox --external '@sinclair/typebox/*'"
		);
	pkg.scripts.release = `bun run check:package && npm publish --access public${
		pkg.version.includes('-beta.') ? ' --tag beta' : ''
	}`;
	pkg.scripts['verify-package'] = 'absolute-manifest verify-package';
	pkg.scripts['check:package'] =
		'bun run format && bun run typecheck && bun run test && bun run verify-package && bun run build && bun run verify-package --artifacts';
	pkg.exports['./manifest'] = {
		import: './dist/manifest.js',
		types: './dist/manifest.d.ts'
	};
	pkg.exports['./manifest.json'] = './dist/manifest.json';
	pkg.absolutejs = {
		manifestContract: 2,
		runtimePeers: {
			'@absolutejs/voice': {
				artifactImports: [],
				buildExternals: ['@absolutejs/voice', '@absolutejs/voice/*'],
				optional: false,
				range: '>=0.0.22-beta.647 <0.1',
				tested: '0.0.22-beta.647'
			}
		}
	};
	const dependencies = pkg.dependencies ?? {};
	dependencies['@absolutejs/manifest'] = '0.7.2';
	dependencies['@sinclair/typebox'] = '0.34.52';
	pkg.dependencies = Object.fromEntries(
		Object.entries(dependencies).sort(([left], [right]) =>
			left.localeCompare(right)
		)
	);
	const devDependencies = pkg.devDependencies ?? {};
	delete devDependencies['@absolutejs/absolute'];
	devDependencies['@absolutejs/voice'] = '0.0.22-beta.647';
	devDependencies['@types/bun'] = '1.3.14';
	devDependencies.elysia = '1.4.29';
	devDependencies.prettier = '3.9.6';
	pkg.devDependencies = Object.fromEntries(
		Object.entries(devDependencies).sort(([left], [right]) =>
			left.localeCompare(right)
		)
	);
	pkg.peerDependencies = {
		...(pkg.peerDependencies ?? {}),
		'@absolutejs/voice': '>=0.0.22-beta.647 <0.1'
	};
	if (pkg.repository?.url.startsWith('https://')) {
		pkg.repository.url = `git+${pkg.repository.url}`;
	}
	const generated = await format(JSON.stringify(pkg), {
		parser: 'json-stringify'
	});
	if (CHECK_MODE) {
		if (current !== generated) mismatches.push(`${vendorDir}/package.json`);
	} else {
		await writeFile(path, generated);
	}
};

for (const vendor of VENDORS) {
	const manifestPath = join(
		import.meta.dir,
		'..',
		vendor.dir,
		'src/manifest.ts'
	);
	const generatedManifest = await format(renderManifest(vendor), {
		parser: 'typescript'
	});
	if (CHECK_MODE) {
		if ((await readFile(manifestPath, 'utf8')) !== generatedManifest)
			mismatches.push(`${vendor.dir}/src/manifest.ts`);
	} else {
		await writeFile(manifestPath, generatedManifest);
	}
	await syncPackageJson(vendor.dir);
	console.log(
		`${CHECK_MODE ? 'verified' : 'wrote'} ${vendor.dir}/src/manifest.ts (+package.json)`
	);
}

if (mismatches.length > 0) {
	throw new Error(
		`Generated voice adapter manifests are stale:\n${mismatches
			.map((path) => `- ${path}`)
			.join('\n')}`
	);
}

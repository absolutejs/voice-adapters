#!/usr/bin/env bun
/**
 * Real-API smoke harness for every adapter in @absolutejs/voice-adapters/*.
 *
 * What it does for each provider whose API key is set:
 *   - TTS: open a session, send "hello world", assert at least one audio
 *     chunk arrives within the timeout, log the first chunk's format.
 *   - STT: open a session, stream a known clean English PCM clip in
 *     realtime-paced chunks, assert at least one final transcript event,
 *     log the recognized text.
 *
 * Adapters whose keys are not set are silently skipped. Every adapter
 * that runs gets a one-line pass/fail in the final summary table.
 *
 * Usage:
 *   bun run /home/alexkahn/abs/voice-adapters/smoke.ts
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  AudioFormat,
  STTAdapter,
  TTSAdapter,
} from "@absolutejs/voice";

// Adapter imports — every package this monorepo ships.
import { assemblyai } from "./assemblyai/src";
import { azureSTT, azureTTS } from "./azure/src";
import { cartesia } from "./cartesia/src";
import { deepgram } from "./deepgram/src";
import { elevenlabs } from "./elevenlabs/src";
import { gladia } from "./gladia/src";
import { googleSpeech, googleSpeechStream } from "./google-speech/src";
import { lmnt } from "./lmnt/src";
import { neets } from "./neets/src";
import { openaiWhisper } from "./openai-whisper/src";
import { playht } from "./playht/src";
import { rime } from "./rime/src";
import { smallest } from "./smallest/src";
import { soniox } from "./soniox/src";
import { speechmatics } from "./speechmatics/src";

const PCM_16K_MONO: AudioFormat = {
  channels: 1,
  container: "raw",
  encoding: "pcm_s16le",
  sampleRateHz: 16_000,
};

const TTS_TIMEOUT_MS = 15_000;
const STT_TIMEOUT_MS = 30_000;

type SmokeResult = {
  detail?: string;
  durationMs: number;
  error?: string;
  name: string;
  passed: boolean;
  skip?: string;
};

const env = (key: string): string | undefined =>
  process.env[key]?.trim() || undefined;

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const loadSamplePCM = async (): Promise<Uint8Array> => {
  const path = resolve(
    "/home/alexkahn/abs/voice/fixtures/pcm/quietly-alone-clean.pcm",
  );
  return new Uint8Array(await readFile(path));
};

const smokeTTS = async (
  name: string,
  build: () => TTSAdapter,
  options: { text?: string } = {},
): Promise<SmokeResult> => {
  const start = Date.now();
  try {
    const adapter = build();
    const session = await adapter.open({ sessionId: `smoke-${name}` });
    let firstChunk: { byteLength: number } | undefined;
    let firstFormat: AudioFormat | undefined;
    let errorPayload: string | undefined;
    const settled = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () =>
          reject(
            new Error(`no audio chunk within ${String(TTS_TIMEOUT_MS)}ms`),
          ),
        TTS_TIMEOUT_MS,
      );
      session.on("audio", (event) => {
        if (firstChunk) return;
        firstChunk = { byteLength: event.chunk.byteLength };
        firstFormat = event.format;
        clearTimeout(timeout);
        resolve();
      });
      session.on("error", (event) => {
        errorPayload = event.error.message;
        clearTimeout(timeout);
        reject(event.error);
      });
    });
    await session.send(options.text ?? "Hello from AbsoluteJS smoke test.");
    await settled;
    await session.close("smoke-done");
    return {
      detail: firstChunk
        ? `first chunk ${String(firstChunk.byteLength)} bytes, ${firstFormat?.encoding}@${String(firstFormat?.sampleRateHz)}Hz`
        : undefined,
      durationMs: Date.now() - start,
      name,
      passed: Boolean(firstChunk),
    };
  } catch (error) {
    return {
      durationMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
      name,
      passed: false,
    };
  }
};

const smokeSTT = async (
  name: string,
  build: () => STTAdapter,
  options: {
    audio?: Uint8Array;
    chunkMs?: number;
    format?: AudioFormat;
    settleMs?: number;
  } = {},
): Promise<SmokeResult> => {
  const start = Date.now();
  try {
    const adapter = build();
    const audio = options.audio ?? (await loadSamplePCM());
    const format = options.format ?? PCM_16K_MONO;
    const session = await adapter.open({
      format,
      sessionId: `smoke-${name}`,
    });
    let finalText: string | undefined;
    let firstError: string | undefined;
    session.on("final", (event) => {
      if (!finalText && event.transcript.text) {
        finalText = event.transcript.text;
      }
    });
    session.on("error", (event) => {
      if (!firstError) firstError = event.error.message;
    });
    const chunkMs = options.chunkMs ?? 100;
    const bytesPerChunk = Math.max(
      2,
      Math.floor(
        ((format.sampleRateHz ?? 16_000) *
          (format.channels ?? 1) *
          2 *
          chunkMs) /
          1_000,
      ),
    );
    for (let offset = 0; offset < audio.byteLength; offset += bytesPerChunk) {
      await session.send(
        audio.subarray(offset, offset + bytesPerChunk),
      );
      await wait(chunkMs);
    }
    // Some buffered-batch adapters need an explicit flush; if the session
    // has it, call it before close to force the POST. The interface contract
    // doesn't require flush, so we feature-detect.
    const flushable = session as { flush?: () => Promise<void> };
    if (typeof flushable.flush === "function") {
      await flushable.flush();
    }
    const deadline = Date.now() + (options.settleMs ?? STT_TIMEOUT_MS);
    while (!finalText && Date.now() < deadline) {
      await wait(200);
    }
    await session.close("smoke-done");
    if (finalText) {
      return {
        detail: `recognized: "${finalText.slice(0, 80)}"`,
        durationMs: Date.now() - start,
        name,
        passed: true,
      };
    }
    return {
      durationMs: Date.now() - start,
      error:
        firstError ??
        `no final transcript within ${String(options.settleMs ?? STT_TIMEOUT_MS)}ms`,
      name,
      passed: false,
    };
  } catch (error) {
    return {
      durationMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
      name,
      passed: false,
    };
  }
};

const skip = (name: string, missingKey: string): SmokeResult => ({
  durationMs: 0,
  name,
  passed: false,
  skip: `missing ${missingKey}`,
});

const ELEVEN_VOICE = env("ELEVENLABS_VOICE_ID") ?? "21m00Tcm4TlvDq8ikWAM";
const CARTESIA_VOICE =
  env("CARTESIA_VOICE_ID") ?? "a0e99841-438c-4a64-b679-ae501e7d6091";
const AZURE_VOICE = env("AZURE_VOICE") ?? "en-US-JennyNeural";
const PLAYHT_VOICE =
  env("PLAYHT_VOICE_ID") ??
  "s3://voice-cloning-zero-shot/d9ff78ba-d016-47f6-b0ef-dd630f59414e/female-cs/manifest.json";
const RIME_SPEAKER = env("RIME_SPEAKER") ?? "cove";
const LMNT_VOICE = env("LMNT_VOICE_ID") ?? "lily";
const NEETS_VOICE = env("NEETS_VOICE_ID") ?? "us-male-2";
const SMALLEST_VOICE = env("SMALLEST_VOICE_ID") ?? "emily";

const runAll = async (): Promise<SmokeResult[]> => {
  const results: SmokeResult[] = [];

  // --- TTS adapters ---
  results.push(
    env("ELEVENLABS_API_KEY")
      ? await smokeTTS("elevenlabs", () =>
          elevenlabs({
            apiKey: env("ELEVENLABS_API_KEY")!,
            outputFormat: "pcm_24000",
            voiceId: ELEVEN_VOICE,
          }),
        )
      : skip("elevenlabs", "ELEVENLABS_API_KEY"),
  );
  results.push(
    env("CARTESIA_API_KEY")
      ? await smokeTTS("cartesia", () =>
          cartesia({
            apiKey: env("CARTESIA_API_KEY")!,
            voice: CARTESIA_VOICE,
          }),
        )
      : skip("cartesia", "CARTESIA_API_KEY"),
  );
  results.push(
    env("AZURE_SPEECH_KEY") && env("AZURE_SPEECH_REGION")
      ? await smokeTTS("azure-tts", () =>
          azureTTS({
            region: env("AZURE_SPEECH_REGION")!,
            subscriptionKey: env("AZURE_SPEECH_KEY")!,
            voice: AZURE_VOICE,
          }),
        )
      : skip("azure-tts", "AZURE_SPEECH_KEY + AZURE_SPEECH_REGION"),
  );
  results.push(
    env("PLAYHT_API_KEY") && env("PLAYHT_USER_ID")
      ? await smokeTTS("playht", () =>
          playht({
            apiKey: env("PLAYHT_API_KEY")!,
            userId: env("PLAYHT_USER_ID")!,
            voice: PLAYHT_VOICE,
          }),
        )
      : skip("playht", "PLAYHT_API_KEY + PLAYHT_USER_ID"),
  );
  results.push(
    env("RIME_API_KEY")
      ? await smokeTTS("rime", () =>
          rime({ apiKey: env("RIME_API_KEY")!, speaker: RIME_SPEAKER }),
        )
      : skip("rime", "RIME_API_KEY"),
  );
  results.push(
    env("LMNT_API_KEY")
      ? await smokeTTS("lmnt", () =>
          lmnt({ apiKey: env("LMNT_API_KEY")!, voice: LMNT_VOICE }),
        )
      : skip("lmnt", "LMNT_API_KEY"),
  );
  results.push(
    env("NEETS_API_KEY")
      ? await smokeTTS("neets", () =>
          neets({ apiKey: env("NEETS_API_KEY")!, voiceId: NEETS_VOICE }),
        )
      : skip("neets", "NEETS_API_KEY"),
  );
  results.push(
    env("SMALLEST_API_KEY")
      ? await smokeTTS("smallest", () =>
          smallest({
            apiKey: env("SMALLEST_API_KEY")!,
            voiceId: SMALLEST_VOICE,
          }),
        )
      : skip("smallest", "SMALLEST_API_KEY"),
  );

  // --- STT adapters ---
  results.push(
    env("DEEPGRAM_API_KEY")
      ? await smokeSTT("deepgram", () =>
          deepgram({
            apiKey: env("DEEPGRAM_API_KEY")!,
            model: "nova-3",
          }),
        )
      : skip("deepgram", "DEEPGRAM_API_KEY"),
  );
  results.push(
    env("ASSEMBLYAI_API_KEY")
      ? await smokeSTT("assemblyai", () =>
          assemblyai({
            apiKey: env("ASSEMBLYAI_API_KEY")!,
          }),
        )
      : skip("assemblyai", "ASSEMBLYAI_API_KEY"),
  );
  results.push(
    env("AZURE_SPEECH_KEY") && env("AZURE_SPEECH_REGION")
      ? await smokeSTT("azure-stt", () =>
          azureSTT({
            region: env("AZURE_SPEECH_REGION")!,
            subscriptionKey: env("AZURE_SPEECH_KEY")!,
          }),
        )
      : skip("azure-stt", "AZURE_SPEECH_KEY + AZURE_SPEECH_REGION"),
  );
  results.push(
    env("SPEECHMATICS_API_KEY")
      ? await smokeSTT("speechmatics", () =>
          speechmatics({
            apiKey: env("SPEECHMATICS_API_KEY")!,
            region: "eu2",
          }),
        )
      : skip("speechmatics", "SPEECHMATICS_API_KEY"),
  );
  results.push(
    env("GLADIA_API_KEY")
      ? await smokeSTT("gladia", () =>
          gladia({ apiKey: env("GLADIA_API_KEY")! }),
        )
      : skip("gladia", "GLADIA_API_KEY"),
  );
  results.push(
    env("SONIOX_API_KEY")
      ? await smokeSTT("soniox", () =>
          soniox({ apiKey: env("SONIOX_API_KEY")! }),
        )
      : skip("soniox", "SONIOX_API_KEY"),
  );
  results.push(
    env("OPENAI_API_KEY")
      ? await smokeSTT(
          "openai-whisper",
          () =>
            openaiWhisper({
              apiKey: env("OPENAI_API_KEY")!,
            }),
          { settleMs: 15_000 },
        )
      : skip("openai-whisper", "OPENAI_API_KEY"),
  );
  results.push(
    env("GOOGLE_API_KEY") || env("GOOGLE_SPEECH_API_KEY")
      ? await smokeSTT(
          "google-speech-buffered",
          () =>
            googleSpeech({
              apiKey: (env("GOOGLE_SPEECH_API_KEY") ?? env("GOOGLE_API_KEY"))!,
              language: "en-US",
            }),
          { settleMs: 15_000 },
        )
      : skip(
          "google-speech-buffered",
          "GOOGLE_API_KEY or GOOGLE_SPEECH_API_KEY",
        ),
  );
  results.push(
    env("GOOGLE_SPEECH_ACCESS_TOKEN") && env("GOOGLE_SPEECH_PROJECT")
      ? await smokeSTT("google-speech-stream", () =>
          googleSpeechStream({
            accessToken: env("GOOGLE_SPEECH_ACCESS_TOKEN")!,
            project: env("GOOGLE_SPEECH_PROJECT")!,
          }),
        )
      : skip(
          "google-speech-stream",
          "GOOGLE_SPEECH_ACCESS_TOKEN + GOOGLE_SPEECH_PROJECT",
        ),
  );

  return results;
};

const formatResults = (results: SmokeResult[]): string => {
  const pad = (text: string, length: number) =>
    text.length >= length ? text : `${text}${" ".repeat(length - text.length)}`;
  const lines = ["", "Smoke results:", ""];
  for (const result of results) {
    const status = result.skip
      ? "SKIP"
      : result.passed
        ? "PASS"
        : "FAIL";
    const time = `${String(result.durationMs).padStart(5, " ")}ms`;
    const detail =
      result.skip ??
      result.detail ??
      result.error ??
      "";
    lines.push(`  ${pad(status, 4)}  ${pad(result.name, 26)}  ${time}  ${detail}`);
  }
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed && !r.skip).length;
  const skipped = results.filter((r) => r.skip).length;
  lines.push(
    "",
    `  ${String(passed)} pass · ${String(failed)} fail · ${String(skipped)} skip`,
    "",
  );
  return lines.join("\n");
};

const main = async () => {
  const results = await runAll();
  console.log(formatResults(results));
  const failed = results.filter((r) => !r.passed && !r.skip).length;
  process.exit(failed === 0 ? 0 : 1);
};

await main();

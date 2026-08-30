import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import { resolveTelephoneWorkerSettings } from "../src/telephone-worker-settings.ts";
import { wellFormedTelephoneWorkerEnvironment as wellFormedEnvironment } from "./telephone-worker-environment.ts";

describe("resolving the telephone worker's settings", () => {
  test("a prolonged-silence setting outside its range names the setting", () => {
    expect(() =>
      resolveTelephoneWorkerSettings({
        ...wellFormedEnvironment,
        VOICE_AGENT_PROLONGED_SILENCE_SECONDS: "5",
      }),
    ).toThrow(/VOICE_AGENT_PROLONGED_SILENCE_SECONDS/);
  });

  test("a prolonged-silence setting that is not an integer names the setting", () => {
    expect(() =>
      resolveTelephoneWorkerSettings({
        ...wellFormedEnvironment,
        VOICE_AGENT_PROLONGED_SILENCE_SECONDS: "sixty",
      }),
    ).toThrow(/VOICE_AGENT_PROLONGED_SILENCE_SECONDS/);
  });

  test("an absent required setting names the setting", () => {
    const { VOICE_AGENT_DATABASE_PATH: _absent, ...environment } =
      wellFormedEnvironment;

    expect(() => resolveTelephoneWorkerSettings(environment)).toThrow(
      /VOICE_AGENT_DATABASE_PATH/,
    );
  });

  test("an empty required setting names the setting", () => {
    expect(() =>
      resolveTelephoneWorkerSettings({
        ...wellFormedEnvironment,
        VOICE_AGENT_BROKER_SOCKET_PATH: "",
      }),
    ).toThrow(/VOICE_AGENT_BROKER_SOCKET_PATH/);
  });

  test("a configured Keeplore source commit requires the Subagent socket", () => {
    const { VOICE_AGENT_SUBAGENT_SOCKET_PATH: _absent, ...environment } =
      wellFormedEnvironment;

    expect(() =>
      resolveTelephoneWorkerSettings({
        ...environment,
        KEEPLORE_SOURCE_COMMIT: "0".repeat(40),
      }),
    ).toThrow(/VOICE_AGENT_SUBAGENT_SOCKET_PATH/);
  });

  test("an unconfigured Keeplore source commit leaves delegation unresolved", () => {
    expect(
      resolveTelephoneWorkerSettings(wellFormedEnvironment).keeplore,
    ).toBeUndefined();
  });

  test("a well-formed configuration resolves the documented settings", () => {
    expect(resolveTelephoneWorkerSettings(wellFormedEnvironment)).toMatchObject({
      brokerSocketPath: "/run/voice-agent-broker/broker.sock",
      databasePath: "/var/lib/voice-agent/voice-agent.sqlite",
      prolongedSilenceMs: 60_000,
      rawAudioDebugDirectory: "/var/lib/voice-agent/raw-audio-debug",
      recognitionModel: { model: "assemblyai/universal-streaming-multilingual" },
      synthesisModel: { model: "inworld/inworld-tts-2", voice: "Sarah" },
    });
  });
});

// A setting that only fails inside a job leaves a misconfigured worker active,
// so post-Promotion health verification passes and callers fail one at a time.
// These drive the real entrypoints as processes, which is what that
// verification observes.
describe.each([
  ["the telephone agent", "../src/telephone-agent.ts"],
  ["the worker server", "../src/server.ts"],
])("%s process", (_label, entrypoint) => {
  function start(overrides: NodeJS.ProcessEnv) {
    return spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        fileURLToPath(new URL(entrypoint, import.meta.url)),
      ],
      {
        encoding: "utf8",
        env: { ...wellFormedEnvironment, PATH: process.env.PATH, ...overrides },
        timeout: 20_000,
      },
    );
  }

  test("refuses a prolonged-silence setting outside its range at start", () => {
    const result = start({ VOICE_AGENT_PROLONGED_SILENCE_SECONDS: "5" });

    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain("VOICE_AGENT_PROLONGED_SILENCE_SECONDS");
  });

  test("refuses a recognition model outside the set at start", () => {
    const result = start({ VOICE_AGENT_STT_MODEL: "assemblyai/u3-rt-pro" });

    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain("VOICE_AGENT_STT_MODEL");
  });

  test("refuses a malformed recognition model at start", () => {
    const result = start({ VOICE_AGENT_STT_MODEL: "assemblyai" });

    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain("VOICE_AGENT_STT_MODEL");
  });

  test("refuses a synthesis model outside the set at start", () => {
    const result = start({
      VOICE_AGENT_TTS_MODEL: "cartesia/sonic-3.5-2026-05-04",
    });

    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain("VOICE_AGENT_TTS_MODEL");
  });

  test("refuses an absent required setting at start", () => {
    const result = start({ VOICE_AGENT_DATABASE_PATH: "" });

    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain("VOICE_AGENT_DATABASE_PATH");
  });
});

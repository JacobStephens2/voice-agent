import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

const wizard = await readFile(
  fileURLToPath(
    new URL(
      "../../../ops/acceptance/run-administrative-autonomy-restart-witness.sh",
      import.meta.url,
    ),
  ),
  "utf8",
);

test("the attended witness performs real service and Agent Host restarts", () => {
  expect(wizard).toContain(
    "systemctl restart voice-agent-api.service voice-agent-worker.service",
  );
  expect(wizard).toContain("sudo systemctl reboot");
  expect(wizard).toContain("server verifies the changed Linux boot identity");
  expect(wizard).not.toContain("simulated reboot");
});

test("every observation is invoked by the signed-in browser and exported from the server store", () => {
  expect(wizard).toContain("#administrative-restart-witness/");
  expect(wizard).toContain("Record server observation");
  expect(wizard).toContain("witness_cli create");
  expect(wizard).toContain("witness_cli show");
  expect(wizard).toContain("witness_cli export");
  expect(wizard).toContain("administrative-autonomy-restart-cli.ts");
  expect(wizard).not.toMatch(/copy the complete JSON response/iu);
  expect(wizard).not.toMatch(/paste/iu);
  expect(wizard).not.toContain("--status-file");
});

test("the witness is post-Promotion, resumable, and records no raw credential or boot identity", () => {
  expect(wizard).toContain("/opt/voice-agent/current/.voice-agent-release");
  expect(wizard).toContain("Run this only post-Promotion");
  expect(wizard).toContain("The server-recorded campaign resumes");
  expect(wizard).not.toContain("__Host-voice_agent_session");
  expect(wizard).not.toContain("session cookie");
  expect(wizard).not.toContain("--session-cookie");
  expect(wizard).not.toContain("/proc/sys/kernel/random/boot_id");
  expect(wizard).not.toMatch(/--boot-id(?:\s|$)/u);
});

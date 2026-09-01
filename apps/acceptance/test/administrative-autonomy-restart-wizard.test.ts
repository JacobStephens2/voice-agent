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
  expect(wizard).toContain("/proc/sys/kernel/random/boot_id");
  expect(wizard).toContain("sudo systemctl reboot");
  expect(wizard).toContain("different boot identity");
  expect(wizard).not.toContain("simulated reboot");
});

test("every policy observation uses the deployed authenticated API", () => {
  expect(wizard).toContain('"$API_ORIGIN/api/administrative-autonomy"');
  expect(wizard).toContain("__Host-voice_agent_session");
  expect(wizard).toContain("record-baseline");
  expect(wizard).toContain("record-service-restart");
  expect(wizard).toContain("record-host-reboot");
  expect(wizard).toContain("administrative-autonomy-restart-cli.ts");
});

test("the witness is post-Promotion, resumable, and records no raw credential or boot identity", () => {
  expect(wizard).toContain("/opt/voice-agent/current/.voice-agent-release");
  expect(wizard).toContain("Run this only post-Promotion");
  expect(wizard).toContain("arm-host-reboot");
  expect(wizard).toContain('sudo rm -f "$BOOT_CHECKPOINT"');
  expect(wizard).toContain("it is never written");
  expect(wizard).not.toContain("--session-cookie");
  expect(wizard).not.toMatch(/--boot-id(?:\s|$)/u);
});

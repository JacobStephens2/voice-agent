import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);

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
  expect(wizard).toContain(
    "systemctl is-active --quiet",
  );
  expect(wizard).toContain(
    "unless both service identities changed on this same boot",
  );
  expect(wizard).toContain("sudo systemctl reboot");
  expect(wizard).toContain(
    "server verifies the changed Linux boot and the stable post-service API/worker identities",
  );
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
  expect(wizard).toContain(
    "ACTIVE_RELEASE=$(readlink -f /opt/voice-agent/current)",
  );
  expect(wizard).toContain('ACCEPTANCE_CLI=$ACTIVE_RELEASE/apps/acceptance/src/administrative-autonomy-restart-cli.ts');
  expect(wizard).toContain('[[ $REPOSITORY_ROOT != "$ACTIVE_RELEASE" ]]');
  expect(wizard).toContain(
    'sudo find "$ACTIVE_RELEASE" ! -uid 0 -print -quit',
  );
  expect(wizard).toContain(
    'sudo find "$ACTIVE_RELEASE" ! -type l -perm /222 -print -quit',
  );
  expect(wizard).toContain(
    'sudo find "$ACTIVE_RELEASE" -type l -print0',
  );
  expect(wizard).toContain('resolved=$(readlink -f -- "$link")');
  expect(wizard).not.toContain(
    'source "$ACTIVE_RELEASE/ops/release/release-immutability.sh"',
  );
  expect(wizard).toContain('"$ACTIVE_RELEASE/.voice-agent-release"');
  expect(wizard).toContain("Run this only post-Promotion");
  expect(wizard).toContain("The server-recorded campaign resumes");
  expect(wizard).not.toContain("__Host-voice_agent_session");
  expect(wizard).not.toContain("session cookie");
  expect(wizard).not.toContain("--session-cookie");
  expect(wizard).not.toContain("/proc/sys/kernel/random/boot_id");
  expect(wizard).not.toMatch(/--boot-id(?:\s|$)/u);
});

test("an unchanged-boot observation cannot strand reboot recovery", () => {
  expect(wizard).toContain('if ! sudo systemctl reboot; then');
  expect(wizard).toMatch(
    /if ! record_current_observation; then[\s\S]*sudo rm -f "\$REBOOT_MARKER"/u,
  );
  expect(wizard).toContain(
    "The reboot was not observed; its marker was cleared so rerunning can request another real reboot.",
  );
});

test("a migrated campaign follows its current server challenge instead of historical passed phases", async () => {
  expect(wizard).toContain("campaign_next_phase");
  expect(wizard).toContain('.nextObservation.phase // "completed"');
  expect(wizard).not.toContain("campaign_has_passed");
  expect(wizard).toContain("[[ $(campaign_next_phase) == baseline ]]");
  expect(wizard).toContain(
    "[[ $(campaign_next_phase) == service-restart ]]",
  );
  expect(wizard).toContain("[[ $(campaign_next_phase) == host-reboot ]]");

  const phaseReader = wizard.match(
    /campaign_next_phase\(\) \{[\s\S]*?\n\}/u,
  )?.[0];
  expect(phaseReader).toBeDefined();
  const migratedCampaign = JSON.stringify({
    nextObservation: { challenge: "v3-baseline", phase: "baseline" },
    observations: [
      { outcome: "passed", phase: "baseline" },
      { outcome: "passed", phase: "service-restart" },
      { outcome: "passed", phase: "host-reboot" },
    ],
    status: "migration-required",
  });
  const { stdout } = await execFileAsync(
    "bash",
    [
      "-c",
      `${phaseReader}\nwitness_cli() { printf '%s' "$CAMPAIGN"; }\ncampaign_next_phase`,
    ],
    { env: { ...process.env, CAMPAIGN: migratedCampaign } },
  );
  expect(stdout.trim()).toBe("baseline");
});

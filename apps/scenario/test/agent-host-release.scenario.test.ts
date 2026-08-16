import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const execFileAsync = promisify(execFile);

test("Human Merge verification resolves the authoritative PR when the commit projection omits merged_by", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-agent-human-merge-"));
  const gh = join(directory, "gh");
  await writeFile(
    gh,
    `#!/usr/bin/env bash
set -euo pipefail
endpoint=\${!#}
if [[ $endpoint == */commits/*/pulls ]]; then
  printf '%s\\n' '[{"number":20,"merge_commit_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","merged_at":"2026-08-16T11:54:26Z","base":{"ref":"main"},"merged_by":null}]'
elif [[ $endpoint == */pulls/20 ]]; then
  if [[ \${MERGER_TYPE:-User} == User ]]; then
    printf '%s\\n' '{"merge_commit_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","merged_at":"2026-08-16T11:54:26Z","base":{"ref":"main"},"merged_by":{"type":"User"}}'
  else
    printf '%s\\n' '{"merge_commit_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","merged_at":"2026-08-16T11:54:26Z","base":{"ref":"main"},"merged_by":{"type":"Bot"}}'
  fi
else
  exit 2
fi
`,
  );
  await chmod(gh, 0o700);

  try {
    await expect(
      execFileAsync(
        join(repositoryRoot, "ops/release/verify-human-merge.sh"),
        [
          "JacobStephens2/voice-agent",
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ],
        {
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH ?? ""}`,
          },
        },
      ),
    ).resolves.toBeDefined();
    await expect(
      execFileAsync(
        join(repositoryRoot, "ops/release/verify-human-merge.sh"),
        [
          "JacobStephens2/voice-agent",
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ],
        {
          env: {
            ...process.env,
            MERGER_TYPE: "Bot",
            PATH: `${directory}:${process.env.PATH ?? ""}`,
          },
        },
      ),
    ).rejects.toMatchObject({ code: 1 });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("the Agent Host release preserves its private ports and service boundaries", async () => {
  const [
    apiServer,
    apache,
    health,
    apiUnit,
    workerUnit,
    brokerUnit,
    installer,
    promotion,
    preflight,
    wizard,
    queue,
    workflow,
    attemptRecorder,
    promotionState,
    resumePromotion,
    resumePath,
    resumeService,
  ] =
    await Promise.all(
      [
        "apps/api/src/server.ts",
        "ops/apache/voice.stephens.page.conf",
        "ops/release/deployment-health.sh",
        "ops/systemd/voice-agent-api.service",
        "ops/systemd/voice-agent-worker.service",
        "ops/systemd/voice-agent-broker.service",
        "ops/release/install-release.sh",
        "ops/release/promote-release.sh",
        "ops/release/candidate-preflight.sh",
        "ops/setup-agent-host.sh",
        "ops/release/promote-main.sh",
        ".github/workflows/promote-agent-host.yml",
        "ops/release/record-promotion-failure.sh",
        "ops/release/promotion-state.sh",
        "ops/release/resume-promotion.sh",
        "ops/systemd/voice-agent-promotion-resume.path",
        "ops/systemd/voice-agent-promotion-resume.service",
      ].map((path) => readFile(join(repositoryRoot, path), "utf8")),
    );

  for (const portConsumer of [apiServer, apache, health, apiUnit]) {
    expect(portConsumer).toContain("3472");
    expect(portConsumer).not.toContain("3470");
  }
  expect(apiUnit).not.toContain("SupplementaryGroups=voice-broker");
  expect(workerUnit).toContain("SupplementaryGroups=voice-broker-client");
  expect(brokerUnit).toContain("SupplementaryGroups=voice-broker-client");
  expect(brokerUnit).toContain("StateDirectoryMode=0750");
  expect(installer).not.toContain("usermod");
  expect(installer).not.toContain("safe.directory");
  expect(installer).toContain("/var/lib/voice-agent-source/repository.git");
  expect(installer).toContain("github-source-token.sh");
  expect(installer).toContain("runuser --user voice-agent-builder -- env -i");
  expect(wizard).toContain(
    "sudo -u voice-agent -g voice-broker-client env",
  );
  expect(wizard).toContain("verify-human-merge.sh");
  expect(wizard).toContain("install-prometheus-scrape.sh");
  expect(wizard).toContain("read-only Contents permission");
  expect(wizard).toContain("github-app-private-key.pem");
  if (promotion === undefined) throw new Error("promotion script is missing");
  expect(promotion).toContain("restore_unit_definitions");
  expect(promotionState).toContain("voice_agent_promotion_circuit_open");
  expect(queue).toContain("verified-human-merges.tsv");
  expect(queue).toContain("'$1 == before { print $2; exit }'");
  expect(workflow).toContain("BEFORE_COMMIT: ${{ github.event.before }}");
  expect(queue).toContain("record-promotion-failure.sh");
  expect(workflow).toContain("./ops/release/verify-human-merge.sh");
  expect(workflow).toContain("/usr/local/libexec/voice-agent/promote-main.sh");
  expect(attemptRecorder).toContain("promotion-state.sh");
  expect(resumePromotion).toContain("VOICE_AGENT_FRESH_PASSKEY_RESUME=1");
  expect(resumePromotion).toContain('last_failed_commit != "$requested_commit"');
  expect(resumePromotion).toContain('promote-main.sh" "$repository" --drain');
  expect(resumePath).toContain("PathExists=/var/lib/voice-agent-promotion-resume/resume.request");
  expect(resumeService).toContain("ExecStart=/usr/local/libexec/voice-agent/resume-promotion.sh");
  expect(resumeService).toContain("CapabilityBoundingSet=");
  expect(resumeService).toContain("ProtectSystem=strict");
  expect(resumeService).toContain("ProtectHome=true");
  expect(resumeService).toContain("LoadCredential=github-app-key:");
  expect(promotion).toContain('"$script_directory/systemd/$unit"');
  expect(promotion).not.toContain('"$release/ops/systemd/$unit"');
  expect(promotion.indexOf("candidate-preflight.sh")).toBeLessThan(
    promotion.lastIndexOf("mv -Tf \"$candidate\" /opt/voice-agent/current"),
  );
  expect(preflight).toContain("systemd-analyze verify");
});

test("the isolated release builder does not depend on a global pnpm shim", async () => {
  const installer = await readFile(
    join(repositoryRoot, "ops/release/install-release.sh"),
    "utf8",
  );

  expect(installer).toContain("corepack pnpm -r --if-present build");
});

test("the broker prepares its shared socket directory before dropping privileges", async () => {
  const brokerUnit = await readFile(
    join(repositoryRoot, "ops/systemd/voice-agent-broker.service"),
    "utf8",
  );

  expect(brokerUnit).toContain(
    "ExecStartPre=+/usr/bin/chgrp voice-broker-client /run/voice-agent-broker",
  );
  expect(brokerUnit).toContain(
    "ExecStartPre=+/usr/bin/chmod 2770 /run/voice-agent-broker",
  );
});

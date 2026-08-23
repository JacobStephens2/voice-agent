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

test("the Keeplore Subagent keeps model tools behind the registered CSS boundary", async () => {
  const [executor, runner, verifier, publisher, publisherUnit, subagentUnit, trial] = await Promise.all(
    [
      "apps/worker/src/keeplore-codex-executor.ts",
      "apps/worker/src/keeplore-subagent-runner-server.ts",
      "apps/worker/src/keeplore-visual-verifier.ts",
      "ops/release/keeplore-github-app-publisher.ts",
      "ops/systemd/voice-agent-keeplore-publisher.service",
      "ops/systemd/voice-agent-subagent.service",
      "ops/acceptance/run-keeplore-button-trial.sh",
    ].map((path) => readFile(join(repositoryRoot, path), "utf8")),
  );

  expect(executor).toContain('default_permissions="keeplore"');
  expect(executor).toContain('"ui/style.css" = "write"');
  expect(executor).toContain("permissions.keeplore.network.enabled=false");
  expect(executor).not.toContain("sandbox_workspace_write.network_access=true");
  expect(executor).toContain("runRegisteredVerification");
  expect(executor).toContain("createUnixSocketKeeploreCandidatePublisher");
  expect(executor).not.toContain('"gh"');
  expect(runner).toContain('active.process.kill("SIGUSR1")');
  expect(runner).toContain("/var/lib/voice-codex/results");
  expect(verifier).toContain("await context.setOffline(true)");
  expect(publisher).toContain('repositories: [keeploreRepositoryName]');
  expect(publisher).toContain('contents: "write", pull_requests: "write"');
  expect(publisher).toContain("new DatabaseSync(databasePath, { readOnly: true })");
  expect(publisher).toContain("/installation/token");
  expect(publisherUnit).toContain("User=root");
  expect(publisherUnit).toContain(
    "LoadCredential=keeplore-github-app-key:/etc/voice-agent/keeplore-github-app-private-key.pem",
  );
  expect(publisherUnit).toContain("SetCredential=keeplore-github-app-key:");
  expect(publisherUnit).toContain("ProtectSystem=strict");
  expect(publisherUnit).toContain("CapabilityBoundingSet=");
  expect(subagentUnit).toContain("PLAYWRIGHT_BROWSERS_PATH=");
  expect(subagentUnit).toContain("Requires=voice-agent-keeplore-publisher.service");
  for (const codexConsumer of [executor, trial]) {
    expect(codexConsumer).toContain("/usr/bin/codex");
    expect(codexConsumer).not.toContain("/usr/local/bin/codex");
  }
});

test("the Agent Host narrowly enables Bubblewrap user namespaces for Codex", async () => {
  const [profile, manifest, upgrader, preflight, promotion, health, trial] =
    await Promise.all(
      [
        "ops/apparmor/bwrap-userns-restrict",
        "ops/release/deployment-authority-manifest.sh",
        "ops/release/upgrade-deployment-authority.sh",
        "ops/release/candidate-preflight.sh",
        "ops/release/promote-release.sh",
        "ops/release/deployment-health.sh",
        "ops/acceptance/run-keeplore-button-trial.sh",
      ].map((path) => readFile(join(repositoryRoot, path), "utf8")),
    );

  expect(profile).toContain("profile bwrap /usr/bin/bwrap");
  expect(profile).toContain("profile unpriv_bwrap");
  expect(profile).toContain("audit deny capability");
  expect(manifest).toContain("voice_agent_authority_apparmor_profiles");
  expect(manifest).toContain("bwrap-userns-restrict");
  expect(upgrader).toContain('"$stage/apparmor"');
  expect(upgrader).toContain("restore_apparmor_profiles");
  expect(upgrader).toContain('/usr/sbin/apparmor_parser -r "$target_path"');
  expect(upgrader).toContain('/usr/sbin/apparmor_parser -R "$target_path"');
  expect(preflight).toContain('cmp -s "$script_directory/apparmor/$profile"');
  expect(promotion).not.toContain("apparmor_parser -r");
  expect(health).toContain("/sys/kernel/security/apparmor/profiles");
  expect(health).toContain("permissions.voice-agent-health.network.enabled=false");
  expect(health).toContain(
    "release_root=$(readlink -f /opt/voice-agent/current)",
  );
  expect(health).toContain('--cd "$release_root"');
  expect(health).not.toContain("--cd /opt/voice-agent/current");
  expect(health).toContain("Bubblewrap AppArmor profile is not enforcing");
  expect(health).toContain("Offline Codex sandbox health probe failed");
  expect(promotion).toContain("Final failed health probe follows");
  expect(trial).toContain("The Bubblewrap AppArmor profile is unavailable");
  expect(trial).toContain(
    "RELEASE_ROOT=$(readlink -f /opt/voice-agent/current)",
  );
  expect(trial).toContain('--cd "$RELEASE_ROOT"');
  expect(trial).toContain(
    '"$RELEASE_ROOT/apps/worker/src/keeplore-delegation-inspect.ts"',
  );
  expect(trial).not.toContain("--cd /opt/voice-agent/current");
  expect(trial).not.toContain(
    "/opt/voice-agent/current/apps/worker/src/keeplore-delegation-inspect.ts",
  );
  expect(trial).not.toContain("/usr/bin/gh auth login");
  expect(trial).toContain("Remove the obsolete dedicated-user GitHub login");
  expect(trial).toContain("voice-agent-keeplore-publisher.service");
  expect(trial).toContain('test ! -S "$PUBLISHER_SOCKET"');
  for (const hostPolicy of [promotion, health, trial]) {
    expect(hostPolicy).not.toContain(
      "kernel.apparmor_restrict_unprivileged_userns=0",
    );
  }
});

test("the Agent Host release preserves its private ports and service boundaries", async () => {
  const [
    apiServer,
    workerServer,
    apache,
    health,
    apiUnit,
    workerUnit,
    subagentUnit,
    publisherUnit,
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
        "apps/worker/src/server.ts",
        "ops/apache/voice.stephens.page.conf",
        "ops/release/deployment-health.sh",
        "ops/systemd/voice-agent-api.service",
        "ops/systemd/voice-agent-worker.service",
        "ops/systemd/voice-agent-subagent.service",
        "ops/systemd/voice-agent-keeplore-publisher.service",
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
  expect(workerServer).toContain(
    'requireEnvironment("VOICE_AGENT_WORKER_PORT")',
  );
  expect(workerServer).not.toContain('?? "3474"');
  expect(workerUnit).toContain("Environment=VOICE_AGENT_WORKER_PORT=3474");
  expect(health).toContain("VOICE_AGENT_WORKER_PORT=");
  expect(health).toContain('"http://127.0.0.1:$worker_port/"');
  expect(health).not.toContain("http://127.0.0.1:3474/");
  expect(apiUnit).not.toContain("SupplementaryGroups=voice-broker");
  expect(apiUnit).toContain("deployment-authority-upgrade.request");
  expect(apiUnit).toContain("deployment-authority-upgrade.challenge");
  expect(apiServer).toContain("deployment-authority-upgrade.request");
  expect(apiServer).toContain("deployment-authority-upgrade.challenge");
  expect(workerUnit).toContain("SupplementaryGroups=voice-broker-client");
  expect(workerUnit).toContain("voice-subagent-client");
  expect(workerUnit).toContain("EnvironmentFile=-/etc/voice-agent/keeplore-delegation.env");
  expect(subagentUnit).toContain("User=voice-codex");
  expect(subagentUnit).toContain("InaccessiblePaths=/var/lib/voice-agent");
  expect(subagentUnit).toContain("/run/docker.sock");
  expect(subagentUnit).not.toContain("voice-broker-client");
  expect(publisherUnit).toContain("User=root");
  expect(publisherUnit).toContain("Group=voice-subagent-client");
  expect(publisherUnit).toContain("SupplementaryGroups=voice-agent");
  expect(publisherUnit).toContain("InaccessiblePaths=/var/lib/voice-codex");
  expect(publisherUnit).toContain("/var/lib/voice-agent-broker");
  expect(publisherUnit).toContain("RuntimeDirectoryMode=0750");
  expect(publisherUnit).toContain("/run/docker.sock");
  expect(brokerUnit).toContain("Group=voice-broker-client");
  expect(brokerUnit).toContain("StateDirectoryMode=0700");
  expect(installer).not.toContain("usermod");
  expect(installer).not.toContain("safe.directory");
  expect(installer).toContain("/var/lib/voice-agent-source/repository.git");
  expect(installer).toContain("github-source-token.sh");
  expect(installer).toContain("runuser --user voice-agent-builder -- env -i");
  expect(installer).toContain("voice-codex");
  expect(installer).toContain("/var/lib/voice-agent-worktrees/keeplore");
  expect(installer).toContain("/var/lib/voice-agent-worktrees/keeplore.git");
  expect(wizard).toContain(
    "sudo -u voice-agent -g voice-broker-client env",
  );
  expect(wizard).toContain("verify-human-merge.sh");
  expect(wizard).toContain("install-prometheus-scrape.sh");
  expect(wizard).toContain("read-only Contents permission");
  expect(wizard).toContain("github-app-private-key.pem");
  expect(wizard).toContain(
    '"headers": {"X-Telnyx-Username": "<same Telnyx username>"}',
  );
  expect(wizard).toContain(
    "headers_to_attributes maps response headers and does not send the initial INVITE header",
  );
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
  expect(resumeService).toContain("/var/lib/voice-agent-broker");
  expect(promotion).toContain('"$script_directory/systemd/$unit"');
  expect(promotion).toContain("voice-agent-subagent.service");
  expect(promotion).toContain("voice-agent-keeplore-publisher.service");
  expect(promotion).not.toContain('"$release/ops/systemd/$unit"');
  expect(promotion.indexOf("candidate-preflight.sh")).toBeLessThan(
    promotion.lastIndexOf("mv -Tf \"$candidate\" /opt/voice-agent/current"),
  );
  expect(preflight).toContain("systemd-analyze verify");
  expect(preflight).toContain("voice-agent-subagent.service");
  expect(health).toContain("/run/voice-agent-subagent/runner.sock");
  expect(health).toContain("/run/voice-agent-keeplore-publisher/publisher.sock");
});

test("the isolated release builder does not depend on a global pnpm shim", async () => {
  const installer = await readFile(
    join(repositoryRoot, "ops/release/install-release.sh"),
    "utf8",
  );

  expect(installer).toContain("corepack pnpm -r --if-present build");
});

test("the broker socket remains reachable through the worker security boundary", async () => {
  const [brokerUnit, health] = await Promise.all([
    readFile(
      join(repositoryRoot, "ops/systemd/voice-agent-broker.service"),
      "utf8",
    ),
    readFile(join(repositoryRoot, "ops/release/deployment-health.sh"), "utf8"),
  ]);

  expect(brokerUnit).toContain("Group=voice-broker-client");
  expect(brokerUnit).toContain("RuntimeDirectory=voice-agent-broker");
  expect(brokerUnit).toContain("RuntimeDirectoryMode=0770");
  expect(brokerUnit).toContain("StateDirectoryMode=0700");
  expect(brokerUnit).not.toContain("ExecStartPre=+/usr/bin/chgrp");
  expect(brokerUnit).not.toContain("ExecStartPre=+/usr/bin/chmod");
  expect(health).toContain(
    "runuser --user voice-agent --group voice-broker-client -- /usr/bin/curl",
  );
});

test("slice-one observability installs explicit probes and a same-host Grafana dashboard", async () => {
  const [
    probeCli,
    probeService,
    probeTimer,
    apiServer,
    apiUnit,
    health,
    preflight,
    promotion,
    setup,
    authorityManifest,
    dashboardSource,
    dashboardInstaller,
  ] = await Promise.all(
    [
      "apps/broker/src/probe-metrics-cli.ts",
      "ops/systemd/voice-agent-probes.service",
      "ops/systemd/voice-agent-probes.timer",
      "apps/api/src/server.ts",
      "ops/systemd/voice-agent-api.service",
      "ops/release/deployment-health.sh",
      "ops/release/candidate-preflight.sh",
      "ops/release/promote-release.sh",
      "ops/setup-agent-host.sh",
      "ops/release/deployment-authority-manifest.sh",
      "ops/grafana/voice-agent-slice-one.json",
      "ops/grafana/install-dashboard.sh",
    ].map((path) => readFile(join(repositoryRoot, path), "utf8")),
  );
  if (dashboardSource === undefined) throw new Error("dashboard is missing");
  const dashboard = JSON.parse(dashboardSource) as {
    readonly panels: readonly { readonly description?: string; readonly title: string }[];
    readonly tags: readonly string[];
    readonly title: string;
  };

  expect(probeCli).toContain("renderApplicationProbeMetrics");
  expect(probeCli).toContain("/api/health");
  expect(probeCli).toContain("/api/data");
  expect(probeService).toContain("StateDirectory=voice-agent-probes");
  expect(probeService).toContain("ProtectSystem=strict");
  expect(probeTimer).toContain("OnUnitActiveSec=30s");
  expect(apiServer).toContain("VOICE_AGENT_APPLICATION_PROBE_METRICS_PATH");
  expect(apiUnit).toContain("/var/lib/voice-agent-probes/probes.prom");
  expect(health).toContain("voice_agent_monitoring_same_host 1");
  expect(preflight).toContain("voice-agent-probes.service");
  expect(promotion).toContain("voice-agent-probes.timer");
  expect(setup).toContain("install-grafana-dashboard.sh");
  expect(setup).toContain("voice_agent_authority_units");
  expect(authorityManifest).toContain("voice-agent-probes.timer");
  expect(authorityManifest).toContain(
    "deployment-authority-authorization-verifier.mjs",
  );
  expect(dashboardInstaller).toContain("voice-agent-slice-one.json");
  expect(dashboardInstaller).toContain(
    "/var/lib/grafana/dashboards/voice-agent",
  );
  expect(dashboard.title).toContain("Slice One");
  expect(dashboard.tags).toContain("same-host-monitoring");
  expect(
    dashboard.panels.some((panel) =>
      panel.description?.includes("same Agent Host failure domain")),
  ).toBe(true);
  expect(dashboard.panels.map((panel) => panel.title)).toEqual(
    expect.arrayContaining([
      "Callback Handshake",
      "Telephone Sessions",
      "Speech Provider Timing",
      "Application and API Probes",
      "Host Resources",
      "Spending",
    ]),
  );
});

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { join } from "node:path";
import { expect, test } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const manifest = join(
  repositoryRoot,
  "ops/release/deployment-authority-manifest.sh",
);
const promoter = join(repositoryRoot, "ops/release/promote-release.sh");
const preflight = join(repositoryRoot, "ops/release/candidate-preflight.sh");
const execFileAsync = promisify(execFile);

/**
 * Lift a Bash array assignment out of a script that cannot be sourced whole —
 * `promote-release.sh` refuses to run outside a root Promotion. The extracted
 * assignment is evaluated for real against the sourced manifest, so a promoter
 * that narrows its own coverage fails here instead of stranding a reviewed
 * unit change on the Agent Host.
 */
async function readShellArray(
  scriptPath: string,
  name: string,
  preamble = "",
): Promise<readonly string[]> {
  const script = await readFile(scriptPath, "utf8");
  const lines = script.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`${name}=(`));
  if (start === -1) {
    throw new Error(`${scriptPath} never assigns ${name}`);
  }
  let depth = 0;
  const block: string[] = [];
  for (const line of lines.slice(start)) {
    block.push(line);
    depth += (line.match(/\(/g) ?? []).length;
    depth -= (line.match(/\)/g) ?? []).length;
    if (depth === 0) break;
  }
  const { stdout } = await execFileAsync("bash", [
    "-c",
    `set -euo pipefail
source "${manifest}"
${preamble}
${block.join("\n")}
printf '%s\\n' "\${${name}[@]}"`,
  ]);
  return stdout.split("\n").filter((unit) => unit !== "");
}

test("Promotion installs every unit definition the pinned authority carries", async () => {
  const pinned = await readShellArray(manifest, "voice_agent_authority_units");
  const installed = await readShellArray(promoter, "unit_definitions");

  expect(pinned).toContain("voice-agent-promotion-resume.path");
  expect(pinned).toContain("voice-agent-promotion-resume.service");
  expect([...installed].sort()).toStrictEqual([...pinned].sort());
});

test("Promotion restarts no unit whose definition it never installs", async () => {
  const installed = new Set(await readShellArray(promoter, "unit_definitions"));
  const promotion = await readFile(promoter, "utf8");
  const restarted = promotion.match(/voice-agent-[a-z-]+\.(?:service|path|timer)/g) ?? [];

  expect([...new Set(restarted)].filter((unit) => !installed.has(unit)))
    .toStrictEqual([]);
});

test("Candidate preflight verifies every pinned unit definition", async () => {
  const pinned = await readShellArray(manifest, "voice_agent_authority_units");
  const verified = await readShellArray(
    preflight,
    "pinned_unit_paths",
    "script_directory=/usr/local/libexec/voice-agent",
  );

  expect(verified).toStrictEqual(
    pinned.map((unit) => `/usr/local/libexec/voice-agent/systemd/${unit}`),
  );
});

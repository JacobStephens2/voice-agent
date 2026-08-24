import { spawn } from "node:child_process";
import { mkdtemp, rmdir } from "node:fs/promises";

const codexExecutable = "/usr/bin/codex";
const modelFilesystemPermissions =
  '{":minimal" = "read", ":workspace_roots" = {"." = "write"}}';

export function keeploreModelSandboxConfigArguments(
  profileName: string,
): string[] {
  if (!/^[a-z][a-z0-9-]*$/u.test(profileName)) {
    throw new Error("Keeplore model permission profile name is invalid");
  }
  return [
    "--config",
    `permissions.${profileName}.filesystem=${modelFilesystemPermissions}`,
    "--config",
    `permissions.${profileName}.network.enabled=false`,
  ];
}

export async function probeKeeploreModelSandbox(): Promise<void> {
  const modelWorkspace = await mkdtemp(
    "/var/lib/voice-codex/tmp/keeplore-model-profile.",
  );
  try {
    const exitCode = await runInheritedCommand(codexExecutable, [
      "sandbox",
      "--permission-profile",
      "keeplore-model-check",
      "--cd",
      modelWorkspace,
      ...keeploreModelSandboxConfigArguments("keeplore-model-check"),
      "--",
      "/usr/bin/true",
    ]);
    if (exitCode !== 0) {
      throw new Error(
        `Keeplore model workspace sandbox probe exited with code ${exitCode ?? "unknown"}`,
      );
    }
  } finally {
    await rmdir(modelWorkspace);
  }
}

function runInheritedCommand(
  command: string,
  arguments_: string[],
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", resolve);
  });
}

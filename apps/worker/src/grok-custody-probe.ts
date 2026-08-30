import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { credentialCustodyBoundaryPaths } from "./grok-credential-custody.ts";

/**
 * Try to read every Credential Custody Boundary store, and report what opened.
 *
 * The enrollment ceremony records a count of boundary stores the model process
 * reached. Deriving that count from the same list the executor and the sandbox
 * profile use is the point: a hand-counted probe proves whatever the operator
 * remembered to try, and a store added to the boundary later would never be
 * probed at all.
 *
 * Run it as the identity under test. Reading a directory listing counts as
 * reaching the store: the question is not whether a credential was exfiltrated
 * on this attempt, it is whether the boundary held.
 */
export async function probeCredentialCustodyBoundary(): Promise<{
  readable: string[];
  readableBoundaryPaths: number;
}> {
  const readable: string[] = [];
  for (const path of credentialCustodyBoundaryPaths) {
    if (await isReachable(path)) readable.push(path);
  }
  return { readable, readableBoundaryPaths: readable.length };
}

async function isReachable(path: string): Promise<boolean> {
  try {
    const metadata = await stat(path);
    if (metadata.isDirectory()) await readdir(path);
    else await readFile(path);
    return true;
  } catch {
    // An absent store is not a held boundary, but it is not a disclosure
    // either: this host may not have installed it yet.
    return false;
  }
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  process.stdout.write(
    `${JSON.stringify(await probeCredentialCustodyBoundary(), null, 2)}\n`,
  );
}

import { readFileSync } from "node:fs";

/**
 * The root-owned Keeplore registration the Agent Host's release tools also read.
 * The Voice Agent process cannot widen it: it only reads the fixed boundaries.
 */
export interface KeeploreRegistrationFile {
  readonly liveCheckoutPath: string;
  readonly servingPath: string;
  readonly verificationCommands: readonly string[];
}

export function readKeeploreRegistrationFile(
  path = "/etc/voice-agent/keeplore.conf",
): KeeploreRegistrationFile {
  const values = new Map<string, string>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    values.set(line.slice(0, separator), line.slice(separator + 1).trim());
  }
  const liveCheckoutPath = values.get("KEEPLORE_LIVE_CHECKOUT");
  if (liveCheckoutPath === undefined || !liveCheckoutPath.startsWith("/")) {
    throw new Error("The Keeplore registration has no live checkout path");
  }
  const verificationCommand = values.get("KEEPLORE_VERIFICATION_COMMAND");
  return {
    liveCheckoutPath,
    servingPath: values.get("KEEPLORE_SERVING_PATH") ?? `${liveCheckoutPath}/public`,
    verificationCommands:
      verificationCommand === undefined || verificationCommand.length === 0
        ? ["npm test"]
        : [verificationCommand],
  };
}

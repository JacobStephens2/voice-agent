import { createSelfPromotionRuntime } from "@voice-agent/runtime";
import { createSqliteSelfPromotionStore } from "@voice-agent/sqlite-store";

/**
 * The Self-Promotion boundary as the pinned promoter reaches it. The promoter
 * runs as root; this runs as the unprivileged `voice-agent` identity that owns
 * the durable store, so closing Call Admission needs no new authority.
 *
 * The outgoing Release runs `pause` and `await-safe-point`; the incoming one
 * runs `reopen`, after its own health verification has passed. Between them the
 * gate is held by a durable row, which is what makes it survive the restart.
 */
const [command, databasePath, first, second] = process.argv.slice(2);

if (databasePath === undefined) {
  throw new Error(usage());
}

const store = createSqliteSelfPromotionStore(databasePath);
const runtime = createSelfPromotionRuntime({
  now: () => new Date().toISOString(),
  store,
});

try {
  if (command === "pause" && first !== undefined && second !== undefined) {
    if (!/^[0-9a-f]{40}$/u.test(first)) {
      throw new Error("A Self-Promotion pauses admission for a 40-character commit");
    }
    const admission = await runtime.pauseCallAdmission({
      commit: first,
      promotionId: second,
    });
    process.stdout.write(
      `Call Admission is ${admission.state} for Self-Promotion of ${first}.\n`,
    );
  } else if (command === "await-safe-point") {
    // One observation a second, bounded so a promoter can never wait forever on
    // a call that will not end. Exceeding the bound abandons the attempt with
    // the prior Release still active rather than ending the call.
    const maximumObservations = Number.parseInt(first ?? "900", 10);
    if (!Number.isInteger(maximumObservations) || maximumObservations < 1) {
      throw new Error("The safe-point bound is a positive number of observations");
    }
    const disposition = await runtime.awaitSafePoint({ maximumObservations });
    const resumable = await runtime.readResumableWork();
    process.stdout.write(
      `${JSON.stringify({ ...disposition, resumableOperations: resumable.length })}\n`,
    );
    if (disposition.disposition === "deadline-exceeded") {
      process.stderr.write(
        "The Promotion Safe Point was not reached; no Telephone Session was ended to reach it.\n",
      );
      process.exitCode = 1;
    }
  } else if (command === "observe") {
    process.stdout.write(`${JSON.stringify(await runtime.observeSafePoint())}\n`);
  } else if (command === "reopen") {
    const admission = await runtime.reopenCallAdmission();
    process.stdout.write(`Call Admission is ${admission.state}.\n`);
  } else {
    throw new Error(usage());
  }
} finally {
  await store.close();
}

function usage(): string {
  return [
    "Usage: self-promotion-cli.ts pause <database> <commit> <promotion-id>",
    "     | self-promotion-cli.ts await-safe-point <database> [observations]",
    "     | self-promotion-cli.ts observe <database>",
    "     | self-promotion-cli.ts reopen <database>",
  ].join("\n");
}

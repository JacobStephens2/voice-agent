import { expect, test } from "vitest";

import { runBoundedCommand } from "../src/bounded-run.ts";

test("a command's output and exit status are returned", async () => {
  await expect(
    runBoundedCommand("/bin/sh", ["-c", "printf hello; printf oops >&2; exit 3"], {
      environment: {},
      maximumOutputBytes: 1_000,
      timeoutMilliseconds: 5_000,
    }),
  ).resolves.toEqual({
    exceededOutputBound: false,
    exitCode: 3,
    stderr: "oops",
    stdout: "hello",
    timedOut: false,
  });
});

test("a command sees only the environment it was given", async () => {
  const result = await runBoundedCommand("/usr/bin/env", [], {
    environment: { GROK_HOME: "/tmp/home" },
    maximumOutputBytes: 10_000,
    timeoutMilliseconds: 5_000,
  });
  expect(result.stdout).toBe("GROK_HOME=/tmp/home\n");
});

test("a command that outruns its time bound is reported, not awaited", async () => {
  const result = await runBoundedCommand("/bin/sh", ["-c", "sleep 30"], {
    environment: {},
    maximumOutputBytes: 1_000,
    timeoutMilliseconds: 200,
  });
  expect(result.timedOut).toBe(true);
});

test("a command that floods its output bound is stopped with what it had said", async () => {
  const result = await runBoundedCommand(
    "/bin/sh",
    ["-c", "while true; do printf 0123456789; done"],
    { environment: {}, maximumOutputBytes: 200, timeoutMilliseconds: 10_000 },
  );
  expect(result.exceededOutputBound).toBe(true);
  expect(result.stdout.length).toBeLessThanOrEqual(200);
});

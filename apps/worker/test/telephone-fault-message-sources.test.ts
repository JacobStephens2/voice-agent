import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

/**
 * The operator log keeps the message of every error this codebase raises in a
 * Telephone Session, so the guarantee that a caller's words stay out of the
 * journal now rests on the throw sites themselves rather than on a list of
 * stages. This reads them and holds them to fixed text.
 */
const telephoneFaultSources = [
  "../src/livekit-telephone-session.ts",
  "../../../packages/runtime/src/telephone-session.ts",
  "../../../packages/runtime/src/telephone-boundaries.ts",
] as const;

/**
 * Two carriers take another error as their only argument: they add no message
 * of their own beyond the fixed one in their constructor, and the error they
 * carry is unwrapped before it is described.
 */
const faultCarriers = new Set(["ProviderReportedError", "TelephoneStageError"]);

// A fault raises one double-quoted literal and nothing else: no template, no
// concatenation, no value passed through from the call.
const throwSite =
  /throw new (?<carrier>\w+)\(\s*(?<message>"(?:[^"\\]|\\.)*"\s*[),])?/gu;

describe("telephone fault messages", () => {
  test.each(telephoneFaultSources)(
    "%s raises every fault in fixed text, never an interpolated one",
    async (source) => {
      const contents = await readFile(
        new URL(source, import.meta.url),
        "utf8",
      );
      const interpolated = [...contents.matchAll(throwSite)]
        .filter(
          (match) =>
            !faultCarriers.has(match.groups?.carrier ?? "") &&
            match.groups?.message === undefined,
        )
        .map((match) => `${match.groups?.carrier} at index ${match.index}`);

      // A message built from a value carries whatever that value holds, and
      // in this path that can be the caller's transcript.
      expect(interpolated).toEqual([]);
    },
  );
});

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import {
  describeKeeploreMatchedControlProperties,
  keeploreMatchedControlProperties,
} from "@voice-agent/contracts";

test("the matched properties name every computed value the controls must share", () => {
  // The six that a real Delegation left mismatched while its rule looked
  // plausible: it guessed 0.4rem where Remove computes 5.6px and never touched
  // the shadow or the text colour at all.
  for (const property of [
    "boxShadow",
    "color",
    "fontSize",
    "height",
    "paddingBottom",
    "paddingTop",
  ]) {
    expect(keeploreMatchedControlProperties).toContain(property);
  }
  // Width is measured, never matched: both controls keep content widths.
  expect(keeploreMatchedControlProperties).not.toContain("width");
});

test("the description hands the model every matched property by name", () => {
  const description = describeKeeploreMatchedControlProperties();

  for (const property of keeploreMatchedControlProperties) {
    expect(description).toContain(property);
  }
});

test("the prompt and both acceptance checks read one property list", async () => {
  const [executor, policy] = await Promise.all(
    [
      new URL("../src/keeplore-codex-executor.ts", import.meta.url),
      new URL(
        "../../../packages/policy/src/keeplore-delegation.ts",
        import.meta.url,
      ),
    ].map((url) => readFile(fileURLToPath(url), "utf8")),
  );

  // A model told less than the check enforces is left guessing, which is how
  // the check came to be met on desktop one run and missed by six properties
  // the next.
  expect(executor).toContain("describeKeeploreMatchedControlProperties()");
  expect(executor).toContain("keeploreMatchedControlProperties");
  expect(executor).not.toContain("const matchingProperties = [");
  // The Operations policy checks the same properties again before accepting a
  // result, and used to carry its own copy of the list.
  expect(policy).toContain("keeploreMatchedControlProperties");
  expect(policy).not.toContain("const matchingComputedProperties = [");
});

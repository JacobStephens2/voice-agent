import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import {
  describeKeeploreControlMismatch,
  describeKeeploreMatchedControlProperties,
  keeploreMatchedControlProperties,
  type KeeploreComputedButtonStyle,
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
  // The runner and the Operations policy each used to carry their own copy of
  // the list and their own wording for a mismatch; both now call one check.
  for (const source of [executor, policy]) {
    expect(source).toContain("describeKeeploreControlMismatch(");
    expect(source).not.toMatch(/controls differ in \$\{/u);
  }
});

test("one check names every mismatching property, in one wording", () => {
  const remove = matchedStyle();

  expect(
    describeKeeploreControlMismatch("desktop", {
      getRidOf: { ...remove, boxShadow: "none", paddingTop: "6.4px" },
      remove,
    }),
  ).toBe("desktop Keeplore table controls differ in boxShadow, paddingTop");
});

test("controls that share every matched property leave nothing to report", () => {
  const remove = matchedStyle();

  // Width is the one measured value the two controls are required to differ
  // on, so a mismatch check that read it would fail every accepted candidate.
  expect(
    describeKeeploreControlMismatch("mobile", {
      getRidOf: { ...remove, width: "104.5px" },
      remove,
    }),
  ).toBeNull();
});

function matchedStyle(): KeeploreComputedButtonStyle {
  return {
    backgroundColor: "rgb(25, 28, 30)",
    borderBottomWidth: "0px",
    borderLeftWidth: "0px",
    borderRadius: "6px",
    borderRightWidth: "0px",
    borderTopWidth: "0px",
    boxShadow: "rgba(25, 28, 30, 0.06) 0px 1px 2px 0px",
    color: "rgb(255, 255, 255)",
    fontFamily: "Inter, sans-serif",
    fontSize: "14px",
    fontWeight: "600",
    height: "32px",
    letterSpacing: "normal",
    lineHeight: "20.8px",
    paddingBottom: "5.6px",
    paddingTop: "5.6px",
    textTransform: "none",
    width: "76.171875px",
    widthMode: "content",
  };
}

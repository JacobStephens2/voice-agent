import { expect, test } from "vitest";

import { assertTableOnlyCandidate } from "../src/keeplore-table-only-candidate.ts";

const baselineCss = "button.untrack-btn {\n  min-height: 2rem;\n}\n";
const tableOnlySelector =
  "table#useBy:not(.cards-view) td.get-rid-of button.get-rid-of-btn";

function candidate(declarations: string): string {
  return `${baselineCss}${tableOnlySelector} {\n${declarations}\n}\n`;
}

test("the matching declarations restricted Codex may append are accepted", () => {
  expect(() =>
    assertTableOnlyCandidate(
      baselineCss,
      candidate(
        [
          "  background: transparent;",
          "  color: var(--text-soft);",
          "  font-weight: 600;",
          "  font-size: 0.82rem;",
          "  min-height: 2rem;",
          "  padding: 0.35rem 0.7rem;",
          "  box-shadow: inset 0 0 0 1px rgba(80, 95, 118, 0.3);",
        ].join("\n"),
      ),
    ),
  ).not.toThrow();
});

test("the candidate may keep its label on one line so a squeezed column cannot change its height", () => {
  expect(() =>
    assertTableOnlyCandidate(
      baselineCss,
      candidate("  min-height: 2rem;\n  white-space: nowrap;"),
    ),
  ).not.toThrow();
});

test("a wrapping mode that cannot hold the label on one line is not a matching declaration", () => {
  expect(() =>
    assertTableOnlyCandidate(
      baselineCss,
      candidate("  white-space: pre-wrap;"),
    ),
  ).toThrow("unregistered CSS declaration");
});

test("a candidate that rewrites the existing Keeplore CSS is rejected", () => {
  expect(() =>
    assertTableOnlyCandidate(
      baselineCss,
      `button.untrack-btn {\n  min-height: 3rem;\n}\n${tableOnlySelector} { white-space: nowrap; }`,
    ),
  ).toThrow("modified existing CSS");
});

test("a candidate outside the registered table-only control is rejected", () => {
  expect(() =>
    assertTableOnlyCandidate(
      baselineCss,
      `${baselineCss}button.get-rid-of-btn { white-space: nowrap; }`,
    ),
  ).toThrow("outside the registered table-only control");
});

test("a candidate that widens its authority through an at-rule or URL is rejected", () => {
  expect(() =>
    assertTableOnlyCandidate(
      baselineCss,
      `${baselineCss}@media (max-width: 750px) { ${tableOnlySelector} { white-space: nowrap; } }`,
    ),
  ).toThrow("exactly one ordinary CSS rule");
  expect(() =>
    assertTableOnlyCandidate(
      baselineCss,
      candidate("  background: url(https://example.invalid/pixel.png);"),
    ),
  ).toThrow("unregistered CSS declaration");
});

test("a candidate that sets width instead of retaining a content-based width is rejected", () => {
  expect(() =>
    assertTableOnlyCandidate(baselineCss, candidate("  width: 76px;")),
  ).toThrow("unregistered CSS declaration");
});

test("a candidate that appends nothing measurable is rejected", () => {
  expect(() => assertTableOnlyCandidate(baselineCss, baselineCss)).toThrow(
    "absent or too large",
  );
  expect(() => assertTableOnlyCandidate(baselineCss, candidate("  "))).toThrow(
    "no measurable declarations",
  );
});

/**
 * How Keeplore's table and card views are measured in a browser.
 *
 * Two programs measure the same page for different reasons: the Delegation's
 * verifier judges a candidate stylesheet inside a Delegated Worktree, and the
 * promoter's verifier judges what production actually serves. They differ only
 * in which browser session they hold and whether a candidate is injected —
 * everything about *what* is measured belongs here, so the selectors and the
 * probe cannot drift between the bar a candidate is held to and the bar
 * production is held to.
 */
import { createHash } from "node:crypto";

import type { KeeploreComputedButtonStyle } from "@voice-agent/contracts";
import type { Locator, Page } from "playwright";

export const keeploreTableUrl = "https://keeplore.app/artifacts/useby.php";

const tableControlSelector =
  "td.get-rid-of button.get-rid-of-btn, td.get-rid-of button.untrack-btn";

export async function requireAuthenticatedKeeplore(page: Page): Promise<void> {
  if (new URL(page.url()).hostname !== "keeplore.app") {
    throw new Error("Keeplore browser session left the registered application");
  }
  if ((await page.locator(tableControlSelector).count()) < 2) {
    throw new Error("Authenticated Keeplore table controls are unavailable");
  }
}

export async function selectKeeploreView(
  page: Page,
  view: "cards" | "table",
): Promise<void> {
  await page.locator(`.view-toggle-btn[data-view="${view}"]`).click();
  await page.locator("table#useBy").evaluate((table, selected) => {
    if (table.classList.contains("cards-view") !== (selected === "cards")) {
      throw new Error("Keeplore view toggle did not reach the requested state");
    }
  }, view);
}

/** The structural projection of card view that the unchanged-hash compares. */
export async function keeploreCardProjection(page: Page): Promise<unknown> {
  return page.locator("table#useBy.cards-view tbody tr").evaluateAll((rows) =>
    rows.slice(0, 5).map((row) => {
      const rowStyle = getComputedStyle(row);
      const rectangle = row.getBoundingClientRect();
      return {
        controls: [...row.querySelectorAll("button")].map((control) => {
          const style = getComputedStyle(control);
          const controlRectangle = control.getBoundingClientRect();
          return {
            borderRadius: style.borderRadius,
            boxShadow: style.boxShadow,
            fontFamily: style.fontFamily,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            height: controlRectangle.height,
            paddingBottom: style.paddingBottom,
            paddingTop: style.paddingTop,
            width: controlRectangle.width,
          };
        }),
        display: rowStyle.display,
        gap: rowStyle.gap,
        gridTemplateAreas: rowStyle.gridTemplateAreas,
        height: rectangle.height,
        padding: rowStyle.padding,
        width: rectangle.width,
      };
    }),
  );
}

/** The two table-view controls both acceptance gates compare. */
export function keeploreTableControls(page: Page): {
  readonly getRidOf: Locator;
  readonly remove: Locator;
} {
  return {
    getRidOf: page.locator("td.get-rid-of button.get-rid-of-btn").first(),
    remove: page.locator("td.get-rid-of button.untrack-btn").first(),
  };
}

/**
 * Measure one control, including whether its width follows its content.
 *
 * The width probe appends text, re-measures, and restores the original, so the
 * page is left exactly as it was found. A control that did not widen is
 * reported as `fixed` rather than raising: the acceptance gates can then name
 * the width failure, where a thrown error would only say that no measurement
 * arrived.
 */
export async function measureKeeploreControl(
  locator: Locator,
): Promise<KeeploreComputedButtonStyle> {
  return locator.evaluate((button) => {
    const style = getComputedStyle(button);
    const width = button.getBoundingClientRect().width;
    const original = button.textContent ?? "";
    button.textContent = `${original} content-width-probe`;
    const expandedWidth = button.getBoundingClientRect().width;
    button.textContent = original;
    return {
      backgroundColor: style.backgroundColor,
      borderBottomWidth: style.borderBottomWidth,
      borderLeftWidth: style.borderLeftWidth,
      borderRadius: style.borderRadius,
      borderRightWidth: style.borderRightWidth,
      borderTopWidth: style.borderTopWidth,
      boxShadow: style.boxShadow,
      color: style.color,
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      height: `${button.getBoundingClientRect().height}px`,
      letterSpacing: style.letterSpacing,
      lineHeight: style.lineHeight,
      paddingBottom: style.paddingBottom,
      paddingTop: style.paddingTop,
      textTransform: style.textTransform,
      width: `${width}px`,
      widthMode: expandedWidth > width + 1 ? ("content" as const) : ("fixed" as const),
    };
  });
}

export function hashKeeploreObservation(value: unknown): string {
  return createHash("sha256")
    .update(Buffer.isBuffer(value) ? value : JSON.stringify(value))
    .digest("hex");
}

export async function readStandardInput(limitBytes = 100_000): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const untrustedChunk of process.stdin) {
    const chunk = Buffer.from(untrustedChunk);
    bytes += chunk.length;
    if (bytes > limitBytes) throw new Error("Verification input is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

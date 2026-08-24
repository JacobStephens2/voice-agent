import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { KeeploreDelegationResult } from "@voice-agent/contracts";
import { chromium, type Page } from "playwright";
import { z } from "zod";

import { keeploreVerificationViewports } from "./keeplore-verification-viewports.ts";

const inputSchema = z
  .object({
    delegationId: z.string().min(1).max(120),
    evidenceDirectory: z.string().startsWith("/var/lib/voice-agent-evidence/"),
    worktreePath: z.string().startsWith("/var/lib/voice-agent-worktrees/keeplore/"),
  })
  .strict();
const input = inputSchema.parse(JSON.parse(await readStandardInput()));
const candidateCss = await readFile(`${input.worktreePath}/ui/style.css`, "utf8");
const storageState = "/var/lib/voice-codex/browser/keeplore.json";
const targetUrl = "https://keeplore.app/artifacts/useby.php";

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ storageState });
const screenshots: KeeploreDelegationResult["verification"]["screenshots"] = [];
const computedStyles: KeeploreDelegationResult["verification"]["computedStyles"] = [];
const cardBefore: unknown[] = [];
const cardAfter: unknown[] = [];
try {
  for (const viewport of keeploreVerificationViewports) {
    await context.setOffline(false);
    const page = await context.newPage();
    await page.setViewportSize(viewport);
    await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 30_000 });
    await requireAuthenticatedKeeplore(page);
    await selectView(page, "cards");
    cardBefore.push({
      pixels: hash(
        await page.screenshot({ animations: "disabled", fullPage: true }),
      ),
      structure: await cardProjection(page),
      viewport: viewport.name,
    });
    // Candidate CSS is evaluated only after the authenticated page is fully
    // loaded and the context is offline, so CSS cannot turn browser authority
    // into an outbound request channel.
    await context.setOffline(true);
    await page.addStyleTag({ content: candidateCss });
    cardAfter.push({
      pixels: hash(
        await page.screenshot({ animations: "disabled", fullPage: true }),
      ),
      structure: await cardProjection(page),
      viewport: viewport.name,
    });
    await selectView(page, "table");
    const getRidOf = page.locator("td.get-rid-of button.get-rid-of-btn").first();
    const remove = page.locator("td.get-rid-of button.untrack-btn").first();
    await getRidOf.waitFor({ state: "visible" });
    await remove.waitFor({ state: "visible" });
    computedStyles.push({
      getRidOf: await measuredButtonStyle(getRidOf),
      remove: await measuredButtonStyle(remove),
      viewport: viewport.name,
    });
    const screenshotPath =
      `${input.evidenceDirectory}/${viewport.name}-table.png`;
    await page.screenshot({ fullPage: true, path: screenshotPath });
    screenshots.push({ authenticated: true, path: screenshotPath, viewport });
    await page.close();
  }
} finally {
  await context.close();
  await browser.close();
}

const beforeHash = hash(cardBefore);
const afterHash = hash(cardAfter);
process.stdout.write(
  JSON.stringify({
    cardView: {
      afterHash,
      beforeHash,
      unchanged: beforeHash === afterHash,
    },
    computedStyles,
    screenshots,
  } satisfies Omit<
    KeeploreDelegationResult["verification"],
    "automated"
  >),
);

async function requireAuthenticatedKeeplore(page: Page): Promise<void> {
  const current = new URL(page.url());
  if (current.hostname !== "keeplore.app") {
    throw new Error("Keeplore browser session left the registered application");
  }
  const controls = page.locator(
    "td.get-rid-of button.get-rid-of-btn, td.get-rid-of button.untrack-btn",
  );
  if ((await controls.count()) < 2) {
    throw new Error("Authenticated Keeplore table controls are unavailable");
  }
}

async function selectView(page: Page, view: "cards" | "table"): Promise<void> {
  const button = page.locator(`.view-toggle-btn[data-view="${view}"]`);
  await button.click();
  await page.locator("table#useBy").evaluate((table, selected) => {
    const cards = table.classList.contains("cards-view");
    if (cards !== (selected === "cards")) {
      throw new Error("Keeplore view toggle did not reach the requested state");
    }
  }, view);
}

async function cardProjection(page: Page): Promise<unknown> {
  return page.locator("table#useBy.cards-view tbody tr").evaluateAll((rows) =>
    rows.slice(0, 5).map((row) => {
      const rowStyle = getComputedStyle(row);
      const rectangle = row.getBoundingClientRect();
      const controls = [...row.querySelectorAll("button")].map((control) => {
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
      });
      return {
        controls,
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

async function measuredButtonStyle(
  locator: import("playwright").Locator,
): Promise<KeeploreDelegationResult["verification"]["computedStyles"][number]["getRidOf"]> {
  return locator.evaluate((button) => {
    const style = getComputedStyle(button);
    const width = button.getBoundingClientRect().width;
    const original = button.textContent ?? "";
    button.textContent = `${original} content-width-probe`;
    const expandedWidth = button.getBoundingClientRect().width;
    button.textContent = original;
    if (expandedWidth <= width + 1) {
      throw new Error("Keeplore table control does not retain content width");
    }
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
      widthMode: "content" as const,
    };
  });
}

function hash(value: unknown): string {
  return createHash("sha256")
    .update(Buffer.isBuffer(value) ? value : JSON.stringify(value))
    .digest("hex");
}

async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const untrustedChunk of process.stdin) {
    const chunk = Buffer.from(untrustedChunk);
    bytes += chunk.length;
    if (bytes > 100_000) throw new Error("Visual verification input is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

import { readFile } from "node:fs/promises";

import type { KeeploreDelegationResult } from "@voice-agent/contracts";
import { chromium } from "playwright";
import { z } from "zod";

import {
  hashKeeploreObservation,
  keeploreCardProjection,
  keeploreTableControls,
  keeploreTableUrl,
  measureKeeploreControl,
  readStandardInput,
  requireAuthenticatedKeeplore,
  selectKeeploreView,
} from "./keeplore-table-measurement.ts";
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
    await page.goto(keeploreTableUrl, { waitUntil: "networkidle", timeout: 30_000 });
    await requireAuthenticatedKeeplore(page);
    await selectKeeploreView(page, "cards");
    cardBefore.push({
      pixels: hashKeeploreObservation(
        await page.screenshot({ animations: "disabled", fullPage: true }),
      ),
      structure: await keeploreCardProjection(page),
      viewport: viewport.name,
    });
    // Candidate CSS is evaluated only after the authenticated page is fully
    // loaded and the context is offline, so CSS cannot turn browser authority
    // into an outbound request channel.
    await context.setOffline(true);
    await page.addStyleTag({ content: candidateCss });
    cardAfter.push({
      pixels: hashKeeploreObservation(
        await page.screenshot({ animations: "disabled", fullPage: true }),
      ),
      structure: await keeploreCardProjection(page),
      viewport: viewport.name,
    });
    await selectKeeploreView(page, "table");
    const { getRidOf, remove } = keeploreTableControls(page);
    await getRidOf.waitFor({ state: "visible" });
    await remove.waitFor({ state: "visible" });
    computedStyles.push({
      getRidOf: await measureKeeploreControl(getRidOf),
      remove: await measureKeeploreControl(remove),
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

const beforeHash = hashKeeploreObservation(cardBefore);
const afterHash = hashKeeploreObservation(cardAfter);
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


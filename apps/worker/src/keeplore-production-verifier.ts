/**
 * Measure what Keeplore *production* renders, for one Promotion Attempt.
 *
 * The Delegation's visual verifier judges a candidate stylesheet inside a
 * Delegated Worktree. This program judges the Release production is actually
 * serving, so a passing Delegation cannot stand in for a passing Promotion. It
 * runs from the trusted promoter and reads a root-owned browser session — never
 * the restricted Subagent's credential store — and it injects no stylesheet:
 * whatever the switched Release serves is what gets measured.
 *
 * It runs twice per Promotion. `baseline` captures card view from the Release
 * production served before the switch; `verify` runs after the switch and
 * compares against that baseline, so "no card-view regression" is measured
 * against the retained Release rather than against itself.
 */
import { mkdir } from "node:fs/promises";

import {
  keeploreProductionAppearanceObservationSchema,
  keeploreProductionEvidenceRoot,
  type KeeploreProductionAppearanceObservation,
} from "@voice-agent/contracts";
import { evaluateKeeploreProductionAppearance } from "@voice-agent/policy";
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

const commitSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const inputSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("baseline") }).strict(),
  z
    .object({
      baselineCardHash: z.string().min(1).max(200),
      health: z
        .object({
          actualStatus: z.number().int().min(0).max(599),
          expectedStatus: z.number().int().min(100).max(599),
        })
        .strict(),
      mode: z.literal("verify"),
      observedAt: z.iso.datetime(),
      releaseCommit: commitSchema,
    })
    .strict(),
]);

const storageState = "/var/lib/voice-agent/browser/keeplore-production.json";

const input = inputSchema.parse(JSON.parse(await readStandardInput()));
const evidenceDirectory =
  input.mode === "verify"
    ? `${keeploreProductionEvidenceRoot}${input.releaseCommit}`
    : undefined;
if (evidenceDirectory !== undefined) {
  await mkdir(evidenceDirectory, { recursive: true });
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ storageState });
const screenshots: KeeploreProductionAppearanceObservation["screenshots"] = [];
const computedStyles: KeeploreProductionAppearanceObservation["computedStyles"] = [];
const cardProjections: unknown[] = [];
try {
  for (const viewport of keeploreVerificationViewports) {
    const page = await context.newPage();
    await page.setViewportSize(viewport);
    await page.goto(keeploreTableUrl, { waitUntil: "networkidle", timeout: 30_000 });
    await requireAuthenticatedKeeplore(page);
    await selectKeeploreView(page, "cards");
    cardProjections.push({
      pixels: hashKeeploreObservation(
        await page.screenshot({ animations: "disabled", fullPage: true }),
      ),
      structure: await keeploreCardProjection(page),
      viewport: viewport.name,
    });
    if (evidenceDirectory !== undefined) {
      await selectKeeploreView(page, "table");
      const { getRidOf, remove } = keeploreTableControls(page);
      await getRidOf.waitFor({ state: "visible" });
      await remove.waitFor({ state: "visible" });
      computedStyles.push({
        getRidOf: await measureKeeploreControl(getRidOf),
        remove: await measureKeeploreControl(remove),
        viewport: viewport.name,
      });
      const path = `${evidenceDirectory}/${viewport.name}-table.png`;
      await page.screenshot({ fullPage: true, path });
      screenshots.push({ authenticated: true, path, viewport });
    }
    await page.close();
  }
} finally {
  await context.close();
  await browser.close();
}

const cardHash = hashKeeploreObservation(cardProjections);
if (input.mode === "baseline") {
  process.stdout.write(JSON.stringify({ cardHash }));
} else {
  const observation = keeploreProductionAppearanceObservationSchema.parse({
    cardView: {
      afterHash: cardHash,
      beforeHash: input.baselineCardHash,
      unchanged: cardHash === input.baselineCardHash,
    },
    computedStyles,
    health: input.health,
    observedAt: input.observedAt,
    releaseCommit: input.releaseCommit,
    screenshots,
  } satisfies KeeploreProductionAppearanceObservation);
  const verdict = evaluateKeeploreProductionAppearance(observation);
  process.stdout.write(JSON.stringify({ observation, verdict }));
  // The promoter reads the exit status, not the JSON, to decide on rollback:
  // a verdict it failed to parse must never be taken for a passing one.
  if (verdict.outcome === "failed") process.exitCode = 1;
}

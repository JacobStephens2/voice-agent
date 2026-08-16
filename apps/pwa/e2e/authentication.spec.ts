import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

const execute = promisify(execFile);
const databasePath = "/tmp/voice-agent-pwa-e2e.sqlite";

test("two independent passkeys protect live evidence and recovery replaces only a passkey", async ({
  browser,
}) => {
  const firstCode = await generateBootstrapCode();
  const firstDevice = await browser.newContext();
  await firstDevice.credentials.install();
  const firstPage = await firstDevice.newPage();
  const documentResponse = await firstPage.goto("/");
  expect(documentResponse?.headers()["content-security-policy"]).toContain(
    "default-src 'self'",
  );
  expect(documentResponse?.headers()["strict-transport-security"]).toBe(
    "max-age=63072000; includeSubDomains",
  );
  await expect(firstPage.getByRole("heading", { name: "Evidence, under your control." })).toBeVisible();
  await firstPage.getByLabel("Bootstrap Code").fill(firstCode);
  await firstPage.getByLabel("Passkey label").fill("Walking phone");
  await firstPage.getByRole("button", { name: "Enroll passkey" }).click();
  await expect(firstPage.getByText("First passkey enrolled.")).toBeVisible();
  await expect(firstPage.getByText("One more independently usable passkey is required.")).toBeVisible();
  const [firstCredential] = await firstDevice.credentials.get({ rpId: "localhost" });
  expect(firstCredential).toBeDefined();

  await firstPage.getByRole("button", { name: "Enroll passkey" }).click();
  await expect(firstPage.getByText("Authentication could not be completed.")).toBeVisible();

  const secondCode = await generateBootstrapCode();
  const secondDevice = await browser.newContext();
  await secondDevice.credentials.install();
  const secondPage = await secondDevice.newPage();
  await secondPage.goto("/");
  await secondPage.getByLabel("Bootstrap Code").fill(secondCode);
  await secondPage.getByLabel("Passkey label").fill("Desktop passkey");
  await secondPage.getByRole("button", { name: "Enroll passkey" }).click();
  await expect(secondPage.getByRole("heading", { name: "Save your Recovery Codes" })).toBeVisible();
  const [secondCredential] = await secondDevice.credentials.get({ rpId: "localhost" });
  expect(secondCredential?.id).not.toBe(firstCredential?.id);
  const recoveryCodes = await secondPage.locator(".recovery-codes code").allTextContents();
  expect(recoveryCodes).toHaveLength(10);
  const recoveryCode = recoveryCodes[0];
  expect(recoveryCode).toBeDefined();

  await secondPage.getByRole("button", { name: "I saved them" }).click();
  await expect(secondPage.getByRole("heading", { name: "Save your Recovery Codes" })).not.toBeVisible();
  await expect(generateBootstrapCode()).rejects.toThrow();

  await firstPage.reload();
  await firstPage.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(firstPage.getByRole("heading", { name: "Durable Tasks" })).toBeVisible();
  await firstDevice.close();

  await secondPage.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(secondPage.getByRole("heading", { name: "Durable Tasks" })).toBeVisible();

  const browserCookies = await secondDevice.cookies();
  const trustedCookie = browserCookies.find(
    (cookie) => cookie.name === "__Host-voice_agent_session",
  );
  const csrfCookie = browserCookies.find(
    (cookie) => cookie.name === "__Host-voice_agent_csrf",
  );
  expect(trustedCookie?.name).toBe("__Host-voice_agent_session");
  expect(trustedCookie?.httpOnly).toBe(true);
  expect(trustedCookie?.secure).toBe(true);
  expect(trustedCookie?.sameSite).toBe("Strict");
  expect((trustedCookie?.expires ?? 0) - Date.now() / 1000).toBeGreaterThan(
    29 * 24 * 60 * 60,
  );
  expect(csrfCookie).toMatchObject({
    httpOnly: false,
    sameSite: "Strict",
    secure: true,
  });
  expect(await secondPage.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  const manifest = await secondPage.evaluate(async () =>
    fetch("/manifest.webmanifest").then((response) => response.json()),
  );
  expect(manifest).toMatchObject({
    display: "standalone",
    icons: expect.arrayContaining([
      expect.objectContaining({ sizes: "192x192" }),
      expect.objectContaining({ sizes: "512x512" }),
    ]),
    name: "Voice Agent",
  });
  await secondPage.reload();
  await expect(secondPage.getByRole("heading", { name: "Durable Tasks" })).toBeVisible();
  await secondPage.getByRole("button", { name: "Perform Fresh Passkey Action" }).click();
  await expect(secondPage.getByText(/Fresh Passkey Action valid until/u)).toBeVisible();
  await secondPage
    .getByRole("button", { name: "Register Bountywell read-only access" })
    .click();
  await expect(
    secondPage.getByText("Bountywell read-only access is registered."),
  ).toBeVisible();
  let inquiryAttempts = 0;
  await secondPage.route("**/api/tasks/bountywell-health", async (route) => {
    inquiryAttempts += 1;
    if (inquiryAttempts === 1) {
      const acceptedResponse = await route.fetch();
      expect(acceptedResponse.status()).toBe(202);
      await route.fulfill({
        body: JSON.stringify({ error: "response lost after acceptance" }),
        contentType: "application/json",
        status: 502,
      });
      return;
    }
    await route.continue();
  });
  await secondPage
    .getByRole("button", { name: "Run Bountywell health inquiry" })
    .click();
  await expect(
    secondPage.getByText("The Bountywell inquiry could not be accepted."),
  ).toBeVisible();
  await secondPage
    .getByRole("button", { name: "Run Bountywell health inquiry" })
    .click();
  await expect(
    secondPage.getByRole("heading", { name: "Is Bountywell healthy?" }),
  ).toBeVisible();
  await expect(secondPage.getByLabel("Task status: pending")).toBeVisible();
  expect(inquiryAttempts).toBe(2);
  expect(
    await secondPage.evaluate(async () =>
      fetch("/api/tasks")
        .then((response) => response.json())
        .then((tasks: unknown[]) => tasks.length),
    ),
  ).toBe(1);
  expect(await secondPage.evaluate(() => localStorage.length)).toBe(0);

  const csrfStatus = await secondPage.evaluate(async () =>
    fetch("/api/auth/fresh/options", {
      body: JSON.stringify({ csrfToken: "wrong-csrf-token-value" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }).then((response) => response.status),
  );
  expect(csrfStatus).toBe(403);

  const anonymous = await browser.newContext();
  const unauthorized = await anonymous.request.get(
    "http://localhost:4183/api/tasks/not-an-email-locator",
  );
  expect(unauthorized.status()).toBe(401);
  await anonymous.close();

  const recoveryDevice = await browser.newContext();
  await recoveryDevice.credentials.install();
  const recoveryPage = await recoveryDevice.newPage();
  await recoveryPage.goto("/");
  await recoveryPage.getByRole("button", { name: "Use a Recovery Code" }).click();
  await recoveryPage.getByLabel("Single-use Recovery Code").fill(recoveryCode);
  await recoveryPage.getByRole("button", { name: "Start passkey replacement" }).click();
  await expect(recoveryPage.getByRole("button", { name: "Enroll replacement passkey" })).toBeVisible();
  const recoveryEvidenceStatus = await recoveryPage.evaluate(async () =>
    fetch("/api/tasks").then((response) => response.status),
  );
  expect(recoveryEvidenceStatus).toBe(401);
  await recoveryPage.getByLabel("Passkey label").fill("Replacement phone");
  await recoveryPage.getByRole("button", { name: "Enroll replacement passkey" }).click();
  await expect(recoveryPage.getByText("Replacement passkey enrolled.")).toBeVisible();
  await recoveryDevice.close();

  const replayDevice = await browser.newContext();
  const replayPage = await replayDevice.newPage();
  await replayPage.goto("/");
  await replayPage.getByRole("button", { name: "Use a Recovery Code" }).click();
  await replayPage.getByLabel("Single-use Recovery Code").fill(recoveryCode);
  await replayPage.getByRole("button", { name: "Start passkey replacement" }).click();
  await expect(replayPage.getByText("Authentication could not be completed.")).toBeVisible();
  await replayDevice.close();

  await secondPage.evaluate(() => navigator.serviceWorker.ready);
  await secondDevice.setOffline(true);
  await secondPage.reload();
  await expect(secondPage.getByRole("heading", { name: "You’re offline" })).toBeVisible();
  const cachedUrls = await secondPage.evaluate(async () => {
    const urls: string[] = [];
    for (const cacheName of await caches.keys()) {
      const cache = await caches.open(cacheName);
      urls.push(...(await cache.keys()).map((request) => request.url));
    }
    return urls;
  });
  expect(cachedUrls.some((url) => url.includes("/api/"))).toBe(false);
  await secondDevice.close();
});

async function generateBootstrapCode(): Promise<string> {
  const { stdout } = await execute(
    "pnpm",
    ["auth:bootstrap", "--database", databasePath],
    { cwd: process.cwd() },
  );
  return stdout.trim().split("\n").at(-1) ?? "";
}

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { createNodeAuthenticationSecrets } from "@voice-agent/auth";
import { createLoginCeremonyAdmission } from "@voice-agent/api";
import { createAuthenticationScenario } from "../src/index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("single-user authentication scenario", () => {
  test("login ceremony admission is bounded per network client", () => {
    let now = 1_000;
    const admission = createLoginCeremonyAdmission({
      maxAttempts: 2,
      maxTrackedClients: 2,
      now: () => now,
      windowMs: 100,
    });
    expect(admission.admit("client-a")).toBe(true);
    expect(admission.admit("client-a")).toBe(true);
    expect(admission.admit("client-a")).toBe(false);
    expect(admission.admit("client-b")).toBe(true);
    expect(admission.admit("client-c")).toBe(false);
    now = 1_101;
    expect(admission.admit("client-a")).toBe(true);
  });

  test("an expired Bootstrap Code cannot enroll a passkey", async () => {
    const directory = await mkdtemp(join(tmpdir(), "voice-agent-expired-"));
    temporaryDirectories.push(directory);
    const scenario = await createAuthenticationScenario({
      bootstrapCodes: ["EXPIRING-BOOTSTRAP"],
      challenges: [],
      databasePath: join(directory, "auth.sqlite"),
      now: "2026-08-15T19:00:00.000Z",
      ownerUserId: "owner-user-id",
      recoveryCodes: [],
    });
    const code = await scenario.generateBootstrapCode();
    scenario.setTime("2026-08-15T19:11:00.000Z");
    await expect(
      scenario.enrollBootstrapPasskey({
        bootstrapCode: code,
        credentialId: "too-late",
        label: "Expired attempt",
      }),
    ).rejects.toThrow("Bootstrap Code is unavailable");
    await scenario.close();
  });

  test("a Bootstrap Code enrolls one first passkey exactly once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "voice-agent-auth-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "auth.sqlite");
    const scenario = await createAuthenticationScenario({
      bootstrapCodes: ["BOOTSTRAP-ONE"],
      challenges: ["registration-challenge-1"],
      databasePath,
      now: "2026-08-15T20:00:00.000Z",
      ownerUserId: "owner-user-id",
      recoveryCodes: [],
    });

    const bootstrapCode = await scenario.generateBootstrapCode();
    expect(bootstrapCode).toBe("BOOTSTRAP-ONE");

    const result = await scenario.enrollBootstrapPasskey({
      bootstrapCode,
      credentialId: "android-passkey",
      label: "Android phone",
    });

    expect(result).toEqual({
      recoveryCodes: [],
      status: {
        bootstrapAvailable: true,
        passkeyCount: 1,
        setup: "second-passkey-required",
        unattendedAuthorityEnabled: false,
      },
    });
    await expect(
      scenario.enrollBootstrapPasskey({
        bootstrapCode,
        credentialId: "replayed-passkey",
        label: "Replay",
      }),
    ).rejects.toThrow("Bootstrap Code is unavailable");
    await scenario.close();

    const reopened = await createAuthenticationScenario({
      bootstrapCodes: ["BOOTSTRAP-TWO"],
      challenges: ["registration-challenge-2"],
      databasePath,
      now: "2026-08-15T20:01:00.000Z",
      ownerUserId: "must-not-replace-owner",
      recoveryCodes: [],
    });

    try {
      expect(await reopened.status()).toEqual(result.status);
      await expect(
        reopened.enrollBootstrapPasskey({
          bootstrapCode,
          credentialId: "replayed-after-restart",
          label: "Replay after restart",
        }),
      ).rejects.toThrow("Bootstrap Code is unavailable");
    } finally {
      await reopened.close();
    }
  });

  test("the second passkey issues Recovery Codes and permanently closes bootstrap", async () => {
    const directory = await mkdtemp(join(tmpdir(), "voice-agent-ready-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "auth.sqlite");
    const scenario = await createAuthenticationScenario({
      bootstrapCodes: ["BOOTSTRAP-ONE", "BOOTSTRAP-TWO"],
      challenges: ["challenge-one", "challenge-two"],
      databasePath,
      now: "2026-08-15T21:00:00.000Z",
      ownerUserId: "owner-user-id",
      recoveryCodes: ["RECOVERY-A", "RECOVERY-B", "RECOVERY-C"],
    });

    const firstCode = await scenario.generateBootstrapCode();
    await scenario.enrollBootstrapPasskey({
      bootstrapCode: firstCode,
      credentialId: "android-passkey",
      label: "Android phone",
    });
    const secondCode = await scenario.generateBootstrapCode();
    const completed = await scenario.enrollBootstrapPasskey({
      bootstrapCode: secondCode,
      credentialId: "security-key-passkey",
      label: "Security key",
    });

    expect(completed).toEqual({
      recoveryCodes: ["RECOVERY-A", "RECOVERY-B", "RECOVERY-C"],
      recoveryConfirmationToken: "recovery-confirmation-token",
      status: {
        bootstrapAvailable: true,
        passkeyCount: 2,
        setup: "recovery-confirmation-required",
        unattendedAuthorityEnabled: false,
      },
    });
    const confirmed = await scenario.confirmRecoveryCodes({
      confirmationToken: completed.recoveryConfirmationToken ?? "",
    });
    expect(confirmed).toEqual({
      bootstrapAvailable: false,
      passkeyCount: 2,
      setup: "ready",
      unattendedAuthorityEnabled: true,
    });
    await expect(
      scenario.recover("SUBSTITUTED-RECOVERY-CODE"),
    ).rejects.toThrow("Recovery Code is unavailable");
    await expect(
      scenario.confirmRecoveryCodes({
        confirmationToken: completed.recoveryConfirmationToken ?? "",
      }),
    ).rejects.toThrow("Recovery Code confirmation is unavailable");
    await expect(scenario.generateBootstrapCode()).rejects.toThrow(
      "Bootstrap enrollment is permanently disabled",
    );
    await scenario.close();

    const reopened = await createAuthenticationScenario({
      bootstrapCodes: ["MUST-NOT-BE-USED"],
      challenges: [],
      databasePath,
      now: "2026-08-15T21:01:00.000Z",
      ownerUserId: "must-not-replace-owner",
      recoveryCodes: ["MUST-NOT-BE-USED"],
    });
    try {
      expect(await reopened.status()).toEqual(confirmed);
      await expect(reopened.generateBootstrapCode()).rejects.toThrow(
        "Bootstrap enrollment is permanently disabled",
      );
    } finally {
      await reopened.close();
    }
  });

  test("the second passkey must be a different verified WebAuthn credential", async () => {
    const directory = await mkdtemp(join(tmpdir(), "voice-agent-independent-"));
    temporaryDirectories.push(directory);
    const scenario = await createAuthenticationScenario({
      bootstrapCodes: ["BOOTSTRAP-ONE", "BOOTSTRAP-TWO"],
      challenges: ["registration-one", "registration-two"],
      databasePath: join(directory, "auth.sqlite"),
      now: "2026-08-15T21:15:00.000Z",
      ownerUserId: "owner-user-id",
      recoveryCodes: ["RECOVERY-A", "RECOVERY-B"],
    });
    const firstCode = await scenario.generateBootstrapCode();
    await scenario.enrollBootstrapPasskey({
      bootstrapCode: firstCode,
      credentialId: "same-credential",
      label: "First passkey",
    });
    const secondCode = await scenario.generateBootstrapCode();
    await expect(
      scenario.enrollBootstrapPasskey({
        bootstrapCode: secondCode,
        credentialId: "same-credential",
        label: "Second passkey",
      }),
    ).rejects.toThrow("Passkey is already enrolled");
    expect(await scenario.status()).toMatchObject({
      passkeyCount: 1,
      unattendedAuthorityEnabled: false,
    });
    await scenario.close();
  });

  test("one passkey cannot establish a Trusted Browser Session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "voice-agent-gated-login-"));
    temporaryDirectories.push(directory);
    const scenario = await createAuthenticationScenario({
      authenticationChallenges: ["must-not-be-used"],
      bootstrapCodes: ["BOOTSTRAP-ONE"],
      challenges: ["registration-one"],
      csrfTokens: ["must-not-be-used"],
      databasePath: join(directory, "auth.sqlite"),
      now: "2026-08-15T21:30:00.000Z",
      ownerUserId: "owner-user-id",
      recoveryCodes: [],
      sessionTokens: ["must-not-be-used"],
    });
    const code = await scenario.generateBootstrapCode();
    await scenario.enrollBootstrapPasskey({
      bootstrapCode: code,
      credentialId: "only-passkey",
      label: "Only passkey",
    });
    await expect(scenario.login("only-passkey")).rejects.toThrow(
      "Authentication setup is incomplete",
    );
    await scenario.close();
  });

  test("login and Fresh Passkey Action have distinct lifetimes and require CSRF", async () => {
    const directory = await mkdtemp(join(tmpdir(), "voice-agent-session-"));
    temporaryDirectories.push(directory);
    const scenario = await createAuthenticationScenario({
      authenticationChallenges: [
        "login-challenge",
        "fresh-challenge",
        "interleaved-login-challenge",
        "interleaved-fresh-challenge",
      ],
      bootstrapCodes: ["BOOTSTRAP-ONE", "BOOTSTRAP-TWO"],
      challenges: ["registration-one", "registration-two"],
      csrfTokens: ["csrf-one", "csrf-two"],
      databasePath: join(directory, "auth.sqlite"),
      now: "2026-08-15T22:00:00.000Z",
      ownerUserId: "owner-user-id",
      recoveryCodes: ["RECOVERY-A", "RECOVERY-B"],
      sessionTokens: ["session-one", "session-two"],
    });

    const firstCode = await scenario.generateBootstrapCode();
    await scenario.enrollBootstrapPasskey({
      bootstrapCode: firstCode,
      credentialId: "android-passkey",
      label: "Android phone",
    });
    const secondCode = await scenario.generateBootstrapCode();
    const pendingRecovery = await scenario.enrollBootstrapPasskey({
      bootstrapCode: secondCode,
      credentialId: "security-key-passkey",
      label: "Security key",
    });
    await scenario.confirmRecoveryCodes({
      confirmationToken:
        pendingRecovery.recoveryConfirmationToken ?? "",
    });

    const session = await scenario.login("android-passkey");
    expect(session).toEqual({
      csrfToken: "csrf-one",
      expiresAt: "2026-09-14T22:00:00.000Z",
      freshUntil: undefined,
      sessionToken: "session-one",
    });
    expect(await scenario.canViewEvidence(session.sessionToken)).toBe(true);

    await expect(
      scenario.performFreshPasskeyAction({
        credentialId: "security-key-passkey",
        csrfToken: "wrong-csrf",
        sessionToken: session.sessionToken,
      }),
    ).rejects.toThrow("CSRF validation failed");

    const fresh = await scenario.performFreshPasskeyAction({
      credentialId: "security-key-passkey",
      csrfToken: session.csrfToken,
      sessionToken: session.sessionToken,
    });
    expect(fresh.freshUntil).toBe("2026-08-15T22:05:00.000Z");
    expect(await scenario.hasFreshPasskeyAction(session.sessionToken)).toBe(true);

    const pendingLogin = await scenario.beginLogin();
    const pendingFresh = await scenario.beginFreshPasskeyAction({
      csrfToken: session.csrfToken,
      sessionToken: session.sessionToken,
    });
    const concurrentSession = await scenario.finishLogin({
      ceremonyId: pendingLogin,
      credentialId: "android-passkey",
    });
    const concurrentFresh = await scenario.finishFreshPasskeyAction({
      ceremonyId: pendingFresh,
      credentialId: "security-key-passkey",
      sessionToken: session.sessionToken,
    });
    expect(concurrentSession.sessionToken).toBe("session-two");
    expect(concurrentFresh.freshUntil).toBe("2026-08-15T22:05:00.000Z");
    expect(await scenario.canViewEvidence(concurrentSession.sessionToken)).toBe(
      true,
    );

    scenario.setTime("2026-08-15T22:06:00.000Z");
    expect(await scenario.hasFreshPasskeyAction(session.sessionToken)).toBe(false);
    expect(await scenario.canViewEvidence(session.sessionToken)).toBe(true);

    scenario.setTime("2026-09-15T22:00:00.000Z");
    expect(await scenario.canViewEvidence(session.sessionToken)).toBe(false);
    expect(await scenario.canViewEvidence(concurrentSession.sessionToken)).toBe(
      false,
    );
    await scenario.close();
  });

  test("public login saturation cannot consume reserved Fresh ceremony capacity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "voice-agent-ceremonies-"));
    temporaryDirectories.push(directory);
    const scenario = await createAuthenticationScenario({
      authenticationChallenges: [
        "initial-login",
        ...Array.from(
          { length: 30 },
          (_value, index) => `public-login-${index}`,
        ),
        "rejected-login",
        "reserved-fresh",
      ],
      bootstrapCodes: ["BOOTSTRAP-ONE", "BOOTSTRAP-TWO"],
      challenges: ["registration-one", "registration-two"],
      csrfTokens: ["csrf-one"],
      databasePath: join(directory, "auth.sqlite"),
      now: "2026-08-15T22:30:00.000Z",
      ownerUserId: "owner-user-id",
      recoveryCodes: ["RECOVERY-A", "RECOVERY-B"],
      sessionTokens: ["session-one"],
    });

    const firstCode = await scenario.generateBootstrapCode();
    await scenario.enrollBootstrapPasskey({
      bootstrapCode: firstCode,
      credentialId: "android-passkey",
      label: "Android phone",
    });
    const secondCode = await scenario.generateBootstrapCode();
    const pendingRecovery = await scenario.enrollBootstrapPasskey({
      bootstrapCode: secondCode,
      credentialId: "security-key-passkey",
      label: "Security key",
    });
    await scenario.confirmRecoveryCodes({
      confirmationToken: pendingRecovery.recoveryConfirmationToken ?? "",
    });
    const session = await scenario.login("android-passkey");

    for (let index = 0; index < 30; index += 1) {
      await scenario.beginLogin();
    }
    await expect(scenario.beginLogin()).rejects.toThrow(
      "Passkey authentication ceremony could not be started",
    );

    const freshCeremony = await scenario.beginFreshPasskeyAction({
      csrfToken: session.csrfToken,
      sessionToken: session.sessionToken,
    });
    await expect(
      scenario.finishFreshPasskeyAction({
        ceremonyId: freshCeremony,
        credentialId: "security-key-passkey",
        sessionToken: session.sessionToken,
      }),
    ).resolves.toEqual({ freshUntil: "2026-08-15T22:35:00.000Z" });
    await scenario.close();
  });

  test("a Recovery Code works once and authorizes only replacement passkey enrollment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "voice-agent-recovery-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "auth.sqlite");
    const scenario = await createAuthenticationScenario({
      bootstrapCodes: ["BOOTSTRAP-ONE", "BOOTSTRAP-TWO"],
      challenges: [
        "registration-one",
        "registration-two",
        "registration-replacement",
      ],
      csrfTokens: ["recovery-csrf"],
      databasePath,
      now: "2026-08-15T23:00:00.000Z",
      ownerUserId: "owner-user-id",
      recoveryCodes: ["RECOVERY-A", "RECOVERY-B"],
      sessionTokens: ["recovery-session"],
    });

    const firstCode = await scenario.generateBootstrapCode();
    await scenario.enrollBootstrapPasskey({
      bootstrapCode: firstCode,
      credentialId: "lost-android-passkey",
      label: "Lost Android phone",
    });
    const secondCode = await scenario.generateBootstrapCode();
    const pendingRecovery = await scenario.enrollBootstrapPasskey({
      bootstrapCode: secondCode,
      credentialId: "security-key-passkey",
      label: "Security key",
    });
    await scenario.confirmRecoveryCodes({
      confirmationToken:
        pendingRecovery.recoveryConfirmationToken ?? "",
    });

    const recovery = await scenario.recover("RECOVERY-A");
    expect(recovery).toEqual({
      csrfToken: "recovery-csrf",
      expiresAt: "2026-08-15T23:15:00.000Z",
      sessionToken: "recovery-session",
    });
    expect(await scenario.canViewEvidence(recovery.sessionToken)).toBe(false);
    expect(
      await scenario.hasFreshPasskeyAction(recovery.sessionToken),
    ).toBe(false);

    const recoveredStatus = await scenario.enrollRecoveryPasskey({
      credentialId: "replacement-android-passkey",
      csrfToken: recovery.csrfToken,
      label: "Replacement Android phone",
      sessionToken: recovery.sessionToken,
    });
    expect(recoveredStatus).toEqual({
      bootstrapAvailable: false,
      passkeyCount: 3,
      setup: "ready",
      unattendedAuthorityEnabled: true,
    });
    await expect(scenario.recover("RECOVERY-A")).rejects.toThrow(
      "Recovery Code is unavailable",
    );
    await scenario.close();

    const reopened = await createAuthenticationScenario({
      bootstrapCodes: [],
      challenges: [],
      databasePath,
      now: "2026-08-15T23:01:00.000Z",
      ownerUserId: "must-not-replace-owner",
      recoveryCodes: [],
    });
    try {
      await expect(reopened.recover("RECOVERY-A")).rejects.toThrow(
        "Recovery Code is unavailable",
      );
    } finally {
      await reopened.close();
    }
  });

  test("Trusted Browser Session retention stays bounded", async () => {
    const directory = await mkdtemp(join(tmpdir(), "voice-agent-sessions-"));
    temporaryDirectories.push(directory);
    const sessionTokens = Array.from(
      { length: 21 },
      (_value, index) => `session-${index}`,
    );
    const scenario = await createAuthenticationScenario({
      authenticationChallenges: Array.from(
        { length: 21 },
        (_value, index) => `login-${index}`,
      ),
      bootstrapCodes: ["BOOTSTRAP-ONE", "BOOTSTRAP-TWO"],
      challenges: ["registration-one", "registration-two"],
      csrfTokens: Array.from(
        { length: 21 },
        (_value, index) => `csrf-token-${index}`,
      ),
      databasePath: join(directory, "auth.sqlite"),
      now: "2026-08-15T23:30:00.000Z",
      ownerUserId: "owner-user-id",
      recoveryCodes: ["RECOVERY-A", "RECOVERY-B"],
      sessionTokens,
    });
    const firstCode = await scenario.generateBootstrapCode();
    await scenario.enrollBootstrapPasskey({
      bootstrapCode: firstCode,
      credentialId: "first-passkey",
      label: "First passkey",
    });
    const secondCode = await scenario.generateBootstrapCode();
    const pending = await scenario.enrollBootstrapPasskey({
      bootstrapCode: secondCode,
      credentialId: "second-passkey",
      label: "Second passkey",
    });
    await scenario.confirmRecoveryCodes({
      confirmationToken: pending.recoveryConfirmationToken ?? "",
    });
    for (let index = 0; index < 20; index += 1) {
      await scenario.login("first-passkey");
    }
    await expect(scenario.login("first-passkey")).rejects.toThrow(
      "Trusted Browser Session limit reached",
    );
    expect(await scenario.canViewEvidence("session-0")).toBe(true);
    expect(await scenario.canViewEvidence("session-19")).toBe(true);
    expect(await scenario.canViewEvidence("session-20")).toBe(false);
    await scenario.close();
  });

  test("production secret verifiers never contain the protected code", async () => {
    const secrets = createNodeAuthenticationSecrets();
    const recoveryCode = secrets.createRecoveryCodes()[0];
    expect(recoveryCode).toBeDefined();
    const verifier = await secrets.protect(recoveryCode ?? "");
    expect(verifier).not.toContain(recoveryCode ?? "");
    expect(await secrets.matches(recoveryCode ?? "", verifier)).toBe(true);
    expect(await secrets.matches("wrong-recovery-code", verifier)).toBe(false);
  });
});

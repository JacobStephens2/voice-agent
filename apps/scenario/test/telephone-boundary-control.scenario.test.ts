import { expect, test } from "vitest";

import { createTaskApi, trustedSessionCookieName } from "@voice-agent/api";

test("spending ceilings and raw-audio debug grants require a Fresh Passkey Action", async () => {
  let fresh = false;
  let changedCeilings = 0;
  let debugGrants = 0;
  let policyDenials = 0;
  const api = createTaskApi({
    authentication: {
      async canChangeState({ csrfToken, sessionToken }) {
        return sessionToken === "trusted-session" && csrfToken === "csrf-token-value";
      },
      async canViewEvidence(sessionToken) {
        return sessionToken === "trusted-session";
      },
      async hasFreshPasskeyAction() {
        return fresh;
      },
    },
    boundaryControls: {
      async authorizeRawAudioDebug(input) {
        debugGrants += 1;
        return {
          decision: "accepted" as const,
          expiresAt: "2026-08-18T12:00:00.000Z",
          sessionId: input.sessionId,
        };
      },
      async changeSpendingCeiling(input) {
        changedCeilings += 1;
        return {
          ceilingMicrousd: input.ceilingMicrousd,
          decision: "accepted" as const,
          revision: 2,
        };
      },
      async readBoundaryStatus() {
        return {
          audioDebug: { activeGrants: 0 },
          spending: {
            bySourceMicrousd: {
              api: 24_000_000,
              "realtime-media": 10_000_000,
              telephony: 6_000_000,
            },
            ceilingMicrousd: 50_000_000,
            month: "2026-08",
            totalMicrousd: 40_000_000,
          },
        };
      },
    },
    origin: "https://voice.stephens.page",
    records: {
      async getEvidenceRecord() {
        return undefined;
      },
      async recordPolicyDenial() {
        policyDenials += 1;
      },
    },
  });
  const headers = {
    cookie: `${trustedSessionCookieName}=trusted-session`,
    origin: "https://voice.stephens.page",
  };

  try {
    const status = await api.inject({
      headers,
      method: "GET",
      url: "/api/telephone/boundaries",
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      spending: { ceilingMicrousd: 50_000_000, totalMicrousd: 40_000_000 },
    });

    const blockedCeiling = await api.inject({
      headers,
      method: "POST",
      payload: { ceilingMicrousd: 75_000_000, csrfToken: "csrf-token-value" },
      url: "/api/telephone/spending-ceiling",
    });
    expect(blockedCeiling.statusCode).toBe(403);
    const blockedDebug = await api.inject({
      headers,
      method: "POST",
      payload: { csrfToken: "csrf-token-value" },
      url: "/api/telephone/sessions/session-1/raw-audio-debug",
    });
    expect(blockedDebug.statusCode).toBe(403);
    expect(changedCeilings).toBe(0);
    expect(debugGrants).toBe(0);

    fresh = true;
    const changed = await api.inject({
      headers,
      method: "POST",
      payload: { ceilingMicrousd: 75_000_000, csrfToken: "csrf-token-value" },
      url: "/api/telephone/spending-ceiling",
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toEqual({
      ceilingMicrousd: 75_000_000,
      decision: "accepted",
      revision: 2,
    });
    const enabled = await api.inject({
      headers,
      method: "POST",
      payload: { csrfToken: "csrf-token-value" },
      url: "/api/telephone/sessions/session-1/raw-audio-debug",
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toEqual({
      decision: "accepted",
      expiresAt: "2026-08-18T12:00:00.000Z",
      sessionId: "session-1",
    });
    expect(changedCeilings).toBe(1);
    expect(debugGrants).toBe(1);
    expect(policyDenials).toBe(2);
  } finally {
    await api.close();
  }
});

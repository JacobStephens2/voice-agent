import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { createTaskApi, trustedSessionCookieName } from "@voice-agent/api";
import { createCallbackHandshakeRuntime } from "@voice-agent/runtime";
import { createSqliteCallbackHandshakeStore } from "@voice-agent/sqlite-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

test("only a Fresh Passkey Action can enroll or change the Registered Telephone", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-agent-telephone-control-"));
  temporaryDirectories.push(directory);
  const runtime = createCallbackHandshakeRuntime({
    nextId: () => "unused-id",
    now: () => "2026-08-16T19:00:00.000Z",
    store: createSqliteCallbackHandshakeStore(
      join(directory, "voice-agent.sqlite"),
    ),
  });
  let fresh = false;
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
    origin: "https://voice.stephens.page",
    records: {
      async getEvidenceRecord() {
        return undefined;
      },
      async recordPolicyDenial() {
        policyDenials += 1;
      },
    },
    telephoneControls: runtime,
  });
  const headers = {
    cookie: `${trustedSessionCookieName}=trusted-session`,
    origin: "https://voice.stephens.page",
  };
  const registration = {
    csrfToken: "csrf-token-value",
    livekitInboundTrunkId: "ST_inbound",
    livekitOutboundTrunkId: "ST_outbound",
    telephoneNumber: "+12155550123",
    telnyxNumber: "+12155550999",
  };

  try {
    const ordinaryBrowser = await api.inject({
      headers,
      method: "POST",
      payload: registration,
      url: "/api/telephone/registration",
    });
    expect(ordinaryBrowser.statusCode).toBe(403);

    fresh = true;
    const enrolled = await api.inject({
      headers,
      method: "POST",
      payload: registration,
      url: "/api/telephone/registration",
    });
    expect(enrolled.statusCode).toBe(200);
    expect(enrolled.json()).toMatchObject({
      livekitOutboundTrunkId: "ST_outbound",
      revision: 1,
      telephoneNumber: "+12155550123",
    });

    const changed = await api.inject({
      headers,
      method: "POST",
      payload: {
        ...registration,
        telephoneNumber: "+12675550123",
      },
      url: "/api/telephone/registration",
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({
      revision: 2,
      telephoneNumber: "+12675550123",
    });

    const status = await api.inject({
      headers,
      method: "GET",
      url: "/api/telephone/registration",
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      registration: {
        revision: 2,
        telephoneNumber: "+12675550123",
      },
    });
    expect(policyDenials).toBe(1);
  } finally {
    await api.close();
    await runtime.close();
  }
});

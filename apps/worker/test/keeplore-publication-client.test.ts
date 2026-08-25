import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { createUnixSocketKeeploreCandidatePublisher } from "../src/keeplore-publication-client.ts";

const temporaryDirectories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

test("a refusal names the kind of check that refused, and nothing the check saw", async () => {
  const publisher = await refusingPublisher({
    error: "publication-refused",
    refusal: "policy",
  });

  await expect(publisher.publish(publicationRequest())).rejects.toThrow(
    "Keeplore publisher refused the request (422: policy)",
  );
});

test("a refusal without a registered code is reported by its status alone", async () => {
  for (const body of [
    { error: "publication-refused" },
    { error: "publication-refused", refusal: "the policy journal is stale" },
    "not-json",
  ]) {
    const publisher = await refusingPublisher(body);

    await expect(publisher.publish(publicationRequest())).rejects.toThrow(
      "Keeplore publisher refused the request (422)",
    );
  }
});

async function refusingPublisher(body: unknown) {
  const directory = await mkdtemp(join(tmpdir(), "keeplore-publisher-"));
  temporaryDirectories.push(directory);
  const socketPath = join(directory, "publisher.sock");
  const server = createServer((_request, response) => {
    const serialized = typeof body === "string" ? body : JSON.stringify(body);
    response.writeHead(422, { "content-type": "application/json" });
    response.end(serialized);
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(socketPath, resolve);
  });
  return createUnixSocketKeeploreCandidatePublisher(socketPath);
}

function publicationRequest() {
  return {
    candidate: {
      automatedVerificationPassed: true as const,
      headCommit: "2222222222222222222222222222222222222222",
      visualVerificationPassed: true as const,
    },
    delegationId: "delegation-button-trial",
    operation: "create-or-observe-pull-request" as const,
  };
}

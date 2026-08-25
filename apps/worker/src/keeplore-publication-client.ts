import { request as requestHttp } from "node:http";

import {
  keeploreCandidatePublicationRefusalSchema,
  keeploreCandidatePublicationRequestSchema,
  keeploreCandidatePublicationResultSchema,
  type KeeploreCandidatePublicationRequest,
  type KeeploreCandidatePublicationResult,
} from "@voice-agent/contracts";

export interface KeeploreCandidatePublisher {
  publish(
    request: KeeploreCandidatePublicationRequest,
  ): Promise<KeeploreCandidatePublicationResult>;
}

export function createUnixSocketKeeploreCandidatePublisher(
  socketPath: string,
): KeeploreCandidatePublisher {
  return {
    async publish(request) {
      const response = await postJson(
        socketPath,
        "/publish",
        keeploreCandidatePublicationRequestSchema.parse(request),
      );
      const result = keeploreCandidatePublicationResultSchema.parse(response);
      const expectedBranch = `codex/keeplore-button-${request.delegationId}`;
      if (
        result.headCommit !== request.candidate.headCommit ||
        result.pullRequest.headCommit !== request.candidate.headCommit ||
        result.pullRequest.headBranch !== expectedBranch
      ) {
        throw new Error("Keeplore publisher returned another candidate");
      }
      return result;
    },
  };
}

function postJson(
  socketPath: string,
  path: string,
  body: unknown,
): Promise<unknown> {
  const serialized = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = requestHttp(
      {
        headers: {
          "content-length": Buffer.byteLength(serialized),
          "content-type": "application/json",
        },
        method: "POST",
        path,
        socketPath,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > 64 * 1_024) {
            request.destroy(new Error("Keeplore publisher response exceeded its bound"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          if (response.statusCode !== 200) {
            reject(
              new Error(
                `Keeplore publisher refused the request (${describeRefusalResponse(
                  response.statusCode ?? 0,
                  chunks,
                )})`,
              ),
            );
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(new Error("Keeplore publisher returned invalid JSON"));
          }
        });
      },
    );
    request.once("error", reject);
    request.end(serialized);
  });
}

/**
 * Say what the publisher refused, in the only terms it discloses.
 *
 * The publisher keeps every reason it derived in its own journal on the Agent
 * Host, because those reasons describe production branch rules and App grants.
 * What crosses the socket is the phase that refused, which separates a
 * boundary refusal from a rejected candidate in this Delegation's own failure
 * without naming either. A response carrying no registered code is reported by
 * its status alone rather than by whatever else it said.
 */
function describeRefusalResponse(statusCode: number, chunks: readonly Buffer[]): string {
  const refusal = keeploreCandidatePublicationRefusalSchema.safeParse(
    parseJson(Buffer.concat(chunks).toString("utf8")),
  );
  return refusal.success
    ? `${statusCode}: ${refusal.data.refusal}`
    : `${statusCode}`;
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

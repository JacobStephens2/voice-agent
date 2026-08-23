import { request as requestHttp } from "node:http";

import {
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
                `Keeplore publisher refused the request (${response.statusCode ?? 0})`,
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

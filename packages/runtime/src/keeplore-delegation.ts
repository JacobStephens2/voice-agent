import {
  keeploreDelegationResultSchema,
  type KeeploreDelegationBrief,
  type KeeploreDelegationRecord,
  type KeeploreDelegationResult,
  type KeeploreRegistration,
  type KeeploreWorktree,
} from "@voice-agent/contracts";
import type { KeeploreDelegationStore } from "@voice-agent/durable-store";
import {
  createKeeploreDelegationBrief,
  validateKeeploreDelegationResult,
} from "@voice-agent/policy";
import { request as requestHttp } from "node:http";

export interface KeeploreSubagentRunner {
  execute(input: {
    readonly brief: KeeploreDelegationBrief;
    readonly stopRequested: () => Promise<boolean>;
    readonly worktree: KeeploreWorktree;
  }): Promise<KeeploreDelegationResult>;
  requestStop?(delegationId: string): Promise<void>;
}

export interface KeeploreDelegationRuntime {
  accept(input: { readonly requestId: string }): Promise<KeeploreDelegationRecord>;
  get(taskId: string): Promise<KeeploreDelegationRecord | undefined>;
  list(): Promise<readonly KeeploreDelegationRecord[]>;
  processNext(): Promise<KeeploreDelegationRecord | undefined>;
  requestStop(taskId: string): Promise<KeeploreDelegationRecord | undefined>;
}

export function createKeeploreDelegationRuntime(options: {
  readonly nextId: () => string;
  readonly now: () => string;
  readonly registration: KeeploreRegistration;
  readonly runner: KeeploreSubagentRunner;
  readonly sourceCommit: string;
  readonly store: KeeploreDelegationStore;
}): KeeploreDelegationRuntime {
  return {
    async accept(input) {
      const taskId = options.nextId();
      const delegationId = options.nextId();
      const accepted = createKeeploreDelegationBrief({
        acceptedAt: options.now(),
        delegationId,
        registration: options.registration,
        requestId: input.requestId,
        sourceCommit: options.sourceCommit,
        taskId,
      });
      return options.store.persistAccepted(accepted);
    },
    get: (taskId) => options.store.findByTaskId(taskId),
    list: () => options.store.list(),
    async processNext() {
      const claimed = await options.store.claimNext({ claimedAt: options.now() });
      if (claimed === undefined) return undefined;
      const taskId = claimed.brief.durableTask.id;
      if (claimed.stopRequested) {
        return options.store.complete({
          completedAt: options.now(),
          result: stoppedBeforeExecutionResult(
            claimed.brief,
            claimed.worktree,
            options.now(),
          ),
          taskId,
        });
      }
      let result: KeeploreDelegationResult | undefined;
      try {
        result = keeploreDelegationResultSchema.parse(
          await options.runner.execute({
            brief: claimed.brief,
            stopRequested: () => options.store.stopRequested(taskId),
            worktree: { ...claimed.worktree, state: "running" },
          }),
        );
        validateKeeploreDelegationResult(claimed.brief, result);
      } catch (error) {
        return options.store.complete({
          completedAt: options.now(),
          result: quarantinedResult(
            claimed.brief,
            claimed.worktree,
            result,
            error,
            options.now(),
          ),
          taskId,
        });
      }
      return options.store.complete({
        completedAt: options.now(),
        result,
        taskId,
      });
    },
    async requestStop(taskId) {
      const record = await options.store.requestStop({
        requestedAt: options.now(),
        taskId,
      });
      if (record !== undefined) {
        await options.runner.requestStop?.(record.delegation.brief.delegationId);
      }
      return record;
    },
  };
}

export function createUnixSocketKeeploreSubagentRunner(
  socketPath: string,
): KeeploreSubagentRunner {
  return {
    async execute(input) {
      const response = await postJson(socketPath, "/execute", {
        brief: input.brief,
        worktree: input.worktree,
      });
      return keeploreDelegationResultSchema.parse(response);
    },
    async requestStop(delegationId) {
      await postJson(socketPath, "/stop", { delegationId });
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
          if (length > 1_000_000) {
            request.destroy(new Error("Subagent Runner response exceeded its bound"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (response.statusCode !== 200) {
            reject(new Error(`Subagent Runner refused the request (${response.statusCode ?? 0})`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error("Subagent Runner returned invalid JSON"));
          }
        });
      },
    );
    request.once("error", reject);
    request.end(serialized);
  });
}

function quarantinedResult(
  brief: KeeploreDelegationBrief,
  worktree: KeeploreWorktree,
  parsedResult: KeeploreDelegationResult | undefined,
  error: unknown,
  completedAt: string,
): KeeploreDelegationResult {
  const risk = error instanceof Error ? error.message : "Invalid Subagent result";
  return keeploreDelegationResultSchema.parse({
    branch: worktree.branch,
    changedFiles: parsedResult?.changedFiles ?? [],
    cleanup: {
      eligible: false,
      quarantineReason:
        "Delegation policy rejected the Subagent result; worktree quarantined",
    },
    commits: parsedResult?.commits ?? [],
    completedAt,
    delegationId: brief.delegationId,
    environment: {
      dockerSocket: false,
      identity: "voice-codex",
      operationsBroker: false,
      productionDirectoryWrite: false,
      productionSecrets: false,
      providerLogin: "separate-eligible-subscription",
      sudo: false,
    },
    pullRequest: { state: "none", url: null },
    risks: [risk.slice(0, 300)],
    status: "failed",
    verification: parsedResult?.verification ?? {
      automated: [],
      cardView: {
        afterHash: "unavailable",
        beforeHash: "unavailable",
        unchanged: false,
      },
      computedStyles: [],
      screenshots: [],
    },
    worktree: {
      ...worktree,
      dirty: parsedResult?.worktree.dirty ?? true,
      state: "failed",
    },
  });
}

function stoppedBeforeExecutionResult(
  brief: KeeploreDelegationBrief,
  worktree: KeeploreWorktree,
  completedAt: string,
): KeeploreDelegationResult {
  return keeploreDelegationResultSchema.parse({
    branch: worktree.branch,
    changedFiles: [],
    cleanup: {
      eligible: false,
      quarantineReason: "Stopped before execution; worktree retained",
    },
    commits: [],
    completedAt,
    delegationId: brief.delegationId,
    environment: {
      dockerSocket: false,
      identity: "voice-codex",
      operationsBroker: false,
      productionDirectoryWrite: false,
      productionSecrets: false,
      providerLogin: "separate-eligible-subscription",
      sudo: false,
    },
    pullRequest: { state: "none", url: null },
    risks: [],
    status: "stopped",
    verification: {
      automated: [],
      cardView: {
        afterHash: "not-run",
        beforeHash: "not-run",
        unchanged: true,
      },
      computedStyles: [],
      screenshots: [],
    },
    worktree: { ...worktree, state: "stopped" },
  });
}

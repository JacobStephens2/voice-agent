import Fastify, { type FastifyInstance } from "fastify";

import {
  evidenceRecordProjectionSchema,
  type EvidenceRecordProjection,
} from "@voice-agent/contracts";

export interface EvidenceRecordReader {
  getEvidenceRecord(taskId: string): Promise<EvidenceRecordProjection | undefined>;
}

export function createTaskApi(reader: EvidenceRecordReader): FastifyInstance {
  const api = Fastify({ logger: false });

  api.get<{ Params: { taskId: string } }>(
    "/api/tasks/:taskId",
    async (request, reply) => {
      const record = await reader.getEvidenceRecord(request.params.taskId);
      if (record === undefined) {
        return reply.code(404).send({ error: "Task not found" });
      }

      return evidenceRecordProjectionSchema.parse(record);
    },
  );

  return api;
}

import {
  AgentServer,
  initializeLogger,
  ServerOptions,
} from "@livekit/agents";

export interface LiveKitAgentServerOptions {
  readonly agent: string;
  readonly agentName: string;
  readonly port: number;
}

export function createLiveKitAgentServer(
  options: LiveKitAgentServerOptions,
): AgentServer {
  initializeLogger({ level: "info", pretty: false });
  return new AgentServer(
    new ServerOptions({
      agent: options.agent,
      agentName: options.agentName,
      host: "127.0.0.1",
      numIdleProcesses: 1,
      port: options.port,
      production: true,
    }),
  );
}

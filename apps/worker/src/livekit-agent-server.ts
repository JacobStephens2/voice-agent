import {
  AgentServer,
  initializeLogger,
  ServerOptions,
} from "@livekit/agents";

export interface LiveKitAgentServerOptions {
  readonly agent: string;
  readonly agentName: string;
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly port: number;
  readonly url: string;
}

export function createLiveKitAgentServer(
  options: LiveKitAgentServerOptions,
): AgentServer {
  initializeLogger({ level: "info", pretty: false });
  return new AgentServer(createLiveKitAgentServerOptions(options));
}

export function createLiveKitAgentServerOptions(
  options: LiveKitAgentServerOptions,
): ServerOptions {
  return new ServerOptions({
    agent: options.agent,
    agentName: options.agentName,
    apiKey: options.apiKey,
    apiSecret: options.apiSecret,
    host: "127.0.0.1",
    numIdleProcesses: 1,
    port: options.port,
    production: true,
    wsURL: options.url,
  });
}

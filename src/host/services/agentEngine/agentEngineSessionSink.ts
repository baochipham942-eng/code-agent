import { getSessionManager } from '../infra/sessionManager';

type SessionManager = ReturnType<typeof getSessionManager>;
type AgentEngineSessionSink = Pick<SessionManager, 'addMessageToSession' | 'updateSession'>;

const SUBAGENT_SESSION_SINK: AgentEngineSessionSink = {
  async addMessageToSession() {},
  async updateSession() {},
};

export function getAgentEngineSessionSink(
  executionOrigin: 'subagent' | undefined,
): AgentEngineSessionSink {
  return executionOrigin === 'subagent' ? SUBAGENT_SESSION_SINK : getSessionManager();
}

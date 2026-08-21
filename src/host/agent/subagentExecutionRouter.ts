import { getExternalEngineSubagentExecutor } from './externalEngineSubagentExecutor';
import { runSubagentExecutionWithTrace } from './subagentExecutionTracing';
import { resolveSubagentEngine } from './subagentEngineResolution';
import type { SubagentExecutionRequest, SubagentResult } from './subagentExecutorTypes';

export function routeExternalSubagentExecution(
  request: SubagentExecutionRequest,
): Promise<SubagentResult> | undefined {
  const engine = resolveSubagentEngine(request.config);
  if (engine === 'native') return undefined;
  const externalRequest: SubagentExecutionRequest = {
    ...request,
    config: { ...request.config, engine },
  };
  return runSubagentExecutionWithTrace(
    externalRequest,
    () => getExternalEngineSubagentExecutor().execute(externalRequest),
  );
}

import { createCliConnector } from '../cli/cliConnector';
import { tmeetDescriptor } from '../../../shared/constants/cliConnectorDescriptors';

interface TmeetCliDriverOptions {
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  npmExecutable?: string;
  timeoutMs?: number;
  statusCacheTtlMs?: number;
  statusTimeoutMs?: number;
  now?: () => number;
  modelName?: string;
}

export function createTmeetCliDriver(options: TmeetCliDriverOptions = {}) {
  const modelName = options.modelName?.trim() || 'unknown';
  return createCliConnector({
    ...tmeetDescriptor,
    env: {
      ...tmeetDescriptor.env,
      add: {
        ...tmeetDescriptor.env.add,
        TMEET_MODEL: modelName,
      },
    },
  }, options);
}

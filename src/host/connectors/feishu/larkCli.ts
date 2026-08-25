import { createCliConnector } from '../cli/cliConnector';
import { feishuCliDescriptor } from './feishuCliDescriptor';

interface LarkCliDriverOptions {
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  npmExecutable?: string;
  timeoutMs?: number;
  statusCacheTtlMs?: number;
  statusTimeoutMs?: number;
  now?: () => number;
}

export function createLarkCliDriver(options: LarkCliDriverOptions = {}) {
  return createCliConnector(feishuCliDescriptor, options);
}

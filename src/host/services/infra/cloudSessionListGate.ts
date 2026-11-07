// verify-slotless --clean-account 用：跳过云端会话列表拉取，让共享测试账号也能得到真空白侧栏。
import { createLogger } from './logger';

const logger = createLogger('CloudSessionListGate');
let logged = false;

export function isCloudSessionListSkipped(): boolean {
  if (process.env.CODE_AGENT_SKIP_CLOUD_SESSION_LIST !== '1') return false;
  if (!logged) {
    logged = true;
    logger.info('Cloud session list pull skipped by CODE_AGENT_SKIP_CLOUD_SESSION_LIST=1');
  }
  return true;
}

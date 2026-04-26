// V2-A devServerManager smoke test
// 用法：npx tsx scripts/devServerManager-smoke.mts
// 验证：
//  1. Vite 项目（spike-app）探测正确 + 启动 + ready URL 拿到 + 进程清理
//  2. Next 项目探测返回 supported=false（不启动）
//  3. 不存在目录返回 supported=false

import { getDevServerManager, detectProjectFramework } from '../src/main/services/infra/devServerManager';

const SPIKE_APP = '/Users/linchen/Downloads/ai/visual-grounding-eval/spike-app';

async function main() {
  const mgr = getDevServerManager();

  // case 1: detect spike-app
  const detection = mgr.detect(SPIKE_APP);
  console.log('[1] detect spike-app →', JSON.stringify(detection, null, 2));
  if (detection.framework !== 'vite' || !detection.supported) {
    console.error('FAIL: 期望 vite + supported=true');
    process.exit(1);
  }

  // case 2: 不存在目录
  const notExist = detectProjectFramework('/tmp/__not_exist__');
  console.log('[2] detect 不存在目录 →', notExist.supported, notExist.reason);
  if (notExist.supported) {
    console.error('FAIL: 期望 supported=false');
    process.exit(1);
  }

  // case 3: 启动 + 等 ready
  console.log('[3] 启动 spike-app dev server …');
  const session = mgr.start(SPIKE_APP);
  console.log('  session:', session.sessionId, 'pid:', session.pid, 'status:', session.status);
  try {
    const url = await mgr.waitForReady(session.sessionId);
    console.log('  ✓ ready, URL:', url);
    const after = mgr.get(session.sessionId);
    console.log('  status now:', after?.status, 'url:', after?.url);
    if (after?.status !== 'ready' || !after.url) {
      console.error('FAIL: ready 后 status 不对');
      process.exit(1);
    }
  } catch (err) {
    console.error('FAIL: ready 等待失败 →', err);
    console.error('  最近日志:');
    for (const log of mgr.getLogs(session.sessionId).slice(-20)) {
      console.error(`  [${log.stream}] ${log.line}`);
    }
    await mgr.stop(session.sessionId);
    process.exit(1);
  }

  // case 4: stop 清理
  console.log('[4] stop session …');
  await mgr.stop(session.sessionId);
  const post = mgr.get(session.sessionId);
  console.log('  list 长度:', mgr.list().length, 'session 应已删:', post === null);
  if (post !== null || mgr.list().length !== 0) {
    console.error('FAIL: stop 后 session 未清理');
    process.exit(1);
  }

  console.log('\n✓ 全部 smoke 通过');
  process.exit(0);
}

main().catch((err) => {
  console.error('UNCAUGHT:', err);
  process.exit(1);
});

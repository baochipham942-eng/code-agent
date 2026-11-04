// 最后遗言探针的 real-process 夹具：装上探针后抛一个 uncaught error。
// 由 tests/unit/web/shutdownCause.uncaughtProcess.test.ts 用
// `node --import tsx <本文件>` 拉起；数据目录经 CODE_AGENT_DATA_DIR 注入。
import { installExitCauseProbes } from '../../../../src/web/shutdownCause';

installExitCauseProbes();

// 异步抛出：保证探针已安装、事件循环已转起来，等价真实运行期的崩溃时点。
setTimeout(() => {
  throw new Error('boom-uncaught-probe');
}, 50);

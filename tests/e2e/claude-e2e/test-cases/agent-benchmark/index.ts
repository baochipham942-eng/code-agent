/**
 * Agent Benchmark 测试用例集
 *
 * 来源：GAIA、AgentBench、OSWorld、MultiAgentBench、ChatDev/MetaGPT
 * 用途：测试 Agent 系统能力（工具调用、环境交互、多步执行、错误恢复、多 Agent 协作）
 *
 * 分类：
 * - T2-A (AB-WEB-*): 信息检索与推理 - GAIA Level 2
 * - T2-B (AB-OS-*): 操作系统交互 - AgentBench OS
 * - T2-C (AB-DB-*): 数据库操作 - AgentBench DB
 * - T2-D (AB-GUI-*): GUI 桌面/浏览器操作 - OSWorld
 * - T3-A (CD-*): 软件开发协作 - ChatDev/MetaGPT 风格
 * - T3-B/C (MAB-*): 多 Agent 协作 - MultiAgentBench
 * - 混合 (HYB-*): 综合工作流场景
 */

// T2-A: 信息检索与推理 (GAIA Level 2)
export { default as ABWEB01 } from './AB-WEB-01-data-fetch.js';
export { default as ABWEB02 } from './AB-WEB-02-search-analyze.js';
export { default as ABWEB03 } from './AB-WEB-03-multi-source.js';

// T2-B: 操作系统交互 (AgentBench OS)
export { default as ABOS01 } from './AB-OS-01-user-count.js';
export { default as ABOS02 } from './AB-OS-02-chmod-recursive.js';
export { default as ABOS03 } from './AB-OS-03-find-compress.js';

// T2-C: 数据库操作 (AgentBench DB)
export { default as ABDB01 } from './AB-DB-01-top-salary.js';
export { default as ABDB02 } from './AB-DB-02-high-value-customers.js';
export { default as ABDB03 } from './AB-DB-03-growth-rate.js';

// T2-D: GUI 桌面/浏览器操作 (OSWorld)
export { default as ABGUI01 } from './AB-GUI-01-screenshot-analyze.js';
export { default as ABGUI02 } from './AB-GUI-02-browser-navigation.js';
export { default as ABGUI03 } from './AB-GUI-03-form-interaction.js';

// T3-A: 软件开发协作 (ChatDev/MetaGPT 风格)
export { default as CD01 } from './CD-01-todo-cli.js';
export { default as CD02 } from './CD-02-markdown-converter.js';
export { default as CD03 } from './CD-03-file-sync.js';

// T3-B/C: 多 Agent 协作 (MultiAgentBench)
export { default as MABC01 } from './MAB-C01-pair-programming.js';
export { default as MABC02 } from './MAB-C02-bug-hunt.js';
export { default as MABR01 } from './MAB-R01-research-proposal.js';

// 混合场景
export { default as HYB01 } from './HYB-01-github-issue-fix.js';
export { default as HYB02 } from './HYB-02-api-sdk-generator.js';
export { default as HYB03 } from './HYB-03-codebase-analysis.js';

// 按类别导出
import ABWEB01 from './AB-WEB-01-data-fetch.js';
import ABWEB02 from './AB-WEB-02-search-analyze.js';
import ABWEB03 from './AB-WEB-03-multi-source.js';
import ABOS01 from './AB-OS-01-user-count.js';
import ABOS02 from './AB-OS-02-chmod-recursive.js';
import ABOS03 from './AB-OS-03-find-compress.js';
import ABDB01 from './AB-DB-01-top-salary.js';
import ABDB02 from './AB-DB-02-high-value-customers.js';
import ABDB03 from './AB-DB-03-growth-rate.js';
import ABGUI01 from './AB-GUI-01-screenshot-analyze.js';
import ABGUI02 from './AB-GUI-02-browser-navigation.js';
import ABGUI03 from './AB-GUI-03-form-interaction.js';
import CD01 from './CD-01-todo-cli.js';
import CD02 from './CD-02-markdown-converter.js';
import CD03 from './CD-03-file-sync.js';
import MABC01 from './MAB-C01-pair-programming.js';
import MABC02 from './MAB-C02-bug-hunt.js';
import MABR01 from './MAB-R01-research-proposal.js';
import HYB01 from './HYB-01-github-issue-fix.js';
import HYB02 from './HYB-02-api-sdk-generator.js';
import HYB03 from './HYB-03-codebase-analysis.js';

/** 所有 Agent Benchmark 测试用例 */
export const agentBenchmarkCases = [
  // T2-A: 信息检索与推理
  ABWEB01,
  ABWEB02,
  ABWEB03,
  // T2-B: 操作系统交互
  ABOS01,
  ABOS02,
  ABOS03,
  // T2-C: 数据库操作
  ABDB01,
  ABDB02,
  ABDB03,
  // T2-D: GUI 桌面/浏览器操作
  ABGUI01,
  ABGUI02,
  ABGUI03,
  // T3-A: 软件开发协作
  CD01,
  CD02,
  CD03,
  // T3-B/C: 多 Agent 协作
  MABC01,
  MABC02,
  MABR01,
  // 混合场景
  HYB01,
  HYB02,
  HYB03,
];

/** 快速验证集（12 题） */
export const quickValidationCases = [
  ABWEB01, // 信息检索
  ABWEB02,
  ABOS01,  // 系统操作
  ABOS02,
  ABDB01,  // 数据库
  ABDB02,
  ABGUI01, // GUI 操作
  CD01,    // 软件协作
  CD02,
  MABC01,  // 多 Agent
  MABR01,
  HYB01,   // 混合场景
];

/** 按难度分组 */
export const casesByComplexity = {
  L2: [ABWEB01, ABWEB02, ABOS01, ABOS02, ABOS03, ABDB01, ABDB02, ABGUI01, MABC01],
  L3: [ABWEB03, ABDB03, ABGUI02, ABGUI03, CD01, CD02, CD03, MABC02, MABR01, HYB01, HYB02, HYB03],
};

/** 按类别分组 */
export const casesByCategory = {
  web: [ABWEB01, ABWEB02, ABWEB03],
  os: [ABOS01, ABOS02, ABOS03],
  database: [ABDB01, ABDB02, ABDB03],
  gui: [ABGUI01, ABGUI02, ABGUI03],
  collaboration: [CD01, CD02, CD03],
  multiAgent: [MABC01, MABC02, MABR01],
  hybrid: [HYB01, HYB02, HYB03],
};

export default agentBenchmarkCases;

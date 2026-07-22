import type { RuntimeContext } from '../runtimeContext';
import { getToolSearchService } from '../../../services/toolSearch';
import { isCoreToolName, resolveToolAlias } from '../../../services/toolSearch/deferredTools';
import { createLogger } from '../../../services/infra/logger';

const logger = createLogger('ContextAssembly');

type RuntimeForDeferredToolPreload = Pick<
  RuntimeContext,
  'enableToolDeferredLoading' | 'executionIntent' | 'messages' | 'goalMode' | 'turn'
>;

// 意图正则守则（issue #322）：\b 对 . / - 等非单词字符也成立，"notes.md" 能穿过
// \bnotes\b；裸词缺 \b 会被子串误命中（"express" 含 "press"）。误触的代价不止暴露
// 无关工具——工具表突变会整体打掉 provider 前缀缓存（PR#321 审计附录实测归因）。
// 所以：常见文件名词必须要求明确 app/动作语境或排除扩展名形态（(?!\.\w)），
// 英文单词一律带 \b，高频 CLI 语境（git/svn checkout）用 lookbehind 排除。
const COMPUTER_INTENT_RE =
  /\bcomputer[\s_-]?use\b|\bcomputer surface\b|\bscreenshot\b(?!\.\w)|\bscreen\s+capture\b|\bcapture\s+(?:the\s+)?(?:current\s+)?screen\b|\b(?:current\s+)?desktop\s+(?:context|browser|window|app)\b|frontmost|notepad|\b(?:apple\s+)?notes\s+app\b|\bopen\s+(?:the\s+)?notes\b|桌面|当前屏幕|屏幕|截屏|截图|鼠标|键盘|点击|双击|右键|滚动|拖拽|打开(?:记事本|备忘录|应用|窗口|app)/i;

const MEETING_DESKTOP_CONTEXT_RE =
  /腾讯会议|tencent\s*meeting|会议内容|当前会议|正在(?:开的|进行的)?会议|meeting\s+(?:content|notes?|transcript)\b(?!\.\w)|current\s+meeting/i;

const BROWSER_INTERACTIVE_INTENT_RE =
  /\bbrowser[\s_-]?action\b|\bbrowser automation\b|\bplaywright\b|托管浏览器|浏览器自动化|登录|登陆|\bsign[\s-]?in\b|\blog[\s-]?in\b|表单|填表|填写|输入账号|输入密码|按钮|点击|\bclick\b|\bpress\b|提交|\bsubmit\b|多页|翻页|分页|下一页|上传|下载|视觉验证|动态页面|弹窗|\bdropdown\b|下拉|选择框|(?<!git\s)(?<!svn\s)\bcheckout\b|支付/i;

const DYNAMIC_WORKFLOW_INTENT_RE =
  /(?:^|\s)\/workflow\b|\bdynamic[-\s]?workflow\b|\bscript(?:ed)?[-\s]?workflow\b|\bprogrammatic[-\s]?workflow\b|\bDynamicWorkflow\b|命令式(?:工作流|workflow)|脚本(?:化|式)?工作流|代码化工作流/i;

const WORKFLOW_ORCHESTRATE_INTENT_RE =
  /\bworkflow_orchestrate\b|\bWorkflowOrchestrate\b|\blegacy[-\s]?workflow\b|\bdeclarative[-\s]?workflow\b|\bcowork\b|\bco[-\s]?work\b|\bmulti[-\s]?agent\b|\bdag\b(?!\.\w)|多\s*agent|多代理|多智能体|子代理|子\s*agent|子阶段|协作(?:任务|流程|模式|审查)|工作流(?:编排|子阶段)?/i;

const MCP_MANAGEMENT_INTENT_RE =
  /\bMCPUnified\b|\bmcp[_\s-]*(?:add|server|config|configure|setup|connect|status|tool|resource)\b|\badd\s+(?:an?\s+)?mcp\b|\bconfigure\s+(?:an?\s+)?mcp\b|配置\s*mcp|添加\s*mcp|新增\s*mcp|连接\s*mcp|管理\s*mcp|mcp\s*(?:配置|服务器|工具|资源|状态)/i;

// 简报/用户直接点名 spawn_agent（组队主理人首轮的固定脚手架就是这样）——不预载会白花一个 ToolSearch 来回。
const SPAWN_AGENT_INTENT_RE = /\bspawn_agent\b/i;

function getLatestUserText(runtime: RuntimeForDeferredToolPreload): string {
  for (let index = runtime.messages.length - 1; index >= 0; index -= 1) {
    const message = runtime.messages[index];
    if (message?.role === 'user' && message.visibility !== 'rewound') {
      return message.content || '';
    }
  }
  return '';
}

export function getDeferredToolsToPreloadForTurn(
  runtime: RuntimeForDeferredToolPreload,
): string[] {
  if (!runtime.enableToolDeferredLoading) {
    return [];
  }

  const tools = new Set<string>();
  const intent = runtime.executionIntent;
  const userText = getLatestUserText(runtime);

  // Goal 模式：预加载 attempt_completion，让模型每轮都能调它申请退出（触发闸1 验证）
  if (runtime.goalMode) {
    tools.add('attempt_completion');
    // Swarm goal（P4）：allowSwarm 时同时预加载 workflow，让模型能扇出并行子 agent。
    // advance 发起的无人值守 goal run（allowSwarm=false）不预加载——无人监督不扇出。
    if (runtime.goalMode.allowsSwarm()) {
      tools.add('workflow');
    }
  }

  if (
    intent?.browserSessionMode === 'desktop' ||
    COMPUTER_INTENT_RE.test(userText) ||
    MEETING_DESKTOP_CONTEXT_RE.test(userText)
  ) {
    tools.add('Computer');
  }

  if (intent?.browserSessionMode === 'managed' && intent.allowBrowserAutomation !== false) {
    tools.add('Browser');
    tools.add('Computer');
  } else if (intent?.allowBrowserAutomation !== false && BROWSER_INTERACTIVE_INTENT_RE.test(userText)) {
    tools.add('Browser');
  }

  if (DYNAMIC_WORKFLOW_INTENT_RE.test(userText)) {
    tools.add('workflow');
  } else if (WORKFLOW_ORCHESTRATE_INTENT_RE.test(userText)) {
    tools.add('workflow_orchestrate');
  }

  if (MCP_MANAGEMENT_INTENT_RE.test(userText)) {
    tools.add('MCPUnified');
  }

  if (SPAWN_AGENT_INTENT_RE.test(userText)) {
    tools.add('spawn_agent');
  }

  // Active skill invocation：把本轮命中的 skill 的 allowedTools 里的非 core 工具预加载，
  // 否则 deferred-loading 模式下这些 skill 专属工具（如 propose_role）对模型不可见，
  // 模型会退而用 core 工具（如 Edit）绕过 skill 设计的流程（验收实证：edit-role 没出确认卡）。
  // 边界内 core 工具本就常驻，无需预加载；模式前缀（Bash(git:*)）取括号前的工具名。
  if (runtime.turn.skillToolBoundary) {
    for (const allowed of runtime.turn.skillToolBoundary.allowedTools) {
      const baseName = allowed.split('(')[0]?.trim();
      if (!baseName) continue;
      const canonical = resolveToolAlias(baseName);
      if (!isCoreToolName(canonical)) {
        tools.add(canonical);
      }
    }
  }

  return Array.from(tools);
}

export function preloadDeferredToolsForTurn(
  runtime: RuntimeForDeferredToolPreload,
): string[] {
  const toolNames = getDeferredToolsToPreloadForTurn(runtime);
  if (toolNames.length === 0) {
    return [];
  }

  const service = getToolSearchService();
  const loaded = new Set<string>();

  for (const toolName of toolNames) {
    try {
      const result = service.selectTool(toolName);
      for (const loadedTool of result.loadedTools) {
        loaded.add(loadedTool);
      }
    } catch (error) {
      logger.debug('[ContextAssembly] Deferred tool preload skipped', {
        toolName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const loadedTools = Array.from(loaded);
  if (loadedTools.length > 0) {
    logger.info('[ContextAssembly] Pre-loaded deferred tools for turn', {
      tools: loadedTools,
    });
  }
  return loadedTools;
}

// ============================================================================
// Desktop Action Claim Gate
// ============================================================================
// Prevents a text-only response from presenting desktop actions or observations
// as facts when no Computer/Desktop tool call happened in the current run.

const DESKTOP_REQUEST_RE =
  /\bcomputer[\s_-]?use\b|\bcomputer surface\b|\bdesktop\b|\bscreenshot\b|\bscreen\b|桌面|屏幕|截图|截屏|鼠标|键盘|点击|双击|右键|滚动|拖拽|打开(?:记事本|备忘录|应用|窗口|app)|关掉|关闭|当前会议|会议内容|会议记录|腾讯会议|飞书会议|voov|tencentmeeting|imeeting|notes|textedit|spotlight/i;

const DESKTOP_OBSERVATION_RE =
  /(?:屏幕上|窗口|前台|后台|最前面|背后|当前打开|当前显示|显示的是|看到了|没看到|没有看到|找到|找到了|没有找到|搜索结果|Spotlight|腾讯会议|飞书会议|TextEdit|Notes|备忘录|记事本|最小化|最大化|打开了|关掉了|关闭了|点击了|进入了|登录|没有安装)/i;

const UNSUPPORTED_ACTION_CLAIM_RE =
  /(?:我|已|已经|刚才|现在|先)?\s*(?:打开|关掉|关闭|搜索|查找|点击|双击|右键|滚动|拖拽|切到|进入|最大化|最小化|登录|截图|看了|看一下|看到了|找到|找到了|没有找到|没有看到|没看到|没有安装)/i;

const HONEST_UNCERTAINTY_RE =
  /(?:还没有|尚未|不能|无法|没法|未能|没有实际|没有调用|需要先|必须先|请先).{0,24}(?:打开|搜索|点击|看到|确认|查看|操作|调用|工具|截图)/i;

const DESKTOP_CLAIM_GATE_REPAIR_PROMPT = [
  '<desktop-action-claim-guard>',
  'Your previous text response claimed desktop/app actions or visual observations without any Computer/Desktop tool call in this run.',
  'Do not state that you opened, searched, clicked, maximized, found, or inspected an app unless a tool result proves it.',
  'Next, either call the appropriate Computer tool to gather evidence, or answer honestly that you have not verified the desktop state yet.',
  '</desktop-action-claim-guard>',
].join('\n');

const DESKTOP_CLAIM_GATE_WARNING =
  '【桌面证据不足】本轮没有成功的 Computer/桌面工具调用，所以下面的桌面操作或屏幕观察不能当作已执行事实。\n\n';

export interface DesktopActionClaimGateInput {
  latestUserMessage?: string;
  assistantContent: string;
  toolCallCount: number;
  iterations: number;
  hasDesktopEvidence?: boolean;
}

export type DesktopActionClaimGateResult =
  | { action: 'none'; content: string; reason?: undefined; repairPrompt?: undefined }
  | { action: 'retry'; content: string; reason: string; repairPrompt: string }
  | { action: 'warn'; content: string; reason: string; repairPrompt?: undefined };

export function applyDesktopActionClaimGate(
  input: DesktopActionClaimGateInput,
): DesktopActionClaimGateResult {
  const content = input.assistantContent || '';
  if (!content.trim()) {
    return { action: 'none', content };
  }

  if (input.toolCallCount > 0 || input.hasDesktopEvidence) {
    return { action: 'none', content };
  }

  const latestUserMessage = input.latestUserMessage || '';
  const desktopContext =
    DESKTOP_REQUEST_RE.test(latestUserMessage) ||
    DESKTOP_OBSERVATION_RE.test(content);

  if (!desktopContext) {
    return { action: 'none', content };
  }

  if (HONEST_UNCERTAINTY_RE.test(content)) {
    return { action: 'none', content };
  }

  const claimsDesktopAction =
    DESKTOP_OBSERVATION_RE.test(content) &&
    UNSUPPORTED_ACTION_CLAIM_RE.test(content);

  if (!claimsDesktopAction) {
    return { action: 'none', content };
  }

  const reason = 'desktop_action_claim_without_tool_evidence';
  if (input.iterations <= 1) {
    return {
      action: 'retry',
      content,
      reason,
      repairPrompt: DESKTOP_CLAIM_GATE_REPAIR_PROMPT,
    };
  }

  return {
    action: 'warn',
    content: DESKTOP_CLAIM_GATE_WARNING + content,
    reason,
  };
}

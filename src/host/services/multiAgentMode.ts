// Multi-agent mode 全局开关。
//
// 主 agent 通过 BrowserTool action="set_multi_agent_mode" 调用切换；状态影响：
// - ComputerSurface.observe(targetApp) 在多 agent 模式下截屏裁剪到 targetApp 的 windowFrame，
//   防止子 agent 看到对方桌面活动
// - computerUse coordinate-only 路径在多 agent 模式下附 warning（建议改 targetApp+axPath）
//
// 不放 BrowserPool 是因为 ComputerSurface 也要读这个状态——独立模块避免跨域
// 依赖的循环风险。

let enabled = false;

export function setMultiAgentMode(value: boolean): void {
  enabled = value === true;
}

export function isMultiAgentMode(): boolean {
  return enabled;
}

export function resetMultiAgentModeForTests(): void {
  enabled = false;
}

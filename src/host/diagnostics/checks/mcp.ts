// ============================================================================
// Doctor Check - MCP Server 状态
// 5 态映射：
//   - connected   → pass
//   - lazy        → skip（懒加载未触发，不计入 fail）
//   - connecting  → warn（卡在中间态）
//   - disconnected→ warn（用户主动断开或冷启动未连接）
//   - error       → fail
// 注意：本检查**不**主动触发 ensureConnected，避免 doctor 产生副作用。
// ============================================================================

import { getMCPClient } from '../../mcp/mcpClient';
import type { MCPServerStatus } from '../../mcp/types';
import type { DoctorItem, DoctorStatus } from '../types';

const STATUS_MAP: Record<MCPServerStatus, { status: DoctorStatus; label: string; suggestion?: string }> = {
  connected: { status: 'pass', label: '已连接' },
  lazy: {
    status: 'skip',
    label: '懒加载（尚未触发首次调用）',
  },
  connecting: {
    status: 'warn',
    label: '连接中',
    suggestion: '如果长时间停在此状态，检查 server 是否真的在启动',
  },
  disconnected: {
    status: 'warn',
    label: '未连接',
    suggestion: '若希望立即可用，可在 MCP 面板手动连接',
  },
  error: {
    status: 'fail',
    label: '连接错误',
    suggestion: '检查 server 命令、网络、依赖；详细错误见 details',
  },
};

export function checkMcpServers(): DoctorItem[] {
  const client = getMCPClient();
  const states = client.getServerStates();

  if (states.length === 0) {
    return [
      {
        category: 'mcp',
        name: 'MCP servers',
        status: 'skip',
        message: '尚未配置任何 MCP server',
      },
    ];
  }

  return states.map((state): DoctorItem => {
    const mapping = STATUS_MAP[state.status];
    const detailParts: string[] = [];
    if (state.toolCount > 0) detailParts.push(`${state.toolCount} tools`);
    if (state.resourceCount > 0) detailParts.push(`${state.resourceCount} resources`);
    if (state.error) detailParts.push(`error: ${state.error}`);

    return {
      category: 'mcp',
      name: state.config.name,
      status: mapping.status,
      message: detailParts.length > 0
        ? `${mapping.label} · ${detailParts.join(' · ')}`
        : mapping.label,
      details: state.error,
      suggestion: mapping.suggestion,
    };
  });
}

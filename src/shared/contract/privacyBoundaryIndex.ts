// ============================================================================
// Privacy Boundary Index Contract
// ============================================================================

import type { AuthInventoryItemId } from './authInventory';
import type { PermissionBoundaryId } from './permissionBoundary';
import type { VoiceTranscriptionPathId } from './voiceTranscription';

export type PrivacyBoundaryIndexId =
  | 'desktop'
  | 'voice'
  | 'channel'
  | 'mcp_plugin'
  | 'model_provider'
  | 'memory'
  | 'telemetry_diagnostic';

export interface PrivacyBoundaryActionTarget {
  tab: string;
  label: string;
}

export interface PrivacyBoundaryIndexEntry {
  id: PrivacyBoundaryIndexId;
  title: string;
  summary: string;
  data: string[];
  storage: string;
  cloud: string;
  revoke: string;
  actionTarget: PrivacyBoundaryActionTarget;
  permissionBoundaryIds: PermissionBoundaryId[];
  voicePathIds?: VoiceTranscriptionPathId[];
  authItemIds?: AuthInventoryItemId[];
}

export const PRIVACY_BOUNDARY_INDEX: Record<PrivacyBoundaryIndexId, PrivacyBoundaryIndexEntry> = {
  desktop: {
    id: 'desktop',
    title: '桌面采集与控制',
    summary: '应用截图、窗口文本、辅助功能点击和系统音频是四条不同边界。',
    data: ['屏幕截图', '窗口标题和文本', '辅助功能树', '系统音频状态'],
    storage: '截图和派生摘要保存在本机缓存或当前会话附件。',
    cloud: '只有在云端模型参与桌面任务时，截图或摘要才会进入模型上下文。',
    revoke: '去 macOS 系统设置撤回屏幕录制/辅助功能权限，或关闭 Appshots/Native Desktop。',
    actionTarget: { tab: 'appshots', label: '打开应用截图设置' },
    permissionBoundaryIds: ['desktop.screen_capture', 'desktop.accessibility', 'desktop.audio.system'],
  },
  voice: {
    id: 'voice',
    title: '语音和转写',
    summary: '聊天语音、voice paste、桌面音频、通道语音分别声明 provider、本地/云端和日志策略。',
    data: ['麦克风音频', '临时音频文件', '转写文本', 'provider 和耗时元数据'],
    storage: '音频只应临时落盘；转写文本进入当前会话、剪贴板动作或通道回复。',
    cloud: '取决于转写路径；Groq、智谱、Kimi 等外部 provider 会出云端。',
    revoke: '撤回麦克风权限，或在对应语音/通道/provider 设置里关闭云端路径。',
    actionTarget: { tab: 'privacy', label: '查看语音转写边界' },
    permissionBoundaryIds: ['desktop.audio.microphone', 'desktop.audio.system', 'channel.connector'],
    voicePathIds: ['chat_voice', 'voice_paste', 'desktop_audio', 'channel_audio'],
  },
  channel: {
    id: 'channel',
    title: '外部通道',
    summary: 'HTTP API、飞书、Telegram 的消息面和凭证面要分开看。',
    data: ['入站消息', 'sender/chat 元数据', '附件', 'channel token/app secret'],
    storage: '通道配置进 secure storage；默认 local-redact 后再进入会话。',
    cloud: '回复会发回对应通道；模型推理可能使用脱敏后的消息内容。',
    revoke: '禁用或删除通道账号，或去外部平台撤销 token。',
    actionTarget: { tab: 'channels', label: '打开通道设置' },
    permissionBoundaryIds: ['channel.connector'],
    authItemIds: ['channel.token'],
  },
  mcp_plugin: {
    id: 'mcp_plugin',
    title: 'MCP 和插件',
    summary: 'MCP server、插件命令、hook 和外部服务风险需要在详情页可见。',
    data: ['server/tool 名称', '工具参数', 'resources', '插件 manifest', 'hook 上下文'],
    storage: 'MCP/plugin 配置保存在本地；OAuth/token 走对应 auth inventory。',
    cloud: '取决于 server/plugin；openWorld 和外部服务能力默认按高风险表达。',
    revoke: '禁用 server/plugin，撤回 OAuth，或删除 env/header secret。',
    actionTarget: { tab: 'mcp', label: '打开 MCP 设置' },
    permissionBoundaryIds: ['mcp.server_tool', 'plugin.extension'],
    authItemIds: ['mcp.env', 'mcp.header', 'mcp.oauth'],
  },
  model_provider: {
    id: 'model_provider',
    title: '模型供应商和 API Key',
    summary: '模型 provider key 是凭证边界；prompt/工具结果是否出云端是数据边界。',
    data: ['provider API key', 'base URL', '模型请求上下文', '工具摘要'],
    storage: 'API key 进入 secure storage / Keychain；普通设置读取只显示 configured。',
    cloud: '使用云端模型时，prompt、工具摘要和必要附件会发给 provider。',
    revoke: '删除 provider key，切换本地模型，或去服务商控制台轮换。',
    actionTarget: { tab: 'model', label: '打开模型设置' },
    permissionBoundaryIds: ['provider.api_key'],
    authItemIds: ['provider.api_key'],
  },
  memory: {
    id: 'memory',
    title: 'Memory',
    summary: '记忆默认本地持久化；进入模型上下文时才可能出云端。',
    data: ['记忆文本', '关联会话', '更新时间', '压缩摘要'],
    storage: '保存在本机数据库或用户配置的记忆目录。',
    cloud: '被选入模型上下文的记忆片段会随当前 provider 出云端。',
    revoke: '在记忆设置里删除、导出或关闭相关记忆。',
    actionTarget: { tab: 'memory', label: '打开记忆设置' },
    permissionBoundaryIds: ['memory.local'],
  },
  telemetry_diagnostic: {
    id: 'telemetry_diagnostic',
    title: '遥测和诊断包',
    summary: '自动遥测是 metadata；失败诊断包和用户导出是单独边界。',
    data: ['运行元数据', '错误分类', '版本指纹', 'scrub 后的 raw payload'],
    storage: '诊断包先生成在本机；上传前 scrub。',
    cloud: '自动 telemetry 不含完整 prompt/代码内容；诊断上传需要单独说明。',
    revoke: '关闭遥测；诊断包上传保持显式动作。',
    actionTarget: { tab: 'privacy', label: '打开隐私防线' },
    permissionBoundaryIds: ['telemetry.diagnostic'],
  },
};

export const PRIVACY_BOUNDARY_INDEX_IDS = Object.keys(PRIVACY_BOUNDARY_INDEX) as PrivacyBoundaryIndexId[];

export function listPrivacyBoundaryIndexEntries(): PrivacyBoundaryIndexEntry[] {
  return PRIVACY_BOUNDARY_INDEX_IDS.map((id) => PRIVACY_BOUNDARY_INDEX[id]);
}

/**
 * 紧凑按钮文案：去掉 actionTarget.label 的「打开」前缀（本索引是 zh 数据契约，
 * zh 耦合的文本处理放在数据同文件，渲染层不持有中文逻辑）。
 */
export function getPrivacyBoundaryActionShortLabel(entry: PrivacyBoundaryIndexEntry): string {
  return entry.actionTarget.label.replace(/^打开/, '');
}

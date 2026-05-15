// ============================================================================
// GeneralSettings - Permission Mode + Subagent Inheritance Settings Tab
// ============================================================================
//
// 三个区段：
//   1. 主 Agent 权限模式（default / acceptEdits / bypassPermissions）
//   2. 子 Agent 权限继承策略（strict-inherit / child-narrow / independent）
//   3. 用户级 deny / ask / allow 规则编辑
//
// P6 grandfathering：检测 _legacyPermissions=true 时弹一次性 banner，
// 用户 ack 后写 inheritanceMigrationAcked=true。
// ============================================================================

import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  CheckCircle,
  Info,
  ListChecks,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  X,
} from 'lucide-react';
import { IPC_CHANNELS, IPC_DOMAINS } from '@shared/ipc';
import type { AppSettings } from '@shared/contract';
import { isWebMode } from '../../../../utils/platform';
import { WebModeBanner } from '../WebModeBanner';
import { SettingsDetails, SettingsPage, SettingsSection } from '../SettingsLayout';
import ipcService from '../../../../services/ipcService';
import { toast } from '../../../../hooks/useToast';

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions';
export type InheritanceMode = 'strict-inherit' | 'child-narrow' | 'independent';

export type PermissionRiskLevel = 'low' | 'medium' | 'high';

interface PermissionModeMetadata {
  id: PermissionMode;
  title: string;
  description: string;
  operationScope: string;
  riskLevel: PermissionRiskLevel;
  riskLabel: string;
}

export interface PermissionModeRow extends PermissionModeMetadata {
  selected: boolean;
  actionLabel: string;
}

interface InheritanceModeMetadata {
  id: InheritanceMode;
  title: string;
  description: string;
  statusLabel: string;
  exposureLabel: string;
  recommended?: boolean;
  warning?: string;
}

export interface InheritanceManagementRow extends InheritanceModeMetadata {
  selected: boolean;
  actionLabel: string;
}

export interface PermissionRuleInput {
  denyRules: string;
  askRules: string;
  allowRules: string;
}

export interface PermissionRuleSummary {
  denyCount: number;
  askCount: number;
  allowCount: number;
  totalCount: number;
  highestPriority: string;
}

const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions'];
const INHERITANCE_MODES: InheritanceMode[] = ['strict-inherit', 'child-narrow', 'independent'];

const PERMISSION_MODE_METADATA: PermissionModeMetadata[] = [
  {
    id: 'default',
    title: '安全模式',
    description: '执行写入、命令、网络操作前需要确认，适合日常工作。',
    operationScope: '写入 / 命令 / 网络前询问',
    riskLevel: 'low',
    riskLabel: '低风险',
  },
  {
    id: 'acceptEdits',
    title: '自动编辑',
    description: '自动接受文件编辑，命令和外部访问仍保留确认。',
    operationScope: '编辑自动通过，命令仍询问',
    riskLevel: 'medium',
    riskLabel: '中风险',
  },
  {
    id: 'bypassPermissions',
    title: 'YOLO 模式',
    description: '跳过所有权限检查，只适合完全可信的隔离环境。',
    operationScope: '跳过权限检查',
    riskLevel: 'high',
    riskLabel: '高风险',
  },
];

const INHERITANCE_MODE_METADATA: InheritanceModeMetadata[] = [
  {
    id: 'strict-inherit',
    title: '严格继承',
    description: '子 Agent = 父真子集；tools 取交集、deny 取并集、mode 取更严。',
    statusLabel: '推荐',
    exposureLabel: '永不扩张',
    recommended: true,
  },
  {
    id: 'child-narrow',
    title: '子可窄化',
    description: '父 mode 宽松时允许子在父集合内窄化 allow，其余等同严格继承。',
    statusLabel: '受控放宽',
    exposureLabel: '父集合内调整',
  },
  {
    id: 'independent',
    title: '独立模式',
    description: '子 Agent 自管 ask/allow，仅强制 deny 并集、topology 和用户 deny。',
    statusLabel: '谨慎使用',
    exposureLabel: '可能扩张',
    warning: '建议只给 e2e 测试或老 CLI grandfathering 使用。',
  },
];

export function parsePermissionRules(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function buildPermissionModeRows(activeMode: PermissionMode): PermissionModeRow[] {
  return PERMISSION_MODE_METADATA.map((mode) => ({
    ...mode,
    selected: mode.id === activeMode,
    actionLabel: mode.id === activeMode ? '当前模式' : '切换',
  }));
}

export function buildInheritanceRows(activeInheritance: InheritanceMode): InheritanceManagementRow[] {
  return INHERITANCE_MODE_METADATA.map((mode) => ({
    ...mode,
    selected: mode.id === activeInheritance,
    actionLabel: mode.id === activeInheritance ? '当前策略' : '使用',
  }));
}

export function buildPermissionRuleSummary(input: PermissionRuleInput): PermissionRuleSummary {
  const denyCount = parsePermissionRules(input.denyRules).length;
  const askCount = parsePermissionRules(input.askRules).length;
  const allowCount = parsePermissionRules(input.allowRules).length;

  return {
    denyCount,
    askCount,
    allowCount,
    totalCount: denyCount + askCount + allowCount,
    highestPriority: denyCount > 0 ? 'Deny' : askCount > 0 ? 'Ask' : allowCount > 0 ? 'Allow' : '无规则',
  };
}

function isPermissionMode(value: string): value is PermissionMode {
  return PERMISSION_MODES.includes(value as PermissionMode);
}

function isInheritanceMode(value: string): value is InheritanceMode {
  return INHERITANCE_MODES.includes(value as InheritanceMode);
}

function getPermissionIcon(mode: PermissionMode): React.ReactNode {
  if (mode === 'acceptEdits') return <ShieldAlert className="h-4 w-4" />;
  if (mode === 'bypassPermissions') return <ShieldOff className="h-4 w-4" />;
  return <Shield className="h-4 w-4" />;
}

function getRiskClass(riskLevel: PermissionRiskLevel): string {
  if (riskLevel === 'high') return 'border-red-500/30 bg-red-500/10 text-red-300';
  if (riskLevel === 'medium') return 'border-amber-500/30 bg-amber-500/10 text-amber-300';
  return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
}

function getRuleRows(ruleSummary: PermissionRuleSummary) {
  return [
    {
      label: 'Deny',
      caption: '拒绝，最高优先级',
      value: ruleSummary.denyCount,
      color: 'text-red-300',
    },
    {
      label: 'Ask',
      caption: '需要确认',
      value: ruleSummary.askCount,
      color: 'text-amber-300',
    },
    {
      label: 'Allow',
      caption: '允许，最低优先级',
      value: ruleSummary.allowCount,
      color: 'text-emerald-300',
    },
  ];
}

export const GeneralSettings: React.FC = () => {
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');
  const [inheritance, setInheritance] = useState<InheritanceMode>('strict-inherit');
  const [denyRules, setDenyRules] = useState<string>('');
  const [askRules, setAskRules] = useState<string>('');
  const [allowRules, setAllowRules] = useState<string>('');
  const [showMigrationBanner, setShowMigrationBanner] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState(true);

  const permissionModeRows = useMemo(
    () => buildPermissionModeRows(permissionMode),
    [permissionMode],
  );
  const inheritanceRows = useMemo(
    () => buildInheritanceRows(inheritance),
    [inheritance],
  );
  const ruleSummary = useMemo(
    () => buildPermissionRuleSummary({ denyRules, askRules, allowRules }),
    [allowRules, askRules, denyRules],
  );
  const activeModeRow = permissionModeRows.find((row) => row.selected) ?? permissionModeRows[0];
  const activeInheritanceRow = inheritanceRows.find((row) => row.selected) ?? inheritanceRows[0];

  useEffect(() => {
    const load = async () => {
      try {
        const currentMode = await ipcService.invoke(IPC_CHANNELS.PERMISSION_GET_MODE);
        if (isPermissionMode(currentMode)) {
          setPermissionMode(currentMode);
        }

        const settings = await ipcService.invokeDomain<AppSettings | undefined>(IPC_DOMAINS.SETTINGS, 'get');
        const perms = settings?.permissions;
        if (perms?.inheritance && isInheritanceMode(perms.inheritance)) {
          setInheritance(perms.inheritance);
        }
        if (perms?.deny) setDenyRules(perms.deny.join('\n'));
        if (perms?.ask) setAskRules(perms.ask.join('\n'));
        if (perms?.allow) setAllowRules(perms.allow.join('\n'));

        if (perms?._legacyPermissions && !perms?.inheritanceMigrationAcked) {
          setShowMigrationBanner(true);
        }
      } catch (error) {
        toast.error('加载权限设置失败: ' + (error instanceof Error ? error.message : '未知错误'));
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, []);

  const handlePermissionModeChange = async (newMode: PermissionMode) => {
    try {
      const success = await ipcService.invoke(IPC_CHANNELS.PERMISSION_SET_MODE, newMode);
      if (success) {
        setPermissionMode(newMode);
      }
    } catch (error) {
      toast.error('设置权限模式失败: ' + (error instanceof Error ? error.message : '未知错误'));
    }
  };

  const persistPermissions = async (patch: Partial<AppSettings['permissions']>) => {
    try {
      await ipcService.invokeDomain(IPC_DOMAINS.SETTINGS, 'set', {
        permissions: patch,
      } as Partial<AppSettings>);
    } catch (error) {
      toast.error('保存权限设置失败: ' + (error instanceof Error ? error.message : '未知错误'));
      throw error;
    }
  };

  const handleInheritanceChange = async (newInheritance: InheritanceMode) => {
    setInheritance(newInheritance);
    await persistPermissions({
      inheritance: newInheritance,
      inheritanceMigrationAcked: true,
    });
    setShowMigrationBanner(false);
    toast.success('继承策略已保存');
  };

  const handleRulesBlur = async (kind: 'deny' | 'ask' | 'allow', text: string) => {
    const rules = parsePermissionRules(text);
    await persistPermissions({ [kind]: rules });
    toast.success(`${kind} 规则已保存 (${rules.length} 条)`);
  };

  const handleAckMigration = async () => {
    setShowMigrationBanner(false);
    await persistPermissions({ inheritanceMigrationAcked: true });
  };

  return (
    <SettingsPage
      title="权限与安全"
      description="管理 Agent 执行敏感操作时的权限检查，以及子 Agent 的权限继承策略。"
    >
      <WebModeBanner />

      {showMigrationBanner && (
        <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 p-3">
          <div className="flex items-start gap-2">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-400" />
            <div className="min-w-0 flex-1">
              <h4 className="text-sm font-medium text-blue-300">安全模型升级提示</h4>
              <p className="mt-1 text-xs leading-relaxed text-blue-400/80">
                子 Agent 默认启用「严格继承」，防止 plan → coder、reviewer → coder 等工作流绕过权限。
                如需保留旧行为请选择「独立模式」。
              </p>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleAckMigration}
                  disabled={isWebMode()}
                  className="rounded border border-blue-500/40 bg-blue-500/10 px-2 py-1 text-xs text-blue-200 hover:bg-blue-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  知道了
                </button>
                <a
                  href="https://github.com/your-org/code-agent/releases"
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-blue-400 underline hover:text-blue-300"
                >
                  查看 release notes
                </a>
              </div>
            </div>
            <button
              type="button"
              onClick={handleAckMigration}
              disabled={isWebMode()}
              className="text-blue-300/60 hover:text-blue-200 disabled:cursor-not-allowed disabled:opacity-50"
              aria-label="关闭"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      <SettingsSection
        title="权限控制面"
        description="日常只需要看当前模式、风险级别、继承策略和用户规则数量。"
      >
        <div className="rounded-lg border border-zinc-700/70 bg-zinc-900/60">
          <div className="grid grid-cols-2 gap-px border-b border-zinc-700/60 bg-zinc-800/80 lg:grid-cols-4">
            {[
              ['当前模式', activeModeRow.title, activeModeRow.operationScope],
              ['风险级别', activeModeRow.riskLabel, activeModeRow.description],
              ['子 Agent', activeInheritanceRow.title, activeInheritanceRow.exposureLabel],
              ['用户规则', String(ruleSummary.totalCount), `最高优先级：${ruleSummary.highestPriority}`],
            ].map(([label, value, caption]) => (
              <div key={label} className="bg-zinc-900/80 px-3 py-3">
                <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-zinc-500">{label}</div>
                <div className="mt-1 truncate text-lg font-semibold text-zinc-100">{value}</div>
                <div className="mt-0.5 truncate text-[11px] text-zinc-500" title={caption}>
                  {caption}
                </div>
              </div>
            ))}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-xs">
              <thead className="border-b border-zinc-700/60 bg-zinc-900/80 text-[11px] uppercase tracking-[0.08em] text-zinc-500">
                <tr>
                  <th className="px-3 py-2 font-medium">主 Agent 权限模式</th>
                  <th className="px-3 py-2 font-medium">状态</th>
                  <th className="px-3 py-2 font-medium">权限行为</th>
                  <th className="px-3 py-2 font-medium">风险</th>
                  <th className="px-3 py-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/80">
                {isLoading ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-center text-zinc-500">加载中...</td>
                  </tr>
                ) : (
                  permissionModeRows.map((row) => (
                    <tr
                      key={row.id}
                      className={row.selected ? 'bg-blue-500/10' : 'bg-zinc-900/40 hover:bg-zinc-800/60'}
                    >
                      <td className="px-3 py-3 align-middle">
                        <div className="flex items-start gap-2">
                          <span className={`rounded border p-1.5 ${getRiskClass(row.riskLevel)}`}>
                            {getPermissionIcon(row.id)}
                          </span>
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-zinc-200">{row.title}</div>
                            <div className="mt-1 max-w-[340px] text-zinc-500">{row.description}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3 align-middle">
                        {row.selected ? (
                          <span className="inline-flex items-center gap-1 rounded border border-blue-500/30 bg-blue-500/10 px-2 py-1 text-blue-300">
                            <CheckCircle className="h-3 w-3" />
                            当前启用
                          </span>
                        ) : (
                          <span className="inline-flex rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-zinc-400">
                            可切换
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-3 align-middle text-zinc-300">{row.operationScope}</td>
                      <td className="px-3 py-3 align-middle">
                        <span className={`inline-flex rounded border px-2 py-1 ${getRiskClass(row.riskLevel)}`}>
                          {row.riskLabel}
                        </span>
                      </td>
                      <td className="px-3 py-3 align-middle">
                        <div className="flex justify-end">
                          <button
                            type="button"
                            disabled={isWebMode() || row.selected}
                            onClick={() => handlePermissionModeChange(row.id)}
                            className="rounded border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {row.actionLabel}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {permissionMode === 'bypassPermissions' && (
          <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-3">
            <div className="flex items-start gap-2">
              <ShieldOff className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
              <div>
                <h4 className="text-sm font-medium text-red-300">YOLO 模式已启用</h4>
                <p className="mt-1 text-xs text-red-400/70">
                  权限检查已跳过。Agent 可以直接执行文件写入、命令执行等操作，请只在可信隔离环境中使用。
                </p>
              </div>
            </div>
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        title="子 Agent 权限继承"
        description="控制 plan → coder、reviewer → coder、CI subagent 等场景下，子 Agent 是否继承父权限约束。"
      >
        <div className="rounded-lg border border-zinc-700/70 bg-zinc-900/60">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-xs">
              <thead className="border-b border-zinc-700/60 bg-zinc-900/80 text-[11px] uppercase tracking-[0.08em] text-zinc-500">
                <tr>
                  <th className="px-3 py-2 font-medium">继承策略</th>
                  <th className="px-3 py-2 font-medium">状态</th>
                  <th className="px-3 py-2 font-medium">暴露面</th>
                  <th className="px-3 py-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/80">
                {isLoading ? (
                  <tr>
                    <td colSpan={4} className="px-3 py-6 text-center text-zinc-500">加载中...</td>
                  </tr>
                ) : (
                  inheritanceRows.map((row) => (
                    <tr
                      key={row.id}
                      className={row.selected ? 'bg-emerald-500/10' : 'bg-zinc-900/40 hover:bg-zinc-800/60'}
                    >
                      <td className="px-3 py-3 align-top">
                        <div className="flex items-start gap-2">
                          <span className="rounded border border-zinc-700 bg-zinc-800 p-1.5 text-zinc-300">
                            <Bot className="h-4 w-4" />
                          </span>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-zinc-200">{row.title}</span>
                              {row.recommended ? (
                                <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[11px] text-emerald-300">
                                  推荐
                                </span>
                              ) : null}
                            </div>
                            <div className="mt-1 max-w-[420px] text-zinc-500">{row.description}</div>
                            {row.warning ? (
                              <div className="mt-1 flex items-center gap-1 text-amber-300/90">
                                <AlertTriangle className="h-3 w-3" />
                                <span>{row.warning}</span>
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3 align-top">
                        <span className={`inline-flex rounded border px-2 py-1 ${
                          row.selected
                            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                            : 'border-zinc-700 bg-zinc-800 text-zinc-400'
                        }`}
                        >
                          {row.selected ? '当前策略' : row.statusLabel}
                        </span>
                      </td>
                      <td className="px-3 py-3 align-top text-zinc-300">{row.exposureLabel}</td>
                      <td className="px-3 py-3 align-top">
                        <div className="flex justify-end">
                          <button
                            type="button"
                            disabled={isWebMode() || row.selected}
                            onClick={() => handleInheritanceChange(row.id)}
                            className="rounded border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {row.actionLabel}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </SettingsSection>

      <SettingsDetails
        title="用户级权限规则"
        description="每行一条 Tool(glob) 规则，同时影响主 Agent 和所有子 Agent。"
        defaultOpen={ruleSummary.totalCount > 0}
        actions={(
          <span className="inline-flex items-center gap-1 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300">
            <ListChecks className="h-3 w-3" />
            {ruleSummary.totalCount} 条
          </span>
        )}
      >
        {isLoading ? (
          <div className="text-xs text-zinc-500">加载中...</div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
              {getRuleRows(ruleSummary).map((row) => (
                <div key={row.label} className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
                  <div className={`text-sm font-medium ${row.color}`}>{row.label}</div>
                  <div className="mt-1 text-lg font-semibold text-zinc-100">{row.value}</div>
                  <div className="text-[11px] text-zinc-500">{row.caption}</div>
                </div>
              ))}
            </div>

            <div className="rounded-lg border border-zinc-800 bg-zinc-950/30 p-3 text-xs text-zinc-500">
              示例：
              <code className="mx-1 rounded bg-zinc-800 px-1 py-0.5 text-[11px] text-zinc-300">Bash(rm -rf *)</code>
              <code className="mx-1 rounded bg-zinc-800 px-1 py-0.5 text-[11px] text-zinc-300">Write(/etc/*)</code>
              焦点离开输入框时自动保存，重启 Agent 后生效。
            </div>

            <div className="grid grid-cols-1 gap-3">
              <div>
                <label className="mb-1 block text-xs text-red-300">Deny（拒绝，最高优先级）</label>
                <textarea
                  value={denyRules}
                  onChange={(event) => setDenyRules(event.target.value)}
                  onBlur={(event) => handleRulesBlur('deny', event.target.value)}
                  disabled={isWebMode()}
                  placeholder={'Bash(rm -rf *)\nWrite(/etc/*)\nNetwork(*)'}
                  rows={4}
                  className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-xs text-zinc-200 outline-none focus:border-red-500/50 disabled:cursor-not-allowed disabled:opacity-50"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-amber-300">Ask（询问）</label>
                <textarea
                  value={askRules}
                  onChange={(event) => setAskRules(event.target.value)}
                  onBlur={(event) => handleRulesBlur('ask', event.target.value)}
                  disabled={isWebMode()}
                  placeholder={'Bash(git push *)\nWrite(*.env)'}
                  rows={3}
                  className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-xs text-zinc-200 outline-none focus:border-amber-500/50 disabled:cursor-not-allowed disabled:opacity-50"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-emerald-300">Allow（允许，最低优先级）</label>
                <textarea
                  value={allowRules}
                  onChange={(event) => setAllowRules(event.target.value)}
                  onBlur={(event) => handleRulesBlur('allow', event.target.value)}
                  disabled={isWebMode()}
                  placeholder={'Read(*)\nBash(ls *)\nBash(git status)'}
                  rows={3}
                  className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-xs text-zinc-200 outline-none focus:border-emerald-500/50 disabled:cursor-not-allowed disabled:opacity-50"
                />
              </div>
            </div>
          </div>
        )}
      </SettingsDetails>

      <SettingsDetails
        title="权限语义说明"
        description="把低频解释折叠在高级区，避免干扰普通用户。"
      >
        <div className="grid grid-cols-1 gap-3 text-xs text-zinc-400 md:grid-cols-2">
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/30 p-3">
            <div className="mb-1 flex items-center gap-2 text-zinc-200">
              <ShieldCheck className="h-4 w-4 text-emerald-300" />
              权限优先级
            </div>
            <p>Deny 优先于 Ask，Ask 优先于 Allow；用户 deny 会覆盖 Agent 与子 Agent 的局部配置。</p>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/30 p-3">
            <div className="mb-1 flex items-center gap-2 text-zinc-200">
              <Bot className="h-4 w-4 text-blue-300" />
              子 Agent 安全边界
            </div>
            <p>默认严格继承，适合生活和工作助手场景；独立模式只保留给迁移、测试或强控制环境。</p>
          </div>
        </div>
      </SettingsDetails>
    </SettingsPage>
  );
};

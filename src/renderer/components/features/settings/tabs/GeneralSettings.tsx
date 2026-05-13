// ============================================================================
// GeneralSettings - Permission Mode + Subagent Inheritance Settings Tab
// ============================================================================
//
// 三个区段：
//   1. 权限模式（default / acceptEdits / bypassPermissions） — 旧实现
//   2. Subagent 权限继承策略（strict-inherit / child-narrow / independent） — P5 新增
//   3. 用户级 deny / ask / allow 规则编辑 — P5 新增
//
// 设计依据：plan §4.3 settings schema、§4.2 默认 strict-inherit。
// P6 grandfathering：检测 _legacyPermissions=true 时弹一次性 banner，
// 用户 ack 后写 inheritanceMigrationAcked=true。
// ============================================================================

import React, { useState, useEffect } from 'react';
import { CheckCircle, Shield, ShieldOff, ShieldAlert, Info, X } from 'lucide-react';
import { IPC_CHANNELS, IPC_DOMAINS } from '@shared/ipc';
import type { AppSettings } from '@shared/contract';
import { isWebMode } from '../../../../utils/platform';
import { WebModeBanner } from '../WebModeBanner';
import { SettingsPage } from '../SettingsLayout';
import ipcService from '../../../../services/ipcService';
import { toast } from '../../../../hooks/useToast';

// 权限模式类型
type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions';
type InheritanceMode = 'strict-inherit' | 'child-narrow' | 'independent';

interface SafetyModeOption {
  id: PermissionMode;
  icon: React.ReactNode;
  title: string;
  description: string;
  riskLevel: 'low' | 'medium' | 'high';
}

interface InheritanceOption {
  id: InheritanceMode;
  title: string;
  description: string;
  recommended?: boolean;
  warning?: string;
}

// ============================================================================
// Component
// ============================================================================

export const GeneralSettings: React.FC = () => {
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');
  const [inheritance, setInheritance] = useState<InheritanceMode>('strict-inherit');
  const [denyRules, setDenyRules] = useState<string>('');
  const [askRules, setAskRules] = useState<string>('');
  const [allowRules, setAllowRules] = useState<string>('');
  const [showMigrationBanner, setShowMigrationBanner] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        // 1. permissionMode
        const currentMode = await ipcService.invoke(IPC_CHANNELS.PERMISSION_GET_MODE);
        if (currentMode && ['default', 'acceptEdits', 'bypassPermissions'].includes(currentMode)) {
          setPermissionMode(currentMode as PermissionMode);
        }

        // 2. 完整 settings 读取（拿 inheritance / deny / ask / allow / _legacy 标记）
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SETTINGS 域 'get' 类型在 codebase 其他位置也用 any（见 AppearanceSettings）
        const settings = (await ipcService.invokeDomain<any>(IPC_DOMAINS.SETTINGS, 'get')) as AppSettings | undefined;
        const perms = settings?.permissions;
        if (perms?.inheritance) setInheritance(perms.inheritance);
        if (perms?.deny) setDenyRules(perms.deny.join('\n'));
        if (perms?.ask) setAskRules(perms.ask.join('\n'));
        if (perms?.allow) setAllowRules(perms.allow.join('\n'));

        // P6 grandfathering：legacy 配置且未 ack 才显示 banner
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

  // 持久化 permissions partial（共享给 inheritance / deny / ask / allow 三个 setter）
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
    // 用户显式选择 inheritance 等同于 ack 升级 banner
    await persistPermissions({
      inheritance: newInheritance,
      inheritanceMigrationAcked: true,
    });
    setShowMigrationBanner(false);
    toast.success('继承策略已保存');
  };

  const parseRules = (text: string): string[] =>
    text
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

  const handleRulesBlur = async (kind: 'deny' | 'ask' | 'allow', text: string) => {
    const arr = parseRules(text);
    await persistPermissions({ [kind]: arr });
    toast.success(`${kind} 规则已保存 (${arr.length} 条)`);
  };

  const handleAckMigration = async () => {
    setShowMigrationBanner(false);
    await persistPermissions({ inheritanceMigrationAcked: true });
  };

  const safetyModeOptions: SafetyModeOption[] = [
    {
      id: 'default',
      icon: <Shield className="w-5 h-5" />,
      title: '安全模式',
      description: '执行写入、命令、网络操作前需要确认',
      riskLevel: 'low',
    },
    {
      id: 'acceptEdits',
      icon: <ShieldAlert className="w-5 h-5" />,
      title: '自动编辑',
      description: '自动接受文件编辑，其他操作需要确认',
      riskLevel: 'medium',
    },
    {
      id: 'bypassPermissions',
      icon: <ShieldOff className="w-5 h-5" />,
      title: 'YOLO 模式',
      description: '跳过所有权限检查，适合可信环境',
      riskLevel: 'high',
    },
  ];

  const inheritanceOptions: InheritanceOption[] = [
    {
      id: 'strict-inherit',
      title: '严格继承（推荐）',
      description: '子 Agent = 父真子集；tools 取交集、deny 取并集、mode 取更严。永不扩张。',
      recommended: true,
    },
    {
      id: 'child-narrow',
      title: '子可窄化',
      description:
        '父 mode 宽松（default/acceptEdits）时允许子在父集合内放宽 allow；其余等同严格继承。',
    },
    {
      id: 'independent',
      title: '独立（不推荐）',
      description:
        '子 Agent 自管 ask/allow，仅强制 deny 并集 + topology + 用户 deny。建议仅在 e2e 测试 / 老 CLI grandfathering 时使用。',
      warning: '可能让 reviewer 派 coder 等场景绕过安全约束',
    },
  ];

  return (
    <SettingsPage
      title="权限与安全"
      description="控制 Agent 执行敏感操作时的权限检查行为，以及子 Agent 的权限继承策略。"
    >
      <WebModeBanner />

      {/* P6 grandfathering banner */}
      {showMigrationBanner && (
        <div className="mb-4 p-3 rounded-lg bg-blue-500/10 border border-blue-500/30">
          <div className="flex items-start gap-2">
            <Info className="w-4 h-4 text-blue-400 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <h4 className="text-sm font-medium text-blue-300">安全模型升级提示</h4>
              <p className="text-xs text-blue-400/80 mt-1 leading-relaxed">
                我们升级了子 Agent 的安全模型：默认启用「严格继承」（子 = 父真子集），
                防止 plan → coder、reviewer → coder 等工作流绕过权限。
                如需保留旧行为请选择「独立」模式（不推荐）。详见 release notes。
              </p>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleAckMigration}
                  disabled={isWebMode()}
                  className="px-2 py-1 text-xs rounded border border-blue-500/40 bg-blue-500/10 text-blue-200 hover:bg-blue-500/20"
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
              className="text-blue-300/60 hover:text-blue-200"
              aria-label="关闭"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Section 1: 权限模式 */}
      <div className="mb-6">
        <h3 className="text-sm font-medium text-zinc-200 mb-2">主 Agent 权限模式</h3>
        {isLoading ? (
          <div className="text-xs text-zinc-500">加载中...</div>
        ) : (
          <div className="grid grid-cols-1 gap-2">
            {safetyModeOptions.map((option) => {
              const isActive = permissionMode === option.id;
              const riskColors = {
                low: { border: 'border-green-500/50', bg: 'bg-green-500/10', text: 'text-green-400' },
                medium: { border: 'border-amber-500/50', bg: 'bg-amber-500/10', text: 'text-amber-400' },
                high: { border: 'border-red-500/50', bg: 'bg-red-500/10', text: 'text-red-400' },
              };
              const colors = riskColors[option.riskLevel];

              return (
                <button
                  key={option.id}
                  disabled={isWebMode()}
                  onClick={() => handlePermissionModeChange(option.id)}
                  className={`relative p-3 rounded-lg border text-left transition-all duration-200 ${
                    isActive
                      ? `${colors.border} ${colors.bg}`
                      : 'border-zinc-700 bg-zinc-800 hover:border-zinc-600 hover:bg-zinc-800'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div
                      className={`p-2 rounded-lg ${
                        isActive ? `${colors.bg} ${colors.text}` : 'bg-zinc-700 text-zinc-400'
                      }`}
                    >
                      {option.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h4
                          className={`text-sm font-medium ${
                            isActive ? 'text-zinc-200' : 'text-zinc-400'
                          }`}
                        >
                          {option.title}
                        </h4>
                        {isActive && <CheckCircle className={`w-4 h-4 ${colors.text}`} />}
                      </div>
                      <p className="text-xs text-zinc-500 mt-0.5">{option.description}</p>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {permissionMode === 'bypassPermissions' && (
          <div className="mt-3 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
            <div className="flex items-start gap-2">
              <ShieldOff className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
              <div>
                <h4 className="text-sm font-medium text-red-300">YOLO 模式已启用</h4>
                <p className="text-xs text-red-400/70 mt-1">
                  所有权限检查已跳过。Agent 可以直接执行文件写入、命令执行等操作，请确保在可信环境中使用。
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Section 2: Subagent 权限继承 */}
      <div className="mb-6">
        <h3 className="text-sm font-medium text-zinc-200 mb-1">子 Agent 权限继承</h3>
        <p className="text-xs text-zinc-500 mb-2">
          控制 plan → coder、reviewer → coder、CI subagent 等场景下，
          子 Agent 是否继承父的权限约束。
        </p>
        {isLoading ? (
          <div className="text-xs text-zinc-500">加载中...</div>
        ) : (
          <div className="grid grid-cols-1 gap-2">
            {inheritanceOptions.map((option) => {
              const isActive = inheritance === option.id;
              return (
                <label
                  key={option.id}
                  className={`relative p-3 rounded-lg border cursor-pointer transition-all duration-200 ${
                    isActive
                      ? 'border-emerald-500/50 bg-emerald-500/10'
                      : 'border-zinc-700 bg-zinc-800 hover:border-zinc-600'
                  } ${isWebMode() ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  <div className="flex items-start gap-3">
                    <input
                      type="radio"
                      name="inheritance"
                      value={option.id}
                      checked={isActive}
                      disabled={isWebMode()}
                      onChange={() => handleInheritanceChange(option.id)}
                      className="mt-1"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h4 className="text-sm font-medium text-zinc-200">{option.title}</h4>
                        {option.recommended && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300">
                            推荐
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-zinc-400 mt-1 leading-relaxed">
                        {option.description}
                      </p>
                      {option.warning && (
                        <p className="text-xs text-amber-400/80 mt-1">⚠️ {option.warning}</p>
                      )}
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
        )}
      </div>

      {/* Section 3: 用户级规则 deny/ask/allow */}
      <div>
        <h3 className="text-sm font-medium text-zinc-200 mb-1">用户级权限规则</h3>
        <p className="text-xs text-zinc-500 mb-2">
          每行一条规则，使用 Tool(glob) 语法。例：
          <code className="px-1 mx-0.5 bg-zinc-800 rounded text-[10px]">Bash(rm -rf *)</code>
          <code className="px-1 mx-0.5 bg-zinc-800 rounded text-[10px]">Write(/etc/*)</code>。
          规则同时对主 Agent 和所有子 Agent 生效（plan §4.5 UserConfigSource）。
        </p>
        {isLoading ? (
          <div className="text-xs text-zinc-500">加载中...</div>
        ) : (
          <div className="space-y-3">
            <div>
              <label className="text-xs text-red-300 mb-1 block">Deny（拒绝，最高优先级）</label>
              <textarea
                value={denyRules}
                onChange={(e) => setDenyRules(e.target.value)}
                onBlur={(e) => handleRulesBlur('deny', e.target.value)}
                disabled={isWebMode()}
                placeholder={'Bash(rm -rf *)\nWrite(/etc/*)\nNetwork(*)'}
                rows={4}
                className="w-full px-2 py-1.5 rounded border border-zinc-700 bg-zinc-900 text-xs font-mono text-zinc-200 focus:border-red-500/50 outline-none"
              />
            </div>
            <div>
              <label className="text-xs text-amber-300 mb-1 block">Ask（询问）</label>
              <textarea
                value={askRules}
                onChange={(e) => setAskRules(e.target.value)}
                onBlur={(e) => handleRulesBlur('ask', e.target.value)}
                disabled={isWebMode()}
                placeholder={'Bash(git push *)\nWrite(*.env)'}
                rows={3}
                className="w-full px-2 py-1.5 rounded border border-zinc-700 bg-zinc-900 text-xs font-mono text-zinc-200 focus:border-amber-500/50 outline-none"
              />
            </div>
            <div>
              <label className="text-xs text-green-300 mb-1 block">Allow（允许，最低优先级）</label>
              <textarea
                value={allowRules}
                onChange={(e) => setAllowRules(e.target.value)}
                onBlur={(e) => handleRulesBlur('allow', e.target.value)}
                disabled={isWebMode()}
                placeholder={'Read(*)\nBash(ls *)\nBash(git status)'}
                rows={3}
                className="w-full px-2 py-1.5 rounded border border-zinc-700 bg-zinc-900 text-xs font-mono text-zinc-200 focus:border-green-500/50 outline-none"
              />
            </div>
            <p className="text-[10px] text-zinc-600">
              焦点离开输入框时自动保存。重启 Agent 后生效。
            </p>
          </div>
        )}
      </div>
    </SettingsPage>
  );
};

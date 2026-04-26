// ============================================================================
// ConversationSettings — 对话相关全局设置 tab
// ============================================================================
// B+ IA 调整：Routing / Browser 这种"配一次跑一年"的设置从 ChatInput 工具栏
// 移除，归到 Settings 这里。每个用户在第一次需要时配一次，后面默认值就走。
// Live Preview 已挪到 TitleBar 顶栏（跟工作目录绑定）。

import React from 'react';
import { GitBranch, Globe, Info } from 'lucide-react';
import type {
  BrowserSessionMode,
  ConversationRoutingMode,
} from '@shared/contract/conversationEnvelope';
import { useComposerStore } from '../../../../stores/composerStore';

const ROUTING_OPTIONS: Array<{ value: ConversationRoutingMode; label: string; hint: string }> = [
  { value: 'auto', label: 'Auto', hint: '路由器按任务复杂度自动选模型（默认）' },
  { value: 'direct', label: 'Direct', hint: '直接用当前选中的模型，不走路由' },
  { value: 'parallel', label: 'Parallel', hint: '并行调多个模型，交叉验证产物' },
];

const BROWSER_OPTIONS: Array<{ value: BrowserSessionMode; label: string; hint: string }> = [
  { value: 'none', label: 'Off', hint: '禁用浏览器工具（默认）' },
  { value: 'managed', label: 'Managed', hint: '使用独立 Playwright Chromium，user-data-dir 隔离' },
  { value: 'desktop', label: 'Desktop', hint: '接管系统 Chrome，复用现有登录态' },
];

export const ConversationSettings: React.FC = () => {
  const routingMode = useComposerStore((s) => s.routingMode);
  const setRoutingMode = useComposerStore((s) => s.setRoutingMode);
  const browserSessionMode = useComposerStore((s) => s.browserSessionMode);
  const setBrowserSessionMode = useComposerStore((s) => s.setBrowserSessionMode);

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Routing */}
      <section>
        <div className="flex items-center gap-2 mb-2">
          <GitBranch className="w-4 h-4 text-zinc-400" />
          <h3 className="text-sm font-medium text-zinc-200">Routing</h3>
        </div>
        <p className="text-xs text-zinc-500 mb-3">模型路由策略 — 决定每条消息怎么被分发给后端模型</p>
        <div className="grid grid-cols-3 gap-2">
          {ROUTING_OPTIONS.map((opt) => {
            const selected = routingMode === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setRoutingMode(opt.value)}
                className={`flex flex-col items-start gap-1 px-3 py-2 rounded-lg border transition-colors text-left ${
                  selected
                    ? 'border-primary-500/40 bg-primary-500/15 text-primary-200'
                    : 'border-white/[0.08] bg-white/[0.02] text-zinc-300 hover:border-white/[0.16] hover:bg-white/[0.04]'
                }`}
              >
                <span className="text-sm font-medium">{opt.label}</span>
                <span className="text-[11px] text-zinc-500 leading-relaxed">{opt.hint}</span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Browser */}
      <section>
        <div className="flex items-center gap-2 mb-2">
          <Globe className="w-4 h-4 text-zinc-400" />
          <h3 className="text-sm font-medium text-zinc-200">Browser</h3>
        </div>
        <p className="text-xs text-zinc-500 mb-3">浏览器工具集成模式 — 决定 agent 怎么操作浏览器</p>
        <div className="grid grid-cols-3 gap-2">
          {BROWSER_OPTIONS.map((opt) => {
            const selected = browserSessionMode === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setBrowserSessionMode(opt.value)}
                className={`flex flex-col items-start gap-1 px-3 py-2 rounded-lg border transition-colors text-left ${
                  selected
                    ? 'border-primary-500/40 bg-primary-500/15 text-primary-200'
                    : 'border-white/[0.08] bg-white/[0.02] text-zinc-300 hover:border-white/[0.16] hover:bg-white/[0.04]'
                }`}
              >
                <span className="text-sm font-medium">{opt.label}</span>
                <span className="text-[11px] text-zinc-500 leading-relaxed">{opt.hint}</span>
              </button>
            );
          })}
        </div>
      </section>

      <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-zinc-800/40 border border-white/[0.06]">
        <Info className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0 mt-0.5" />
        <p className="text-[11px] text-zinc-500 leading-relaxed">
          这两组设置是会话级配置，多数人配一次后无需再调。Browser readiness 状态、修复入口、
          Live Preview 已挪到顶栏 / 任务面板 / 命令面板，不再占 ChatInput 工具栏视觉。
        </p>
      </div>
    </div>
  );
};

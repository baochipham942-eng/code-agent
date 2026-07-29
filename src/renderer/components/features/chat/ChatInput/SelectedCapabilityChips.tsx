import { Sparkles, X } from 'lucide-react';
import { useWorkbenchCapabilityRegistry } from '../../../../hooks/useWorkbenchCapabilityRegistry';
import { useComposerStore } from '../../../../stores/composerStore';
import { getWorkbenchCapabilityTitle } from '../../../../utils/workbenchPresentation';
import type { WorkbenchCapabilityRegistryItem } from '../../../../utils/workbenchCapabilityRegistry';
import { useI18n } from '../../../../hooks/useI18n';

const MAX_VISIBLE_CAPABILITIES = 8;

// 导出给底栏连接器图标行（MountedConnectorIcons）复用同一份取消挂载逻辑
export function removeCapability(capability: WorkbenchCapabilityRegistryItem): void {
  const store = useComposerStore.getState();
  store.setTurnCapabilityScopeMode('manual');
  if (capability.kind === 'skill') {
    store.setSelectedSkillIds(store.selectedSkillIds.filter((id) => id !== capability.id));
  } else if (capability.kind === 'connector') {
    store.setSelectedConnectorIds(store.selectedConnectorIds.filter((id) => id !== capability.id));
  } else {
    store.setSelectedMcpServerIds(store.selectedMcpServerIds.filter((id) => id !== capability.id));
  }
}

// Delete/Backspace 与文件 chip、pin chip 对齐：chip 聚焦后键盘可删
function isChipRemoveKey(event: React.KeyboardEvent): boolean {
  return event.key === 'Delete' || event.key === 'Backspace';
}

export function SelectedCapabilityChips() {
  const { t } = useI18n();
  const { skills } = useWorkbenchCapabilityRegistry();
  // 只展示当轮 skill：连接器/MCP 是会话级挂载，归底栏 MountedConnectorIcons（权限徽章旁），
  // 不进输入框内的 chip 区（2026-07-29 拍板：框内 chip = 单轮生效，框外 = 会话级）。
  const selectedCapabilities = skills.filter((capability) => capability.selected);
  if (selectedCapabilities.length === 0) return null;

  const visibleCapabilities = selectedCapabilities.slice(0, MAX_VISIBLE_CAPABILITIES);
  const overflowCount = selectedCapabilities.length - visibleCapabilities.length;

  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5 px-2" data-testid="selected-capability-chips">
      {visibleCapabilities.map((capability) => {
        const title = capability.blockedReason?.detail || getWorkbenchCapabilityTitle(capability, { locale: 'zh' });
        const dimmed = !capability.available || capability.blocked;
        const removeAria = t.selectedCapabilityChips.removeAria.replace('{name}', capability.label);
        return (
          // chip 本体只承载展示与焦点：整颗点击即删有误点风险（2026-07-29 统一 chip 交互），
          // 删除收敛到 hover 浮现的 × 按钮与键盘 Delete/Backspace。
          <div
            key={capability.key}
            role="group"
            tabIndex={0}
            title={title}
            aria-label={capability.label}
            onKeyDown={(event) => {
              if (!isChipRemoveKey(event)) return;
              event.preventDefault();
              removeCapability(capability);
            }}
            className={`group inline-flex max-w-[220px] cursor-default items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs transition-colors ${
              dimmed
                ? 'border-zinc-800 bg-zinc-900/50 text-zinc-500'
                : 'border-zinc-700 bg-zinc-800/70 text-zinc-200 hover:border-zinc-500'
            }`}
          >
            {/* 类型图标（WorkBuddy 式）：skill 一眼可辨，不用名字首字母猜类型 */}
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-emerald-400" aria-hidden />
            <span className="truncate">{capability.label}</span>
            <button
              type="button"
              tabIndex={-1}
              onClick={() => removeCapability(capability)}
              aria-label={removeAria}
              className="-mr-0.5 shrink-0 rounded-full p-0.5 text-zinc-400 opacity-0 transition-opacity hover:bg-zinc-600/70 hover:text-zinc-100 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
            >
              <X className="h-3 w-3" aria-hidden />
            </button>
          </div>
        );
      })}
      {overflowCount > 0 && <span className="text-[11px] text-zinc-500">+{overflowCount}</span>}
    </div>
  );
}

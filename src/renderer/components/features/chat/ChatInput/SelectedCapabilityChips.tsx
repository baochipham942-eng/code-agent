import { X } from 'lucide-react';
import { RoleInitialAvatar } from '../../expert/RoleInitialAvatar';
import { useWorkbenchCapabilityRegistry } from '../../../../hooks/useWorkbenchCapabilityRegistry';
import { useComposerStore } from '../../../../stores/composerStore';
import { getWorkbenchCapabilityTitle } from '../../../../utils/workbenchPresentation';
import type { WorkbenchCapabilityRegistryItem } from '../../../../utils/workbenchCapabilityRegistry';
import { useI18n } from '../../../../hooks/useI18n';

const MAX_VISIBLE_CAPABILITIES = 8;

function removeCapability(capability: WorkbenchCapabilityRegistryItem): void {
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

export function SelectedCapabilityChips() {
  const { t } = useI18n();
  const { skills, connectors, mcpServers } = useWorkbenchCapabilityRegistry();
  const selectedCapabilities = [...skills, ...connectors, ...mcpServers].filter((capability) => capability.selected);
  if (selectedCapabilities.length === 0) return null;

  const visibleCapabilities = selectedCapabilities.slice(0, MAX_VISIBLE_CAPABILITIES);
  const overflowCount = selectedCapabilities.length - visibleCapabilities.length;

  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5 px-2" data-testid="selected-capability-chips">
      {visibleCapabilities.map((capability) => {
        const title = capability.blockedReason?.detail || getWorkbenchCapabilityTitle(capability, { locale: 'zh' });
        const dimmed = !capability.available || capability.blocked;
        return (
          <button
            key={capability.key}
            type="button"
            onClick={() => removeCapability(capability)}
            title={title}
            aria-label={t.selectedCapabilityChips.removeAria.replace('{name}', capability.label)}
            className={`group inline-flex max-w-[220px] items-center gap-1 rounded-full border px-1 py-0.5 text-xs transition-colors ${
              dimmed
                ? 'border-zinc-800 bg-zinc-900/50 text-zinc-500'
                : 'border-zinc-700 bg-zinc-800/70 text-zinc-200 hover:border-zinc-500 hover:bg-zinc-700/70'
            }`}
          >
            <span className="relative h-4 w-4 shrink-0">
              <RoleInitialAvatar roleId={capability.id} name={capability.label} className="h-4 w-4 text-[10px] transition-opacity group-hover:opacity-0" />
              <X className="absolute inset-0 h-4 w-4 p-0.5 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
            </span>
            <span className="truncate">{capability.label}</span>
          </button>
        );
      })}
      {overflowCount > 0 && <span className="text-[11px] text-zinc-500">+{overflowCount}</span>}
    </div>
  );
}

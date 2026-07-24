// ============================================================================
// RoleSecurityTab - 专家详情「安全」页
// ============================================================================
// 两档授权方式：跟随通用设置 / 为这位专家单独设置（后者展开三档单选）。
// 三档文案对着 permissionPresets.ts 的 PERMISSION_PRESETS 表逐条核过——
// 「标准」档在工作目录内的写入和执行是不问的，文案不许简化成「改文件先问你」。

import React, { useState } from 'react';
import { Check, ShieldAlert } from 'lucide-react';
import type { RolePanelDetail } from '@shared/contract/roleAssets';
import { useI18n } from '../../../hooks/useI18n';
import { SettingsSection } from '../settings/SettingsLayout';

type Equipment = NonNullable<RolePanelDetail['equipment']>;
type Preset = NonNullable<Equipment['permissionPreset']>;

const PRESETS: Preset[] = ['strict', 'development', 'ci'];

export interface RoleSecurityTabProps {
  equipment: Equipment;
  onSave: (next: { permissionPreset: Preset | null }) => Promise<void>;
}

export const RoleSecurityTab: React.FC<RoleSecurityTabProps> = ({ equipment, onSave }) => {
  const { t } = useI18n();
  const text = t.expert.roleSecurity;
  const [preset, setPreset] = useState<Preset | null>(equipment.permissionPreset ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const commit = async (next: Preset | null) => {
    setSaving(true);
    setError(null);
    try {
      await onSave({ permissionPreset: next });
      setPreset(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection title={text.title} description={text.description}>
      <div data-testid="role-security-editor" className="space-y-4">
        <button /* ds-allow:button: 授权方式为紧凑单选行，Button primitive 会改变布局 */
          type="button"
          data-testid="role-security-mode-follow"
          aria-pressed={preset === null}
          disabled={saving}
          onClick={() => void commit(null)}
          className={`flex w-full items-start gap-2 rounded-lg border p-3 text-left transition-colors ${preset === null ? 'border-emerald-500/60 bg-emerald-500/10' : 'border-zinc-700/60 hover:border-zinc-600'}`}
        >
          <Check className={`mt-0.5 h-4 w-4 shrink-0 ${preset === null ? 'text-emerald-300' : 'text-transparent'}`} />
          <span className="min-w-0">
            <span className="block text-sm text-zinc-200">{text.modeFollow}</span>
            <span className="mt-1 block text-xs text-zinc-500">{text.modeFollowHint}</span>
          </span>
        </button>

        <div className="space-y-2">
          <div className="text-xs text-zinc-400">{text.modeCustom}</div>
          {PRESETS.map((key) => (
            <button /* ds-allow:button: 档位单选行需与上方授权方式保持同一紧凑样式 */
              key={key}
              type="button"
              data-testid={`role-security-preset-${key}`}
              aria-pressed={preset === key}
              disabled={saving}
              onClick={() => void commit(key)}
              className={`flex w-full items-start gap-2 rounded-lg border p-3 text-left transition-colors ${preset === key ? 'border-emerald-500/60 bg-emerald-500/10' : 'border-zinc-700/60 hover:border-zinc-600'}`}
            >
              <Check className={`mt-0.5 h-4 w-4 shrink-0 ${preset === key ? 'text-emerald-300' : 'text-transparent'}`} />
              <span className="min-w-0">
                <span className="block text-sm text-zinc-200">{text.presets[key].label}</span>
                <span className="mt-1 block text-xs text-zinc-500">{text.presets[key].hint}</span>
              </span>
            </button>
          ))}
        </div>

        <div data-testid="role-security-floor" className="rounded-lg border border-zinc-700/60 bg-zinc-900/40 p-3">
          <div className="flex items-center gap-1.5 text-xs text-amber-200">
            <ShieldAlert className="h-3.5 w-3.5" />
            {text.floorTitle}
          </div>
          <ul className="mt-2 space-y-1 text-xs text-zinc-400">
            {text.floorItems.map((item) => <li key={item}>· {item}</li>)}
          </ul>
        </div>

        {saving ? <div className="text-xs text-zinc-500">{text.saving}</div> : null}
        {error ? <div className="text-xs text-red-400">{error}</div> : null}
      </div>
    </SettingsSection>
  );
};

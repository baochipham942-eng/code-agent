// ============================================================================
// MemoryConsolidationSection —— 「自动整理记忆」开关（N-MEM-CONSOLSAFE 第二波）
// 读写 settings.memory.autoConsolidate；host 侧在设置保存时同步 cron job 的 dryRun。
// 独立成组件而非内联进 MemoryTab：后者已逼近 max-lines。
// ============================================================================

import React, { useEffect, useState } from 'react';
import { IPC_DOMAINS } from '@shared/ipc/domains';
import type { AppSettings } from '@shared/contract';
import { Toggle } from '../../../primitives';
import { SettingsSection } from '../SettingsLayout';
import ipcService from '../../../../services/ipcService';
import { useI18n } from '../../../../hooks/useI18n';

export const MemoryConsolidationSection: React.FC = () => {
  const { t } = useI18n();
  const copy = t.settings.memory.consolidation;
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    ipcService.invokeDomain<AppSettings>(IPC_DOMAINS.SETTINGS, 'get')
      .then((settings) => {
        if (!cancelled) setEnabled(settings?.memory?.autoConsolidate === true);
      })
      .catch(() => {
        if (!cancelled) setEnabled(false);
      });
    return () => { cancelled = true; };
  }, []);

  const handleToggle = async (next: boolean) => {
    if (saving) return;
    setError(null);
    setSaving(true);
    const previous = enabled;
    setEnabled(next);
    try {
      await ipcService.invokeDomain(IPC_DOMAINS.SETTINGS, 'set', {
        memory: { autoConsolidate: next },
      });
    } catch {
      setEnabled(previous);
      setError(copy.saveFailed);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection title={copy.title} description={copy.description}>
      <div className="rounded-lg border border-zinc-700/70 bg-zinc-900/60 px-3 py-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-zinc-200">{copy.toggleLabel}</span>
          <Toggle
            checked={enabled === true}
            onChange={handleToggle}
            disabled={enabled === null || saving}
            aria-label={copy.toggleLabel}
          />
        </div>
        <p className="mt-2 text-xs text-zinc-500" data-testid="memory-consolidation-hint">
          {enabled === true ? copy.toggleOnHint : copy.toggleOffHint}
        </p>
        {error && <p className="mt-1 text-xs text-badge-warning">{error}</p>}
      </div>
    </SettingsSection>
  );
};

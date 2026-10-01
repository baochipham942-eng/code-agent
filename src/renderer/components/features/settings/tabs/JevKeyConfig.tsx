// ============================================================================
// JevKeyConfig — TypeSafe (Jev) API key row on General settings.
// Writes the service slot `typesafe` through setServiceApiKey (secure storage).
// Display is masked; an empty save on a configured key clears only after confirm.
// ============================================================================

import React, { useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import type { ServiceApiKey } from '@shared/contract/configService';
import ipcService from '../../../../services/ipcService';
import { useI18n } from '../../../../hooks/useI18n';
import { Button } from '../../../primitives';
import { ConfirmDialog } from '../../../composites/ConfirmDialog';
import { toast } from '../../../../hooks/useToast';

const TYPESAFE_SERVICE: ServiceApiKey = 'typesafe';

const maskApiKey = (key: string) => (key.length > 8 ? `${key.substring(0, 8)}...` : key);

export const JevKeyConfig: React.FC = () => {
  const { t } = useI18n();
  const text = t.settings.general.jevKey;
  const [configured, setConfigured] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');
  const [keyEditorOpen, setKeyEditorOpen] = useState(false);
  const [keySaving, setKeySaving] = useState(false);
  const [maskedKey, setMaskedKey] = useState<string | null>(null);
  const [pendingKeyClear, setPendingKeyClear] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void ipcService.invokeDomain<Record<string, string | undefined>>(IPC_DOMAINS.SETTINGS, 'getAllServiceKeys')
      .then((keys) => {
        if (cancelled) return;
        const masked = keys?.typesafe;
        if (typeof masked === 'string' && masked.length > 0) {
          setMaskedKey(masked);
          setConfigured(true);
        }
      })
      .catch(() => {
        // Keep the empty input. Saving still writes the service slot.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSaveKey = async () => {
    const draft = keyDraft.trim();
    if (!draft) {
      if (configured) setPendingKeyClear(true);
      return;
    }
    setKeySaving(true);
    try {
      await ipcService.invokeDomain(IPC_DOMAINS.SETTINGS, 'setServiceApiKey', {
        service: TYPESAFE_SERVICE,
        apiKey: draft,
      });
      setMaskedKey(maskApiKey(draft));
      setConfigured(true);
      setKeyDraft('');
      setKeyEditorOpen(false);
      toast.success(text.saved);
    } catch (error) {
      toast.error(`${text.saveFailedPrefix}${error instanceof Error ? error.message : t.settings.general.permissions.unknownError}`);
    } finally {
      setKeySaving(false);
    }
  };

  const handleConfirmClearKey = async () => {
    setPendingKeyClear(false);
    try {
      await ipcService.invokeDomain(IPC_DOMAINS.SETTINGS, 'setServiceApiKey', {
        service: TYPESAFE_SERVICE,
        apiKey: '',
      });
      setMaskedKey(null);
      setConfigured(false);
      setKeyDraft('');
      setKeyEditorOpen(false);
      toast.success(text.cleared);
    } catch (error) {
      toast.error(`${text.saveFailedPrefix}${error instanceof Error ? error.message : t.settings.general.permissions.unknownError}`);
    }
  };

  return (
    <div data-testid="jev-api-key-config">
      <h3 className="mb-1 text-sm font-medium text-zinc-200">{text.title}</h3>
      <p className="mb-3 text-xs text-zinc-500" data-testid="jev-api-key-description">{text.description}</p>
      {configured && !keyEditorOpen ? (
        <div className="flex items-center gap-2 text-xs text-zinc-400">
          <KeyRound className="h-3.5 w-3.5 text-zinc-500" />
          <span className="font-mono" data-testid="jev-key-masked">{maskedKey ?? text.configured}</span>
          <Button
            variant="ghost"
            size="sm"
            data-testid="jev-key-change"
            onClick={() => setKeyEditorOpen(true)}
          >
            {text.change}
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <input
            type="password"
            data-testid="jev-key-input"
            value={keyDraft}
            onChange={(event) => setKeyDraft(event.target.value)}
            placeholder={text.placeholder}
            className="h-7 w-56 rounded border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-badge-info/60"
          />
          <Button
            variant="primary"
            size="sm"
            data-testid="jev-key-save"
            onClick={() => void handleSaveKey()}
            disabled={keySaving || (!keyDraft.trim() && !configured)}
          >
            {keySaving ? text.saving : text.save}
          </Button>
        </div>
      )}

      <ConfirmDialog
        isOpen={pendingKeyClear}
        title={text.clearTitle}
        message={text.clearMessage}
        variant="danger"
        confirmText={text.clearConfirm}
        cancelText={t.common.cancel}
        onConfirm={() => void handleConfirmClearKey()}
        onCancel={() => setPendingKeyClear(false)}
      />
    </div>
  );
};

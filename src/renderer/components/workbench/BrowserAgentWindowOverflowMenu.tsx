import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Cookie, ExternalLink, MoreHorizontal } from 'lucide-react';
import type { BrowserProfileDescriptor } from '../../../shared/contract/desktop';
import {
  importBrowserProfileCookiesToPersonal,
  listImportableBrowserProfiles,
} from '../../services/browserCookieImportClient';
import { humanizeBrowserCookieImportFailure } from '../../utils/browserCookieImportMessages';
import { ConfirmDialog } from '../composites/ConfirmDialog';
import { GhostButton, IconButton } from '../primitives';

export type BrowserAgentWindowCopy = {
  moreActions: string;
  importCookies: string;
  importCookiesTitle: string;
  importCookiesHint: string;
  importCookiesSelectLabel: string;
  importCookiesConfirm: string;
  importCookiesCancel: string;
  importCookiesScanning: string;
  importCookiesEmpty: string;
  importCookiesBusy: string;
  importCookiesSuccess: string;
  importCookiesFailed: string;
  importCookiesCookieDbLocked: string;
  importCookiesKeychainDenied: string;
  importCookiesKeychainUnavailable: string;
  importCookiesProfileNotFound: string;
  importCookiesCookieDbMissing: string;
  importCookiesNotConfirmed: string;
  importCookiesManagedUnavailable: string;
  importCookiesUnsupportedPlatform: string;
  importCookiesDecryptFailed: string;
  importCookiesSchemaUnsupported: string;
  importCookiesUnknown: string;
  openLocalOps: string;
};

function formatTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (
    vars[key] !== undefined ? String(vars[key]) : match
  ));
}

function cookieImportFailureCopy(copy: BrowserAgentWindowCopy) {
  return {
    cookieDbLocked: copy.importCookiesCookieDbLocked,
    keychainDenied: copy.importCookiesKeychainDenied,
    keychainUnavailable: copy.importCookiesKeychainUnavailable,
    profileNotFound: copy.importCookiesProfileNotFound,
    cookieDbMissing: copy.importCookiesCookieDbMissing,
    notConfirmed: copy.importCookiesNotConfirmed,
    managedBrowserUnavailable: copy.importCookiesManagedUnavailable,
    unsupportedPlatform: copy.importCookiesUnsupportedPlatform,
    decryptFailed: copy.importCookiesDecryptFailed,
    schemaUnsupported: copy.importCookiesSchemaUnsupported,
    unknown: copy.importCookiesUnknown,
  };
}

export const BrowserAgentWindowOverflowMenu: React.FC<{
  copy: BrowserAgentWindowCopy;
  modeLabel: string;
  onOpenLocalOps: () => void;
  onImportNotice: (message: string, kind: 'success' | 'error') => void;
}> = ({
  copy,
  modeLabel,
  onOpenLocalOps,
  onImportNotice,
}) => {
  const [open, setOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [profiles, setProfiles] = useState<BrowserProfileDescriptor[]>([]);
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onMouseDown = (event: MouseEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const openImportDialog = useCallback(() => {
    setOpen(false);
    setImportOpen(true);
    setImportError(null);
    setProfilesLoading(true);
    void listImportableBrowserProfiles()
      .then((list) => {
        const available = list.filter((item) => item.available);
        setProfiles(available);
        const first = available[0];
        setSelectedKey(first ? `${first.source}::${first.profileId}` : null);
      })
      .catch((error) => {
        setProfiles([]);
        setSelectedKey(null);
        setImportError(error instanceof Error ? error.message : copy.importCookiesUnknown);
      })
      .finally(() => setProfilesLoading(false));
  }, [copy.importCookiesUnknown]);

  const selected = profiles.find((item) => `${item.source}::${item.profileId}` === selectedKey) || null;

  const confirmImport = useCallback(async () => {
    if (!selected || importBusy) return;
    setImportBusy(true);
    setImportError(null);
    try {
      const result = await importBrowserProfileCookiesToPersonal({
        source: selected.source,
        profileId: selected.profileId,
      });
      if (!result?.ok) {
        const human = humanizeBrowserCookieImportFailure(
          result?.failureCode,
          result?.failureMessage,
          cookieImportFailureCopy(copy),
        );
        setImportError(human);
        onImportNotice(formatTemplate(copy.importCookiesFailed, { error: human }), 'error');
        return;
      }
      setImportOpen(false);
      onImportNotice(
        formatTemplate(copy.importCookiesSuccess, {
          count: result.importedCookieCount,
          domains: result.domainCount,
        }),
        'success',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : copy.importCookiesUnknown;
      setImportError(message);
      onImportNotice(formatTemplate(copy.importCookiesFailed, { error: message }), 'error');
    } finally {
      setImportBusy(false);
    }
  }, [copy, importBusy, onImportNotice, selected]);

  return (
    <div ref={wrapperRef} className="relative shrink-0">
      <IconButton
        icon={<MoreHorizontal className="h-3.5 w-3.5" />}
        aria-label={copy.moreActions}
        variant="ghost"
        size="sm"
        onClick={() => setOpen((value) => !value)}
        data-testid="browser-agent-window-more"
      />
      {open && (
        <div className="absolute right-0 top-full z-40 mt-1 w-56 rounded-lg border border-white/[0.1] bg-zinc-900/95 p-1 shadow-xl backdrop-blur">
          <div className="px-2 py-1.5 text-[10px] text-zinc-500">{modeLabel}</div>
          <GhostButton
            size="sm"
            className="w-full justify-start"
            leftIcon={<Cookie className="h-3.5 w-3.5" />}
            onClick={openImportDialog}
            data-testid="browser-agent-window-import-cookies"
          >
            {copy.importCookies}
          </GhostButton>
          <GhostButton
            size="sm"
            className="w-full justify-start"
            leftIcon={<ExternalLink className="h-3.5 w-3.5" />}
            onClick={() => {
              setOpen(false);
              onOpenLocalOps();
            }}
            data-testid="browser-agent-window-open-local-ops"
          >
            {copy.openLocalOps}
          </GhostButton>
        </div>
      )}
      <ConfirmDialog
        isOpen={importOpen}
        title={copy.importCookiesTitle}
        variant="info"
        confirmText={importBusy ? copy.importCookiesBusy : copy.importCookiesConfirm}
        cancelText={copy.importCookiesCancel}
        confirmDisabled={importBusy || profilesLoading || !selected}
        onCancel={() => {
          if (importBusy) return;
          setImportOpen(false);
        }}
        onConfirm={() => {
          void confirmImport();
        }}
        message={(
          <div className="space-y-3" data-testid="browser-agent-window-import-cookies-dialog">
            <p className="text-sm text-zinc-300">{copy.importCookiesHint}</p>
            {profilesLoading ? (
              <p className="text-xs text-zinc-500" data-testid="browser-cookie-import-scanning">
                {copy.importCookiesScanning}
              </p>
            ) : profiles.length === 0 ? (
              <p className="text-xs text-badge-warning" data-testid="browser-cookie-import-empty">
                {copy.importCookiesEmpty}
              </p>
            ) : (
              <label className="block space-y-1.5">
                <span className="text-xs text-zinc-400">{copy.importCookiesSelectLabel}</span>
                <select
                  className="w-full rounded-md border border-white/10 bg-zinc-950/80 px-2 py-1.5 text-sm text-zinc-100"
                  value={selectedKey || ''}
                  disabled={importBusy}
                  onChange={(event) => setSelectedKey(event.target.value || null)}
                  data-testid="browser-cookie-import-profile-select"
                >
                  {profiles.map((item) => (
                    <option
                      key={`${item.source}::${item.profileId}`}
                      value={`${item.source}::${item.profileId}`}
                    >
                      {item.appName} / {item.profileName}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {importError && (
              <p className="text-xs text-badge-danger" data-testid="browser-cookie-import-error">
                {importError}
              </p>
            )}
          </div>
        )}
      />
    </div>
  );
};

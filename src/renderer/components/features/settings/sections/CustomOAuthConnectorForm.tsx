import React from 'react';
import { Button, Input, Select } from '../../../primitives';
import { useI18n } from '../../../../hooks/useI18n';

type CustomOAuthLoopbackSupport = 'confirmed' | 'pending-verification' | 'unsupported';

export interface CustomOAuthDescriptorDraft {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  requiresClientSecret: boolean;
  loopbackRedirectUriSupport: CustomOAuthLoopbackSupport;
}

interface Props {
  open: boolean;
  busy: boolean;
  draft: CustomOAuthDescriptorDraft;
  onToggle: () => void;
  onChange: (draft: CustomOAuthDescriptorDraft) => void;
  onSave: () => void;
}

export const CustomOAuthConnectorForm: React.FC<Props> = ({
  open,
  busy,
  draft,
  onToggle,
  onChange,
  onSave,
}) => {
  const { t } = useI18n();
  const text = t.settings.saasConnectors;

  return (
    <div className="col-span-full rounded-xl border border-dashed border-zinc-700 bg-zinc-900/40 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-zinc-100">{text.customOAuth.title}</div>
          <p className="mt-1 text-xs text-zinc-400">{text.customOAuth.description}</p>
        </div>
        <Button size="sm" variant="secondary" onClick={onToggle} data-testid="saas-custom-oauth-toggle">
          {open ? text.customOAuth.close : text.customOAuth.open}
        </Button>
      </div>
      {open && (
        <div className="mt-4 grid gap-3 md:grid-cols-2" data-testid="saas-custom-oauth-form">
          <label className="space-y-1 text-xs text-zinc-300">
            <span>{text.customOAuth.authorizeUrl}</span>
            <Input
              value={draft.authorizeUrl}
              onChange={(event) => onChange({ ...draft, authorizeUrl: event.target.value })}
              placeholder="https://accounts.example.com/oauth/authorize"
              data-testid="saas-custom-authorize-url"
            />
          </label>
          <label className="space-y-1 text-xs text-zinc-300">
            <span>{text.customOAuth.tokenUrl}</span>
            <Input
              value={draft.tokenUrl}
              onChange={(event) => onChange({ ...draft, tokenUrl: event.target.value })}
              placeholder="https://api.example.com/oauth/token"
              data-testid="saas-custom-token-url"
            />
          </label>
          <label className="space-y-1 text-xs text-zinc-300">
            <span>{text.customOAuth.clientId}</span>
            <Input
              value={draft.clientId}
              onChange={(event) => onChange({ ...draft, clientId: event.target.value })}
              placeholder="client_id"
              data-testid="saas-custom-client-id"
            />
          </label>
          <label className="space-y-1 text-xs text-zinc-300">
            <span>{text.customOAuth.loopbackSupport}</span>
            <Select
              value={draft.loopbackRedirectUriSupport}
              onChange={(event) => onChange({
                ...draft,
                loopbackRedirectUriSupport: event.target.value as CustomOAuthLoopbackSupport,
              })}
              options={[
                { value: 'confirmed', label: text.customOAuth.loopbackConfirmed },
                { value: 'pending-verification', label: text.customOAuth.loopbackPending },
                { value: 'unsupported', label: text.customOAuth.loopbackUnsupported },
              ]}
              data-testid="saas-custom-loopback-support"
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-zinc-300">
            <input
              type="checkbox"
              checked={draft.requiresClientSecret}
              onChange={(event) => onChange({ ...draft, requiresClientSecret: event.target.checked })}
              data-testid="saas-custom-requires-secret"
            />
            <span>{text.customOAuth.requiresClientSecret}</span>
          </label>
          <div className="flex items-end justify-end">
            <Button
              size="sm"
              variant="primary"
              disabled={busy}
              onClick={onSave}
              data-testid="saas-custom-save"
            >
              {busy ? text.actions.saving : text.customOAuth.save}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

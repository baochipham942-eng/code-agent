// ============================================================================
// MCPOAuthConsentModal - Confirm MCP OAuth browser authorization
// ============================================================================

import React, { useMemo, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { MCPOAuthConsentRequest, MCPOAuthConsentResponse } from '@shared/contract';
import { IPC_CHANNELS } from '@shared/ipc';
import { Modal, ModalFooter } from './primitives/Modal';
import { useI18n } from '../hooks/useI18n';
import { createLogger } from '../utils/logger';
import ipcService from '../services/ipcService';

const logger = createLogger('MCPOAuthConsentModal');

interface Props {
  request: MCPOAuthConsentRequest;
  onClose: () => void;
}

type ConsentAction = MCPOAuthConsentResponse['action'];

export const MCPOAuthConsentModal: React.FC<Props> = ({ request, onClose }) => {
  const { t } = useI18n();
  const text = t.settings.mcp.oauthConsent;
  const [submitting, setSubmitting] = useState(false);

  const rows = useMemo(() => [
    [text.fields.serverName, request.serverName],
    [text.fields.serverUrl, request.serverUrl],
    [text.fields.configSource, request.configSource],
    [text.fields.scope, request.scope],
    [text.fields.authorizationServer, request.authorizationServer],
    [text.fields.redirectHost, request.redirectHost],
  ] as const, [request, text]);

  const sendResponse = async (action: ConsentAction) => {
    if (submitting) return;
    setSubmitting(true);

    const response: MCPOAuthConsentResponse = {
      requestId: request.requestId,
      action,
    };

    try {
      await ipcService.invoke(IPC_CHANNELS.MCP_OAUTH_CONSENT_RESPONSE, response);
      onClose();
    } catch (error) {
      setSubmitting(false);
      logger.error('Failed to submit MCP OAuth consent response', error);
    }
  };

  return (
    <Modal
      isOpen={true}
      onClose={() => void sendResponse('decline')}
      size="lg"
      title={text.title}
      headerBgClass="bg-emerald-500/10"
      headerIcon={<ShieldCheck className="w-5 h-5 text-emerald-400" />}
      footer={
        <ModalFooter
          cancelText={text.decline}
          confirmText={text.authorize}
          onCancel={() => void sendResponse('decline')}
          onConfirm={() => void sendResponse('authorize')}
          confirmColorClass="bg-emerald-600 hover:bg-emerald-500"
          confirmDisabled={submitting}
        />
      }
    >
      <div className="space-y-4 max-h-[60vh] overflow-y-auto -mx-6 px-6">
        <p className="text-sm text-zinc-300">{text.description}</p>

        <dl className="divide-y divide-zinc-800 rounded-lg border border-zinc-800 overflow-hidden">
          {rows.map(([label, value]) => (
            <div key={label} className="grid grid-cols-[9rem_1fr] gap-3 px-3 py-2.5 text-sm">
              <dt className="text-zinc-400">{label}</dt>
              <dd className="min-w-0 break-all text-zinc-100">
                {value && value.trim().length > 0 ? value : text.emptyValue}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </Modal>
  );
};

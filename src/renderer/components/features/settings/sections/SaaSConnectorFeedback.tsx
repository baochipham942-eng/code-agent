import React from 'react';
import { Loader2 } from 'lucide-react';
import { Z_LAYERS } from '../../../../styles/zLayers';

interface Props {
  receipt: { kind: 'info' | 'success'; text: string } | null;
  error: string | null;
}

export const SaaSConnectorFeedback: React.FC<Props> = ({ receipt, error }) => (
  <>
    {receipt && (
      <div
        role="status"
        data-testid="saas-connector-toast"
        className={`fixed right-6 top-6 flex max-w-sm items-center gap-2 rounded-lg border bg-zinc-900 px-3 py-2 text-xs shadow-md dark:shadow-2xl ${
          receipt.kind === 'success'
            ? 'border-emerald-500/30 text-badge-success'
            : 'border-amber-500/30 text-badge-warning'
        }`}
        style={{ zIndex: Z_LAYERS.toast }}
      >
        {receipt.kind === 'success' ? null : <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {receipt.text}
      </div>
    )}
    {error && (
      <div
        role="alert"
        data-testid="saas-connector-error"
        className="col-span-full rounded-md border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-badge-danger"
      >
        {error}
      </div>
    )}
  </>
);

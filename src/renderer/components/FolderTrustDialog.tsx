import React from 'react';
import { ShieldAlert } from 'lucide-react';
import { ConfirmDialog } from './composites/ConfirmDialog';
import { useI18n } from '../hooks/useI18n';
import { FolderTrustDangerList, type FolderTrustDangerousItem } from './FolderTrustDangerList';

export type { FolderTrustDangerousItem };

export interface FolderTrustEvaluationView {
  state: 'trusted' | 'blocked' | 'untrusted';
  canonicalRealpath: string;
  displayPath: string;
  dangerousItems: FolderTrustDangerousItem[];
  blockedItems: FolderTrustDangerousItem[];
  identityChanged: boolean;
}

interface FolderTrustDialogProps {
  evaluation: FolderTrustEvaluationView | null;
  isBusy?: boolean;
  /**
   * 默认 true：零危险项的未信任评估不渲染（App 启动预检语义——干净目录不值得打扰）。
   * 技能信任门等场景撞的是「未信任/失效」本身，零危险项也要给完整确认弹窗 → 传 false；
   * 此时不渲染危险项清单，只显示说明文案（identityChanged 警告条照常）。
   */
  requireDangerousItems?: boolean;
  onTrust: () => void;
  onBlock: () => void;
  onOpenSettings: () => void;
}

export const FolderTrustDialog: React.FC<FolderTrustDialogProps> = ({
  evaluation,
  isBusy = false,
  requireDangerousItems = true,
  onTrust,
  onBlock,
  onOpenSettings,
}) => {
  const { t } = useI18n();
  if (
    !evaluation ||
    evaluation.state === 'trusted' ||
    (requireDangerousItems && evaluation.dangerousItems.length === 0)
  ) {
    return null;
  }

  const copy = t.folderTrust;
  const message = (
    <div className="space-y-4 text-sm text-zinc-300">
      <div className="space-y-1">
        <p className="text-zinc-400">{copy.directory}</p>
        <p className="font-mono text-xs text-zinc-100 break-all">{evaluation.displayPath}</p>
        <p className="text-zinc-500">{copy.realpath}</p>
        <p className="font-mono text-xs text-zinc-400 break-all">{evaluation.canonicalRealpath}</p>
      </div>

      {evaluation.identityChanged && (
        <div className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-100">
          {copy.identityChanged}
        </div>
      )}

      {evaluation.dangerousItems.length > 0 ? (
        <FolderTrustDangerList items={evaluation.dangerousItems} />
      ) : (
        <p className="text-zinc-400">{copy.emptyDangerNote}</p>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
          onClick={onOpenSettings}
        >
          {copy.openSettings}
        </button>
        <button
          type="button"
          className="rounded-md border border-red-500/40 px-3 py-1.5 text-xs text-red-200 hover:bg-red-500/10"
          onClick={onBlock}
          disabled={isBusy}
        >
          {isBusy ? copy.saving : copy.block}
        </button>
      </div>
    </div>
  );

  return (
    <ConfirmDialog
      isOpen
      title={copy.title}
      message={message}
      variant="warning"
      icon={<ShieldAlert className="h-6 w-6" />}
      confirmText={isBusy ? copy.saving : copy.trust}
      cancelText={copy.block}
      confirmDisabled={isBusy}
      onConfirm={onTrust}
      onCancel={onBlock}
    />
  );
};

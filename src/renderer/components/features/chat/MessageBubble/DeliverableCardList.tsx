import React from 'react';
import {
  AlertTriangle,
  Archive,
  BarChart3,
  CheckCircle2,
  Code,
  Copy,
  Download,
  ExternalLink,
  Eye,
  File,
  FileText,
  FolderOpen,
  GitBranch,
  Image as ImageIcon,
  Music,
  Presentation,
  Table,
  Video,
} from 'lucide-react';
import type { DeliverableCardView, DeliverableSecondaryAction } from '@shared/contract';
import { useAppStore } from '../../../../stores/appStore';
import { useSessionStore } from '../../../../stores/sessionStore';
import { copyPathToClipboard, isWebMode } from '../../../../utils/platform';
import { addLibraryItem } from '../../../../services/libraryClient';
import ipcService from '../../../../services/ipcService';
import { IPC_DOMAINS } from '@shared/ipc';
import { toast } from '../../../../hooks/useToast';
import { useI18n } from '../../../../hooks/useI18n';
import { BookOpen } from 'lucide-react';

interface Props {
  cards: DeliverableCardView[];
  className?: string;
}

function iconForKind(kind: string): React.ReactNode {
  const cls = 'h-3.5 w-3.5 flex-shrink-0';
  switch (kind) {
    case 'chart':
      return <BarChart3 className={`${cls} text-cyan-300`} />;
    case 'spreadsheet':
      return <Table className={`${cls} text-emerald-300`} />;
    case 'document':
      return <FileText className={`${cls} text-zinc-300`} />;
    case 'audio':
      return <Music className={`${cls} text-emerald-300`} />;
    case 'video':
      return <Video className={`${cls} text-fuchsia-300`} />;
    case 'archive':
      return <Archive className={`${cls} text-amber-300`} />;
    case 'presentation':
      return <Presentation className={`${cls} text-fuchsia-300`} />;
    case 'generative_ui':
    case 'neo_ui':
    case 'generic_html':
      return <Code className={`${cls} text-orange-300`} />;
    case 'mermaid':
    case 'diagram':
      return <GitBranch className={`${cls} text-violet-300`} />;
    case 'image':
    case 'web_snapshot':
      return <ImageIcon className={`${cls} text-emerald-300`} />;
    default:
      return <File className={`${cls} text-zinc-400`} />;
  }
}

function statusMeta(card: DeliverableCardView): { label: string; className: string; icon: React.ReactNode } {
  if (card.status === 'failed') {
    return {
      label: 'Failed',
      className: 'bg-rose-500/12 text-rose-300',
      icon: <AlertTriangle className="h-3 w-3" />,
    };
  }
  if (card.status === 'verified') {
    return {
      label: 'Verified',
      className: 'bg-emerald-500/12 text-emerald-300',
      icon: <CheckCircle2 className="h-3 w-3" />,
    };
  }
  return {
    label: 'Unverified',
    className: 'bg-amber-500/12 text-amber-300',
    icon: <AlertTriangle className="h-3 w-3" />,
  };
}

function qualityMeta(card: DeliverableCardView): { label: string; className: string; icon: React.ReactNode } | null {
  if (!card.quality) return null;
  if (card.quality.status === 'failed') {
    return {
      label: 'Quality failed',
      className: 'bg-rose-500/12 text-rose-300',
      icon: <AlertTriangle className="h-3 w-3" />,
    };
  }
  if (card.quality.status === 'needs_review' || card.quality.status === 'degraded') {
    return {
      label: 'Needs review',
      className: 'bg-amber-500/12 text-amber-300',
      icon: <AlertTriangle className="h-3 w-3" />,
    };
  }
  if (card.quality.status === 'passed') {
    return {
      label: 'Validated',
      className: 'bg-emerald-500/12 text-emerald-300',
      icon: <CheckCircle2 className="h-3 w-3" />,
    };
  }
  return null;
}

function actionLabel(card: DeliverableCardView): string {
  switch (card.openTarget.kind) {
    case 'workspace-preview':
      return 'Open in Workspace Preview';
    case 'file-preview':
      return 'Open file preview';
    case 'external':
      return 'Open external link';
    default:
      return card.openTarget.reason;
  }
}

function secondaryActionKey(action: DeliverableSecondaryAction): string {
  switch (action.kind) {
    case 'reveal-file':
    case 'open-file':
      return `${action.kind}:${action.path}`;
    case 'copy-reference':
      return `${action.kind}:${action.value}`;
    case 'download-url':
      return `${action.kind}:${action.url}`;
    case 'export-bundle':
      return `${action.kind}:${action.bundleName || action.files.map((file) => file.path).join('|')}`;
    default:
      return 'secondary-action';
  }
}

export const DeliverableCardList: React.FC<Props> = ({ cards, className = 'mt-2' }) => {
  const { t } = useI18n();
  const openPreview = useAppStore((state) => state.openPreview);
  const openWorkspacePreview = useAppStore((state) => state.openWorkspacePreview);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const currentSessionProjectId = useSessionStore(
    (state) => state.sessions.find((s) => s.id === state.currentSessionId)?.projectId ?? null,
  );
  const currentSessionWorkingDirectory = useSessionStore(
    (state) => state.sessions.find((s) => s.id === state.currentSessionId)?.workingDirectory ?? null,
  );

  if (cards.length === 0) return null;

  const openCard = (card: DeliverableCardView) => {
    switch (card.openTarget.kind) {
      case 'workspace-preview':
        openWorkspacePreview(card.openTarget.itemId);
        break;
      case 'file-preview':
        openPreview(card.openTarget.path);
        break;
      case 'external':
        window.open(card.openTarget.url, '_blank', 'noopener,noreferrer');
        break;
      default:
        break;
    }
  };

  const runSecondaryAction = async (action: DeliverableSecondaryAction, card: DeliverableCardView) => {
    if (action.disabled) return;
    try {
      switch (action.kind) {
        case 'reveal-file':
          if (isWebMode()) {
            await copyPathToClipboard(action.path);
            return;
          }
          await window.domainAPI?.invoke('workspace', 'showItemInFolder', { filePath: action.path });
          break;
        case 'open-file':
          if (isWebMode()) {
            await copyPathToClipboard(action.path);
            return;
          }
          await window.domainAPI?.invoke('workspace', 'openPath', { filePath: action.path });
          break;
        case 'copy-reference':
          await copyPathToClipboard(action.value);
          break;
        case 'download-url':
          if (isWebMode()) {
            window.open(action.url, '_blank', 'noopener,noreferrer');
            return;
          }
          await window.domainAPI?.invoke('workspace', 'downloadFile', {
            url: action.url,
            filename: action.filename,
          });
          break;
        case 'archive-to-library': {
          // Batch 2 L3：一键归档到当前项目资料库，默认打「定稿」标签
          try {
            const item = await addLibraryItem({
              projectId: currentSessionProjectId,
              title: action.title,
              kind: 'artifact',
              pathOrUri: action.path,
              tags: ['定稿'],
              sourceSessionId: currentSessionId ?? undefined,
            });
            toast.success(t.library.archivedToast.replace('{title}', item.title));
            // 归档成功后顺手写一句摘要进项目记忆；无摘要/无工作目录跳过，失败不打断归档主流程
            if (currentSessionWorkingDirectory && card.description.trim()) {
              void ipcService
                .invokeDomain(IPC_DOMAINS.ROLES, 'writeProjectMemory', {
                  workspacePath: currentSessionWorkingDirectory,
                  name: card.title,
                  description: card.description,
                  content: `${card.description}\n\n定稿产物：${action.path}`,
                })
                .catch((err) => console.warn('[DeliverableCardList] write project memory failed', err));
            }
          } catch (error) {
            toast.error(t.library.archiveFailed + (error instanceof Error ? `: ${error.message}` : ''));
          }
          break;
        }
        case 'export-bundle': {
          const response = await window.domainAPI?.invoke<{ filePath: string }>('workspace', 'exportBundle', {
            files: action.files,
            bundleName: action.bundleName,
            manifest: action.manifest,
          });
          if (response && !response.success) {
            throw new Error(response.error?.message || 'Export bundle failed');
          }
          const bundlePath = response?.data?.filePath;
          if (!bundlePath) break;
          if (isWebMode()) {
            await copyPathToClipboard(bundlePath);
            return;
          }
          await window.domainAPI?.invoke('workspace', 'showItemInFolder', { filePath: bundlePath });
          break;
        }
        default:
          break;
      }
    } catch (error) {
      console.warn('[DeliverableCardList] secondary action failed', action.kind, error);
    }
  };

  const secondaryIcon = (action: DeliverableSecondaryAction): React.ReactNode => {
    const cls = 'h-3.5 w-3.5';
    switch (action.kind) {
      case 'reveal-file':
        return <FolderOpen className={cls} />;
      case 'download-url':
        return <Download className={cls} />;
      case 'export-bundle':
        return <Archive className={cls} />;
      case 'archive-to-library':
        return <BookOpen className={cls} />;
      case 'copy-reference':
        return <Copy className={cls} />;
      case 'open-file':
        return <ExternalLink className={cls} />;
      default:
        return <Copy className={cls} />;
    }
  };

  return (
    <div className={`${className} space-y-1.5`}>
      {cards.map((card) => {
        const status = statusMeta(card);
        const quality = qualityMeta(card);
        const clickable = card.openTarget.kind !== 'none';
        const content = (
          <>
            {iconForKind(card.kind)}
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium text-zinc-100">{card.title}</div>
              <div className="truncate text-[11px] leading-4 text-zinc-500">{card.description}</div>
            </div>
            {quality && (
              <span
                className={`inline-flex flex-shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${quality.className}`}
                title={card.quality?.summary}
              >
                {quality.icon}
                {quality.label}
              </span>
            )}
            <span className={`inline-flex flex-shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${status.className}`}>
              {status.icon}
              {status.label}
            </span>
            {clickable && (
              card.openTarget.kind === 'external'
                ? <ExternalLink className="h-3.5 w-3.5 flex-shrink-0 text-zinc-500" />
                : <Eye className="h-3.5 w-3.5 flex-shrink-0 text-zinc-500" />
            )}
          </>
        );
        const secondaryActions = card.secondaryActions?.filter((action) => !action.disabled) ?? [];
        const cardChrome = 'rounded-md border border-border-muted bg-surface-subtle transition-colors';

        return (
          <div
            key={card.id}
            className={`${cardChrome} ${clickable ? 'hover:border-cyan-500/25 hover:bg-cyan-500/[0.045]' : ''}`}
          >
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => clickable && openCard(card)}
                className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left disabled:cursor-default"
                title={actionLabel(card)}
                aria-label={`${actionLabel(card)}: ${card.title}`}
                disabled={!clickable}
              >
                {content}
              </button>
              {secondaryActions.length > 0 && (
                <div className="flex flex-shrink-0 items-center gap-0.5 pr-1.5">
                  {secondaryActions.map((action) => (
                    <button
                      key={secondaryActionKey(action)}
                      type="button"
                      onClick={() => void runSecondaryAction(action, card)}
                      className="inline-flex h-6 w-6 items-center justify-center rounded text-zinc-500 hover:bg-surface-hover hover:text-zinc-200"
                      title={action.reason || action.label}
                      aria-label={`${action.label}: ${card.title}`}
                    >
                      {secondaryIcon(action)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};

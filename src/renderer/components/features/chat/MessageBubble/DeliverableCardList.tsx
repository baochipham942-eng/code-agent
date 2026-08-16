import React, { useEffect, useRef, useState } from 'react';
import {
  Archive,
  BarChart3,
  BookOpen,
  Code,
  Copy,
  Download,
  ExternalLink,
  File,
  FileText,
  FolderOpen,
  GitBranch,
  Image as ImageIcon,
  MoreHorizontal,
  Music,
  Presentation,
  Table,
  Video,
} from 'lucide-react';
import type { DeliverableCardView, DeliverableSecondaryAction } from '@shared/contract';
import { useAppStore } from '../../../../stores/appStore';
import { useSessionStore } from '../../../../stores/sessionStore';
import { useWorkspacePreviewModel } from '../../../../hooks/useWorkspacePreviewModel';
import { copyPathToClipboard, isWebMode } from '../../../../utils/platform';
import { addLibraryItem } from '../../../../services/libraryClient';
import ipcService from '../../../../services/ipcService';
import { IPC_DOMAINS } from '@shared/ipc';
import { toast } from '../../../../hooks/useToast';
import { useI18n } from '../../../../hooks/useI18n';

interface Props {
  cards: DeliverableCardView[];
  className?: string;
}

export function iconForKind(kind: string): React.ReactNode {
  const cls = 'h-3.5 w-3.5 flex-shrink-0';
  switch (kind) {
    case 'chart':
      return <BarChart3 className={`${cls} text-badge-info`} />;
    case 'spreadsheet':
      return <Table className={`${cls} text-badge-success`} />;
    case 'document':
      return <FileText className={`${cls} text-zinc-300`} />;
    case 'audio':
      return <Music className={`${cls} text-badge-success`} />;
    case 'video':
      return <Video className={`${cls} text-badge-accent`} />;
    case 'archive':
      return <Archive className={`${cls} text-badge-warning`} />;
    case 'presentation':
      return <Presentation className={`${cls} text-badge-accent`} />;
    case 'generative_ui':
    case 'neo_ui':
    case 'generic_html':
      return <Code className={`${cls} text-badge-warning`} />;
    case 'mermaid':
    case 'diagram':
      return <GitBranch className={`${cls} text-badge-accent`} />;
    case 'image':
    case 'web_snapshot':
      return <ImageIcon className={`${cls} text-badge-success`} />;
    default:
      return <File className={`${cls} text-zinc-400`} />;
  }
}

function actionLabel(card: DeliverableCardView, labels: ReturnType<typeof useI18n>['t']['deliverable']): string {
  switch (card.openTarget.kind) {
    case 'workspace-preview':
      return labels.workspacePreview;
    case 'file-preview':
      return labels.filePreview;
    case 'external':
      return labels.externalLink;
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

function secondaryIcon(action: DeliverableSecondaryAction): React.ReactNode {
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
}

function secondaryActionLabel(
  action: DeliverableSecondaryAction,
  labels: ReturnType<typeof useI18n>['t']['deliverable'],
): string {
  switch (action.kind) {
    case 'reveal-file':
      return labels.reveal;
    case 'open-file':
      return labels.openFile;
    case 'copy-reference':
      return labels.copyReference;
    case 'download-url':
      return labels.download;
    case 'archive-to-library':
      return labels.archiveToLibrary;
    case 'export-bundle':
      return labels.exportBundle;
  }
}

interface CardRowProps {
  card: DeliverableCardView;
  labels: ReturnType<typeof useI18n>['t']['deliverable'];
  openCard: (card: DeliverableCardView) => void;
  runSecondaryAction: (action: DeliverableSecondaryAction, card: DeliverableCardView) => Promise<void>;
}

const CardRow: React.FC<CardRowProps> = ({ card, labels, openCard, runSecondaryAction }) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  const clickable = card.openTarget.kind !== 'none';
  const cardChrome = 'rounded-md border border-border-muted bg-surface-subtle transition-colors';

  const allActions = card.secondaryActions?.filter((action) => !action.disabled) ?? [];
  const archiveAction = allActions.find((action) => action.kind === 'archive-to-library');
  const overflowActions = allActions.filter((action) => action.kind !== 'archive-to-library');

  const handleActionClick = (action: DeliverableSecondaryAction) => {
    setMenuOpen(false);
    void runSecondaryAction(action, card);
  };

  return (
    <div
      key={card.id}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-label={clickable ? `${actionLabel(card, labels)}: ${card.title}` : undefined}
      title={clickable ? actionLabel(card, labels) : undefined}
      onClick={() => clickable && openCard(card)}
      onKeyDown={(event) => {
        if (!clickable || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        openCard(card);
      }}
      className={`${cardChrome} ${clickable ? 'cursor-pointer hover:border-badge-info/25 hover:bg-cyan-500/[0.045]' : ''}`}
    >
      <div className="flex items-center gap-1">
        <div className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left">
          {iconForKind(card.kind)}
          <div className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-100">{card.title}</div>
        </div>
        {(archiveAction || overflowActions.length > 0) && (
          <div className="flex flex-shrink-0 items-center gap-0.5 pr-1.5">
            {archiveAction && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void runSecondaryAction(archiveAction, card);
                }}
                className="inline-flex h-6 items-center justify-center gap-1 rounded px-1.5 text-[11px] text-badge-info hover:bg-surface-hover hover:text-badge-info"
                title={archiveAction.reason || labels.archiveToLibrary}
                aria-label={`${labels.archiveToLibrary}: ${card.title}`}
              >
                <BookOpen className="h-3.5 w-3.5" />
                <span>{labels.archiveToLibrary}</span>
              </button>
            )}
            {overflowActions.length > 0 && (
              <div className="relative" ref={menuRef}>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpen((value) => !value);
                  }}
                  className="inline-flex h-6 w-6 items-center justify-center rounded text-zinc-500 hover:bg-surface-hover hover:text-zinc-200"
                  aria-label={`${labels.moreActions}: ${card.title}`}
                  title={labels.moreActions}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </button>
                {menuOpen && (
                  <div
                    role="menu"
                    onClick={(event) => event.stopPropagation()}
                    aria-label={`${labels.moreActions}: ${card.title}`}
                    className="absolute right-0 top-full z-30 mt-1 min-w-[160px] rounded-lg border border-border-muted bg-surface-subtle py-1 shadow-xl"
                  >
                    {overflowActions.map((action) => (
                      <button
                        key={secondaryActionKey(action)}
                        type="button"
                        role="menuitem"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleActionClick(action);
                        }}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-400 transition-colors hover:bg-surface-hover hover:text-zinc-200"
                        title={action.reason || secondaryActionLabel(action, labels)}
                        aria-label={`${secondaryActionLabel(action, labels)}: ${card.title}`}
                      >
                        {secondaryIcon(action)}
                        <span className="truncate">{secondaryActionLabel(action, labels)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export const DeliverableCardList: React.FC<Props> = ({ cards, className = 'mt-2' }) => {
  const { t } = useI18n();
  const deliverableLabels = t.deliverable;
  const openPreview = useAppStore((state) => state.openPreview);
  const openContentPreview = useAppStore((state) => state.openContentPreview);
  const openWorkspacePreview = useAppStore((state) => state.openWorkspacePreview);
  const workspacePreviewItems = useWorkspacePreviewModel();
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const currentSessionProjectId = useSessionStore(
    (state) => state.sessions.find((s) => s.id === state.currentSessionId)?.projectId ?? null,
  );
  const currentSessionWorkingDirectory = useSessionStore(
    (state) => state.sessions.find((s) => s.id === state.currentSessionId)?.workingDirectory ?? null,
  );

  if (cards.length === 0) return null;

  const openCard = (card: DeliverableCardView) => {
    const target = card.openTarget;
    switch (target.kind) {
      case 'workspace-preview':
        {
          const item = workspacePreviewItems.find((candidate) => candidate.id === target.itemId);
          if (item?.file?.path) {
            openPreview(item.file.path, { deliverableStatus: card.status });
            break;
          }
          const content = item?.content?.html
            ?? item?.content?.json
            ?? item?.content?.text
            ?? item?.content?.diff
            ?? item?.content?.summary;
          if (item && content) {
            openContentPreview({
              id: item.id,
              title: item.title,
              content,
              format: item.content?.html
                ? 'html'
                : item.content?.json
                  ? 'json'
                  : item.content?.text || item.content?.summary
                    ? 'markdown'
                    : 'text',
            });
            break;
          }
          openWorkspacePreview();
        }
        break;
      case 'file-preview':
        openPreview(target.path, { deliverableStatus: card.status });
        break;
      case 'external':
        window.open(target.url, '_blank', 'noopener,noreferrer');
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
            // 相对路径文件项按发起会话的 workingDirectory 解析
            ...(currentSessionId ? { sessionId: currentSessionId } : {}),
            ...(currentSessionWorkingDirectory
              ? { workingDirectory: currentSessionWorkingDirectory }
              : {}),
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

  return (
    <div className={`${className} space-y-1.5`}>
      {cards.map((card) => (
        <CardRow
          key={card.id}
          card={card}
          labels={deliverableLabels}
          openCard={openCard}
          runSecondaryAction={runSecondaryAction}
        />
      ))}
    </div>
  );
};

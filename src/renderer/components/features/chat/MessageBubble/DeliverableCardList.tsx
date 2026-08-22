import React, { useEffect, useMemo, useRef, useState } from 'react';
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
  Rocket,
  Table,
  Video,
} from 'lucide-react';
import type {
  DeliverableCardView,
  DeliverablePublishInfo,
  DeliverableSecondaryAction,
  PublishedDeliverableVersion,
} from '@shared/contract';
import { useAppStore } from '../../../../stores/appStore';
import { useSessionStore } from '../../../../stores/sessionStore';
import { useWorkspacePreviewModel } from '../../../../hooks/useWorkspacePreviewModel';
import { copyPathToClipboard, isWebMode } from '../../../../utils/platform';
import { addLibraryItem } from '../../../../services/libraryClient';
import ipcService from '../../../../services/ipcService';
import { IPC_DOMAINS } from '@shared/ipc';
import { toast } from '../../../../hooks/useToast';
import { useI18n } from '../../../../hooks/useI18n';
import { Modal } from '../../../primitives/Modal';
import { Button } from '../../../primitives/Button';
import { Input } from '../../../primitives/Input';
import { DeliverablePublishBadge } from '../../../DeliverablePublishBadge';
import { applyPublishInfoToDeliverableCard } from '../../../../utils/deliverables';

interface Props {
  cards: DeliverableCardView[];
  className?: string;
  renderCardDetail?: (card: DeliverableCardView) => React.ReactNode;
}

interface PublishVersionResponse extends DeliverablePublishInfo {
  publishedVersion: PublishedDeliverableVersion;
}

function isPublishInfo(value: unknown): value is DeliverablePublishInfo {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<DeliverablePublishInfo>;
  return Boolean(candidate.publishState) && Array.isArray(candidate.publishedVersions);
}

function publishActionForCard(
  card: DeliverableCardView,
): Extract<DeliverableSecondaryAction, { kind: 'publish-version' }> | undefined {
  return card.secondaryActions?.find(
    (action): action is Extract<DeliverableSecondaryAction, { kind: 'publish-version' }> => action.kind === 'publish-version',
  );
}

function resolveDeliverablePath(filePath: string, workingDirectory: string | null): string {
  if (filePath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(filePath) || !workingDirectory) return filePath;
  return `${workingDirectory.replace(/[\\/]$/, '')}/${filePath}`;
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
    case 'publish-version':
      return `${action.kind}:${action.path}`;
    case 'reveal-file':
    case 'open-file':
      return `${action.kind}:${action.path}`;
    case 'copy-reference':
      return `${action.kind}:${action.value}`;
    case 'download-url':
      return `${action.kind}:${action.url}`;
    case 'export-bundle':
      return `${action.kind}:${action.bundleName || action.files.map((file) => file.path).join('|')}`;
    case 'archive-to-library':
      return `${action.kind}:${action.path}`;
    default:
      return 'secondary-action';
  }
}

function secondaryIcon(action: DeliverableSecondaryAction): React.ReactNode {
  const cls = 'h-3.5 w-3.5';
  switch (action.kind) {
    case 'publish-version':
      return <Rocket className={cls} />;
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
    case 'publish-version':
      return labels.publishVersion;
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
  requestPublish: (action: Extract<DeliverableSecondaryAction, { kind: 'publish-version' }>, card: DeliverableCardView) => void;
  detail?: React.ReactNode;
}

const CardRow: React.FC<CardRowProps> = ({ card, labels, openCard, runSecondaryAction, requestPublish, detail }) => {
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
  const publishAction = allActions.find(
    (action): action is Extract<DeliverableSecondaryAction, { kind: 'publish-version' }> => action.kind === 'publish-version',
  );
  const overflowActions = allActions.filter((action) => action.kind !== 'publish-version');

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
          <DeliverablePublishBadge state={card.publishState} testId={`deliverable-publish-state-${card.id}`} />
        </div>
        {(publishAction || overflowActions.length > 0) && (
          <div className="flex flex-shrink-0 items-center gap-0.5 pr-1.5">
            {publishAction && (
              <button /* ds-allow:button: 产物卡窄版专用主动作，通用 Button 尺寸不适配 */
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  requestPublish(publishAction, card);
                }}
                className="inline-flex h-6 items-center justify-center gap-1 rounded border border-teal-500/50 px-1.5 text-[11px] text-badge-success hover:bg-teal-500/10"
                title={labels.publishVersion}
                aria-label={`${labels.publishVersion}: ${card.title}`}
              >
                <Rocket className="h-3.5 w-3.5" />
                <span>{labels.publishVersion}</span>
              </button>
            )}
            {overflowActions.length > 0 && (
              <div className="relative" ref={menuRef}>
                <button /* ds-allow:button: 产物卡窄版溢出菜单图标按钮 */
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
                      <button /* ds-allow:button: 紧凑菜单项承载可选副文案 */
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
                        <span className="min-w-0">
                          <span className="block truncate">{secondaryActionLabel(action, labels)}</span>
                          {action.kind === 'export-bundle' && action.sourceVersion && (
                            <span className="block truncate text-[10px] text-zinc-500">
                              {labels.exportBundleSource.replace('{version}', String(action.sourceVersion))}
                            </span>
                          )}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      {detail}
    </div>
  );
};

export const DeliverableCardList: React.FC<Props> = ({ cards, className = 'mt-2', renderCardDetail }) => {
  const { t } = useI18n();
  const deliverableLabels = t.deliverable;
  const openPreview = useAppStore((state) => state.openPreview);
  const openContentPreview = useAppStore((state) => state.openContentPreview);
  const openWorkspacePreview = useAppStore((state) => state.openWorkspacePreview);
  const setWorkbenchCollapsed = useAppStore((state) => state.setWorkbenchCollapsed);
  const workspacePreviewItems = useWorkspacePreviewModel();
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const currentSessionProjectId = useSessionStore(
    (state) => state.sessions.find((s) => s.id === state.currentSessionId)?.projectId ?? null,
  );
  const currentSessionWorkingDirectory = useSessionStore(
    (state) => state.sessions.find((s) => s.id === state.currentSessionId)?.workingDirectory ?? null,
  );

  const [publishInfoByPath, setPublishInfoByPath] = useState<Record<string, DeliverablePublishInfo>>({});
  const [publishTarget, setPublishTarget] = useState<{
    action: Extract<DeliverableSecondaryAction, { kind: 'publish-version' }>;
    card: DeliverableCardView;
  } | null>(null);
  const [publishNote, setPublishNote] = useState('');
  const [isPublishing, setIsPublishing] = useState(false);
  const publishInfoRequestRef = useRef(0);

  const publishPaths = useMemo(() => Array.from(new Set(cards.flatMap((card) => {
    const action = publishActionForCard(card);
    return action ? [resolveDeliverablePath(action.path, currentSessionWorkingDirectory)] : [];
  }))), [cards, currentSessionWorkingDirectory]);
  const publishPathsKey = publishPaths.join('\n');
  const publishRevisionKey = cards.map((card) => [
    card.id,
    card.revisionContext?.sha256,
    card.revisionContext?.version,
    card.createdAt,
  ].join(':')).join('\n');

  useEffect(() => {
    if (!publishPathsKey) return;
    const paths = publishPathsKey.split('\n');
    const requestId = ++publishInfoRequestRef.current;
    let cancelled = false;
    void Promise.all(paths.map(async (filePath) => {
      try {
        const info = await ipcService.invokeDomain<DeliverablePublishInfo>(
          IPC_DOMAINS.WORKSPACE,
          'getPublishInfo',
          { filePath },
        );
        return isPublishInfo(info) ? [filePath, info] as const : null;
      } catch {
        return null;
      }
    })).then((entries) => {
      if (cancelled || requestId !== publishInfoRequestRef.current) return;
      setPublishInfoByPath((current) => ({
        ...current,
        ...Object.fromEntries(entries.filter((entry): entry is readonly [string, DeliverablePublishInfo] => entry !== null)),
      }));
    });
    return () => { cancelled = true; };
  }, [publishPathsKey, publishRevisionKey]);

  const displayCards = useMemo(() => cards.map((card) => {
    const action = publishActionForCard(card);
    if (!action) return card;
    const filePath = resolveDeliverablePath(action.path, currentSessionWorkingDirectory);
    const info = publishInfoByPath[filePath];
    return info ? applyPublishInfoToDeliverableCard(card, info) : card;
  }), [cards, currentSessionWorkingDirectory, publishInfoByPath]);

  const requestPublish = (
    action: Extract<DeliverableSecondaryAction, { kind: 'publish-version' }>,
    card: DeliverableCardView,
  ) => {
    setPublishNote('');
    setPublishTarget({ action, card });
  };

  const confirmPublish = async () => {
    if (!publishTarget || isPublishing) return;
    const filePath = resolveDeliverablePath(publishTarget.action.path, currentSessionWorkingDirectory);
    setIsPublishing(true);
    try {
      const response = await ipcService.invokeDomain<PublishVersionResponse>(
        IPC_DOMAINS.WORKSPACE,
        'publishVersion',
        { filePath, note: publishNote },
      );
      publishInfoRequestRef.current += 1;
      setPublishInfoByPath((current) => ({ ...current, [filePath]: response }));
      setPublishTarget(null);
      toast.success(deliverableLabels.publishSuccess.replace('{version}', String(response.publishedVersion.version)));
    } catch (error) {
      toast.error(`${deliverableLabels.publishFailed}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsPublishing(false);
    }
  };

  if (cards.length === 0) return null;

  const openCard = (card: DeliverableCardView) => {
    setWorkbenchCollapsed(false);
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

  const currentVersion = publishTarget?.card.publishState.kind === 'draft'
    ? 1
    : (publishTarget?.card.publishState.version ?? 0) + 1;

  return (
    <>
      <div className={`${className} space-y-1.5`}>
        {displayCards.map((card) => (
          <CardRow
            key={card.id}
            card={card}
            labels={deliverableLabels}
            openCard={openCard}
            runSecondaryAction={runSecondaryAction}
            requestPublish={requestPublish}
            detail={renderCardDetail?.(card)}
          />
        ))}
      </div>
      <Modal
        isOpen={publishTarget !== null}
        onClose={() => { if (!isPublishing) setPublishTarget(null); }}
        title={deliverableLabels.publishConfirmTitle}
        size="sm"
        portal
        footer={(
          <>
            <Button variant="ghost" size="sm" onClick={() => setPublishTarget(null)} disabled={isPublishing}>
              {t.common.cancel}
            </Button>
            <Button variant="primary" size="sm" onClick={() => void confirmPublish()} loading={isPublishing}>
              {deliverableLabels.publish}
            </Button>
          </>
        )}
      >
        <div className="space-y-3">
          <p className="text-xs leading-5 text-zinc-400">
            {deliverableLabels.publishConfirmDescription
              .replace('{title}', publishTarget?.card.title ?? '')
              .replace('{version}', String(currentVersion))}
          </p>
          <label className="block space-y-1.5 text-xs text-zinc-300">
            <span>{deliverableLabels.publishNote}</span>
            <Input
              value={publishNote}
              onChange={(event) => setPublishNote(event.target.value)}
              placeholder={deliverableLabels.publishNotePlaceholder}
              maxLength={160}
              autoFocus
            />
          </label>
        </div>
      </Modal>
    </>
  );
};

// ============================================================================
// ToolDetails - Expandable details area showing arguments and results
// ============================================================================

import React, { useState, lazy, Suspense } from 'react';
import { Play, Copy, Check, RotateCcw } from 'lucide-react';
import type { ToolCall } from '@shared/contract';
import {
  buildToolResultMediaAssets,
  type SessionMediaContext,
} from '@shared/utils/sessionMediaAssets';
import { IPC_DOMAINS } from '@shared/ipc';
import { DiffView } from '../../../../DiffView';
import { useAppStore } from '../../../../../stores/appStore';
import { isPreviewable } from '../../../../../utils/previewable';
import {
  formatBrowserComputerActionArguments,
  formatBrowserComputerActionResultDetails,
} from '../../../../../utils/browserComputerActionPreview';
import { buildAgentPointerEvent } from '../../../../../utils/agentPointer';
import { LiveToolOutput } from './LiveToolOutput';
import { redactBrowserComputerInputPayloadsInValue } from '@shared/utils/browserComputerRedaction';
import { getBrowserComputerActionCatalogEntry } from '@shared/utils/browserComputerActionCatalog';
import { MemoryCitationGroup } from '../../../../citations/MemoryCitationGroup';
import type { Citation } from '@shared/contract/citation';
import {
  humanizeToolError,
  buildToolErrorActions,
  isToolInterruptionPlaceholder,
} from '../../../../../utils/toolExecutionPresentation';
import { useI18n } from '../../../../../hooks/useI18n';
import type { Translations } from '../../../../../i18n';
import { useMessageActionStore } from '../../../../../stores/messageActionStore';
import { copyPathToClipboard } from '../../../../../utils/platform';
import {
  ImageResultDisplay,
  GenericMediaResultDisplay,
  FileResultDisplay,
  VideoResultDisplay,
} from './ToolResultMediaDisplays';

// Shiki 高亮内核按需动态加载,只在真的渲染 JSON 高亮时才下载。
const LazyShikiCodeBlock = lazy(() => import('../ShikiCodeBlock'));

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI_SEQUENCE_PATTERN = new RegExp(
  `${ESC}\\[[0-9;]*[a-zA-Z]|${ESC}\\].*?${BEL}|${ESC}\\[\\??[0-9;]*[a-zA-Z]`,
  'g',
);

// ============================================================================
// ANSI 转义码过滤 - 清理终端输出中的颜色和格式代码
// ============================================================================

/**
 * 移除字符串中的 ANSI 转义序列
 * 支持：颜色代码、光标控制、清屏等所有常见 ANSI 序列
 */
function stripAnsiCodes(str: string): string {
  if (typeof str !== 'string') return str;
  return str.replace(ANSI_SEQUENCE_PATTERN, '');
}

// JSON 语法高亮 - 仅用于结构化 JSON（参数 default 分支 / 对象型 result.output）。
// 复用 MessageContent 同款 Shiki（palette 随 data-theme，见 shikiTheme）。纯文本/日志/带行号输出不走这里，
// 避免把 Read 的 "  1→code" 行号前缀或 Bash 日志当代码高亮弄乱。
const JSON_HIGHLIGHT_STYLE: React.CSSProperties = {
  margin: 0,
  padding: '0.75rem',
  fontSize: '0.75rem',
  lineHeight: 1.5,
  background: 'var(--code-bg)',
  borderRadius: '0.5rem',
};

function JsonHighlight({ code, error }: { code: string; error?: boolean }) {
  const borderClass = error ? 'border-red-500/20' : 'border-gray-800/50';
  return (
    <Suspense
      fallback={
        <pre
          className={`scrollbar-hidden whitespace-pre-wrap break-words rounded-md border ${borderClass}`}
          style={JSON_HIGHLIGHT_STYLE}
        >
          {code}
        </pre>
      }
    >
      <LazyShikiCodeBlock
        language="json"
        customStyle={JSON_HIGHLIGHT_STYLE}
        codeTagProps={{ style: { fontSize: '0.75rem', background: 'transparent' } }}
        wrapLongLines
        className={`scrollbar-hidden border ${borderClass}`}
        code={code}
      />
    </Suspense>
  );
}

// 展开后正文行级硬 cap（P0 #1c）：非用户工具默认只露 5 行，shell 命令输出常合理偏长
// 给 50 行，超出给「展开」。避免未识别错误/长输出把详情撑成一面墙（即便已默认折叠，
// 用户点开后也不该被 300+ 字符的原始 JSON/ANSI 糊脸）。
const RESULT_BODY_LINE_CAP = 5;
const SHELL_RESULT_BODY_LINE_CAP = 50;

type ToolDetailsCopy = Translations['rendererHumanPipe']['toolDetails'];
type RecoveryCopy = ToolDetailsCopy['recovery'];

function isShellTool(name: string): boolean {
  return name === 'Bash' || name === 'bash';
}

function CappedResultBody({
  text,
  lineCap,
  className,
  copy,
}: {
  text: string;
  lineCap: number;
  className: string;
  copy: ToolDetailsCopy;
}) {
  const [showAll, setShowAll] = useState(false);
  const allLines = text.split('\n');
  const overflow = allLines.length - lineCap;
  const display = overflow > 0 && !showAll ? allLines.slice(0, lineCap).join('\n') : text;

  return (
    <>
      <pre className={className}>{display}</pre>
      {overflow > 0 && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="mt-1 block text-[11px] text-zinc-500 transition-colors hover:text-zinc-300"
        >
          {showAll
            ? copy.collapse
            : copy.expandRemaining.replace('{count}', String(overflow))}
        </button>
      )}
    </>
  );
}

interface Props {
  toolCall: ToolCall;
  compact?: boolean;
  mediaContext?: SessionMediaContext;
}

export function ToolDetails({ toolCall, compact, mediaContext }: Props) {
  const { name, arguments: args, result } = toolCall;
  const [showDiff, setShowDiff] = useState(true);
  const [showRawError, setShowRawError] = useState(false);
  const openPreview = useAppStore((state) => state.openPreview);
  const openSettingsTab = useAppStore((state) => state.openSettingsTab);
  const { t } = useI18n();
  const copy = t.rendererHumanPipe.toolDetails;

  // 报错说人话：识别得了的错误（如搜索源额度耗尽）给一行摘要 + 去设置入口，原始报错折叠。
  // metadata.code 命中登记表的门（如工作台范围拦截）优先用 code 文案，正则降为兜底。
  const humanError = result && !result.success
    ? humanizeToolError(result.error, name, t, result.metadata)
    : null;

  // Check if this is Edit tool
  const isEditFile = name === 'Edit';
  const editFileArgs = isEditFile
    ? {
        filePath: (args?.file_path as string) || '',
        oldString: (args?.old_string as string) || '',
        newString: (args?.new_string as string) || '',
      }
    : null;

  // 空编辑检测：old_string 和 new_string 完全相同
  const isEmptyEdit = isEditFile && editFileArgs &&
    editFileArgs.oldString === editFileArgs.newString;

  // Check for special file results
  const createdFilePath = extractCreatedFilePath(toolCall);
  const imageResult = extractImageResult(toolCall);
  const videoResult = extractVideoResult(toolCall);
  const pointerEvent = buildAgentPointerEvent(toolCall);
  const mediaAssets = buildToolResultMediaAssets(toolCall, mediaContext);
  const imageAsset = mediaAssets.find((asset) => asset.kind === 'image' && asset.role === 'output')
    || mediaAssets.find((asset) => asset.kind === 'image');
  const videoAsset = mediaAssets.find((asset) => asset.kind === 'video' && asset.role === 'output')
    || mediaAssets.find((asset) => asset.kind === 'video');
  const genericMediaAsset = !imageResult && !videoResult
    ? mediaAssets.find((asset) => asset.role === 'output') || mediaAssets[0]
    : undefined;
  const generatedFileResult = extractGeneratedFile(toolCall);
  const safeBrowserComputerResult = formatBrowserComputerActionResultDetails(toolCall);
  const browserComputerNextSteps = getBrowserComputerNextSteps(toolCall, copy);
  // 通用失败工具的可点 action（复制错误 + 从此重试）。浏览器/Computer 类有自己的
  // 只读 recovery actions，这里只兜底其余工具，避免两套 action 行重复。
  const toolErrorActions = buildToolErrorActions(toolCall, mediaContext?.messageId);
  const interruptionPlaceholder = isToolInterruptionPlaceholder(result?.error);
  const showGenericErrorActions = browserComputerNextSteps.length === 0
    && toolErrorActions.show
    && !interruptionPlaceholder;

  const canPreviewCreated = isPreviewable(createdFilePath);

  return (
    <div className="mt-1 space-y-1.5 text-xs">
      {/* Diff view for Edit (skip for empty edits) */}
      {isEditFile && editFileArgs && showDiff && !isEmptyEdit && (
        <div className="animate-fadeIn">
          <div className="flex items-center gap-2 text-xs font-medium text-gray-500 mb-2">
            <span>{t.toolDisplay.diff}</span>
            <div className="flex-1 h-px bg-gray-700/50" />
            <button
              onClick={() => setShowDiff(false)}
              className="text-gray-500 hover:text-zinc-300 px-2 transition-colors"
            >
              {t.toolDisplay.hide}
            </button>
          </div>
          <DiffView
            oldText={editFileArgs.oldString}
            newText={editFileArgs.newString}
            fileName={editFileArgs.filePath.split('/').pop()}
            className="border border-gray-700/50 rounded-lg overflow-hidden"
          />
        </div>
      )}

      {/* Arguments section - hidden in compact mode */}
      {!compact && args && (
        <div>
          {isEmptyEdit ? (
            <div className="text-xs text-zinc-500 italic py-1">
              {copy.noChange} · {editFileArgs!.filePath.split('/').pop()}
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 text-xs font-medium text-gray-500 mb-2">
                <span>{t.toolDisplay.args}</span>
                <div className="flex-1 h-px bg-gray-700/50" />
                {isEditFile && !showDiff && (
                  <button
                    onClick={() => setShowDiff(true)}
                    className="text-badge-info hover:text-badge-info px-2 transition-colors"
                  >
                    {copy.viewDiff}
                  </button>
                )}
              </div>
              {(() => {
                if (isEditFile && editFileArgs) {
                  return (
                    <pre className="text-xs text-zinc-400 bg-gray-900/50 rounded-lg p-3 overflow-x-auto scrollbar-hidden border border-gray-800/50 whitespace-pre-wrap">
                      {`${copy.fileLabel}: ${editFileArgs.filePath}\n${copy.changesLabel}: ${editFileArgs.oldString.length} → ${editFileArgs.newString.length} ${copy.characters}`}
                    </pre>
                  );
                }
                const formatted = formatArgs(name, args, copy);
                return formatted.language === 'json' ? (
                  <JsonHighlight code={formatted.text} />
                ) : (
                  <pre className="text-xs text-zinc-400 bg-gray-900/50 rounded-lg p-3 overflow-x-auto scrollbar-hidden border border-gray-800/50 whitespace-pre-wrap">
                    {formatted.text}
                  </pre>
                );
              })()}
            </>
          )}
        </div>
      )}

      {!result && (
        <>
          {genericMediaAsset && <GenericMediaResultDisplay asset={genericMediaAsset} pointerEvent={pointerEvent} />}
          <LiveToolOutput toolCall={toolCall} />
        </>
      )}

      {/* Result section */}
      {result && (
        <div className="animate-fadeIn">
          {!imageResult && !videoResult && !genericMediaAsset && !generatedFileResult && !createdFilePath && (
            <div className="flex items-center gap-2 text-xs font-medium text-gray-500 mb-2">
              <span>{result.success ? copy.result : copy.error}</span>
              <div className="flex-1 h-px bg-gray-700/50" />
            </div>
          )}

          {/* Image result display */}
          {imageResult && result.success && (
            <ImageResultDisplay
              imagePath={imageResult.imagePath}
              imageBase64={imageResult.imageBase64}
              asset={imageAsset}
              pointerEvent={pointerEvent}
            />
          )}

          {/* Video result display */}
          {videoResult && result.success && (
            <VideoResultDisplay
              videoUrl={videoResult.videoUrl}
              coverUrl={videoResult.coverUrl}
              videoPath={videoResult.videoPath}
              duration={videoResult.duration}
              aspectRatio={videoResult.aspectRatio}
              asset={videoAsset}
            />
          )}

          {genericMediaAsset && (result.success || genericMediaAsset.state === 'failed') && (
            <GenericMediaResultDisplay asset={genericMediaAsset} pointerEvent={pointerEvent} />
          )}

          {/* Generated file display (ppt_generate, etc.) */}
          {generatedFileResult && result.success && (
            <FileResultDisplay
              filePath={generatedFileResult.filePath}
              canPreview={false}
              onPreview={() => {}}
            />
          )}

          {/* Created file display for Write */}
          {createdFilePath && result.success && (
            <FileResultDisplay
              filePath={createdFilePath}
              canPreview={canPreviewCreated}
              onPreview={() => openPreview(createdFilePath)}
            />
          )}

          {/* Standard result output */}
          {!imageResult && !videoResult && !genericMediaAsset && !generatedFileResult && !createdFilePath && (
            <>
              {browserComputerNextSteps.length > 0 && (
                <BrowserComputerNextStepActions actions={browserComputerNextSteps} copy={copy} />
              )}
              {showGenericErrorActions && (
                <GenericToolErrorActions
                  errorText={stripAnsiCodes(toolErrorActions.errorText)}
                  canRetry={toolErrorActions.canRetry}
                  messageId={mediaContext?.messageId}
                  copy={copy}
                />
              )}
              {!result.success && !safeBrowserComputerResult ? (
                <div className="rounded-lg border border-badge-warning/20 bg-amber-500/[0.04] p-3 text-xs">
                  <div className="font-medium text-badge-warning/90">
                    {humanError?.summary ?? copy.genericErrorSummary}
                  </div>
                  {(humanError?.detail ?? copy.genericErrorDetail) && (
                    <div className="mt-1 text-badge-warning/60">
                      {humanError?.detail ?? copy.genericErrorDetail}
                    </div>
                  )}
                  {humanError?.settingsHint && (
                    <button
                      type="button"
                      onClick={() => openSettingsTab('model')}
                      className="mt-2 inline-flex items-center gap-1 rounded-md border border-badge-warning/25 bg-amber-400/10 px-2 py-1 text-[11px] text-badge-warning transition-colors hover:bg-amber-400/20"
                    >
                      {copy.settingsHint}
                    </button>
                  )}
                  {!interruptionPlaceholder && (
                    <>
                      <button
                        type="button"
                        onClick={() => setShowRawError((v) => !v)}
                        className="mt-2 block text-[11px] text-zinc-500 transition-colors hover:text-zinc-300"
                      >
                        {showRawError ? copy.hideRawError : copy.viewRawError}
                      </button>
                      {showRawError && (
                        <pre className="mt-1.5 max-h-48 overflow-auto scrollbar-hidden whitespace-pre-wrap break-words rounded-md border border-zinc-800/50 bg-gray-900/50 p-2 text-[11px] text-zinc-500">
                          {stripAnsiCodes(result.error || '')}
                        </pre>
                      )}
                    </>
                  )}
                </div>
              ) : (!safeBrowserComputerResult && !result.error && result.output !== null && typeof result.output === 'object') ? (
                // 对象/数组型 output（非字符串日志）走 JSON 语法高亮
                <JsonHighlight code={JSON.stringify(result.output, null, 2)} error={!result.success} />
              ) : (
                <CappedResultBody
                  text={
                    safeBrowserComputerResult
                      ? stripAnsiCodes(safeBrowserComputerResult)
                      : result.error
                        ? stripAnsiCodes(result.error)
                        : typeof result.output === 'string'
                          ? stripAnsiCodes(result.output)
                          : JSON.stringify(result.output, null, 2)
                  }
                  lineCap={isShellTool(name) ? SHELL_RESULT_BODY_LINE_CAP : RESULT_BODY_LINE_CAP}
                  copy={copy}
                  className={`text-xs bg-gray-900/50 rounded-lg p-3 overflow-x-auto scrollbar-hidden border transition-colors duration-200 whitespace-pre-wrap break-words ${
                    result.success
                      ? 'text-zinc-400 border-gray-800/50'
                      : 'text-badge-danger border-red-500/20'
                  }`}
                />
              )}
            </>
          )}
        </div>
      )}

      {/* Memory citations: 模型从 memory 来源引用片段时同步出 rationale + lineRange */}
      {(() => {
        const rawCitations = toolCall.result?.metadata?.citations;
        if (!Array.isArray(rawCitations) || rawCitations.length === 0) return null;
        return <MemoryCitationGroup citations={rawCitations as Citation[]} />;
      })()}
    </div>
  );
}

interface BrowserComputerNextStepAction {
  id:
    | 'launch_managed_browser'
    | 'refresh_browser_snapshot'
    | 'open_desktop_status'
    | 'observe_current_window'
    | 'list_ax_candidates';
  title: string;
  detail: string;
  executable: boolean;
  sourceToolName?: string;
  sourceArgs?: Record<string, unknown>;
  run?: () => Promise<BrowserComputerRecoveryOutcome>;
}

export function getBrowserComputerNextSteps(
  toolCall: ToolCall,
  copy: ToolDetailsCopy,
): BrowserComputerNextStepAction[] {
  const recovery = copy.recovery;
  if (!toolCall.result || toolCall.result.success) {
    return [];
  }
  const action = typeof toolCall.arguments?.action === 'string' ? toolCall.arguments.action : '';
  const error = `${toolCall.result.error || ''}`.toLowerCase();
  const code = typeof toolCall.result.metadata?.code === 'string' ? toolCall.result.metadata.code : '';
  const catalog = getBrowserComputerActionCatalogEntry(toolCall.name, action, toolCall.arguments);

  if (
    toolCall.name === 'browser_action'
    && catalog?.requiresManagedSession
    && (error.includes('browser not running') || error.includes('managed browser'))
  ) {
    return [{
      id: 'launch_managed_browser',
      title: recovery.launchBrowserTitle,
      detail: recovery.launchBrowserDetail,
      executable: true,
      sourceToolName: toolCall.name,
      sourceArgs: toolCall.arguments,
      run: async () => {
        const response = await window.domainAPI?.invoke(IPC_DOMAINS.DESKTOP, 'ensureManagedBrowserSession', {
          url: 'about:blank',
          provider: 'system-chrome-cdp',
        });
        if (response?.success) {
          return {
            status: 'success',
            text: recovery.launchBrowserSuccess,
          };
        }
        return {
          status: 'failed',
          text: formatRecoveryFailure(recovery.launchBrowserFailed),
        };
      },
    }];
  }

  if (toolCall.name === 'computer_use' && catalog?.scope === 'browser_scoped_computer') {
    return [buildBrowserSnapshotRecoveryAction(toolCall, recovery)];
  }

  if (toolCall.name === 'computer_use' && catalog?.scope === 'desktop_surface') {
    const targetApp = typeof toolCall.arguments?.targetApp === 'string'
      ? toolCall.arguments.targetApp
      : '';
    const actions: BrowserComputerNextStepAction[] = [{
      id: 'open_desktop_status',
      title: recovery.openStatusTitle,
      detail: recovery.openStatusDetail,
      executable: true,
      sourceToolName: toolCall.name,
      sourceArgs: toolCall.arguments,
      run: async () => {
        const response = await window.domainAPI?.invoke(IPC_DOMAINS.DESKTOP, 'getComputerSurfaceState', {
          targetApp: targetApp || undefined,
        });
        if (response?.success) {
          return {
            status: 'success',
            text: [
              recovery.openStatusSuccess,
              ...summarizeComputerSurfaceState(response.data, recovery),
              recovery.openStatusSafety,
            ].join('\n'),
          };
        }
        return {
          status: 'failed',
          text: formatRecoveryFailure(recovery.openStatusFailed),
        };
      },
    }];

    actions.push({
      id: 'observe_current_window',
      title: recovery.observeWindowTitle,
      detail: recovery.observeWindowDetail,
      executable: true,
      sourceToolName: toolCall.name,
      sourceArgs: toolCall.arguments,
      run: async () => {
        const response = await window.domainAPI?.invoke(IPC_DOMAINS.DESKTOP, 'observeComputerSurface', {
          includeScreenshot: false,
        });
        if (response?.success) {
          return {
            status: 'success',
            text: [
              recovery.observeWindowSuccess,
              ...summarizeComputerSurfaceObservation(response.data, recovery),
              recovery.observeWindowSafety,
            ].join('\n'),
          };
        }
        return {
          status: 'failed',
          text: formatRecoveryFailure(recovery.observeWindowFailed),
        };
      },
    });

    if (targetApp) {
      actions.push({
        id: 'list_ax_candidates',
        title: recovery.listCandidatesTitle,
        detail: recovery.listCandidatesDetail.replace('{app}', targetApp),
        executable: true,
        sourceToolName: toolCall.name,
        sourceArgs: toolCall.arguments,
        run: async () => {
          const response = await window.domainAPI?.invoke(IPC_DOMAINS.DESKTOP, 'listComputerSurfaceElements', {
            targetApp,
            limit: 12,
          });
          if (response?.success) {
            return {
              status: 'success',
              text: [
                recovery.listCandidatesSuccess,
                ...summarizeComputerSurfaceElements(response.data, targetApp, recovery),
                recovery.listCandidatesSafety,
              ].join('\n'),
            };
          }
          return {
            status: 'failed',
            text: formatRecoveryFailure(recovery.listCandidatesFailed),
          };
        },
      });
    }

    return actions;
  }

  if (
    toolCall.name === 'browser_action'
    && code === 'STALE_TARGET_REF'
    && catalog?.safeRecovery === 'refresh_managed_snapshot'
  ) {
    return [buildBrowserSnapshotRecoveryAction(toolCall, recovery)];
  }

  return [];
}

function buildBrowserSnapshotRecoveryAction(
  toolCall: ToolCall,
  recovery: RecoveryCopy,
): BrowserComputerNextStepAction {
  return {
    id: 'refresh_browser_snapshot',
    title: recovery.refreshEvidenceTitle,
    detail: recovery.refreshEvidenceDetail,
    executable: true,
    sourceToolName: toolCall.name,
    sourceArgs: toolCall.arguments,
    run: async () => {
      const response = await window.domainAPI?.invoke<Record<string, unknown>>(
        IPC_DOMAINS.DESKTOP,
        'getManagedBrowserRecoverySnapshot',
        { includeAccessibility: true },
      );
      const data = response?.data;
      const dom = data?.domSnapshot as Record<string, unknown> | undefined;
      const accessibility = data?.accessibilitySnapshot as Record<string, unknown> | undefined;
      const recoveryEvidence = data?.recoveryEvidence as Record<string, unknown> | undefined;
      const headingCount = typeof dom?.headingCount === 'number' ? dom.headingCount : 0;
      const interactiveCount = typeof dom?.interactiveCount === 'number' ? dom.interactiveCount : 0;
      const accessibilityStatus = accessibility?.available ? recovery.available : recovery.unavailable;
      const capturedAtMs = typeof recoveryEvidence?.snapshotCapturedAtMs === 'number'
        ? recoveryEvidence.snapshotCapturedAtMs
        : typeof dom?.capturedAtMs === 'number'
          ? dom.capturedAtMs
          : null;
      const snapshotTimestamp = capturedAtMs && Number.isFinite(capturedAtMs)
        ? new Date(capturedAtMs).toISOString()
        : recovery.unavailable;
      return {
        status: 'success',
        text: [
          recovery.refreshEvidenceSuccess,
          `${recovery.headings}: ${headingCount}`,
          `${recovery.interactiveElements}: ${interactiveCount}`,
          `${recovery.accessibilitySnapshot}: ${accessibilityStatus}`,
          `${recovery.capturedAt}: ${snapshotTimestamp}`,
        ].join('\n'),
      };
    },
  };
}

type BrowserComputerRecoveryOutcome = {
  status: 'preparing' | 'success' | 'failed';
  text: string;
};

function BrowserComputerNextStepActions({
  actions,
  copy,
}: {
  actions: BrowserComputerNextStepAction[];
  copy: ToolDetailsCopy;
}) {
  const [runningAction, setRunningAction] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<BrowserComputerRecoveryOutcome | null>(null);

  return (
    <div className="mb-2 space-y-1.5">
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          data-testid={`browser-computer-next-step-action-${action.id}`}
          disabled={!action.executable || !action.run || runningAction === action.id}
          onClick={async (event) => {
            event.stopPropagation();
            if (!action.run) return;
            setRunningAction(action.id);
            setOutcome({ status: 'preparing', text: copy.recovery.preparing });
            try {
              setOutcome(await action.run());
            } catch {
              setOutcome({
                status: 'failed',
                text: copy.genericErrorSummary,
              });
            } finally {
              setRunningAction(null);
            }
          }}
          className={`flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left text-xs transition-colors ${
            action.executable
              ? 'border-badge-info/20 bg-sky-500/10 text-badge-info hover:bg-sky-500/15'
              : 'border-zinc-700/50 bg-zinc-900/50 text-zinc-300'
          }`}
        >
          <Play className="mt-0.5 h-3 w-3 flex-shrink-0" />
          <span className="min-w-0">
            <span className="block font-medium">{action.title}</span>
            <span className="block text-[11px] text-zinc-400">{action.detail}</span>
          </span>
        </button>
      ))}
      {outcome && (
        <pre
          data-testid="browser-computer-recovery-outcome"
          className={`whitespace-pre-wrap rounded-lg border p-2 text-[11px] ${
            outcome.status === 'failed'
              ? 'border-red-500/20 bg-red-500/10 text-badge-danger'
              : outcome.status === 'preparing'
                ? 'border-badge-info/20 bg-sky-500/10 text-badge-info'
                : 'border-badge-success/20 bg-emerald-500/10 text-badge-success'
          }`}
        >
          {sanitizeBrowserComputerRecoveryText(outcome.text, actions)}
        </pre>
      )}
    </div>
  );
}

// 通用失败工具的可点 action 行：复制错误 + 从此重试。
// 「从此重试」复用 messageActionStore.createForkFromReply（与会话页消息级 Fork 同源），
// 在所属 assistant 消息处 fork 重跑；拿不到 messageId 时只显示复制。
function GenericToolErrorActions({
  errorText,
  canRetry,
  messageId,
  copy,
}: {
  errorText: string;
  canRetry: boolean;
  messageId?: string;
  copy: ToolDetailsCopy;
}) {
  const [copied, setCopied] = useState(false);
  const createForkFromReply = useMessageActionStore((state) => state.createForkFromReply);

  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      <button
        type="button"
        data-testid="tool-error-copy"
        onClick={async (event) => {
          event.stopPropagation();
          const ok = await copyPathToClipboard(errorText);
          if (ok) {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }
        }}
        className="inline-flex items-center gap-1 rounded-md border border-zinc-700/60 bg-zinc-800/60 px-2 py-1 text-[11px] text-zinc-300 transition-colors hover:bg-zinc-700/60"
      >
        {copied ? <Check className="h-3 w-3 text-badge-success" /> : <Copy className="h-3 w-3" />}
        {copied ? copy.copied : copy.copyError}
      </button>
      {canRetry && messageId && (
        <button
          type="button"
          data-testid="tool-error-retry"
          onClick={(event) => {
            event.stopPropagation();
            createForkFromReply(messageId);
          }}
          className="inline-flex items-center gap-1 rounded-md border border-badge-info/25 bg-sky-500/10 px-2 py-1 text-[11px] text-badge-info transition-colors hover:bg-sky-500/20"
        >
          <RotateCcw className="h-3 w-3" />
          {copy.retryFromHere}
        </button>
      )}
    </div>
  );
}

function sanitizeBrowserComputerRecoveryText(
  text: string,
  actions: BrowserComputerNextStepAction[],
): string {
  const source = actions.find((action) => action.sourceArgs);
  const redacted = redactBrowserComputerInputPayloadsInValue(
    source?.sourceToolName || 'computer_use',
    source?.sourceArgs || {},
    text,
  );
  return typeof redacted === 'string' ? redacted : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function formatRecoveryFailure(title: string): string {
  return title;
}

function summarizeComputerSurfaceState(data: unknown, copy: RecoveryCopy): string[] {
  const state = isRecord(data) && isRecord(data.state) ? data.state : isRecord(data) ? data : null;
  if (!state) return [copy.stateUnavailable];
  return [
    typeof state.mode === 'string' ? `${copy.mode}: ${state.mode}` : null,
    typeof state.targetApp === 'string' && state.targetApp ? `${copy.targetApp}: ${state.targetApp}` : null,
    typeof state.requiresForeground === 'boolean'
      ? `${copy.needsForeground}: ${state.requiresForeground ? copy.yes : copy.no}`
      : null,
    typeof state.approvalScope === 'string' ? `${copy.approvalScope}: ${state.approvalScope}` : null,
  ].filter((line): line is string => Boolean(line));
}

function summarizeComputerSurfaceObservation(data: unknown, copy: RecoveryCopy): string[] {
  const snapshot = isRecord(data) && isRecord(data.snapshot) ? data.snapshot : null;
  const stateLines = isRecord(data) ? summarizeComputerSurfaceState(data.state, copy) : [];
  return [
    snapshot && typeof snapshot.appName === 'string' ? `${copy.frontmostApp}: ${snapshot.appName}` : null,
    snapshot && typeof snapshot.windowTitle === 'string' ? `${copy.windowTitle}: ${snapshot.windowTitle}` : null,
    ...stateLines,
  ].filter((line): line is string => Boolean(line));
}

function summarizeComputerSurfaceElements(
  data: unknown,
  targetApp: string,
  copy: RecoveryCopy,
): string[] {
  const metadata = isRecord(data) && isRecord(data.metadata) ? data.metadata : null;
  const output = isRecord(data) && typeof data.output === 'string' ? data.output : '';
  const candidateCount = Array.isArray(metadata?.elements)
    ? metadata.elements.length
    : Array.isArray(metadata?.candidates)
      ? metadata.candidates.length
      : null;
  const outputLines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4);
  return [
    `${copy.targetApp}: ${targetApp}`,
    candidateCount !== null ? `${copy.candidateCount}: ${candidateCount}` : null,
    ...outputLines,
  ].filter((line): line is string => Boolean(line));
}

// ============================================================================
// Helper Functions
// ============================================================================

// language='json' 表示返回的是结构化 JSON 转储，可走语法高亮；
// 'text' 表示是人话标签（File: / Command: 等），保持纯文本展示。
type FormattedArgs = { text: string; language: 'json' | 'text' };

function formatArgs(
  toolName: string,
  args: Record<string, unknown>,
  copy: ToolDetailsCopy,
): FormattedArgs {
  const browserComputerArgs = formatBrowserComputerActionArguments(toolName, args);
  if (browserComputerArgs) {
    return { text: browserComputerArgs, language: 'text' };
  }

  switch (toolName) {
    case 'Read': {
      let filePath = (args.file_path as string) || '';
      if (filePath.includes(' offset=') || filePath.includes(' limit=')) {
        filePath = filePath.split(' ')[0];
      }
      const offset = args.offset as number;
      const limit = args.limit as number;
      let result = `${copy.fileLabel}: ${filePath}`;
      if (offset && offset > 1) result += `\n${copy.offsetLabel}: ${offset}`;
      if (limit && limit !== 2000) result += `\n${copy.limitLabel}: ${limit}`;
      return { text: result, language: 'text' };
    }

    case 'Write': {
      const filePath = (args.file_path as string) || '';
      const content = (args.content as string) || '';
      return {
        text: `${copy.fileLabel}: ${filePath}\n${copy.contentLabel}: ${content.length} ${copy.characters}`,
        language: 'text',
      };
    }

    case 'Bash': {
      const command = (args.command as string) || '';
      return { text: `${copy.commandLabel}:\n${command}`, language: 'text' };
    }

    case 'Glob': {
      const pattern = (args.pattern as string) || '';
      const path = (args.path as string) || '.';
      return { text: `${copy.patternLabel}: ${pattern}\n${copy.pathLabel}: ${path}`, language: 'text' };
    }

    case 'Grep': {
      const pattern = (args.pattern as string) || '';
      const path = (args.path as string) || '.';
      return { text: `${copy.patternLabel}: ${pattern}\n${copy.pathLabel}: ${path}`, language: 'text' };
    }

    case 'list_directory': {
      const path = (args.path as string) || '.';
      return { text: `${copy.pathLabel}: ${path}`, language: 'text' };
    }

    default:
      return { text: JSON.stringify(args, null, 2), language: 'json' };
  }
}

function extractCreatedFilePath(toolCall: {
  name: string;
  arguments?: Record<string, unknown>;
  result?: { success: boolean; output?: unknown };
}): string | null {
  if (toolCall.name !== 'Write') return null;

  // If result exists and failed, don't show file
  if (toolCall.result && !toolCall.result.success) return null;

  // Try to extract from result output first (has absolute path)
  const output = toolCall.result?.output as string;
  if (output) {
    // Match path up to " (" which precedes the byte count, or end of line
    // Output format: "Created file: /path/to/file (1234 bytes)"
    const match = output.match(/(?:Created|Updated) file: (.+?)(?:\s+\(|\n|$)/);
    if (match) return match[1].trim();
  }

  // Fallback to arguments.file_path (may be relative path)
  // Note: This path may be relative and won't work for shell.openPath()
  // but still useful for display purposes
  return (toolCall.arguments?.file_path as string) || null;
}

function extractImageResult(toolCall: {
  name: string;
  result?: { success: boolean; metadata?: Record<string, unknown> };
}): { imagePath?: string; imageBase64?: string } | null {
  if (toolCall.name !== 'image_generate' || !toolCall.result?.success)
    return null;
  const metadata = toolCall.result.metadata;
  if (!metadata) return null;

  const imagePath = metadata.imagePath as string | undefined;
  const imageBase64 = metadata.imageBase64 as string | undefined;

  if (imagePath || imageBase64) {
    return { imagePath, imageBase64 };
  }
  return null;
}

function extractGeneratedFile(toolCall: {
  name: string;
  result?: { success: boolean; metadata?: Record<string, unknown> };
}): { filePath: string; fileName: string } | null {
  if (!['ppt_generate'].includes(toolCall.name) || !toolCall.result?.success)
    return null;
  const metadata = toolCall.result.metadata;
  if (!metadata) return null;

  const filePath = metadata.filePath as string | undefined;
  const fileName = metadata.fileName as string | undefined;

  if (filePath && fileName) {
    return { filePath, fileName };
  }
  return null;
}

function extractVideoResult(toolCall: {
  name: string;
  result?: { success: boolean; metadata?: Record<string, unknown> };
}): {
  videoUrl?: string;
  coverUrl?: string;
  videoPath?: string;
  duration?: number;
  aspectRatio?: string;
} | null {
  if (toolCall.name !== 'video_generate' || !toolCall.result?.success)
    return null;
  const metadata = toolCall.result.metadata;
  if (!metadata) return null;

  const videoUrl = metadata.videoUrl as string | undefined;
  const coverUrl = metadata.coverUrl as string | undefined;
  const videoPath = metadata.videoPath as string | undefined;
  const duration = metadata.duration as number | undefined;
  const aspectRatio = metadata.aspectRatio as string | undefined;

  if (videoUrl || videoPath) {
    return { videoUrl, coverUrl, videoPath, duration, aspectRatio };
  }
  return null;
}

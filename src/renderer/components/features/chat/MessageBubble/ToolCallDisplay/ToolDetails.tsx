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
import { humanizeToolError, buildToolErrorActions } from '../../../../../utils/toolExecutionPresentation';
import { useI18n } from '../../../../../hooks/useI18n';
import { useMessageActionStore } from '../../../../../stores/messageActionStore';
import { copyPathToClipboard } from '../../../../../utils/platform';
import {
  ImageResultDisplay,
  GenericMediaResultDisplay,
  FileResultDisplay,
  VideoResultDisplay,
} from './ToolResultMediaDisplays';

// Prism 语法高亮(~react-syntax-highlighter)按需动态加载,只在真的渲染 JSON 高亮时才下载。
const LazyPrismCodeBlock = lazy(() => import('../PrismCodeBlock'));

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
// 复用 MessageContent 同款 Prism + oneDark。纯文本/日志/带行号输出不走这里，
// 避免把 Read 的 "  1→code" 行号前缀或 Bash 日志当代码高亮弄乱。
const JSON_HIGHLIGHT_STYLE: React.CSSProperties = {
  margin: 0,
  padding: '0.75rem',
  fontSize: '0.75rem',
  lineHeight: 1.5,
  background: 'rgba(17, 24, 39, 0.5)',
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
      <LazyPrismCodeBlock
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

function isShellTool(name: string): boolean {
  return name === 'Bash' || name === 'bash';
}

function CappedResultBody({
  text,
  lineCap,
  className,
}: {
  text: string;
  lineCap: number;
  className: string;
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
          {showAll ? '收起' : `展开剩余 ${overflow} 行`}
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

  // 报错说人话：识别得了的错误（如搜索源额度耗尽）给一行摘要 + 去设置入口，原始报错折叠。
  const humanError = result && !result.success
    ? humanizeToolError(result.error, name, t)
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
  const browserComputerNextSteps = getBrowserComputerNextSteps(toolCall);
  // 通用失败工具的可点 action（复制错误 + 从此重试）。浏览器/Computer 类有自己的
  // 只读 recovery actions，这里只兜底其余工具，避免两套 action 行重复。
  const toolErrorActions = buildToolErrorActions(toolCall, mediaContext?.messageId);
  const showGenericErrorActions = browserComputerNextSteps.length === 0 && toolErrorActions.show;

  const canPreviewCreated = isPreviewable(createdFilePath);

  return (
    <div className="mt-1 space-y-1.5 text-xs">
      {/* Diff view for Edit (skip for empty edits) */}
      {isEditFile && editFileArgs && showDiff && !isEmptyEdit && (
        <div className="animate-fadeIn">
          <div className="flex items-center gap-2 text-xs font-medium text-gray-500 mb-2">
            <span>Diff</span>
            <div className="flex-1 h-px bg-gray-700/50" />
            <button
              onClick={() => setShowDiff(false)}
              className="text-gray-500 hover:text-gray-300 px-2 transition-colors"
            >
              Hide
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
              无变化 — {editFileArgs!.filePath.split('/').pop()}
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 text-xs font-medium text-gray-500 mb-2">
                <span>Arguments</span>
                <div className="flex-1 h-px bg-gray-700/50" />
                {isEditFile && !showDiff && (
                  <button
                    onClick={() => setShowDiff(true)}
                    className="text-blue-400 hover:text-blue-300 px-2 transition-colors"
                  >
                    View Diff
                  </button>
                )}
              </div>
              {(() => {
                if (isEditFile && editFileArgs) {
                  return (
                    <pre className="text-xs text-gray-400 bg-gray-900/50 rounded-lg p-3 overflow-x-auto scrollbar-hidden border border-gray-800/50 whitespace-pre-wrap">
                      {`File: ${editFileArgs.filePath}\nChanges: ${editFileArgs.oldString.length} -> ${editFileArgs.newString.length} chars`}
                    </pre>
                  );
                }
                const formatted = formatArgs(name, args);
                return formatted.language === 'json' ? (
                  <JsonHighlight code={formatted.text} />
                ) : (
                  <pre className="text-xs text-gray-400 bg-gray-900/50 rounded-lg p-3 overflow-x-auto scrollbar-hidden border border-gray-800/50 whitespace-pre-wrap">
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
              <span>{result.success ? 'Result' : 'Error'}</span>
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
                <BrowserComputerNextStepActions actions={browserComputerNextSteps} />
              )}
              {showGenericErrorActions && (
                <GenericToolErrorActions
                  errorText={stripAnsiCodes(toolErrorActions.errorText)}
                  canRetry={toolErrorActions.canRetry}
                  messageId={mediaContext?.messageId}
                />
              )}
              {humanError && !safeBrowserComputerResult ? (
                <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.04] p-3 text-xs">
                  <div className="font-medium text-amber-200/90">{humanError.summary}</div>
                  {humanError.detail && (
                    <div className="mt-1 text-amber-100/60">{humanError.detail}</div>
                  )}
                  {humanError.settingsHint && (
                    <button
                      type="button"
                      onClick={() => openSettingsTab('model')}
                      className="mt-2 inline-flex items-center gap-1 rounded-md border border-amber-400/25 bg-amber-400/10 px-2 py-1 text-[11px] text-amber-100 transition-colors hover:bg-amber-400/20"
                    >
                      去「设置 &gt; Service API Keys」换 key ›
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowRawError((v) => !v)}
                    className="mt-2 block text-[11px] text-zinc-500 transition-colors hover:text-zinc-300"
                  >
                    {showRawError ? '收起原始报错' : '查看原始报错'}
                  </button>
                  {showRawError && (
                    <pre className="mt-1.5 max-h-48 overflow-auto scrollbar-hidden whitespace-pre-wrap break-words rounded-md border border-zinc-800/50 bg-gray-900/50 p-2 text-[11px] text-zinc-500">
                      {stripAnsiCodes(result.error || '')}
                    </pre>
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
                  className={`text-xs bg-gray-900/50 rounded-lg p-3 overflow-x-auto scrollbar-hidden border transition-colors duration-200 whitespace-pre-wrap break-words ${
                    result.success
                      ? 'text-gray-400 border-gray-800/50'
                      : 'text-red-300 border-red-500/20'
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

export function getBrowserComputerNextSteps(toolCall: ToolCall): BrowserComputerNextStepAction[] {
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
      title: '启动隔离浏览器',
      detail: '可执行；也可以从能力菜单 -> Browser -> Managed 手动切换。',
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
            text: 'success\nManaged browser 已启动\nProvider: system-chrome-cdp',
          };
        }
        return {
          status: 'failed',
          text: formatRecoveryFailure('Managed browser 启动失败', response),
        };
      },
    }];
  }

  if (toolCall.name === 'computer_use' && catalog?.scope === 'browser_scoped_computer') {
    return [buildBrowserSnapshotRecoveryAction(toolCall)];
  }

  if (toolCall.name === 'computer_use' && catalog?.scope === 'desktop_surface') {
    const targetApp = typeof toolCall.arguments?.targetApp === 'string'
      ? toolCall.arguments.targetApp
      : '';
    const actions: BrowserComputerNextStepAction[] = [{
      id: 'open_desktop_status',
      title: '打开 Desktop status',
      detail: '可执行；只读取 Computer Surface 状态，不执行点击或输入。',
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
              'success',
              'Desktop status 已打开',
              ...summarizeComputerSurfaceState(response.data),
              '只打开了状态面，没有执行点击、输入或自动重试。',
            ].join('\n'),
          };
        }
        return {
          status: 'failed',
          text: formatRecoveryFailure('Desktop status 打开失败', response),
        };
      },
    }];

    actions.push({
      id: 'observe_current_window',
      title: '观察当前窗口',
      detail: '可执行；只读取前台窗口和 Computer Surface 状态，不执行动作。',
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
              'success',
              '当前窗口已观察',
              ...summarizeComputerSurfaceObservation(response.data),
              '只读观察完成，没有执行点击、输入或自动重试。',
            ].join('\n'),
          };
        }
        return {
          status: 'failed',
          text: formatRecoveryFailure('当前窗口观察失败', response),
        };
      },
    });

    if (targetApp) {
      actions.push({
        id: 'list_ax_candidates',
        title: '列出 AX candidates',
        detail: `可执行；只读取 ${targetApp} 的 Accessibility 候选，不自动重试原动作。`,
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
                'success',
                'AX candidates 已准备',
                ...summarizeComputerSurfaceElements(response.data, targetApp),
                '只读候选已准备，没有执行点击、输入或自动重试。',
              ].join('\n'),
            };
          }
          return {
            status: 'failed',
            text: formatRecoveryFailure('AX candidates 准备失败', response),
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
    return [buildBrowserSnapshotRecoveryAction(toolCall)];
  }

  return [];
}

function buildBrowserSnapshotRecoveryAction(toolCall: ToolCall): BrowserComputerNextStepAction {
  return {
    id: 'refresh_browser_snapshot',
    title: '刷新页面证据',
    detail: '可执行；读取 DOM / Accessibility snapshot，方便下次用新 targetRef、选择器或 AX 证据重试。',
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
      const accessibilityStatus = accessibility?.available ? 'available' : 'unavailable';
      const capturedAtMs = typeof recoveryEvidence?.snapshotCapturedAtMs === 'number'
        ? recoveryEvidence.snapshotCapturedAtMs
        : typeof dom?.capturedAtMs === 'number'
          ? dom.capturedAtMs
          : null;
      const snapshotTimestamp = capturedAtMs && Number.isFinite(capturedAtMs)
        ? new Date(capturedAtMs).toISOString()
        : 'unavailable';
      return {
        status: 'success',
        text: [
          'success',
          '页面证据已刷新',
          `DOM headings: ${headingCount}`,
          `Interactive elements: ${interactiveCount}`,
          `Accessibility snapshot: ${accessibilityStatus}`,
          `Snapshot captured: ${snapshotTimestamp}`,
        ].join('\n'),
      };
    },
  };
}

type BrowserComputerRecoveryOutcome = {
  status: 'preparing' | 'success' | 'failed';
  text: string;
};

function BrowserComputerNextStepActions({ actions }: { actions: BrowserComputerNextStepAction[] }) {
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
            setOutcome({ status: 'preparing', text: 'preparing\n正在准备只读 recovery 证据…' });
            try {
              setOutcome(await action.run());
            } catch (error) {
              setOutcome({
                status: 'failed',
                text: `failed\n${error instanceof Error ? error.message : String(error)}`,
              });
            } finally {
              setRunningAction(null);
            }
          }}
          className={`flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left text-xs transition-colors ${
            action.executable
              ? 'border-sky-500/20 bg-sky-500/10 text-sky-100 hover:bg-sky-500/15'
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
              ? 'border-red-500/20 bg-red-500/10 text-red-100'
              : outcome.status === 'preparing'
                ? 'border-sky-500/20 bg-sky-500/10 text-sky-100'
                : 'border-emerald-500/20 bg-emerald-500/10 text-emerald-100'
          }`}
        >
          {sanitizeBrowserComputerRecoveryText(outcome.text, actions)}
        </pre>
      )}
    </div>
  );
}

// 通用失败工具的可点 action 行：复制错误 + 从此重试。
// 「从此重试」复用 messageActionStore.forkFromHere（与会话页消息级「从此重试」同源），
// 在所属 assistant 消息处 fork 重跑；拿不到 messageId 时只显示复制。
function GenericToolErrorActions({
  errorText,
  canRetry,
  messageId,
}: {
  errorText: string;
  canRetry: boolean;
  messageId?: string;
}) {
  const [copied, setCopied] = useState(false);
  const forkFromHere = useMessageActionStore((state) => state.forkFromHere);

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
        {copied ? <Check className="h-3 w-3 text-green-400" /> : <Copy className="h-3 w-3" />}
        {copied ? '已复制' : '复制错误'}
      </button>
      {canRetry && messageId && (
        <button
          type="button"
          data-testid="tool-error-retry"
          onClick={(event) => {
            event.stopPropagation();
            forkFromHere(messageId);
          }}
          className="inline-flex items-center gap-1 rounded-md border border-sky-500/25 bg-sky-500/10 px-2 py-1 text-[11px] text-sky-100 transition-colors hover:bg-sky-500/20"
        >
          <RotateCcw className="h-3 w-3" />
          从此重试
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

function formatRecoveryFailure(title: string, response: unknown): string {
  if (isRecord(response) && isRecord(response.error)) {
    const message = typeof response.error.message === 'string' ? response.error.message : 'unknown error';
    return ['failed', title, message].join('\n');
  }
  return ['failed', title, 'unknown error'].join('\n');
}

function summarizeComputerSurfaceState(data: unknown): string[] {
  const state = isRecord(data) && isRecord(data.state) ? data.state : isRecord(data) ? data : null;
  if (!state) return ['State: unavailable'];
  return [
    typeof state.mode === 'string' ? `Mode: ${state.mode}` : null,
    typeof state.targetApp === 'string' && state.targetApp ? `Target app: ${state.targetApp}` : null,
    typeof state.requiresForeground === 'boolean' ? `Requires foreground: ${state.requiresForeground ? 'yes' : 'no'}` : null,
    typeof state.approvalScope === 'string' ? `Approval scope: ${state.approvalScope}` : null,
  ].filter((line): line is string => Boolean(line));
}

function summarizeComputerSurfaceObservation(data: unknown): string[] {
  const snapshot = isRecord(data) && isRecord(data.snapshot) ? data.snapshot : null;
  const stateLines = isRecord(data) ? summarizeComputerSurfaceState(data.state) : [];
  return [
    snapshot && typeof snapshot.appName === 'string' ? `Frontmost app: ${snapshot.appName}` : null,
    snapshot && typeof snapshot.windowTitle === 'string' ? `Window title: ${snapshot.windowTitle}` : null,
    ...stateLines,
  ].filter((line): line is string => Boolean(line));
}

function summarizeComputerSurfaceElements(data: unknown, targetApp: string): string[] {
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
    `Target app: ${targetApp}`,
    candidateCount !== null ? `Candidates: ${candidateCount}` : null,
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
  args: Record<string, unknown>
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
      let result = `File: ${filePath}`;
      if (offset && offset > 1) result += `\nOffset: ${offset}`;
      if (limit && limit !== 2000) result += `\nLimit: ${limit}`;
      return { text: result, language: 'text' };
    }

    case 'Write': {
      const filePath = (args.file_path as string) || '';
      const content = (args.content as string) || '';
      return { text: `File: ${filePath}\nContent: ${content.length} chars`, language: 'text' };
    }

    case 'Bash': {
      const command = (args.command as string) || '';
      return { text: `Command:\n${command}`, language: 'text' };
    }

    case 'Glob': {
      const pattern = (args.pattern as string) || '';
      const path = (args.path as string) || '.';
      return { text: `Pattern: ${pattern}\nPath: ${path}`, language: 'text' };
    }

    case 'Grep': {
      const pattern = (args.pattern as string) || '';
      const path = (args.path as string) || '.';
      return { text: `Pattern: ${pattern}\nPath: ${path}`, language: 'text' };
    }

    case 'list_directory': {
      const path = (args.path as string) || '.';
      return { text: `Path: ${path}`, language: 'text' };
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

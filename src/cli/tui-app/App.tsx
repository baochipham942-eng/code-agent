// ============================================================================
// Ink TUI：Static（被挤出视口的封口消息）→ live（预算内消息，与 Static 互斥）
// → Turn status → Slash → 多行编辑器 → StatusBar → ShortcutsBar。
// 动态块高度 = 终端行高，输入钉底；live 与 Static 不得重复渲染同一条。
// P2 能力：多行编辑（Shift+Enter/Ctrl+J/`\` 续行）、粘贴 chip、slash 补全、
// 真 slash 命令（onCommand 注入）、运行中排队 follow-up、100 条输入历史。
// P1 高频体感：/ps /stop 后台任务（StatusBar 计数）、OSC 9 终端通知（失焦才发）、
// 审批卡扩充（allow-all-edits/never/附反馈/inline diff）、Ctrl+Q 双击退出、
// Ctrl+R prompt 历史搜索。
// P2b：/model 交互选择器（blocking picker，↑↓+Enter 切换）。
// ============================================================================

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Box, Static, Text, useInput, useStdout } from 'ink';
import type { CLIAgent } from '../adapter';
import type { AgentEvent } from '../../shared/contract';
import type { PermissionAskResult } from '../../shared/contract/permission';
import type { PermissionRequestData } from '../../host/tools/types';
import { setInteractiveApprovalProvider } from '../permissionPolicy';
import { approvalOptions, SessionAllowList, type ApprovalChoice } from './approval';
import { ApprovalCard } from './ApprovalCard';
import { onBackgroundTaskLifecycleEvent } from '../../host/tools/shell/backgroundTasks';
import { pickStartupTip } from './tips';
import { WelcomeCard } from './WelcomeCard';
import {
  formatWorkspaceLine,
  WELCOME_ACTIONS,
  WELCOME_COMPACT_ROWS,
  welcomeActionIndexAt,
  type WelcomeActionId,
} from './welcomeSplash';
import {
  isMouseEventInput,
  MOUSE_SGR_DISABLE,
  MOUSE_SGR_ENABLE,
  parseSgrMouse,
} from './mouse';
import {
  buildTerminalNotification,
  buildTerminalTitleSequence,
  FOCUS_REPORTING_DISABLE,
  FOCUS_REPORTING_ENABLE,
  formatTerminalTitle,
  classifyStrippedCsi,
  isFocusEventInput,
  parseFocusEvent,
  shouldTerminalNotify,
} from './terminalNotification';
import { queueActionAt, type QueueActionId } from './queueBar';
import {
  appendShellCommand,
  appendSystemMessage,
  appendUserMessage,
  createChatState,
  markRunStarted,
  reduceAgentEvent,
  resolveShellCommand,
  type ChatMessage,
  type ChatState,
} from './events';
import {
  applyPaste,
  backspace,
  content,
  createEditorState,
  expandedContent,
  insertNewline,
  insertText,
  isEmpty,
  moveDown,
  moveEnd,
  moveHome,
  moveLeft,
  moveRight,
  moveUp,
  PromptHistory,
  withContent,
  type EditorState,
} from './editorState';
import { filterSlashCommands, type SlashItem } from './slashCommands';
import { editorVisualRows, hitLiveToolGroup, partitionScrollback, planDynamicLayout } from './layout';
import { HistorySearchBar, QueueBar, ShortcutsBar, StatusBar, Toast, TurnStatus } from './chrome';
import { Editor } from './Editor';
import { SlashMenu } from './SlashMenu';
import { MessageView } from './MessageView';
import { ModelPicker } from './ModelPicker';
import type { ModelPickerItem } from './modelItems';

interface InkCommandResult {
  /** 命令产生的文本输出（渲染为系统消息） */
  output?: string;
  /** /exit 类命令请求退出 */
  exit?: boolean;
}

export interface InkChatOptions {
  cwd: string;
  model: string;
  /** 当前 provider（StatusBar；/model 切换后由事件流刷新） */
  provider?: string;
  /** 产品版本（欢迎海报标题行） */
  version?: string;
  /** git 分支（首屏顶左 + StatusBar；取不到传空串） */
  gitBranch: string;
  /** 工作树有未提交改动（StatusBar 分支名后加 *） */
  gitDirty?: boolean;
  /** slash 命令执行入口（chat.ts 注入，内部走统一 handleCommand） */
  onCommand: (input: string) => Promise<InkCommandResult>;
  /** `!` shell 直通入口（chat.ts 注入，内部走 ToolExecutor 正式链路） */
  onShellCommand: (command: string) => Promise<{ success: boolean; output?: string; error?: string }>;
  /** slash 补全数据源（注册表 cli 命令 + 本地命令） */
  slashItems: SlashItem[];
  /** /model 交互选择器数据源（chat.ts 由 PROVIDER_REGISTRY 构建） */
  modelItems: ModelPickerItem[];
  /** StatusBar 左侧权限档（TTY 默认 auto） */
  permissionLabel?: string;
  /** 当前会话标题（终端标签标题用；首条消息后会被自动命名，调用方在 turn 边界重取） */
  getSessionTitle?: () => Promise<string | null>;
}

/** braille spinner，降到 ~4fps：Ink 每次帧变化整屏擦除重写，133ms 一档肉眼可见闪烁 */
const SPINNER_INTERVAL_MS = 250;

/** Toast 自动消失时间 */
const TOAST_MS = 3000;
/** Esc 取消后的手势冷静期（规格：取消后 1s 内不触发其他 Esc 手势） */
const CANCEL_COOLDOWN_MS = 1000;
/** Ctrl+Q 双击确认退出的时间窗（规格：1000ms 防误触） */
const QUIT_CONFIRM_MS = 1000;

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function App({ agent, options, onExit }: {
  agent: CLIAgent;
  options: InkChatOptions;
  onExit: () => void;
}) {
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;

  const [state, setState] = useState<ChatState>(createChatState);
  const [editor, setEditorState] = useState<EditorState>(createEditorState);
  // 编辑器真源（同步更新，连续按键/合批时闭包过期会乱序），state 只驱动渲染
  const editorRef = useRef(editor);
  const setEditor = useCallback((next: EditorState) => {
    editorRef.current = next;
    slashDismissedRef.current = false; // 文本变化后 slash 菜单重新可用
    setEditorState(next);
  }, []);
  const historyRef = useRef(new PromptHistory());
  const queueRef = useRef<string[]>([]);
  const [queuedItems, setQueuedItems] = useState<string[]>([]);
  const syncQueue = useCallback((next: string[]) => {
    queueRef.current = next;
    setQueuedItems(next);
  }, []);
  const [queueHover, setQueueHover] = useState<QueueActionId | 'body' | null>(null);
  const visibleLiveRef = useRef<ChatMessage[]>([]);
  const liveAllocationRef = useRef<Map<string, number>>(new Map());
  const slashDismissedRef = useRef(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const runningRef = useRef(false);
  runningRef.current = state.running;
  const [frame, setFrame] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  /** Toast（单行轻提示，TOAST_MS 后自动消失） */
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((text: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(text);
    toastTimerRef.current = setTimeout(() => setToast(null), TOAST_MS);
  }, []);
  /** Esc 取消后的手势冷静期起点 */
  const lastCancelAtRef = useRef(0);
  /** P4 权限审批卡：等待中的请求 + Promise 应答器（键盘被卡片接管） */
  const [approval, setApprovalState] = useState<{
    request: PermissionRequestData;
    resolve: (result: PermissionAskResult) => void;
  } | null>(null);
  const approvalRef = useRef(approval);
  approvalRef.current = approval;
  const [approvalIndex, setApprovalIndex] = useState(0);
  /** No 附反馈输入模式（非 null = 正在输反馈） */
  const [approvalFeedback, setApprovalFeedback] = useState<string | null>(null);
  /** inline diff 展开（edit 类审批，Tab 切换） */
  const [approvalDiffExpanded, setApprovalDiffExpanded] = useState(false);
  const setApproval = useCallback((next: typeof approval) => {
    setApprovalIndex(0);
    setApprovalFeedback(null);
    setApprovalDiffExpanded(false);
    setApprovalState(next);
  }, []);
  /** 会话级 always/never 授权状态 */
  const allowListRef = useRef(new SessionAllowList());
  /** /model 交互选择器（非 null = 打开中，键盘被它接管） */
  const [modelPicker, setModelPicker] = useState<{ index: number } | null>(null);
  const modelPickerRef = useRef(modelPicker);
  modelPickerRef.current = modelPicker;
  /** 展开中的 tool_group id（点击行 / Ctrl+X 切最后一个） */
  const [expandedTools, setExpandedTools] = useState<ReadonlySet<string>>(() => new Set());
  /** 终端焦点（焦点上报 1004；默认聚焦 → 不打扰） */
  const focusedRef = useRef(true);
  /** 运行中后台任务数（StatusBar 分段） */

  /** Ctrl+Q 首次按下时间（QUIT_CONFIRM_MS 内再按才退出） */
  const quitArmedAtRef = useRef(0);
  /** Ctrl+R 历史搜索：query + 当前匹配游标；null = 关闭 */
  const [historySearch, setHistorySearch] = useState<{ query: string; index: number } | null>(null);
  const historySearchRef = useRef(historySearch);
  historySearchRef.current = historySearch;
  /** 进搜索前的草稿（Esc 恢复） */
  const historySearchDraftRef = useRef('');
  /** 首屏动作高亮（键盘 ↑↓ / 鼠标悬停）；-1 = 无悬停，不预选 */
  const [welcomeSelected, setWelcomeSelected] = useState(-1);
  const welcomeSelectedRef = useRef(-1);
  welcomeSelectedRef.current = welcomeSelected;
  const onWelcomeMouseRef = useRef<(event: { button: number; x: number; y: number; kind: 'press' | 'release' | 'move' }) => void>(() => {});
  const welcomeGeometryRef = useRef({
    termRows: 24, termCols: 80, chromeRows: 5, compact: false,
    queueRow: 0, promptRows: 5, shortcuts: false, toast: false,
  });

  /** 终端通知：失焦才发（语义对齐桌面 shouldSuppressOsNotification），OSC 9 回退 BEL */
  const notify = useCallback((message: string) => {
    if (!shouldTerminalNotify(focusedRef.current)) return;
    const sequence = buildTerminalNotification(message, process.env);
    if (sequence) stdout?.write(sequence);
  }, [stdout]);

  // Agent 事件 → 消息模型
  useEffect(() => {
    agent.setEventObserver((event: AgentEvent) => {
      setState((prev) => reduceAgentEvent(prev, event));
    });
  }, [agent]);

  // P4：注册交互审批通道（Ink 存续期间）；headless 永远注册不到
  useEffect(() => {
    setInteractiveApprovalProvider((request) => {
      // never allow 命中：直接拒（denialSource=user），不再弹卡
      if (allowListRef.current.isDenied(request)) {
        return Promise.resolve({
          approved: false,
          denialSource: 'user',
          message: 'User chose "never allow" for this action earlier in the session.',
        });
      }
      if (allowListRef.current.has(request)) {
        return Promise.resolve({ approved: true });
      }
      notify(`需要审批: ${request.tool}`);
      return new Promise<PermissionAskResult>((resolve) => {
        setApproval({ request, resolve });
      });
    });
    return () => setInteractiveApprovalProvider(null);
  }, [setApproval, notify]);

  // 终端焦点上报（DECSET 1004）+ 首屏 SGR 鼠标。开启推迟到 raw mode 就绪之后。
  const showWelcomeRef = useRef(true);
  useEffect(() => {
    const timer = setTimeout(() => {
      stdout?.write(FOCUS_REPORTING_ENABLE);
      if (showWelcomeRef.current) stdout?.write(MOUSE_SGR_ENABLE);
    }, 0);
    const onData = (chunk: Buffer | string) => {
      const text = chunk.toString();
      const focus = parseFocusEvent(text);
      if (focus === 'in') focusedRef.current = true;
      if (focus === 'out') {
        focusedRef.current = false;
        setWelcomeSelected(-1);
      }
      const mouse = parseSgrMouse(text);
      if (mouse) onWelcomeMouseRef.current(mouse);
    };
    process.stdin.on('data', onData);
    return () => {
      clearTimeout(timer);
      process.stdin.off('data', onData);
      stdout?.write(MOUSE_SGR_DISABLE);
      stdout?.write(FOCUS_REPORTING_DISABLE);
    };
  }, [stdout]);

  // 后台任务：StatusBar 计数 + 完成/失败时系统消息 + 失焦通知
  useEffect(() => {
    return onBackgroundTaskLifecycleEvent((event) => {
      if (event.type === 'started') return;
      const short = event.task.taskId.slice(0, 8);
      const summary = `后台任务 ${short} ${event.type === 'completed' ? '完成' : '失败'}：${event.task.command.replace(/\s+/g, ' ').slice(0, 60)}`;
      setState((prev) => appendSystemMessage(prev, summary, event.type === 'completed' ? 'info' : 'warn'));
      notify(summary);
    });
  }, [notify]);

  // turn 结束（running true→false）失焦通知
  const prevRunningRef = useRef(false);
  useEffect(() => {
    if (prevRunningRef.current && !state.running) {
      const last = [...state.messages].reverse().find((message) => message.kind === 'assistant' && message.text.trim());
      const snippet = last?.kind === 'assistant'
        ? last.text.replace(/\s+/g, ' ').trim().slice(0, 80)
        : '';
      notify(snippet || 'Turn 完成');
    }
    prevRunningRef.current = state.running;
  }, [state.running, state.messages, notify]);

  useLayoutEffect(() => {
    stdout?.write('\x1b[?25l');
  });

  // 会话标题：首条消息后 quick model 自动改名（异步，实测在 agent_complete 后 1-2s 才落库），
  // 在 turn 边界/消息数变化时重取，turn 结束后再补几次延迟重取追上改名
  const [sessionTitle, setSessionTitle] = useState<string | null>(null);
  useEffect(() => {
    const fetchTitle = options.getSessionTitle;
    if (!fetchTitle) return;
    let cancelled = false;
    const refresh = () => {
      void fetchTitle().then((title) => {
        if (!cancelled && title) setSessionTitle((prev) => (prev === title ? prev : title));
      });
    };
    refresh();
    const timers: ReturnType<typeof setTimeout>[] = [];
    if (!state.running && state.messages.length > 0) {
      for (const ms of [2000, 5000, 10000]) timers.push(setTimeout(refresh, ms));
    }
    return () => { cancelled = true; timers.forEach(clearTimeout); };
  }, [options, state.running, state.messages.length]);

  useEffect(() => {
    stdout?.write(buildTerminalTitleSequence(formatTerminalTitle({
      running: state.running,
      activity: state.activity,
      queued: queuedItems.length,
      sessionTitle,
    })));
  }, [state.running, state.activity, queuedItems.length, sessionTitle, stdout]);

  // 只在 turn 运行时 ~7.5fps 跳 spinner / 计时。空闲停表——否则整树 133ms
  // 一渲，placeholder 光标和空闲 ◆ 都会卡闪。
  useEffect(() => {
    if (!state.running) return;
    setNow(Date.now());
    const timer = setInterval(() => {
      setFrame((prev) => prev + 1);
      setNow(Date.now());
    }, SPINNER_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [state.running]);

  const wantsMouse = state.messages.length === 0
    || queuedItems.length > 0
    || state.messages.some((message) => message.kind === 'tool_group');
  useEffect(() => {
    const welcome = state.messages.length === 0;
    showWelcomeRef.current = welcome;
    stdout?.write(wantsMouse ? MOUSE_SGR_ENABLE : MOUSE_SGR_DISABLE);
  }, [wantsMouse, state.messages.length, stdout]);

  // slash 菜单当前过滤结果（handler 与渲染共用，走 ref 保证新鲜）
  const computeMenuItems = useCallback((): SlashItem[] => {
    const current = content(editorRef.current);
    if (!current.startsWith('/') || /[\s\n]/.test(current.slice(1))) return [];
    if (slashDismissedRef.current) return [];
    return filterSlashCommands(current.slice(1), options.slashItems);
  }, [options.slashItems]);

  const adoptSlashItem = useCallback((item: SlashItem) => {
    setEditor(withContent(editorRef.current, `/${item.name} `));
    slashDismissedRef.current = true; // 采纳后收起（含空格本来也会隐藏，双保险）
  }, [setEditor]);

  const handleSlash = useCallback(async (text: string) => {
    const cmd = text.slice(1).split(/\s+/)[0]?.toLowerCase();
    // /clear 除了清 agent 历史，也要清 Ink 消息区
    if (cmd === 'clear' || cmd === 'c') {
      setState(createChatState());
      showToast('已清空会话');
    }
    const result = await options.onCommand(text);
    const output = result.output?.replace(/\s+$/, '') ?? '';
    if (output) {
      setState((prev) => appendSystemMessage(prev, output));
    }
    if (result.exit) {
      onExit();
    }
  }, [options, onExit, showToast]);

  const activateWelcomeAction = useCallback((id: WelcomeActionId) => {
    if (id === 'model') {
      const currentIndex = Math.max(0, options.modelItems.findIndex((item) => item.current));
      setModelPicker({ index: currentIndex });
      return;
    }
    if (id === 'quit') {
      onExit();
      return;
    }
    void handleSlash(id === 'sessions' ? '/sessions' : '/help');
  }, [options.modelItems, onExit, handleSlash]);

  onWelcomeMouseRef.current = (event) => {
    const geo = welcomeGeometryRef.current;
    if (event.kind !== 'move' && event.kind !== 'press') return;
    if (showWelcomeRef.current) {
      const chromeStart = geo.termRows - geo.chromeRows + 1;
      const index = event.y >= chromeStart
        ? null
        : welcomeActionIndexAt(
          event.y, geo.termRows, geo.chromeRows, geo.compact, event.x, geo.termCols,
        );
      const next = index ?? -1;
      if (next !== welcomeSelectedRef.current) setWelcomeSelected(next);
    }
    if (queueRef.current.length > 0 && geo.queueRow > 0) {
      if (event.y === geo.queueRow) {
        const action = queueActionAt(event.x, geo.termCols);
        setQueueHover(action);
        if (event.kind === 'press' && event.button === 0) {
          const items = queueRef.current;
          if (action === 'cancel') {
            syncQueue(items.slice(1));
            setQueueHover(null);
          } else if (action === 'edit' || action === 'body') {
            const [head, ...rest] = items;
            syncQueue(rest);
            if (head) setEditor(withContent(editorRef.current, head));
            setQueueHover(null);
          } else if (action === 'send') {
            showToast('本轮结束后发出');
          }
        }
      } else if (event.kind === 'move') {
        setQueueHover(null);
      }
    }
    if (event.kind === 'press' && event.button === 0 && !showWelcomeRef.current) {
      const id = hitLiveToolGroup(
        event.y, visibleLiveRef.current, liveAllocationRef.current, geo.termRows, geo.chromeRows,
      );
      if (id) {
        setExpandedTools((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      }
    }
  };

  const runPrompt = useCallback(async (text: string) => {
    setState((prev) => markRunStarted(appendUserMessage(prev, text)));
    try {
      const result = await agent.run(text);
      if (!result.success && result.error) {
        const errorText = result.error;
        setState((prev) => {
          const last = prev.messages[prev.messages.length - 1];
          // error 事件通常已渲染过同一条，避免双份
          if (last?.kind === 'system' && last.text === errorText) return prev;
          return appendSystemMessage(prev, errorText, 'error');
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setState((prev) => appendSystemMessage(prev, message, 'error'));
    }
    // agent_complete 事件正常收口；这里兜底一次防事件丢失卡死 running 态
    setState((prev) => (prev.running ? { ...prev, running: false, activity: null } : prev));
    // 排队 follow-up：当前 turn 结束后自动发出下一条
    const [next, ...rest] = queueRef.current;
    if (next !== undefined) {
      syncQueue(rest);
      await runPrompt(next);
    }
  }, [agent, syncQueue]);

  /** `!` shell 直通：追加进行中工具块 → 走正式链路执行 → 用结果收口。
   *  审批卡打开时不并发（键盘与审批 Promise 都被卡片独占）。 */
  const runShellCommand = useCallback(async (command: string) => {
    if (approvalRef.current) {
      showToast('请先处理当前审批');
      return;
    }
    setState((prev) => appendUserMessage(prev, `! ${command}`));
    let messageId = '';
    setState((prev) => {
      const [next, id] = appendShellCommand(prev, command);
      messageId = id;
      return next;
    });
    try {
      const result = await options.onShellCommand(command);
      setState((prev) => resolveShellCommand(prev, messageId, result));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setState((prev) => resolveShellCommand(prev, messageId, { success: false, error: message }));
    }
  }, [options, showToast]);

  const submit = useCallback((raw: string) => {
    const text = raw.trim();
    if (!text) return;
    historyRef.current.push(text);
    setEditor(createEditorState());
    if (text === '/model' || text === '/m') {
      // 无参 /model：打开交互选择器（↑↓+Enter），不走 onCommand 的静态列表
      const currentIndex = Math.max(0, options.modelItems.findIndex((item) => item.current));
      setModelPicker({ index: currentIndex });
      return;
    }
    if (text.startsWith('/')) {
      void handleSlash(text);
      return;
    }
    if (text.startsWith('!')) {
      // `!` shell 直通：走 ToolExecutor 正式链路（权限/审计/截断/cwd/超时），
      // 永远不进模型 prompt（此前 Ink 无此分支，`!cmd` 被当 prompt 发出，行为陷阱）
      const command = text.slice(1).trim();
      if (command) void runShellCommand(command);
      return;
    }
    if (runningRef.current) {
      // turn 运行中：带文本 Enter = 排队 follow-up（此时才出现队列条）
      syncQueue([...queueRef.current, text]);
      return;
    }
    void runPrompt(text);
  }, [handleSlash, runPrompt, runShellCommand, setEditor, options, syncQueue]);

  /** Enter：`\` 结尾续行，否则提交（chip 在提交时展开） */
  const onEnter = useCallback(() => {
    const current = content(editorRef.current);
    if (!current.trim()) {
      if (showWelcomeRef.current) {
        const selected = welcomeSelectedRef.current;
        const action = selected >= 0 ? WELCOME_ACTIONS[selected] : undefined;
        if (action) activateWelcomeAction(action.id);
      }
      return;
    }
    if (current.replace(/[ \t]+$/, '').endsWith('\\')) {
      setEditor(insertNewline(editorRef.current));
      return;
    }
    submit(expandedContent(editorRef.current));
  }, [setEditor, submit, activateWelcomeAction]);

  /** Ctrl+O：把 chip 徽章展开回原文（展开查看） */
  const expandChips = useCallback(() => {
    if (Object.keys(editorRef.current.chips).length === 0) return;
    setEditor(withContent({ ...editorRef.current, chips: {} }, expandedContent(editorRef.current)));
  }, [setEditor]);

  useInput((input, key) => {
    // 焦点事件残片（DECSET 1004 的 \x1b[I/\x1b[O 被 Ink 剥 ESC 后成 '[I'/'[O'）：
    // 丢弃，不进草稿、不触发任何快捷键
    if (isFocusEventInput(input) || isMouseEventInput(input)) return;
    const strippedCsi = classifyStrippedCsi(input);
    if (strippedCsi === 'drop') return;
    if (strippedCsi === 'shift-enter') {
      if (approvalRef.current && approvalFeedback !== null) {
        setApprovalFeedback((prev) => (prev ?? '') + '\n');
        return;
      }
      if (historySearch) return;
      if (welcomeSelectedRef.current >= 0) setWelcomeSelected(-1);
      setEditor(insertNewline(editorRef.current));
      return;
    }
    // 审批卡接管键盘：数字直选、↑↓+Enter、Tab 展开 diff、Esc/Ctrl+C = reject（agent 继续）
    const pendingApproval = approvalRef.current;
    if (pendingApproval) {
      const options = approvalOptions(pendingApproval.request);
      const answer = (choice: ApprovalChoice) => {
        const { request, resolve } = pendingApproval;
        const optionLabel = (c: ApprovalChoice) => options.find((o) => o.choice === c)?.label ?? '';
        if (choice === 'reject-feedback') {
          // 进入附反馈输入模式，反馈随拒绝回传 agent（PermissionAskResult.message）
          setApprovalFeedback('');
          return;
        }
        if (choice === 'always') {
          allowListRef.current.add(request);
          showToast(`本会话不再询问：${optionLabel('always').replace('Always allow: ', '')}`);
        }
        if (choice === 'session-edits') {
          allowListRef.current.addAllEdits();
          showToast('本会话放行所有文件编辑');
        }
        setApproval(null);
        if (choice === 'never') {
          allowListRef.current.deny(request);
          showToast(`本会话拒绝：${optionLabel('never').replace('Never allow: ', '')}`);
          resolve({
            approved: false,
            denialSource: 'user',
            message: 'User chose "never allow" for this action in the session.',
          });
          return;
        }
        resolve(choice === 'reject'
          ? { approved: false, denialSource: 'user' }
          : { approved: true, approvalSource: 'user' });
      };
      // 附反馈输入模式：Enter 提交拒绝（反馈回传 agent），Esc 返回选项。
      // 合批 chunk（如 'y\r'）里 \r 也算提交，前面的可打印字符并入反馈。
      if (approvalFeedback !== null) {
        if (key.escape) {
          setApprovalFeedback(null);
          return;
        }
        if (key.return || input.includes('\r')) {
          const { resolve } = pendingApproval;
          const head = key.return ? '' : input.slice(0, input.indexOf('\r'));
          const extra = [...head].filter((ch) => ch >= ' ').join('');
          const feedback = (approvalFeedback + extra).trim();
          setApproval(null);
          resolve({
            approved: false,
            denialSource: 'user',
            ...(feedback ? { message: `User rejected with feedback: ${feedback}` } : {}),
          });
          return;
        }
        if (key.backspace || key.delete) {
          setApprovalFeedback((prev) => (prev ?? '').slice(0, -1));
          return;
        }
        if (input && !key.ctrl && !key.meta && input >= ' ') {
          setApprovalFeedback((prev) => (prev ?? '') + input);
          return;
        }
        return;
      }
      if (key.escape || (key.ctrl && input === 'c')) {
        answer('reject');
        return;
      }
      if (key.tab) {
        setApprovalDiffExpanded((prev) => !prev);
        return;
      }
      if (key.upArrow) {
        setApprovalIndex((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setApprovalIndex((prev) => Math.min(options.length - 1, prev + 1));
        return;
      }
      if (key.return) {
        answer(options[Math.min(approvalIndex, options.length - 1)].choice);
        return;
      }
      if (/^[1-9]$/.test(input)) {
        const option = options[Number(input) - 1];
        if (option) answer(option.choice);
        return;
      }
      return; // 其余按键吞掉（blocking card）
    }

    // /model 选择器接管键盘：↑↓ 导航、Enter 切换（走 /model <id> 原链路）、Esc 关闭
    const picker = modelPickerRef.current;
    if (picker) {
      const items = options.modelItems;
      if (key.escape || (key.ctrl && input === 'c')) {
        setModelPicker(null);
        return;
      }
      if (key.upArrow) {
        setModelPicker({ index: Math.max(0, picker.index - 1) });
        return;
      }
      if (key.downArrow) {
        setModelPicker({ index: Math.min(items.length - 1, picker.index + 1) });
        return;
      }
      if (key.return || input.includes('\r')) {
        const item = items[Math.min(picker.index, items.length - 1)];
        setModelPicker(null);
        if (item) void handleSlash(`/model ${item.id}`);
        return;
      }
      return; // 其余按键吞掉（blocking picker）
    }

    // Ctrl+R 历史搜索接管键盘（Editor 区域换成搜索行）。
    // 合批 chunk 里 \r 也算采纳，前面的可打印字符先并进 query。
    const search = historySearchRef.current;
    if (search) {
      const matches = historyRef.current.search(search.query);
      if (key.escape) {
        setEditor(withContent(editorRef.current, historySearchDraftRef.current));
        setHistorySearch(null);
        return;
      }
      if (key.return || input.includes('\r')) {
        const head = key.return ? '' : input.slice(0, input.indexOf('\r'));
        const extra = [...head].filter((ch) => ch >= ' ').join('');
        const finalMatches = extra ? historyRef.current.search(search.query + extra) : matches;
        const match = finalMatches[Math.min(search.index, finalMatches.length - 1)];
        if (match !== undefined) setEditor(withContent(editorRef.current, match));
        setHistorySearch(null);
        return;
      }
      if ((key.ctrl && input === 'r') || key.downArrow) {
        if (matches.length > 0) setHistorySearch({ ...search, index: (search.index + 1) % matches.length });
        return;
      }
      if (key.upArrow) {
        if (matches.length > 0) setHistorySearch({ ...search, index: (search.index - 1 + matches.length) % matches.length });
        return;
      }
      if (key.backspace || key.delete) {
        setHistorySearch({ query: search.query.slice(0, -1), index: 0 });
        return;
      }
      if (input && !key.ctrl && !key.meta && input >= ' ') {
        setHistorySearch({ query: search.query + input, index: 0 });
        return;
      }
      return;
    }

    const menuItems = computeMenuItems();
    const menuActive = menuItems.length > 0;

    /** Enter 统一路径：菜单激活且未完整输入命令名 → 采纳；否则提交。
     *  菜单项必须现算（合批 chunk 可能刚改过文本，不能用 handler 顶部的旧值） */
    const handleReturnKey = () => {
      const items = computeMenuItems();
      if (items.length > 0) {
        const index = Math.min(slashIndex, items.length - 1);
        const typed = content(editorRef.current).slice(1);
        if (typed !== items[index].name) {
          adoptSlashItem(items[index]);
          return;
        }
      }
      onEnter();
    };

    // Esc：先关 slash 菜单；其次运行中取消 turn（草稿保留、排队丢弃，1s 冷静期）
    if (key.escape) {
      if (menuActive) {
        slashDismissedRef.current = true;
        setEditorState((prev) => ({ ...prev })); // 触发重渲染让菜单消失
        return;
      }
      if (runningRef.current) {
        if (Date.now() - lastCancelAtRef.current < CANCEL_COOLDOWN_MS) return; // 冷静期内忽略
        lastCancelAtRef.current = Date.now();
        syncQueue([]);
        agent.cancel();
        showToast('已取消当前 turn');
      }
      return;
    }
    // Ctrl+C 分层：有草稿 → 只清草稿（turn 继续）；空草稿运行中 → 取消；空闲 → 退出
    if (key.ctrl && input === 'c') {
      if (!isEmpty(editorRef.current)) {
        setEditor(createEditorState());
        showToast('草稿已清除');
        return;
      }
      if (runningRef.current) {
        if (Date.now() - lastCancelAtRef.current < CANCEL_COOLDOWN_MS) return;
        lastCancelAtRef.current = Date.now();
        syncQueue([]);
        agent.cancel();
        showToast('已取消当前 turn');
      } else {
        onExit();
      }
      return;
    }
    // Ctrl+Q 双击确认退出（QUIT_CONFIRM_MS 窗口，防误触）
    if (key.ctrl && input === 'q') {
      if (Date.now() - quitArmedAtRef.current < QUIT_CONFIRM_MS) {
        onExit();
        return;
      }
      quitArmedAtRef.current = Date.now();
      showToast('再按一次 Ctrl+Q 退出');
      return;
    }
    // Ctrl+R：进入 prompt 历史搜索（草稿进暂存，Esc 恢复）
    if (key.ctrl && input === 'r') {
      historySearchDraftRef.current = content(editorRef.current);
      setHistorySearch({ query: '', index: 0 });
      return;
    }

    // slash 菜单接管导航键
    if (menuActive) {
      const index = Math.min(slashIndex, menuItems.length - 1);
      if (key.upArrow) {
        setSlashIndex(Math.max(0, index - 1));
        return;
      }
      if (key.downArrow) {
        setSlashIndex(Math.min(menuItems.length - 1, index + 1));
        return;
      }
      if (key.tab) {
        adoptSlashItem(menuItems[index]);
        return;
      }
    }

    if ((key.return && key.shift) || (key.ctrl && (input === 'j' || input === '\n'))) {
      if (welcomeSelectedRef.current >= 0) setWelcomeSelected(-1);
      setEditor(insertNewline(editorRef.current));
      return;
    }
    if (key.return) {
      handleReturnKey();
      return;
    }
    if (key.upArrow) {
      if (showWelcomeRef.current && isEmpty(editorRef.current) && !historyRef.current.browsing) {
        setWelcomeSelected((index) => (index < 0 ? 0 : Math.max(0, index - 1)));
        return;
      }
      // 空 prompt（或已在翻历史）按 ↑ 翻历史，翻到的内容落回编辑器可编辑
      if (isEmpty(editorRef.current) || historyRef.current.browsing) {
        const text = historyRef.current.prev(content(editorRef.current));
        if (text !== null) setEditor(withContent(editorRef.current, text));
        return;
      }
      setEditor(moveUp(editorRef.current));
      return;
    }
    if (key.downArrow) {
      if (showWelcomeRef.current && isEmpty(editorRef.current) && !historyRef.current.browsing) {
        setWelcomeSelected((index) => (index < 0 ? 0 : Math.min(WELCOME_ACTIONS.length - 1, index + 1)));
        return;
      }
      if (historyRef.current.browsing) {
        const text = historyRef.current.next();
        if (text !== null) setEditor(withContent(editorRef.current, text));
        return;
      }
      setEditor(moveDown(editorRef.current));
      return;
    }
    if (key.leftArrow) {
      setEditor(moveLeft(editorRef.current));
      return;
    }
    if (key.rightArrow) {
      setEditor(moveRight(editorRef.current));
      return;
    }
    if (key.backspace || key.delete) {
      setEditor(backspace(editorRef.current));
      return;
    }
    if (key.ctrl && input === 'a') {
      setEditor(moveHome(editorRef.current));
      return;
    }
    if (key.ctrl && input === 'e') {
      setEditor(moveEnd(editorRef.current));
      return;
    }
    if (key.ctrl && input === 'o') {
      expandChips();
      return;
    }
    if (key.ctrl && input === 'x') {
      const last = [...state.messages].reverse().find((message) => message.kind === 'tool_group');
      if (last) {
        setExpandedTools((prev) => {
          const next = new Set(prev);
          if (next.has(last.id)) next.delete(last.id);
          else next.add(last.id);
          return next;
        });
      }
      return;
    }

    if (input && !key.ctrl && !key.meta) {
      // 逐字符状态机（合批按键不乱序）：\n 换行、\x7f 退格、可打印字符插入
      const insertTyped = (s: string) => {
        if (welcomeSelectedRef.current >= 0) setWelcomeSelected(-1);
        for (const ch of s) {
          if (ch === '\n') {
            setEditor(insertNewline(editorRef.current));
            continue;
          }
          if (ch === '\x7f' || ch === '\b') {
            setEditor(backspace(editorRef.current));
            continue;
          }
          if (ch < ' ') continue; // 其余控制字符丢弃
          setEditor(insertText(editorRef.current, ch));
        }
      };

      // 粘贴判定：bracketed-paste 标记（可能和前一个合批按键粘在同 chunk 里，
      // 且 Ink use-input 会剥掉开头的 \x1b），或含换行的多字符 chunk。
      // 多字符 chunk 里的 \r 不再当提交（修掉 P1"粘贴分段提交"）——
      // 真实 Enter 是单字符 '\r'（key.return=true，走上面的分支）。
      const text = input;
      // eslint-disable-next-line no-control-regex -- ANSI bracketed-paste 标记必须匹配 ESC
      const startMatch = /\x1b?\[200~/.exec(text);
      if (startMatch && startMatch.index <= 8) {
        if (startMatch.index > 0) insertTyped(text.slice(0, startMatch.index));
        // eslint-disable-next-line no-control-regex -- 同上，结束标记含 ESC
        const body = text.slice(startMatch.index + startMatch[0].length).replace(/\x1b?\[201~$/, '');
        const normalized = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        if (normalized) setEditor(applyPaste(editorRef.current, normalized));
        return;
      }
      if (text.length > 1 && /[\r\n]/.test(text) && !/[\x7f\b]/.test(text)) {
        // 含退格键的 chunk 是打字合批不是粘贴（剪贴板内容不会带 \x7f），落到逐字符路径。
        // 末尾恰好一个 \r 且无其他换行：判定为"打字+Enter"合批（laggy 终端），
        // 先插入文本再提交；否则按粘贴处理（修掉 P1"粘贴分段提交"）。
        const breaks = text.match(/[\r\n]/g) ?? [];
        if (breaks.length === 1 && text.endsWith('\r')) {
          insertTyped(text.slice(0, -1));
          handleReturnKey(); // 与 Enter 同路径：菜单激活时先采纳
          return;
        }
        const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        if (normalized) setEditor(applyPaste(editorRef.current, normalized));
        return;
      }
      insertTyped(text);
    }
  });

  // 消息区可用宽度：左右 padding 各 2 列（规格）
  const messageWidth = useMemo(() => Math.max(columns - 4, 20), [columns]);

  // 消息一分为二且互斥：视口预算内的只在 live 画一次；
  // 被挤出视口的已封口消息才进 Static scrollback。

  const menuItems = computeMenuItems();
  const menuIndex = Math.min(slashIndex, Math.max(menuItems.length - 1, 0));

  // Ctrl+R 搜索当前匹配（渲染用）
  const searchMatches = historySearch ? historyRef.current.search(historySearch.query) : [];
  const searchMatch = historySearch
    ? (searchMatches[Math.min(historySearch.index, searchMatches.length - 1)] ?? null)
    : null;

  // ── 全屏钉底布局（2026-08-31 用户实测决策：Grok 式全屏零噪音首屏）──
  // 动态块恒等于终端行高：输入区钉在屏幕底部，留白在内容之上；
  // live 消息预算分配防溢出（Ink v7 裁剪护栏保留）。StatusBar 在输入框下。
  const rows = stdout?.rows ?? 24;
  const editorMaxRows = Math.min(10, Math.max(3, rows - 6));
  const approvalRows = approval
    ? Math.min(
      3 /* 标题+目标+reason */
        + (approvalFeedback !== null ? 1 : approvalOptions(approval.request).length)
        + (approvalDiffExpanded ? 20 : 2), /* 摘要行 + diff 预算（超出由 overflowY 裁） */
      Math.max(6, rows - 6),
    )
    : 0;
  const pickerRows = modelPicker ? Math.min(options.modelItems.length, 12) + 2 : 0;
  const promptRows = approval
    ? approvalRows
    : modelPicker
      ? pickerRows
      : historySearch
        ? 2
        // 输入框：边框上下各 1，无纵向内边距（2026-08-31 实测：paddingY=1 单行占 5 行太高）
        : editorVisualRows(editor, Math.max(columns - 6, 8), editorMaxRows) + 2;
  // 首屏欢迎海报（Grok Build 构图）：顶左 workspace 行 + live 区居中宽卡，
  // 呼吸 ◆ 让位（零噪音）；首条消息出现即切回消息流
  const showWelcome = state.messages.length === 0;
  showWelcomeRef.current = showWelcome;
  const welcomeCompact = rows < WELCOME_COMPACT_ROWS;
  // 首屏 tip 行（Grok 风格）：空会话空闲时在输入框上方显示一条轮换提示
  const [tip] = useState(() => pickStartupTip(Date.now()));
  const showTip = showWelcome && !state.running && !approval && !modelPicker && !historySearch;
  // 零噪音首屏（Grok）：快捷键提示栏只在有上下文时出现——
  // 空闲空草稿的首屏不显示（可发现性由轮换 tip 行承担）
  const queued = queuedItems.length > 0;
  const shortcutsVisible = state.running || menuItems.length > 0 || !isEmpty(editor)
    || approval !== null || historySearch !== null || queued;
  const chromeRows = 1 /* StatusBar（输入框下） */ + (state.running ? 1 : 0) /* TurnStatus */
    + Math.min(menuItems.length, 8)
    + promptRows + (toast ? 1 : 0) + (showTip ? 1 : 0) + (shortcutsVisible ? 1 : 0)
    + (queued ? 1 : 0);
  const queueRow = queued
    ? rows - (shortcutsVisible ? 1 : 0) - 1 - (toast ? 1 : 0) - promptRows
    : 0;
  welcomeGeometryRef.current = {
    termRows: rows, termCols: columns, chromeRows, compact: welcomeCompact,
    queueRow, promptRows, shortcuts: shortcutsVisible, toast: Boolean(toast),
  };
  const layoutPlan = planDynamicLayout(state.messages, messageWidth, rows, chromeRows);
  const liveAllocation = layoutPlan.allocation;
  const { scrollback: settled, live: visibleLive } = partitionScrollback(state.messages, liveAllocation);
  visibleLiveRef.current = visibleLive;
  liveAllocationRef.current = liveAllocation;

  return (
    <Box flexDirection="column">
      <Static items={settled}>
        {(message) => (
          <Box key={message.id} paddingX={2}>
            <MessageView message={message} width={messageWidth} expandTools={expandedTools.has(message.id)} />
          </Box>
        )}
      </Static>
      <Box flexDirection="column" height={layoutPlan.height} flexShrink={0}>
        <Box flexDirection="column" flexGrow={1} justifyContent="flex-end" overflowY="hidden">
          {showWelcome
            ? (
              <Box flexGrow={1} flexDirection="column">
                <Box paddingX={2} paddingTop={1}>
                  <Text dimColor>
                    {formatWorkspaceLine(options.cwd, options.gitBranch, options.gitDirty)}
                  </Text>
                </Box>
                <Box flexGrow={1} justifyContent="center" alignItems="center" paddingX={2}>
                  <WelcomeCard
                    version={options.version ?? ''}
                    columns={columns}
                    compact={welcomeCompact}
                    selectedIndex={welcomeSelected}
                  />
                </Box>
              </Box>
            )
            : visibleLive.map((message) => (
              <Box key={message.id} paddingX={2}>
                <MessageView message={message} width={messageWidth} maxLines={liveAllocation.get(message.id)} expandTools={expandedTools.has(message.id)} />
              </Box>
            ))}
        </Box>
        {state.running
          ? <TurnStatus state={state} frame={frame} now={now} />
          : null}
        {menuItems.length > 0 ? <SlashMenu items={menuItems} selected={menuIndex} /> : null}
        {showTip
          ? (
            <Box paddingX={1}>
              <Text dimColor>{tip}</Text>
            </Box>
          )
          : null}
        {approval
          ? (
            <ApprovalCard
              request={approval.request}
              selected={approvalIndex}
              feedback={approvalFeedback}
              diffExpanded={approvalDiffExpanded}
            />
          )
          : modelPicker
            ? <ModelPicker items={options.modelItems} selected={modelPicker.index} />
            : historySearch
              ? <HistorySearchBar query={historySearch.query} match={searchMatch} />
              : (
                <Box flexDirection="column">
                  {queued
                    ? <QueueBar items={queuedItems} columns={columns} hover={queueHover} />
                    : null}
                  <Editor state={editor} width={columns} maxRows={editorMaxRows} placeholder="让 Neo 做点什么…" />
                </Box>
              )}
        {toast ? <Toast text={toast} /> : null}
        <StatusBar
          state={state}
          gitBranch={options.gitBranch}
          gitDirty={options.gitDirty}
          fallbackModel={options.model}
          fallbackProvider={options.provider}
          permissionLabel={options.permissionLabel ?? 'auto'}
          columns={columns}
        />
        {shortcutsVisible
          ? (
            <ShortcutsBar
              running={state.running}
              menuOpen={menuItems.length > 0}
              hasDraft={!isEmpty(editor)}
              approvalOpen={approval !== null}
              searchOpen={historySearch !== null}
              queued={queued}
            />
          )
          : null}
      </Box>
    </Box>
  );
}



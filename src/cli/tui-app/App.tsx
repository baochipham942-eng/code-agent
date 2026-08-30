// ============================================================================
// Ink TUI 主界面（P2）：<Static> 消息滚动区（已封口消息滚入终端历史）→
// StatusBar（动态区顶行）→ 未封口消息 → Turn status 行 → Slash 补全弹窗 →
// 多行编辑器（❯ + rail ┃）。
// P2 能力：多行编辑（Shift+Enter/Ctrl+J/`\` 续行）、粘贴 chip、slash 补全、
// 真 slash 命令（onCommand 注入）、运行中排队 follow-up、100 条输入历史。
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Static, Text, useInput, useStdout } from 'ink';
import type { CLIAgent } from '../adapter';
import type { AgentEvent } from '../../shared/contract';
import {
  appendSystemMessage,
  appendUserMessage,
  createChatState,
  estimateCostUsd,
  formatDuration,
  markRunStarted,
  reduceAgentEvent,
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
import { Editor } from './Editor';
import { SlashMenu } from './SlashMenu';
import { MessageView } from './MessageView';

export interface InkCommandResult {
  /** 命令产生的文本输出（渲染为系统消息） */
  output?: string;
  /** /exit 类命令请求退出 */
  exit?: boolean;
}

export interface InkChatOptions {
  cwd: string;
  model: string;
  /** git 分支（StatusBar 显示；取不到传空串） */
  gitBranch: string;
  /** slash 命令执行入口（chat.ts 注入，内部走统一 handleCommand） */
  onCommand: (input: string) => Promise<InkCommandResult>;
  /** slash 补全数据源（注册表 cli 命令 + 本地命令） */
  slashItems: SlashItem[];
}

/** braille spinner，刻意 ~7.5fps（规格：30fps 每帧停 4 tick ≈ 133ms/帧） */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧'];
const SPINNER_INTERVAL_MS = 133;

/** 呼吸 ◆ 周期 ~1.3s（sin² 脉动，空闲等待输入时显示） */
const PULSE_PERIOD_MS = 1300;
/** 呼吸 ◆ 的 4 档亮度（accent_user 绿色系） */
const PULSE_COLORS = ['#1d4d1d', '#2e7d2e', '#57c757', '#2e7d2e'];

/** Toast 自动消失时间 */
const TOAST_MS = 3000;
/** Esc 取消后的手势冷静期（规格：取消后 1s 内不触发其他 Esc 手势） */
const CANCEL_COOLDOWN_MS = 1000;

/** 活动标签按类型着色（规格：accent 槽位） */
function activityColor(activity: string | null): string {
  if (!activity) return 'cyan';
  if (/^Thinking/.test(activity)) return 'magenta';
  if (/^(Running|Run)/.test(activity)) return 'yellow';
  if (/^(Writing|Editing|Appending|Deleting|Wrote|Edited)/.test(activity)) return 'red';
  return 'cyan'; // Reading/Searching/Finding/Listing 等读取类
}

// ---------------------------------------------------------------------------
// StatusBar：左 model(provider) / 中 cwd·branch / 右 条件分段
// （token、ctx% 迷你条、成本、turns、工具数、上轮耗时、phase）
// ---------------------------------------------------------------------------

/** ctx% 迷你条（5 格） */
function ctxBar(percent: number): string {
  const filled = Math.round((Math.min(percent, 100) / 100) * 5);
  return '▓'.repeat(filled) + '░'.repeat(5 - filled);
}

function StatusBar({ state, cwd, gitBranch, fallbackModel }: {
  state: ChatState;
  cwd: string;
  gitBranch: string;
  fallbackModel: string;
}) {
  const model = state.model ?? fallbackModel;
  const cost = estimateCostUsd(model, state.inputTokens, state.outputTokens);
  return (
    <Box paddingX={1} justifyContent="space-between">
      <Text>
        <Text color="green">⏺ </Text>
        <Text bold>{model}</Text>
        {state.provider ? <Text dimColor> ({state.provider})</Text> : null}
      </Text>
      <Text dimColor>
        {cwd}{gitBranch ? ` (${gitBranch})` : ''}
      </Text>
      <Text dimColor>
        {state.inputTokens + state.outputTokens > 0
          ? `⇡${state.inputTokens} ⇣${state.outputTokens}  `
          : ''}
        {state.contextPercent != null ? `ctx ${ctxBar(state.contextPercent)} ${state.contextPercent.toFixed(0)}%  ` : ''}
        {cost > 0 ? `$${cost.toFixed(4)}  ` : ''}
        {state.turns > 0 ? `⟳${state.turns}  ` : ''}
        {state.toolNames.length > 0 ? `${state.toolNames.length} tools  ` : ''}
        {state.lastTurnMs != null ? `${formatDuration(state.lastTurnMs)}  ` : ''}
        {state.running ? 'running' : 'idle'}
      </Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// 底部 shortcuts bar：随上下文切换提示内容
// ---------------------------------------------------------------------------

function ShortcutsBar({ running, menuOpen, hasDraft }: {
  running: boolean;
  menuOpen: boolean;
  hasDraft: boolean;
}) {
  const text = menuOpen
    ? '↑↓ 选择 · Tab 采纳 · Enter 采纳/执行 · Esc 关闭'
    : running
      ? 'Esc 取消 · 带文本 Enter 排队 · Shift+Enter 换行'
      : hasDraft
        ? 'Enter 提交 · Ctrl+C 清草稿 · Shift+Enter 换行'
        : '/ 命令 · ↑ 历史 · Shift+Enter 换行 · Ctrl+C 退出';
  return (
    <Box paddingX={1}>
      <Text dimColor>{text}</Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Toast：单行右对齐轻提示，几秒自动消失
// ---------------------------------------------------------------------------

function Toast({ text }: { text: string }) {
  return (
    <Box paddingX={1} justifyContent="flex-end">
      <Text dimColor>{text}</Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Turn status 行（运行时）：spinner + 活动标签 + 计时 + token + 排队数
// ---------------------------------------------------------------------------

function TurnStatus({ state, frame, now, queuedCount }: {
  state: ChatState;
  frame: number;
  now: number;
  queuedCount: number;
}) {
  const elapsed = state.turnStartedAt != null ? now - state.turnStartedAt : 0;
  return (
    <Box paddingX={1}>
      <Text>
        <Text color={activityColor(state.activity)}>{SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} </Text>
        <Text color={activityColor(state.activity)}>{state.activity ?? 'Working…'}</Text>
        <Text dimColor>  {formatDuration(elapsed)}</Text>
        {state.outputTokens > 0 ? <Text dimColor>  ⇣{state.outputTokens}</Text> : null}
        {queuedCount > 0 ? <Text dimColor>  · {queuedCount} queued</Text> : null}
      </Text>
    </Box>
  );
}

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
  const [queuedCount, setQueuedCount] = useState(0);
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

  // Agent 事件 → 消息模型
  useEffect(() => {
    agent.setEventObserver((event: AgentEvent) => {
      setState((prev) => reduceAgentEvent(prev, event));
    });
  }, [agent]);

  // spinner + 呼吸 ◆ 共用 tick：运行时 braille ~7.5fps，空闲时 sin² 脉动
  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prev) => prev + 1);
      setNow(Date.now());
    }, SPINNER_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

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
    const next = queueRef.current.shift();
    if (next !== undefined) {
      setQueuedCount(queueRef.current.length);
      await runPrompt(next);
    }
  }, [agent]);

  const submit = useCallback((raw: string) => {
    const text = raw.trim();
    if (!text) return;
    historyRef.current.push(text);
    setEditor(createEditorState());
    if (text.startsWith('/')) {
      void handleSlash(text);
      return;
    }
    if (runningRef.current) {
      // turn 运行中：带文本 Enter = 排队 follow-up
      queueRef.current.push(text);
      setQueuedCount(queueRef.current.length);
      return;
    }
    void runPrompt(text);
  }, [handleSlash, runPrompt, setEditor]);

  /** Enter：`\` 结尾续行，否则提交（chip 在提交时展开） */
  const onEnter = useCallback(() => {
    const current = content(editorRef.current);
    if (!current.trim()) return;
    if (current.replace(/[ \t]+$/, '').endsWith('\\')) {
      setEditor(insertNewline(editorRef.current));
      return;
    }
    submit(expandedContent(editorRef.current));
  }, [setEditor, submit]);

  /** Ctrl+O：把 chip 徽章展开回原文（展开查看） */
  const expandChips = useCallback(() => {
    if (Object.keys(editorRef.current.chips).length === 0) return;
    setEditor(withContent({ ...editorRef.current, chips: {} }, expandedContent(editorRef.current)));
  }, [setEditor]);

  useInput((input, key) => {
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
        queueRef.current = []; // 取消时丢弃排队
        setQueuedCount(0);
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
        queueRef.current = [];
        setQueuedCount(0);
        agent.cancel();
        showToast('已取消当前 turn');
      } else {
        onExit();
      }
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

    if (key.return && key.shift) {
      // kitty 协议终端的 Shift+Enter（其余终端用 Ctrl+J 换行）
      setEditor(insertNewline(editorRef.current));
      return;
    }
    if (key.return) {
      handleReturnKey();
      return;
    }
    if (key.upArrow) {
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

    if (input && !key.ctrl && !key.meta) {
      // 逐字符状态机（合批按键不乱序）：\n 换行、\x7f 退格、可打印字符插入
      const insertTyped = (s: string) => {
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

  // 消息一分为二：已封口的进 <Static>（滚入终端历史，天然滚动区）；
  // 未封口的（流式 assistant/thinking/运行中工具组）留在动态区原地更新。
  const firstLiveIndex = state.messages.findIndex((message) => !isSettled(message));
  const settled = firstLiveIndex === -1 ? state.messages : state.messages.slice(0, firstLiveIndex);
  const live = firstLiveIndex === -1 ? [] : state.messages.slice(firstLiveIndex);

  const menuItems = computeMenuItems();
  const menuIndex = Math.min(slashIndex, Math.max(menuItems.length - 1, 0));

  // 空闲呼吸 ◆：sin² 脉动（~1.3s 周期），turn 运行时位置被 TurnStatus 占用
  const pulseAlpha = Math.sin((now / PULSE_PERIOD_MS) * Math.PI) ** 2;
  const pulseColor = PULSE_COLORS[Math.min(PULSE_COLORS.length - 1, Math.floor(pulseAlpha * PULSE_COLORS.length))];

  return (
    <Box flexDirection="column">
      <Static items={settled}>
        {(message) => (
          <Box key={message.id} paddingX={2}>
            <MessageView message={message} width={messageWidth} />
          </Box>
        )}
      </Static>
      <Box flexDirection="column">
        <StatusBar state={state} cwd={options.cwd} gitBranch={options.gitBranch} fallbackModel={options.model} />
        {live.map((message) => (
          <Box key={message.id} paddingX={2}>
            <MessageView message={message} width={messageWidth} />
          </Box>
        ))}
        {state.running
          ? <TurnStatus state={state} frame={frame} now={now} queuedCount={queuedCount} />
          : (
            <Box paddingX={1}>
              <Text color={pulseColor}>◆</Text>
            </Box>
          )}
        {menuItems.length > 0 ? <SlashMenu items={menuItems} selected={menuIndex} /> : null}
        <Editor state={editor} width={columns} />
        {toast ? <Toast text={toast} /> : null}
        <ShortcutsBar running={state.running} menuOpen={menuItems.length > 0} hasDraft={!isEmpty(editor)} />
      </Box>
    </Box>
  );
}

/** 消息是否已封口（不会再变，可永久落入终端 scrollback） */
function isSettled(message: ChatMessage): boolean {
  switch (message.kind) {
    case 'user':
    case 'system':
      return true;
    case 'assistant':
      return !message.streaming;
    case 'thinking':
      return message.endedAt !== undefined;
    case 'tool_group':
      return message.status !== 'running';
    default:
      return true;
  }
}

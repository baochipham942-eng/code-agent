# DeerFlow 核心机制集成设计

> 将 DeerFlow 的上下文压缩机制和深度研究流程集成到 Code Agent

## 一、概述

### 1.1 目标

借鉴 DeerFlow 两个核心机制，解决 Code Agent 在复杂任务场景下的痛点：

| 机制 | 解决的问题 | 预期收益 |
|------|-----------|---------|
| 上下文压缩 | Token 溢出导致对话中断 | 支持超长对话，降低 API 成本 |
| 深度研究流程 | 研究报告质量不稳定 | 结构化输出，质量可控 |

### 1.2 设计原则

1. **渐进增强**：新机制作为可选增强，不影响现有功能
2. **最小改动**：复用现有架构（TokenManager、AgentLoop），仅扩展
3. **配置灵活**：支持按会话、按任务类型启用/禁用
4. **智能 + 手动**：自动识别研究意图，同时支持用户主动控制

---

## 二、上下文压缩机制

### 2.1 现状分析

**Code Agent 现有能力：**
- `TokenManager.pruneMessages()`: 基于保留头尾 N 条的简单裁剪
- `TokenManager.summarizeAndPrune()`: 需要外部 summarizer，目前未实际使用
- 触发时机：`MemoryService.pruneMessagesForContext()` 被动调用

**DeerFlow 算法优势：**
- 智能 Token 计数（中英文差异化）
- 消息优先级压缩（保留 system 提示）
- 从尾部填充策略（保留最新上下文）
- 单条消息截断（内容压缩而非整条删除）

### 2.2 架构设计

```
┌─────────────────────────────────────────────────────────────────────┐
│                         AgentLoop.inference()                        │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    ContextCompressor (新增)                          │
│  ┌───────────────┐  ┌───────────────┐  ┌─────────────────────────┐ │
│  │ TokenCounter  │  │ MessagePruner │  │ MessageSummarizer       │ │
│  │ (中英文差异)  │  │ (优先级裁剪)  │  │ (可选, LLM 生成摘要)   │ │
│  └───────────────┘  └───────────────┘  └─────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         TokenManager (现有)                          │
│                    - getContextWindow()                              │
│                    - needsPruning()                                  │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.3 核心接口定义

```typescript
// src/main/context/contextCompressor.ts

/**
 * 消息压缩配置
 */
export interface CompressionConfig {
  /** Token 上限，默认从模型配置获取 */
  tokenLimit?: number;
  /** 保留的前缀消息数（通常是 system prompt 相关），默认 1 */
  preservePrefixCount?: number;
  /** 保留的最近消息数，默认 6 */
  preserveRecentCount?: number;
  /** 目标利用率 (0-1)，默认 0.8 */
  targetUtilization?: number;
  /** 启用 LLM 摘要压缩（更高质量但有延迟），默认 false */
  enableSummarization?: boolean;
  /** 触发摘要的消息数阈值，默认 20 */
  summarizationThreshold?: number;
}

/**
 * 压缩结果
 */
export interface CompressionResult {
  messages: Message[];
  stats: {
    originalTokens: number;
    compressedTokens: number;
    removedMessageCount: number;
    truncatedMessageCount: number;
    summarized: boolean;
  };
}

/**
 * 上下文压缩器
 *
 * 借鉴 DeerFlow ContextManager 算法：
 * 1. 精确 Token 计数（中英文差异化）
 * 2. 消息优先级保留（system > recent > middle）
 * 3. 单条消息截断（非整条删除）
 * 4. 可选 LLM 摘要
 */
export class ContextCompressor {
  private config: Required<CompressionConfig>;

  constructor(config: CompressionConfig = {}) {
    this.config = {
      tokenLimit: config.tokenLimit ?? 64000,
      preservePrefixCount: config.preservePrefixCount ?? 1,
      preserveRecentCount: config.preserveRecentCount ?? 6,
      targetUtilization: config.targetUtilization ?? 0.8,
      enableSummarization: config.enableSummarization ?? false,
      summarizationThreshold: config.summarizationThreshold ?? 20,
    };
  }

  /**
   * 压缩消息列表
   */
  compress(
    messages: Message[],
    systemPrompt: string
  ): CompressionResult;

  /**
   * 带 LLM 摘要的压缩（异步）
   */
  async compressWithSummarization(
    messages: Message[],
    systemPrompt: string,
    summarizer: (messages: Message[]) => Promise<string>
  ): Promise<CompressionResult>;

  /**
   * 检查是否需要压缩
   */
  needsCompression(messages: Message[], systemPrompt: string): boolean;

  /**
   * 更新 Token 上限（模型切换时调用）
   */
  setTokenLimit(limit: number): void;
}
```

### 2.4 Token 计数算法

```typescript
// src/main/context/tokenCounter.ts

/**
 * 智能 Token 计数器
 *
 * 借鉴 DeerFlow 的中英文差异化算法：
 * - 英文: 4 chars ≈ 1 token
 * - 中文/日文/韩文: 1 char ≈ 1 token
 * - 特殊字符: 1 char ≈ 1 token
 */
export function countTokens(text: string): number {
  if (!text) return 0;

  let tokens = 0;

  for (const char of text) {
    const code = char.charCodeAt(0);

    // CJK 字符范围（中日韩）
    if (
      (code >= 0x4e00 && code <= 0x9fff) || // CJK 基本
      (code >= 0x3400 && code <= 0x4dbf) || // CJK 扩展 A
      (code >= 0x20000 && code <= 0x2a6df) || // CJK 扩展 B
      (code >= 0x3040 && code <= 0x309f) || // 平假名
      (code >= 0x30a0 && code <= 0x30ff) || // 片假名
      (code >= 0xac00 && code <= 0xd7af)    // 韩文
    ) {
      tokens += 1;
    }
    // ASCII 可打印字符
    else if (code >= 32 && code <= 126) {
      tokens += 0.25; // 4 chars = 1 token
    }
    // 其他（特殊字符、空格、换行等）
    else {
      tokens += 0.5;
    }
  }

  return Math.ceil(tokens);
}

/**
 * 计算消息的总 Token 数
 */
export function countMessageTokens(message: Message): number {
  let total = 4; // 角色标记开销

  total += countTokens(message.content);

  // 工具调用
  if (message.toolCalls?.length) {
    for (const tc of message.toolCalls) {
      total += countTokens(tc.name) + 10;
      total += countTokens(JSON.stringify(tc.arguments));
    }
  }

  // 工具结果
  if (message.toolResults?.length) {
    for (const tr of message.toolResults) {
      total += countTokens(tr.output ?? '') + 10;
      if (tr.error) total += countTokens(tr.error);
    }
  }

  // 附件（仅计算文本部分，图片另算）
  if (message.attachments?.length) {
    for (const att of message.attachments) {
      if (att.type === 'file' && att.data) {
        total += countTokens(att.data);
      }
    }
  }

  return total;
}
```

### 2.5 压缩算法实现

```typescript
// src/main/context/contextCompressor.ts (核心方法)

compress(messages: Message[], systemPrompt: string): CompressionResult {
  const systemTokens = countTokens(systemPrompt) + 4;
  const targetTokens = Math.floor(this.config.tokenLimit * this.config.targetUtilization);
  const availableForMessages = targetTokens - systemTokens;

  // 计算原始 Token 数
  let originalTokens = 0;
  const messageTokens: number[] = [];
  for (const msg of messages) {
    const tokens = countMessageTokens(msg);
    messageTokens.push(tokens);
    originalTokens += tokens;
  }

  // 检查是否需要压缩
  if (originalTokens <= availableForMessages) {
    return {
      messages,
      stats: {
        originalTokens,
        compressedTokens: originalTokens,
        removedMessageCount: 0,
        truncatedMessageCount: 0,
        summarized: false,
      },
    };
  }

  // Step 1: 分离保留区和可压缩区
  const { prefixCount, recentCount } = this.config;
  const prefixMessages = messages.slice(0, prefixCount);
  const recentMessages = messages.slice(-recentCount);
  const middleMessages = messages.slice(prefixCount, -recentCount || undefined);

  // Step 2: 计算固定保留区 Token
  let prefixTokens = 0;
  for (let i = 0; i < prefixCount && i < messages.length; i++) {
    prefixTokens += messageTokens[i];
  }

  let recentTokens = 0;
  for (let i = Math.max(0, messages.length - recentCount); i < messages.length; i++) {
    recentTokens += messageTokens[i];
  }

  const availableForMiddle = availableForMessages - prefixTokens - recentTokens;

  // Step 3: 从尾部向头部填充中间消息（DeerFlow 策略）
  const keptMiddle: Message[] = [];
  let middleTokensUsed = 0;
  let truncatedCount = 0;

  for (let i = middleMessages.length - 1; i >= 0; i--) {
    const msgIndex = prefixCount + i;
    const msgTokens = messageTokens[msgIndex];

    if (middleTokensUsed + msgTokens <= availableForMiddle) {
      // 整条保留
      keptMiddle.unshift(middleMessages[i]);
      middleTokensUsed += msgTokens;
    } else {
      // 尝试截断保留（DeerFlow 增强策略）
      const remainingTokens = availableForMiddle - middleTokensUsed;
      if (remainingTokens > 100) { // 至少 100 token 才值得保留
        const truncatedMsg = this.truncateMessage(middleMessages[i], remainingTokens);
        if (truncatedMsg) {
          keptMiddle.unshift(truncatedMsg);
          middleTokensUsed += remainingTokens;
          truncatedCount++;
        }
      }
      break; // 超出后不再处理更早的消息
    }
  }

  // Step 4: 组合结果
  const compressedMessages = [...prefixMessages, ...keptMiddle, ...recentMessages];
  const compressedTokens = prefixTokens + middleTokensUsed + recentTokens;

  return {
    messages: compressedMessages,
    stats: {
      originalTokens,
      compressedTokens,
      removedMessageCount: messages.length - compressedMessages.length,
      truncatedMessageCount: truncatedCount,
      summarized: false,
    },
  };
}

/**
 * 截断单条消息内容
 */
private truncateMessage(message: Message, targetTokens: number): Message | null {
  const baseTokens = 20; // 角色 + 结构开销
  const availableForContent = targetTokens - baseTokens;

  if (availableForContent < 50) return null;

  // 估算保留字符数
  const originalTokens = countTokens(message.content);
  const ratio = availableForContent / originalTokens;
  const targetLength = Math.floor(message.content.length * ratio * 0.95);

  const truncatedContent = message.content.slice(0, targetLength) + '\n\n[... content truncated ...]';

  return {
    ...message,
    content: truncatedContent,
    // 清除工具调用（避免不完整数据）
    toolCalls: undefined,
    toolResults: undefined,
  };
}
```

### 2.6 集成到 AgentLoop

```typescript
// src/main/agent/agentLoop.ts

// 在 inference() 方法调用前添加压缩钩子

private async inference(): Promise<ModelResponse> {
  // --- 新增：上下文压缩 ---
  const compressor = getContextCompressor(this.modelConfig.model);
  const systemPrompt = this.buildEnhancedSystemPrompt();

  if (compressor.needsCompression(this.messages, systemPrompt)) {
    const compressionResult = await this.compressContext(compressor, systemPrompt);

    // 记录压缩事件
    this.onEvent({
      type: 'context_compressed',
      data: compressionResult.stats,
    });

    // 更新消息列表
    this.messages = compressionResult.messages;
  }
  // --- 压缩钩子结束 ---

  // 原有逻辑...
  const modelMessages = this.prepareModelMessages();
  // ...
}

private async compressContext(
  compressor: ContextCompressor,
  systemPrompt: string
): Promise<CompressionResult> {
  const config = getConfigService().getSettings();

  // 如果启用 LLM 摘要且消息数超过阈值
  if (config.contextCompression?.enableSummarization &&
      this.messages.length > (config.contextCompression?.summarizationThreshold ?? 20)) {
    return await compressor.compressWithSummarization(
      this.messages,
      systemPrompt,
      (messages) => this.generateSummary(messages)
    );
  }

  return compressor.compress(this.messages, systemPrompt);
}

/**
 * 调用 LLM 生成历史消息摘要
 */
private async generateSummary(messages: Message[]): Promise<string> {
  const summaryPrompt = `请简洁总结以下对话的关键信息，包括：
1. 用户的主要目标
2. 已完成的操作
3. 当前的进展状态
4. 遇到的问题（如有）

对话内容：
${messages.map(m => `${m.role}: ${m.content.slice(0, 500)}`).join('\n\n')}

请用 150 字以内总结：`;

  const response = await this.modelRouter.call({
    provider: this.modelConfig.provider,
    model: this.modelConfig.model,
    messages: [{ role: 'user', content: summaryPrompt }],
    maxTokens: 200,
  });

  return response.content;
}
```

### 2.7 配置入口

```typescript
// src/shared/types/settings.ts

export interface AppSettings {
  // ... 现有配置

  /** 上下文压缩配置 */
  contextCompression?: {
    /** 是否启用，默认 true */
    enabled: boolean;
    /** 目标利用率，默认 0.8 */
    targetUtilization: number;
    /** 是否启用 LLM 摘要，默认 false */
    enableSummarization: boolean;
    /** 触发摘要的消息数阈值，默认 20 */
    summarizationThreshold: number;
  };
}
```

### 2.8 前端事件展示

```typescript
// 新增 AgentEvent 类型
interface ContextCompressedEvent {
  type: 'context_compressed';
  data: {
    originalTokens: number;
    compressedTokens: number;
    removedMessageCount: number;
    truncatedMessageCount: number;
    summarized: boolean;
  };
}

// 前端展示（可选，在消息流中显示）
// "上下文已压缩: 45,000 → 28,000 tokens (移除 12 条消息)"
```

---

## 三、深度研究流程

### 3.1 现状分析

**Code Agent 现有能力：**
- `web_fetch`: 单页面抓取
- `web_search`: 搜索引擎查询（MCP/直接调用）
- 无结构化研究流程

**DeerFlow 深度研究优势：**
- 8 维分析框架（历史/现状/未来/利益方/量化/定性/对比/风险）
- Step 类型强制（research/analysis/processing）
- 计划验证与自动修复
- 6 种报告风格

### 3.2 模式切换机制

深度研究模式通过**用户手动切换**触发，提供清晰的模式指示和切换体验。

#### 3.2.1 交互设计

```
┌─────────────────────────────────────────────────────────────────────┐
│  正常模式 (默认)                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ [💬 正常]  [🔬 深度研究]                                     │   │
│  │                                                              │   │
│  │ [输入框...]                                      [发送]      │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  深度研究模式 (用户切换后)                                           │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ [💬 正常]  [🔬 深度研究 ✓]                                   │   │
│  │                                                              │   │
│  │ 📋 报告风格: [默认 ▾]                                        │   │
│  │                                                              │   │
│  │ [输入研究主题...]                                [开始研究]  │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

**模式特征对比：**

| 特征 | 正常模式 | 深度研究模式 |
|------|---------|-------------|
| 发送按钮 | "发送" | "开始研究" |
| 输入提示 | "输入消息..." | "输入研究主题..." |
| 额外选项 | 无 | 报告风格选择 |
| 处理流程 | 直接 Agent 对话 | 规划 → 搜索 → 分析 → 报告 |
| 预期时长 | 秒级 | 分钟级 |

#### 3.2.2 模式切换组件

```typescript
// src/renderer/components/features/chat/ChatInput/ModeSwitch.tsx

import React from 'react';
import { MessageSquare, Microscope } from 'lucide-react';

export type ChatMode = 'normal' | 'deep-research';

interface ModeSwitchProps {
  mode: ChatMode;
  onModeChange: (mode: ChatMode) => void;
  disabled?: boolean;
}

export const ModeSwitch: React.FC<ModeSwitchProps> = ({
  mode,
  onModeChange,
  disabled,
}) => {
  return (
    <div className="flex items-center gap-1 p-1 bg-surface-800 rounded-lg">
      {/* 正常模式 */}
      <button
        type="button"
        onClick={() => onModeChange('normal')}
        disabled={disabled}
        className={`
          flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium
          transition-all duration-200
          ${mode === 'normal'
            ? 'bg-surface-700 text-white shadow-sm'
            : 'text-zinc-400 hover:text-zinc-300 hover:bg-surface-700/50'
          }
          ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
        `}
      >
        <MessageSquare className="w-4 h-4" />
        <span>正常</span>
      </button>

      {/* 深度研究模式 */}
      <button
        type="button"
        onClick={() => onModeChange('deep-research')}
        disabled={disabled}
        className={`
          flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium
          transition-all duration-200
          ${mode === 'deep-research'
            ? 'bg-primary-500/20 text-primary-400 shadow-sm'
            : 'text-zinc-400 hover:text-zinc-300 hover:bg-surface-700/50'
          }
          ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
        `}
      >
        <Microscope className="w-4 h-4" />
        <span>深度研究</span>
      </button>
    </div>
  );
};
```

#### 3.2.3 报告风格选择器

```typescript
// src/renderer/components/features/chat/ChatInput/ReportStyleSelector.tsx

import React from 'react';
import { ChevronDown } from 'lucide-react';

export type ReportStyle =
  | 'default'
  | 'academic'
  | 'popular_science'
  | 'news'
  | 'social_media'
  | 'strategic_investment';

const STYLE_OPTIONS: Array<{ value: ReportStyle; label: string; description: string }> = [
  { value: 'default', label: '默认', description: '通用报告格式' },
  { value: 'academic', label: '学术论文', description: '正式、引用规范' },
  { value: 'popular_science', label: '科普文章', description: '通俗易懂、有趣' },
  { value: 'news', label: '新闻报道', description: '倒金字塔、简洁' },
  { value: 'social_media', label: '社交媒体', description: '简短、列表化' },
  { value: 'strategic_investment', label: '投资分析', description: '深度、量化数据' },
];

interface ReportStyleSelectorProps {
  value: ReportStyle;
  onChange: (style: ReportStyle) => void;
  disabled?: boolean;
}

export const ReportStyleSelector: React.FC<ReportStyleSelectorProps> = ({
  value,
  onChange,
  disabled,
}) => {
  const [isOpen, setIsOpen] = React.useState(false);
  const selectedOption = STYLE_OPTIONS.find(opt => opt.value === value);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        disabled={disabled}
        className={`
          flex items-center gap-2 px-3 py-1.5 rounded-md text-sm
          bg-surface-800 border border-zinc-700 hover:border-zinc-600
          transition-colors
          ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
        `}
      >
        <span className="text-zinc-400">报告风格:</span>
        <span className="text-white">{selectedOption?.label}</span>
        <ChevronDown className={`w-4 h-4 text-zinc-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && !disabled && (
        <>
          {/* 点击外部关闭 */}
          <div
            className="fixed inset-0 z-10"
            onClick={() => setIsOpen(false)}
          />

          {/* 下拉选项 */}
          <div className="absolute bottom-full left-0 mb-2 w-64 py-1 bg-surface-800 border border-zinc-700 rounded-lg shadow-xl z-20">
            {STYLE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  onChange(option.value);
                  setIsOpen(false);
                }}
                className={`
                  w-full px-3 py-2 text-left hover:bg-surface-700 transition-colors
                  ${value === option.value ? 'bg-surface-700' : ''}
                `}
              >
                <div className="text-sm text-white">{option.label}</div>
                <div className="text-xs text-zinc-500">{option.description}</div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
};
```

#### 3.2.4 ChatInput 集成

```typescript
// src/renderer/components/features/chat/ChatInput/index.tsx

import React, { useState, useRef, useCallback } from 'react';
import type { MessageAttachment } from '@shared/types';

import { InputArea, InputAreaRef } from './InputArea';
import { AttachmentBar } from './AttachmentBar';
import { SendButton } from './SendButton';
import { ModeSwitch, ChatMode } from './ModeSwitch';
import { ReportStyleSelector, ReportStyle } from './ReportStyleSelector';

export interface ChatInputProps {
  onSend: (message: string, attachments?: MessageAttachment[], options?: {
    mode: ChatMode;
    reportStyle?: ReportStyle;
  }) => void;
  disabled?: boolean;
  isProcessing?: boolean;
  onStop?: () => void;
}

export const ChatInput: React.FC<ChatInputProps> = ({
  onSend,
  disabled,
  isProcessing,
  onStop,
}) => {
  const [value, setValue] = useState('');
  const [mode, setMode] = useState<ChatMode>('normal');
  const [reportStyle, setReportStyle] = useState<ReportStyle>('default');
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const inputAreaRef = useRef<InputAreaRef>(null);

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if ((value.trim() || attachments.length > 0) && !disabled) {
      onSend(
        value,
        attachments.length > 0 ? attachments : undefined,
        {
          mode,
          reportStyle: mode === 'deep-research' ? reportStyle : undefined,
        }
      );
      setValue('');
      setAttachments([]);
      // 注意：模式保持不变，用户可能连续进行多次研究
    }
  };

  const handleModeChange = (newMode: ChatMode) => {
    setMode(newMode);
    // 切换模式时聚焦输入框
    inputAreaRef.current?.focus();
  };

  const isDeepResearch = mode === 'deep-research';
  const hasContent = value.trim().length > 0 || attachments.length > 0;

  return (
    <div className="border-t border-zinc-800/50 bg-gradient-to-t from-surface-950 to-surface-950/80 p-4">
      <form onSubmit={handleSubmit} className="max-w-3xl mx-auto space-y-3">

        {/* 顶部工具栏 */}
        <div className="flex items-center justify-between">
          {/* 模式切换 */}
          <ModeSwitch
            mode={mode}
            onModeChange={handleModeChange}
            disabled={isProcessing}
          />

          {/* 深度研究模式的报告风格选择 */}
          {isDeepResearch && (
            <ReportStyleSelector
              value={reportStyle}
              onChange={setReportStyle}
              disabled={isProcessing}
            />
          )}
        </div>

        {/* 深度研究模式提示 */}
        {isDeepResearch && (
          <div className="px-3 py-2 bg-primary-500/10 border border-primary-500/20 rounded-lg">
            <p className="text-xs text-primary-400">
              🔬 深度研究模式：输入研究主题，AI 将自动规划研究步骤、搜索信息、分析数据并生成结构化报告。
            </p>
          </div>
        )}

        {/* 附件预览区 */}
        <AttachmentBar attachments={attachments} onRemove={removeAttachment} />

        {/* 输入区域 */}
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <InputArea
              ref={inputAreaRef}
              value={value}
              onChange={setValue}
              onSubmit={handleSubmit}
              placeholder={isDeepResearch ? '输入研究主题...' : '输入消息...'}
              disabled={disabled}
            />
          </div>

          {/* 发送/停止按钮 */}
          <SendButton
            isProcessing={isProcessing}
            hasContent={hasContent}
            disabled={disabled}
            onStop={onStop}
            label={isDeepResearch ? '开始研究' : '发送'}
          />
        </div>
      </form>
    </div>
  );
};
```

#### 3.2.5 后端模式处理

```typescript
// src/main/agent/agentLoop.ts

export interface RunOptions {
  mode: 'normal' | 'deep-research';
  reportStyle?: ReportStyle;
}

async run(userMessage: string, options: RunOptions = { mode: 'normal' }): Promise<void> {
  const { mode, reportStyle } = options;

  // 根据模式分发处理
  if (mode === 'deep-research') {
    await this.runDeepResearchMode(userMessage, reportStyle);
    return;
  }

  // 正常模式：原有逻辑
  await this.runNormalMode(userMessage);
}

/**
 * 深度研究模式执行
 */
private async runDeepResearchMode(
  topic: string,
  reportStyle: ReportStyle = 'default'
): Promise<void> {
  // 通知前端进入研究模式
  this.onEvent({
    type: 'research_mode_started',
    data: { topic, reportStyle },
  });

  try {
    // 1. 规划阶段
    this.onEvent({
      type: 'research_progress',
      data: { phase: 'planning', message: '正在制定研究计划...', percent: 10 },
    });

    const planner = new ResearchPlanner(this.modelRouter);
    const plan = await planner.createPlan(topic, { reportStyle });

    this.onEvent({
      type: 'research_plan_created',
      data: { plan },
    });

    // 2. 执行阶段
    this.onEvent({
      type: 'research_progress',
      data: { phase: 'researching', message: '正在执行研究...', percent: 20 },
    });

    const executor = new ResearchExecutor(
      this.toolExecutor,
      this.modelRouter,
      (step, stepPercent) => {
        this.onEvent({
          type: 'research_progress',
          data: {
            phase: 'researching',
            message: `执行中: ${step.title}`,
            percent: 20 + stepPercent * 0.5, // 20% - 70%
            currentStep: step,
          },
        });
      }
    );
    const executedPlan = await executor.execute(plan);

    // 3. 报告生成阶段
    this.onEvent({
      type: 'research_progress',
      data: { phase: 'reporting', message: '正在生成报告...', percent: 80 },
    });

    const generator = new ReportGenerator(this.modelRouter);
    const report = await generator.generate(executedPlan, reportStyle);

    // 4. 完成
    this.onEvent({
      type: 'research_complete',
      data: {
        success: true,
        report,
        plan: executedPlan,
      },
    });

  } catch (error: any) {
    this.onEvent({
      type: 'research_error',
      data: { error: error.message },
    });
  }
}

/**
 * 正常模式执行
 */
private async runNormalMode(userMessage: string): Promise<void> {
  // ... 原有的 Agent 对话逻辑
}
```

#### 3.2.6 研究进度展示组件

```typescript
// src/renderer/components/features/chat/ResearchProgress.tsx

import React from 'react';
import { Loader2, CheckCircle, AlertCircle, FileText, Search, Brain } from 'lucide-react';

export type ResearchPhase = 'planning' | 'researching' | 'reporting' | 'complete' | 'error';

interface ResearchProgressProps {
  phase: ResearchPhase;
  message: string;
  percent: number;
  currentStep?: {
    title: string;
    status: 'running' | 'completed' | 'failed';
  };
  error?: string;
}

const PHASE_ICONS: Record<ResearchPhase, React.ReactNode> = {
  planning: <Brain className="w-5 h-5" />,
  researching: <Search className="w-5 h-5" />,
  reporting: <FileText className="w-5 h-5" />,
  complete: <CheckCircle className="w-5 h-5 text-green-400" />,
  error: <AlertCircle className="w-5 h-5 text-red-400" />,
};

const PHASE_LABELS: Record<ResearchPhase, string> = {
  planning: '制定计划',
  researching: '执行研究',
  reporting: '生成报告',
  complete: '研究完成',
  error: '研究失败',
};

export const ResearchProgress: React.FC<ResearchProgressProps> = ({
  phase,
  message,
  percent,
  currentStep,
  error,
}) => {
  const isActive = phase !== 'complete' && phase !== 'error';

  return (
    <div className="p-4 bg-surface-800/50 border border-zinc-700/50 rounded-lg">
      {/* 顶部状态栏 */}
      <div className="flex items-center gap-3 mb-3">
        <div className={`p-2 rounded-lg ${isActive ? 'bg-primary-500/20' : 'bg-surface-700'}`}>
          {isActive ? (
            <Loader2 className="w-5 h-5 text-primary-400 animate-spin" />
          ) : (
            PHASE_ICONS[phase]
          )}
        </div>

        <div className="flex-1">
          <div className="text-sm font-medium text-white">
            {PHASE_LABELS[phase]}
          </div>
          <div className="text-xs text-zinc-400">
            {message}
          </div>
        </div>

        <div className="text-sm text-zinc-500">
          {percent}%
        </div>
      </div>

      {/* 进度条 */}
      <div className="h-1.5 bg-surface-700 rounded-full overflow-hidden">
        <div
          className={`h-full transition-all duration-300 ${
            phase === 'error' ? 'bg-red-500' :
            phase === 'complete' ? 'bg-green-500' :
            'bg-primary-500'
          }`}
          style={{ width: `${percent}%` }}
        />
      </div>

      {/* 阶段指示器 */}
      <div className="flex items-center justify-between mt-3 px-1">
        {['planning', 'researching', 'reporting'].map((p, index) => {
          const phaseIndex = ['planning', 'researching', 'reporting'].indexOf(phase);
          const isCompleted = index < phaseIndex || phase === 'complete';
          const isCurrent = p === phase;

          return (
            <div key={p} className="flex items-center gap-1.5">
              <div className={`w-2 h-2 rounded-full ${
                isCompleted ? 'bg-green-400' :
                isCurrent ? 'bg-primary-400' :
                'bg-zinc-600'
              }`} />
              <span className={`text-xs ${
                isCompleted || isCurrent ? 'text-zinc-300' : 'text-zinc-600'
              }`}>
                {PHASE_LABELS[p as ResearchPhase]}
              </span>
            </div>
          );
        })}
      </div>

      {/* 当前步骤详情 */}
      {currentStep && (
        <div className="mt-3 pt-3 border-t border-zinc-700/50">
          <div className="flex items-center gap-2 text-xs">
            {currentStep.status === 'running' && (
              <Loader2 className="w-3 h-3 text-primary-400 animate-spin" />
            )}
            {currentStep.status === 'completed' && (
              <CheckCircle className="w-3 h-3 text-green-400" />
            )}
            {currentStep.status === 'failed' && (
              <AlertCircle className="w-3 h-3 text-red-400" />
            )}
            <span className="text-zinc-400">{currentStep.title}</span>
          </div>
        </div>
      )}

      {/* 错误信息 */}
      {error && (
        <div className="mt-3 p-2 bg-red-500/10 border border-red-500/20 rounded text-xs text-red-400">
          {error}
        </div>
      )}
    </div>
  );
};
```

#### 3.2.7 前端状态管理

```typescript
// src/renderer/stores/uiStore.ts

import { create } from 'zustand';
import type { ReportStyle, ResearchPhase } from '../components/features/chat';

interface DeepResearchState {
  /** 当前聊天模式 */
  mode: 'normal' | 'deep-research';
  /** 选择的报告风格 */
  reportStyle: ReportStyle;
  /** 研究进度状态 */
  progress: {
    isActive: boolean;
    phase: ResearchPhase;
    message: string;
    percent: number;
    currentStep?: {
      title: string;
      status: 'running' | 'completed' | 'failed';
    };
    error?: string;
  };
}

interface UIState {
  // ... 其他状态

  deepResearch: DeepResearchState;
}

interface UIActions {
  // ... 其他 actions

  // 深度研究相关
  setDeepResearchMode: (mode: 'normal' | 'deep-research') => void;
  setReportStyle: (style: ReportStyle) => void;
  updateResearchProgress: (progress: Partial<DeepResearchState['progress']>) => void;
  resetResearchProgress: () => void;
}

const initialDeepResearchState: DeepResearchState = {
  mode: 'normal',
  reportStyle: 'default',
  progress: {
    isActive: false,
    phase: 'planning',
    message: '',
    percent: 0,
  },
};

export const useUIStore = create<UIState & UIActions>()((set) => ({
  // ... 其他初始状态

  deepResearch: initialDeepResearchState,

  setDeepResearchMode: (mode) =>
    set((state) => ({
      deepResearch: { ...state.deepResearch, mode },
    })),

  setReportStyle: (style) =>
    set((state) => ({
      deepResearch: { ...state.deepResearch, reportStyle: style },
    })),

  updateResearchProgress: (progress) =>
    set((state) => ({
      deepResearch: {
        ...state.deepResearch,
        progress: {
          ...state.deepResearch.progress,
          ...progress,
          isActive: true,
        },
      },
    })),

  resetResearchProgress: () =>
    set((state) => ({
      deepResearch: {
        ...state.deepResearch,
        progress: initialDeepResearchState.progress,
      },
    })),
}));
```

#### 3.2.8 IPC 事件处理

```typescript
// src/renderer/hooks/useAgentEvents.ts

import { useEffect } from 'react';
import { useUIStore } from '../stores/uiStore';

export function useAgentEvents() {
  const { updateResearchProgress, resetResearchProgress } = useUIStore();

  useEffect(() => {
    // 监听研究相关事件
    const handlers = {
      'research_mode_started': () => {
        updateResearchProgress({
          isActive: true,
          phase: 'planning',
          message: '准备开始研究...',
          percent: 0,
        });
      },

      'research_progress': (data: {
        phase: ResearchPhase;
        message: string;
        percent: number;
        currentStep?: { title: string; status: string };
      }) => {
        updateResearchProgress({
          phase: data.phase,
          message: data.message,
          percent: data.percent,
          currentStep: data.currentStep,
        });
      },

      'research_complete': () => {
        updateResearchProgress({
          phase: 'complete',
          message: '研究完成',
          percent: 100,
        });
        // 3 秒后重置进度
        setTimeout(resetResearchProgress, 3000);
      },

      'research_error': (data: { error: string }) => {
        updateResearchProgress({
          phase: 'error',
          message: '研究失败',
          error: data.error,
        });
      },
    };

    // 注册事件监听
    Object.entries(handlers).forEach(([event, handler]) => {
      window.electronAPI?.on(event, handler);
    });

    return () => {
      // 清理事件监听
      Object.keys(handlers).forEach((event) => {
        window.electronAPI?.off(event);
      });
    };
  }, [updateResearchProgress, resetResearchProgress]);
}
```

### 3.3 架构设计

```
┌─────────────────────────────────────────────────────────────────────┐
│                      用户: "深度研究 XXX"                            │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    DeepResearchMode (新增)                           │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │  1. ResearchPlanner - 生成研究计划                             │ │
│  │     - 8 维分析框架                                             │ │
│  │     - Step 类型: research / analysis / processing             │ │
│  │     - 自动验证与修复                                           │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                              │                                      │
│                              ▼                                      │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │  2. ResearchExecutor - 执行研究步骤                            │ │
│  │     - research: web_search + web_fetch                        │ │
│  │     - analysis: 纯 LLM 推理                                   │ │
│  │     - processing: bash + code 执行                            │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                              │                                      │
│                              ▼                                      │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │  3. ReportGenerator - 生成报告                                 │ │
│  │     - 6 种风格: academic / popular_science / news / ...       │ │
│  │     - Markdown 格式输出                                        │ │
│  └───────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         现有 AgentLoop                               │
│                    (复用工具执行基础设施)                             │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.3 核心类型定义

```typescript
// src/main/research/types.ts

/**
 * 研究步骤类型
 */
export type ResearchStepType = 'research' | 'analysis' | 'processing';

/**
 * 单个研究步骤
 */
export interface ResearchStep {
  /** 步骤 ID */
  id: string;
  /** 步骤标题 */
  title: string;
  /** 详细描述 */
  description: string;
  /** 步骤类型 */
  stepType: ResearchStepType;
  /** 是否需要网络搜索（仅 research 类型有效）*/
  needSearch?: boolean;
  /** 搜索关键词（仅 research 类型有效）*/
  searchQueries?: string[];
  /** 执行状态 */
  status: 'pending' | 'running' | 'completed' | 'failed';
  /** 执行结果 */
  result?: string;
  /** 错误信息 */
  error?: string;
}

/**
 * 研究计划
 */
export interface ResearchPlan {
  /** 研究主题 */
  topic: string;
  /** 澄清后的主题（更精确）*/
  clarifiedTopic: string;
  /** 研究目标 */
  objectives: string[];
  /** 执行步骤 */
  steps: ResearchStep[];
  /** 预期产出 */
  expectedOutput: string;
  /** 计划创建时间 */
  createdAt: number;
}

/**
 * 报告风格
 */
export type ReportStyle =
  | 'academic'           // 学术论文风格
  | 'popular_science'    // 科普文章风格
  | 'news'              // 新闻报道风格
  | 'social_media'      // 社交媒体风格
  | 'strategic_investment' // 投资分析风格
  | 'default';          // 默认风格

/**
 * 研究报告
 */
export interface ResearchReport {
  /** 报告标题 */
  title: string;
  /** 报告风格 */
  style: ReportStyle;
  /** 摘要 */
  summary: string;
  /** 正文（Markdown）*/
  content: string;
  /** 参考来源 */
  sources: Array<{
    title: string;
    url: string;
    snippet?: string;
  }>;
  /** 生成时间 */
  generatedAt: number;
}

/**
 * 深度研究配置
 */
export interface DeepResearchConfig {
  /** 最大研究步骤数 */
  maxSteps?: number;
  /** 每步最大搜索次数 */
  maxSearchPerStep?: number;
  /** 报告风格 */
  reportStyle?: ReportStyle;
  /** 是否强制网络搜索 */
  enforceWebSearch?: boolean;
  /** 语言偏好 */
  locale?: string;
}
```

### 3.4 研究计划器

```typescript
// src/main/research/researchPlanner.ts

/**
 * 研究计划器 - 生成结构化研究计划
 *
 * 借鉴 DeerFlow planner.md 的 8 维分析框架
 */
export class ResearchPlanner {
  private modelRouter: ModelRouter;

  constructor(modelRouter: ModelRouter) {
    this.modelRouter = modelRouter;
  }

  /**
   * 生成研究计划
   */
  async createPlan(
    topic: string,
    config: DeepResearchConfig = {}
  ): Promise<ResearchPlan> {
    const planPrompt = this.buildPlanPrompt(topic, config);

    const response = await this.modelRouter.call({
      provider: config.modelProvider ?? 'deepseek',
      model: config.model ?? 'deepseek-chat',
      messages: [{ role: 'user', content: planPrompt }],
      maxTokens: 2000,
    });

    // 解析 JSON 响应
    const planJson = this.parseJsonResponse(response.content);

    // 验证和修复计划
    const validatedPlan = this.validateAndFixPlan(planJson, config);

    return validatedPlan;
  }

  /**
   * 构建计划 Prompt
   *
   * 借鉴 DeerFlow 8 维分析框架
   */
  private buildPlanPrompt(topic: string, config: DeepResearchConfig): string {
    return `你是一个专业的研究规划师。请为以下主题制定详细的研究计划。

## 研究主题
${topic}

## 分析框架

请从以下 8 个维度思考研究方向：

1. **历史维度**: 这个主题的起源和发展历程
2. **现状维度**: 当前的状态、趋势和关键数据
3. **未来维度**: 发展方向、预测和潜在变化
4. **利益方维度**: 涉及的各方及其立场和利益
5. **量化维度**: 可量化的数据、统计和指标
6. **定性维度**: 观点、评价和主观分析
7. **对比维度**: 与相关主题的比较和差异
8. **风险维度**: 潜在风险、挑战和不确定性

## 步骤类型说明

每个步骤必须指定 stepType：
- **research**: 需要网络搜索收集信息的步骤
- **analysis**: 基于已收集信息进行纯分析的步骤
- **processing**: 需要执行代码或处理数据的步骤

## 要求

1. 至少包含一个 research 类型步骤（需要网络搜索）
2. 步骤数量控制在 ${config.maxSteps ?? 5} 个以内
3. 步骤之间应有逻辑递进关系
4. 每个 research 步骤需提供搜索关键词

## 输出格式

请以 JSON 格式输出：

\`\`\`json
{
  "clarifiedTopic": "更精确的研究主题描述",
  "objectives": ["研究目标1", "研究目标2"],
  "steps": [
    {
      "id": "step_1",
      "title": "步骤标题",
      "description": "步骤详细描述",
      "stepType": "research",
      "needSearch": true,
      "searchQueries": ["搜索词1", "搜索词2"]
    },
    {
      "id": "step_2",
      "title": "分析xxx",
      "description": "基于收集的信息分析...",
      "stepType": "analysis"
    }
  ],
  "expectedOutput": "预期产出的报告类型和内容"
}
\`\`\``;
  }

  /**
   * 验证和修复计划
   *
   * 借鉴 DeerFlow validate_and_fix_plan 逻辑
   */
  private validateAndFixPlan(
    plan: Partial<ResearchPlan>,
    config: DeepResearchConfig
  ): ResearchPlan {
    const steps = plan.steps ?? [];

    // 1. 确保每个步骤都有 stepType
    for (const step of steps) {
      if (!step.stepType) {
        // 根据内容推断类型
        if (step.needSearch || step.searchQueries?.length) {
          step.stepType = 'research';
        } else if (step.title?.includes('分析') || step.title?.includes('总结')) {
          step.stepType = 'analysis';
        } else {
          step.stepType = 'analysis'; // 默认
        }
      }

      // 初始化状态
      step.status = 'pending';
    }

    // 2. 强制网络搜索：确保至少有一个 research 步骤
    if (config.enforceWebSearch !== false) {
      const hasResearch = steps.some(s => s.stepType === 'research' && s.needSearch);
      if (!hasResearch && steps.length > 0) {
        steps[0].stepType = 'research';
        steps[0].needSearch = true;
        steps[0].searchQueries = steps[0].searchQueries ?? [plan.clarifiedTopic ?? plan.topic];
      }
    }

    return {
      topic: plan.topic ?? '',
      clarifiedTopic: plan.clarifiedTopic ?? plan.topic ?? '',
      objectives: plan.objectives ?? [],
      steps,
      expectedOutput: plan.expectedOutput ?? '研究报告',
      createdAt: Date.now(),
    };
  }
}
```

### 3.5 研究执行器

```typescript
// src/main/research/researchExecutor.ts

/**
 * 研究执行器 - 执行研究计划中的步骤
 */
export class ResearchExecutor {
  private toolExecutor: ToolExecutor;
  private modelRouter: ModelRouter;
  private onProgress: (step: ResearchStep, progress: number) => void;

  constructor(
    toolExecutor: ToolExecutor,
    modelRouter: ModelRouter,
    onProgress?: (step: ResearchStep, progress: number) => void
  ) {
    this.toolExecutor = toolExecutor;
    this.modelRouter = modelRouter;
    this.onProgress = onProgress ?? (() => {});
  }

  /**
   * 执行研究计划
   */
  async execute(plan: ResearchPlan): Promise<ResearchPlan> {
    const updatedPlan = { ...plan };

    for (let i = 0; i < updatedPlan.steps.length; i++) {
      const step = updatedPlan.steps[i];

      // 更新状态
      step.status = 'running';
      this.onProgress(step, (i / updatedPlan.steps.length) * 100);

      try {
        const result = await this.executeStep(step, updatedPlan);
        step.result = result;
        step.status = 'completed';
      } catch (error: any) {
        step.error = error.message;
        step.status = 'failed';
        // 继续执行后续步骤（非阻塞）
      }

      this.onProgress(step, ((i + 1) / updatedPlan.steps.length) * 100);
    }

    return updatedPlan;
  }

  /**
   * 执行单个步骤
   */
  private async executeStep(
    step: ResearchStep,
    plan: ResearchPlan
  ): Promise<string> {
    switch (step.stepType) {
      case 'research':
        return await this.executeResearchStep(step);
      case 'analysis':
        return await this.executeAnalysisStep(step, plan);
      case 'processing':
        return await this.executeProcessingStep(step, plan);
      default:
        throw new Error(`Unknown step type: ${step.stepType}`);
    }
  }

  /**
   * 执行研究步骤（网络搜索 + 内容抓取）
   */
  private async executeResearchStep(step: ResearchStep): Promise<string> {
    const results: string[] = [];

    // 执行搜索
    for (const query of step.searchQueries ?? []) {
      try {
        const searchResult = await this.toolExecutor.execute('web_search', {
          query,
          count: 5,
        });

        if (searchResult.success && searchResult.output) {
          results.push(`## 搜索: ${query}\n${searchResult.output}`);

          // 抓取前 3 个结果页面
          const urls = this.extractUrls(searchResult.output).slice(0, 3);
          for (const url of urls) {
            try {
              const fetchResult = await this.toolExecutor.execute('web_fetch', { url });
              if (fetchResult.success && fetchResult.output) {
                results.push(`### ${url}\n${fetchResult.output.slice(0, 2000)}`);
              }
            } catch {
              // 忽略单个页面抓取失败
            }
          }
        }
      } catch (error: any) {
        results.push(`搜索失败 [${query}]: ${error.message}`);
      }
    }

    return results.join('\n\n');
  }

  /**
   * 执行分析步骤（纯 LLM 推理）
   */
  private async executeAnalysisStep(
    step: ResearchStep,
    plan: ResearchPlan
  ): Promise<string> {
    // 收集前序步骤的结果
    const previousResults = plan.steps
      .filter(s => s.status === 'completed' && s.result)
      .map(s => `### ${s.title}\n${s.result}`)
      .join('\n\n');

    const analysisPrompt = `基于以下已收集的信息，完成分析任务。

## 研究主题
${plan.clarifiedTopic}

## 当前任务
${step.title}: ${step.description}

## 已收集信息
${previousResults}

## 要求
1. 基于事实进行分析
2. 引用具体数据和来源
3. 保持客观中立
4. 输出结构化的分析结果`;

    const response = await this.modelRouter.call({
      provider: 'deepseek',
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: analysisPrompt }],
      maxTokens: 2000,
    });

    return response.content;
  }

  /**
   * 执行处理步骤（代码执行）
   */
  private async executeProcessingStep(
    step: ResearchStep,
    plan: ResearchPlan
  ): Promise<string> {
    // 当前简化实现：将处理请求转换为 LLM 分析
    // 未来可扩展为真实代码执行
    return await this.executeAnalysisStep(step, plan);
  }

  private extractUrls(text: string): string[] {
    const urlPattern = /https?:\/\/[^\s\)\]]+/g;
    return text.match(urlPattern) ?? [];
  }
}
```

### 3.6 报告生成器

```typescript
// src/main/research/reportGenerator.ts

/**
 * 报告风格 Prompt 配置
 *
 * 借鉴 DeerFlow reporter.md 的 6 种风格
 */
const REPORT_STYLE_PROMPTS: Record<ReportStyle, string> = {
  academic: `以学术论文风格撰写报告：
- 使用正式、客观的语言
- 引用来源需标注
- 包含摘要、引言、方法、结果、讨论、结论等部分
- 使用专业术语`,

  popular_science: `以科普文章风格撰写报告：
- 使用通俗易懂的语言
- 用类比和例子解释复杂概念
- 保持趣味性和可读性
- 适合普通读者阅读`,

  news: `以新闻报道风格撰写报告：
- 采用倒金字塔结构
- 开头包含核心要点（5W1H）
- 语言简洁有力
- 引用权威来源`,

  social_media: `以社交媒体风格撰写报告：
- 简短精炼
- 使用列表和要点
- 适合快速阅读
- 可包含 emoji 增强可读性`,

  strategic_investment: `以投资分析风格撰写报告：
- 包含市场分析、竞争格局
- 量化数据和财务指标
- 风险评估和投资建议
- 专业且深入，不少于 5000 字`,

  default: `以通用报告风格撰写：
- 结构清晰
- 客观呈现信息
- 包含摘要和结论`,
};

/**
 * 报告生成器
 */
export class ReportGenerator {
  private modelRouter: ModelRouter;

  constructor(modelRouter: ModelRouter) {
    this.modelRouter = modelRouter;
  }

  /**
   * 生成研究报告
   */
  async generate(
    plan: ResearchPlan,
    style: ReportStyle = 'default'
  ): Promise<ResearchReport> {
    // 收集所有步骤结果
    const stepResults = plan.steps
      .filter(s => s.status === 'completed' && s.result)
      .map(s => `## ${s.title}\n${s.result}`)
      .join('\n\n');

    // 生成报告
    const reportPrompt = `请基于以下研究内容，生成一份完整的研究报告。

## 研究主题
${plan.clarifiedTopic}

## 研究目标
${plan.objectives.map((o, i) => `${i + 1}. ${o}`).join('\n')}

## 研究结果
${stepResults}

## 写作风格要求
${REPORT_STYLE_PROMPTS[style]}

## 输出格式
请输出 Markdown 格式的报告，包含：
1. 标题
2. 摘要（100-200字）
3. 正文（根据风格要求组织）
4. 结论
5. 参考来源列表`;

    const response = await this.modelRouter.call({
      provider: 'deepseek',
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: reportPrompt }],
      maxTokens: 4000,
    });

    // 解析报告
    const report = this.parseReport(response.content, plan, style);

    return report;
  }

  private parseReport(
    content: string,
    plan: ResearchPlan,
    style: ReportStyle
  ): ResearchReport {
    // 提取标题
    const titleMatch = content.match(/^#\s+(.+)$/m);
    const title = titleMatch?.[1] ?? plan.clarifiedTopic;

    // 提取摘要
    const summaryMatch = content.match(/##\s*摘要\s*\n([\s\S]*?)(?=\n##|$)/);
    const summary = summaryMatch?.[1]?.trim() ?? '';

    // 提取来源
    const sources = this.extractSources(content);

    return {
      title,
      style,
      summary,
      content,
      sources,
      generatedAt: Date.now(),
    };
  }

  private extractSources(content: string): Array<{ title: string; url: string }> {
    const sources: Array<{ title: string; url: string }> = [];
    const urlPattern = /\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g;

    let match;
    while ((match = urlPattern.exec(content)) !== null) {
      sources.push({
        title: match[1],
        url: match[2],
      });
    }

    return sources;
  }
}
```

### 3.7 深度研究 Skill 集成

```typescript
// src/main/skills/deepResearch.ts

/**
 * 深度研究 Skill
 *
 * 作为 Gen4 Skill 系统的一部分集成
 */
export const deepResearchSkill: Skill = {
  name: 'deep-research',
  description: '深度研究：自动规划、搜索、分析并生成研究报告',

  async execute(input: string, context: SkillContext): Promise<SkillResult> {
    const { toolExecutor, modelRouter, onProgress } = context;

    // 解析输入
    const config = parseResearchInput(input);

    // 1. 创建研究计划
    onProgress?.('planning', '正在制定研究计划...');
    const planner = new ResearchPlanner(modelRouter);
    const plan = await planner.createPlan(config.topic, config);

    // 2. 执行研究
    onProgress?.('researching', '正在执行研究...');
    const executor = new ResearchExecutor(toolExecutor, modelRouter, (step, progress) => {
      onProgress?.('researching', `执行中: ${step.title} (${progress.toFixed(0)}%)`);
    });
    const executedPlan = await executor.execute(plan);

    // 3. 生成报告
    onProgress?.('reporting', '正在生成报告...');
    const generator = new ReportGenerator(modelRouter);
    const report = await generator.generate(executedPlan, config.reportStyle);

    return {
      success: true,
      output: report.content,
      metadata: {
        title: report.title,
        style: report.style,
        sourcesCount: report.sources.length,
        stepsCompleted: executedPlan.steps.filter(s => s.status === 'completed').length,
      },
    };
  },
};

function parseResearchInput(input: string): DeepResearchConfig & { topic: string } {
  // 简单解析，支持格式：
  // "研究 <topic>"
  // "研究 <topic> 风格:<style>"
  const styleMatch = input.match(/风格[：:]\s*(\w+)/);
  const topic = input.replace(/风格[：:]\s*\w+/, '').replace(/^研究\s*/, '').trim();

  return {
    topic,
    reportStyle: (styleMatch?.[1] as ReportStyle) ?? 'default',
    maxSteps: 5,
    maxSearchPerStep: 3,
    enforceWebSearch: true,
    locale: 'zh-CN',
  };
}
```

### 3.8 前端集成

```typescript
// 新增 AgentEvent 类型
interface ResearchProgressEvent {
  type: 'research_progress';
  data: {
    phase: 'planning' | 'researching' | 'reporting';
    message: string;
    plan?: ResearchPlan;
    currentStep?: ResearchStep;
    progress?: number;
  };
}

interface ResearchCompleteEvent {
  type: 'research_complete';
  data: {
    report: ResearchReport;
    plan: ResearchPlan;
  };
}
```

---

## 四、实现计划

### 4.1 第一阶段：上下文压缩（1-2 天）

| 任务 | 文件 | 优先级 |
|------|------|--------|
| 创建 TokenCounter | `src/main/context/tokenCounter.ts` | P0 |
| 创建 ContextCompressor | `src/main/context/contextCompressor.ts` | P0 |
| 集成到 AgentLoop | `src/main/agent/agentLoop.ts` | P0 |
| 添加配置项 | `src/shared/types/settings.ts` | P1 |
| 前端事件展示 | `src/renderer/components/` | P2 |

### 4.2 第二阶段：深度研究核心（2-3 天）

| 任务 | 文件 | 优先级 |
|------|------|--------|
| 定义类型 | `src/main/research/types.ts` | P0 |
| 研究计划器 | `src/main/research/researchPlanner.ts` | P0 |
| 研究执行器 | `src/main/research/researchExecutor.ts` | P0 |
| 报告生成器 | `src/main/research/reportGenerator.ts` | P0 |
| Skill 集成 | `src/main/skills/deepResearch.ts` | P1 |

### 4.3 第三阶段：模式切换与进度展示（1-2 天）

| 任务 | 文件 | 优先级 |
|------|------|--------|
| 模式切换组件 | `src/renderer/components/features/chat/ChatInput/ModeSwitch.tsx` | P0 |
| 报告风格选择器 | `src/renderer/components/features/chat/ChatInput/ReportStyleSelector.tsx` | P0 |
| ChatInput 集成 | `src/renderer/components/features/chat/ChatInput/index.tsx` | P0 |
| 研究进度展示组件 | `src/renderer/components/features/chat/ResearchProgress.tsx` | P0 |
| UI 状态管理 | `src/renderer/stores/uiStore.ts` | P1 |
| AgentLoop 模式分发 | `src/main/agent/agentLoop.ts` | P0 |
| IPC 事件处理 | `src/renderer/hooks/useAgentEvents.ts` | P1 |

### 4.4 测试用例

```typescript
// 上下文压缩测试
describe('ContextCompressor', () => {
  it('should compress messages when over token limit', () => {
    const compressor = new ContextCompressor({ tokenLimit: 1000 });
    const messages = generateLongMessages(50); // 生成超限消息

    const result = compressor.compress(messages, 'system prompt');

    expect(result.stats.compressedTokens).toBeLessThanOrEqual(800);
    expect(result.messages.length).toBeLessThan(messages.length);
  });

  it('should preserve prefix and recent messages', () => {
    const compressor = new ContextCompressor({
      tokenLimit: 500,
      preservePrefixCount: 2,
      preserveRecentCount: 3,
    });
    const messages = generateMessages(10);

    const result = compressor.compress(messages, '');

    // 验证头尾保留
    expect(result.messages[0].id).toBe(messages[0].id);
    expect(result.messages[1].id).toBe(messages[1].id);
    expect(result.messages.at(-1)?.id).toBe(messages.at(-1)?.id);
  });
});

// 深度研究测试
describe('DeepResearch', () => {
  it('should create valid research plan', async () => {
    const planner = new ResearchPlanner(mockModelRouter);

    const plan = await planner.createPlan('AI 发展趋势');

    expect(plan.steps.length).toBeGreaterThan(0);
    expect(plan.steps.some(s => s.stepType === 'research')).toBe(true);
  });

  it('should execute research steps and generate report', async () => {
    const executor = new ResearchExecutor(mockToolExecutor, mockModelRouter);
    const generator = new ReportGenerator(mockModelRouter);

    const plan = mockResearchPlan();
    const executed = await executor.execute(plan);
    const report = await generator.generate(executed, 'default');

    expect(report.content.length).toBeGreaterThan(500);
    expect(report.sources.length).toBeGreaterThan(0);
  });
});

// 研究意图识别测试
describe('ResearchIntentAnalyzer', () => {
  const analyzer = new ResearchIntentAnalyzer();

  it('should detect strong research intent', () => {
    const result = analyzer.analyze('帮我深度研究一下 AI Agent 的发展趋势');

    expect(result.isResearchIntent).toBe(true);
    expect(result.confidence).toBeGreaterThan(0.7);
  });

  it('should detect research intent with multiple signals', () => {
    const result = analyzer.analyze('我想了解一下市场趋势，对比分析一下主流产品的优劣');

    expect(result.isResearchIntent).toBe(true);
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('should NOT detect research intent for code tasks', () => {
    const result = analyzer.analyze('帮我写一个 React 组件');

    expect(result.isResearchIntent).toBe(false);
    expect(result.confidence).toBeLessThan(0.5);
  });

  it('should NOT detect research intent for simple questions', () => {
    const result = analyzer.analyze('简单说一下什么是 TypeScript');

    expect(result.isResearchIntent).toBe(false);
  });

  it('should infer report style from message', () => {
    const academic = analyzer.analyze('请用学术论文的风格研究这个课题');
    expect(academic.suggestedStyle).toBe('academic');

    const investment = analyzer.analyze('帮我做一个投资分析报告');
    expect(investment.suggestedStyle).toBe('strategic_investment');
  });
});
```

---

## 五、风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| Token 计数不准确 | 压缩过度或不足 | 保留 10% 余量；支持配置调整 |
| LLM 摘要质量差 | 关键信息丢失 | 摘要默认关闭；保留原始消息备份 |
| 研究计划格式解析失败 | 流程中断 | JSON 解析容错；自动修复逻辑 |
| 网络搜索超时/失败 | 研究结果不完整 | 重试机制；允许跳过失败步骤 |
| 报告生成 Token 超限 | 输出截断 | 分段生成；控制单次输出长度 |
| 意图识别误判（假阳性）| 简单问题被当作研究任务 | 置信度阈值 0.7；用户可手动关闭 |
| 意图识别误判（假阴性）| 研究需求被当作普通问题 | UI 提供手动开启按钮；AI 建议提示 |

---

## 六、参考

- DeerFlow 源码: https://github.com/bytedance/deer-flow
- DeerFlow `src/utils/context_manager.py`: 上下文压缩算法
- DeerFlow `src/prompts/planner.md`: 研究计划 Prompt
- DeerFlow `src/prompts/reporter.md`: 报告生成 Prompt
- Code Agent `src/main/services/auth/tokenManager.ts`: 现有 Token 管理
- Code Agent `src/main/agent/agentLoop.ts`: Agent 执行循环

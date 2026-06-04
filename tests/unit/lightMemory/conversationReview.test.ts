// ============================================================================
// ConversationReview Tests — 运行时 skill 自沉淀的 LLM 复盘链
// 测试：skill 名规整、复盘 JSON 解析、prompt 组装、优雅降级（模型失败/超时/太短）
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ──

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const quickModelMocks = vi.hoisted(() => ({
  quickTask: vi.fn<(prompt: string, maxTokens?: number) => Promise<{ success: boolean; content?: string; error?: string }>>(),
}));

vi.mock('../../../src/main/model/quickModel', () => ({
  quickTask: quickModelMocks.quickTask,
}));

// withTimeout 直接透传被包裹的 promise（超时分支单独用 reject 模拟）
vi.mock('../../../src/main/services/infra/timeoutController', () => ({
  withTimeout: <T>(promise: Promise<T>) => promise,
}));

import {
  toSkillName,
  parseReviewedSkill,
  buildReviewSnippet,
  buildReviewPrompt,
  reviewConversationForSkill,
} from '../../../src/main/lightMemory/conversationReview';

beforeEach(() => {
  quickModelMocks.quickTask.mockReset();
});

// ── toSkillName ──

describe('toSkillName', () => {
  it('规整为 kebab-case', () => {
    expect(toSkillName('Deploy Tauri macOS')).toBe('deploy-tauri-macos');
    expect(toSkillName('部署 Tauri / macOS!!')).toBe('tauri-macos');
    expect(toSkillName('  --foo__bar--  ')).toBe('foo-bar');
  });

  it('超长截断且不留尾部连字符', () => {
    const name = toSkillName('a'.repeat(80));
    expect(name.length).toBeLessThanOrEqual(48);
    expect(name.endsWith('-')).toBe(false);
  });
});

// ── parseReviewedSkill ──

describe('parseReviewedSkill', () => {
  const valid = {
    shouldCreate: true,
    signal: 'user_correction',
    name: 'deploy-tauri-macos',
    description: '在 macOS 上打包并安装 Tauri 应用的标准流程',
    body: '## 步骤\n1. typecheck\n2. cargo tauri build\n3. 用安装脚本而非手动 cp',
  };

  it('解析合法 JSON', () => {
    const r = parseReviewedSkill(JSON.stringify(valid));
    expect(r).not.toBeNull();
    expect(r!.name).toBe('deploy-tauri-macos');
    expect(r!.signal).toBe('user_correction');
    expect(r!.body).toContain('cargo tauri build');
  });

  it('容忍 JSON 前后有多余文字 / 代码块包裹', () => {
    const wrapped = '好的，结论如下：\n```json\n' + JSON.stringify(valid) + '\n```\n以上。';
    expect(parseReviewedSkill(wrapped)).not.toBeNull();
  });

  it('shouldCreate=false → null（本轮不沉淀）', () => {
    expect(parseReviewedSkill(JSON.stringify({ ...valid, shouldCreate: false }))).toBeNull();
  });

  it('缺 name / description / body 任一 → null', () => {
    expect(parseReviewedSkill(JSON.stringify({ ...valid, name: '' }))).toBeNull();
    expect(parseReviewedSkill(JSON.stringify({ ...valid, description: '' }))).toBeNull();
    expect(parseReviewedSkill(JSON.stringify({ ...valid, body: '   ' }))).toBeNull();
  });

  it('非法 / 缺失 signal → 兜底为 reusable_workflow', () => {
    expect(parseReviewedSkill(JSON.stringify({ ...valid, signal: 'garbage' }))!.signal).toBe('reusable_workflow');
    const noSig = { ...valid } as Record<string, unknown>;
    delete noSig.signal;
    expect(parseReviewedSkill(JSON.stringify(noSig))!.signal).toBe('reusable_workflow');
  });

  it('无 JSON / 坏 JSON → null', () => {
    expect(parseReviewedSkill('完全没有 JSON')).toBeNull();
    expect(parseReviewedSkill('{ 坏的: }')).toBeNull();
  });

  it('name 会被规整为 kebab-case', () => {
    expect(parseReviewedSkill(JSON.stringify({ ...valid, name: 'Deploy Tauri macOS' }))!.name).toBe('deploy-tauri-macos');
  });
});

// ── buildReviewSnippet / buildReviewPrompt ──

describe('buildReviewSnippet', () => {
  it('只取最近 N 轮用户消息并附最后助手回复', () => {
    const userMessages = Array.from({ length: 15 }, (_, i) => `msg ${i}`);
    const snippet = buildReviewSnippet({ userMessages, lastAssistant: '助手回复内容' });
    expect(snippet).toContain('msg 14');
    expect(snippet).not.toContain('msg 0'); // 超出 RECENT_USER_TURNS(10) 被裁掉
    expect(snippet).toContain('助手最后回复：助手回复内容');
  });

  it('过滤空消息', () => {
    const snippet = buildReviewSnippet({ userMessages: ['', '  ', '有效内容'] });
    expect(snippet).toContain('有效内容');
    expect(snippet.match(/用户消息/g)?.length).toBe(1);
  });
});

describe('buildReviewPrompt', () => {
  it('包含决策指令与会话内容', () => {
    const prompt = buildReviewPrompt({ userMessages: ['帮我部署'] });
    expect(prompt).toContain('shouldCreate');
    expect(prompt).toContain('CLASS-LEVEL');
    expect(prompt).toContain('帮我部署');
  });
});

// ── reviewConversationForSkill（编排 + 降级）──

describe('reviewConversationForSkill', () => {
  const turns = ['第一轮提问', '第二轮纠正：应该用脚本安装'];

  it('用户轮数不足 MIN_USER_TURNS → 直接 null，不调用模型', async () => {
    const r = await reviewConversationForSkill({ userMessages: ['只有一轮'] });
    expect(r).toBeNull();
    expect(quickModelMocks.quickTask).not.toHaveBeenCalled();
  });

  it('模型返回合法草稿 → 返回 ReviewedSkill', async () => {
    quickModelMocks.quickTask.mockResolvedValue({
      success: true,
      content: JSON.stringify({
        shouldCreate: true,
        signal: 'user_correction',
        name: 'install-via-script',
        description: '安装桌面应用时优先用安装脚本而非手动 cp',
        body: '## 要点\n用 scripts/tauri-install.sh，手动 cp 会残留旧文件',
      }),
    });
    const r = await reviewConversationForSkill({ userMessages: turns });
    expect(r).not.toBeNull();
    expect(r!.name).toBe('install-via-script');
  });

  it('模型不可用 → null（不抛错）', async () => {
    quickModelMocks.quickTask.mockResolvedValue({ success: false, error: 'not configured' });
    expect(await reviewConversationForSkill({ userMessages: turns })).toBeNull();
  });

  it('模型抛错 / 超时 → null（静默降级）', async () => {
    quickModelMocks.quickTask.mockRejectedValue(new Error('timeout'));
    expect(await reviewConversationForSkill({ userMessages: turns })).toBeNull();
  });

  it('模型返回 shouldCreate=false → null', async () => {
    quickModelMocks.quickTask.mockResolvedValue({
      success: true,
      content: JSON.stringify({ shouldCreate: false, signal: 'none', name: '', description: '', body: '' }),
    });
    expect(await reviewConversationForSkill({ userMessages: turns })).toBeNull();
  });
});

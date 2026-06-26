// ============================================================================
// ConversationReview Tests — 运行时 skill 自沉淀的 LLM 复盘链
// 测试：skill 名规整、复盘 JSON 解析、prompt 组装、优雅降级（模型失败/超时/太短）
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ──

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const quickModelMocks = vi.hoisted(() => ({
  quickTask: vi.fn<(prompt: string, maxTokens?: number) => Promise<{ success: boolean; content?: string; error?: string }>>(),
}));

vi.mock('../../../src/host/model/quickModel', () => ({
  quickTask: quickModelMocks.quickTask,
}));

// withTimeout 直接透传被包裹的 promise（超时分支单独用 reject 模拟）
vi.mock('../../../src/host/services/infra/timeoutController', () => ({
  withTimeout: <T>(promise: Promise<T>) => promise,
}));

import {
  toSkillName,
  isLowValueSkillName,
  parseReviewedSkill,
  buildReviewSnippet,
  buildReviewPrompt,
  reviewConversationForSkill,
} from '../../../src/host/lightMemory/conversationReview';
import { SKILL_REVIEW, SESSION_JUDGE } from '../../../src/shared/constants';

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

// ── isLowValueSkillName ──

describe('isLowValueSkillName', () => {
  it('泛词 → 低价值', () => {
    for (const n of ['helper', 'utils', 'tools', 'workflow', 'data', 'files', 'general', 'skill']) {
      expect(isLowValueSkillName(n)).toBe(true);
    }
  });

  it('纯工具名拼接 → 低价值', () => {
    for (const n of ['bash-bash-bash', 'grep-read-edit', 'run-bash', 'read-write-edit', 'BASH-BASH-BASH-BASH']) {
      expect(isLowValueSkillName(n)).toBe(true);
    }
  });

  it('空名 → 低价值', () => {
    expect(isLowValueSkillName('')).toBe(true);
    expect(isLowValueSkillName('  !!  ')).toBe(true);
  });

  it('有意义的意图名 → 放行', () => {
    for (const n of ['deploying-tauri-macos', 'extracting-pdf-tables', 'migrating-database-schema', 'read-pdf-tables', 'run-eval-suite']) {
      expect(isLowValueSkillName(n)).toBe(false);
    }
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

  it('低价值名（泛词 / 纯工具名拼接）→ null', () => {
    expect(parseReviewedSkill(JSON.stringify({ ...valid, name: 'bash-bash-bash' }))).toBeNull();
    expect(parseReviewedSkill(JSON.stringify({ ...valid, name: 'helper' }))).toBeNull();
    expect(parseReviewedSkill(JSON.stringify({ ...valid, name: 'tools' }))).toBeNull();
  });

  it('主题级 PPT 草稿且只有空泛方法 → null', () => {
    const r = parseReviewedSkill(JSON.stringify({
      ...valid,
      signal: 'reusable_workflow',
      name: 'creating-ai-product-manager-presentation',
      description: 'Create a professional AI product manager transformation presentation.',
      body: [
        '## When to use',
        'Create a presentation on AI product manager transformation.',
        '## Steps',
        '1. Define content structure with market trends and core competencies.',
        '2. Choose a professional style.',
        '3. Deliver it to the user.',
        '## Verification',
        '- Check content accuracy and style consistency.',
      ].join('\n'),
    }));
    expect(r).toBeNull();
  });

  it('跨主题 PPT 工作流名 → 放行', () => {
    const r = parseReviewedSkill(JSON.stringify({
      ...valid,
      signal: 'reusable_workflow',
      name: 'generating-ppt-from-outline',
      description: 'Generate a presentation from a structured outline.',
      body: [
        '## Steps',
        '1. Convert the outline into slide titles and bullets.',
        '2. Generate slides.json and page prompts.',
        '3. Synthesize PPTX/PDF and review the browser export.',
      ].join('\n'),
    }));
    expect(r).not.toBeNull();
    expect(r!.name).toBe('generating-ppt-from-outline');
  });

  it('主题级 PPT 但有可迁移方法 → 归并成通用工作流名', () => {
    const r = parseReviewedSkill(JSON.stringify({
      ...valid,
      signal: 'reusable_workflow',
      name: 'generating-ai-agent-architecture-ppt',
      description: 'Create an AI Agent architecture PPT with a specific theme.',
      body: [
        '## Steps',
        '1. Convert the brief into a slide outline.',
        '2. Generate slides.json and page prompts.',
        '3. Generate background images.',
        '4. Merge text and images into PPTX/PDF.',
        '## Verification',
        '- Render the deck in a browser and capture screenshots.',
      ].join('\n'),
    }));
    expect(r).not.toBeNull();
    expect(r!.name).toBe('generating-presentation-from-outline');
    expect(r!.description).toContain('structured outline');
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
    expect(prompt).toContain('不要把具体主题写进 skill 名');
    expect(prompt).toContain('帮我部署');
  });
});

// ── reviewConversationForSkill（编排 + 降级）──

describe('reviewConversationForSkill', () => {
  const turns = ['第一轮提问', '第二轮纠正：应该用脚本安装'];

  it('skill 复盘要给足生成正文的真实 provider 超时预算', () => {
    expect(SKILL_REVIEW.TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
    expect(SKILL_REVIEW.TIMEOUT_MS).toBeGreaterThan(SESSION_JUDGE.TIMEOUT_MS);
  });

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

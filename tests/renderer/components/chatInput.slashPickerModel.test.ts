import { describe, expect, it } from 'vitest';
import type { ParsedSkill } from '../../../src/shared/contract/agentSkill';
import type { AgentListEntry } from '../../../src/shared/contract/agentRegistry';
import type { SessionSkillMount } from '../../../src/shared/contract/skillRepository';
import {
  buildInlineSkillTokenValue,
  buildLeadingSlashCommandValue,
  createAgentCandidates,
  createCommandCandidate,
  createPromptCandidate,
  createSkillCandidates,
  createWorkbenchCapabilityCandidates,
  filterAndRankSlashCandidates,
  getTrailingSlashToken,
  groupSlashCandidates,
  removeTrailingSlashToken,
} from '../../../src/renderer/components/features/chat/ChatInput/slashPickerModel';
import type { WorkbenchCapabilityRegistryItem } from '../../../src/renderer/utils/workbenchCapabilityRegistry';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';

const makeSkill = (overrides: Partial<ParsedSkill>): ParsedSkill => ({
  name: 'docx',
  description: 'Word document helper',
  promptContent: '',
  basePath: '/repo/skills/docx',
  allowedTools: [],
  disableModelInvocation: false,
  userInvocable: true,
  executionContext: 'inline',
  source: 'project',
  ...overrides,
});

const agents: AgentListEntry[] = [
  {
    id: 'reviewer',
    name: 'Reviewer',
    description: 'Reviews code quality.',
    source: 'builtin',
    modelTier: 'balanced',
    readonly: true,
    tools: [],
  },
];

describe('slash picker model', () => {
  it('detects leading and trailing slash tokens without matching paths', () => {
    expect(getTrailingSlashToken('/low')).toMatchObject({
      query: 'low',
      start: 0,
      end: 4,
      baseInput: '',
    });
    expect(getTrailingSlashToken('帮我整理 /sum')).toMatchObject({
      query: 'sum',
      start: 5,
      end: 9,
      baseInput: '帮我整理',
    });
    expect(getTrailingSlashToken('打开 /tmp/file')).toBeNull();
    expect(getTrailingSlashToken('https://example.com/sum')).toBeNull();
  });

  it('preserves the draft when prefilling leading slash commands', () => {
    expect(buildLeadingSlashCommandValue('帮我整理 /sum', 'summarize')).toBe('/summarize 帮我整理 ');
    expect(buildLeadingSlashCommandValue('/goal', 'goal')).toBe('/goal ');
  });

  it('replaces the trailing slash with an inline skill token', () => {
    expect(buildInlineSkillTokenValue('帮我处理 /doc', 'docx')).toBe('帮我处理 <docx> ');
    expect(buildInlineSkillTokenValue('帮我处理 <docx> /doc', 'docx')).toBe('帮我处理 <docx> ');
    expect(removeTrailingSlashToken('帮我处理 /doc')).toBe('帮我处理');
  });

  it('ranks exact slash command matches ahead of substring matches', () => {
    const commands = [
      createCommandCandidate({ id: 'workflow', label: 'Workflow', description: 'Run workflow' }),
      createCommandCandidate({ id: 'low', label: 'Low', description: 'Low effort' }),
    ];

    expect(filterAndRankSlashCandidates(commands, 'low').map((cmd) => cmd.id)).toEqual([
      'low',
      'workflow',
    ]);
  });

  it('creates prompt and agent candidates for direct composer prefill', () => {
    expect(createPromptCandidate({
      name: 'summarize',
      description: 'Summarize current topic',
      source: 'file',
      hints: ['$ARGUMENTS'],
    })).toMatchObject({
      id: 'prompt:summarize',
      kind: 'prompt',
      actionKind: 'prefill-prompt',
      slashText: '/summarize',
      promptName: 'summarize',
    });

    expect(createAgentCandidates(agents)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'agent:reviewer',
        kind: 'agent',
        actionKind: 'select-agent',
        slashText: '/agent reviewer',
        agentToken: 'reviewer',
      }),
    ]));
  });

  it('creates skill candidates with mounted and selected state', () => {
    const mounted: SessionSkillMount[] = [
      {
        skillName: 'docx',
        libraryId: 'office',
        mountedAt: 1,
        source: 'manual',
      },
    ];
    const candidates = createSkillCandidates({
      availableSkills: [
        makeSkill({ basePath: '/repo/libraries/office/docx' }),
        makeSkill({ name: 'excel', description: 'Spreadsheet helper', basePath: '/repo/skills/excel' }),
      ],
      mountedSkills: mounted,
      selectedSkillIds: ['docx'],
    });

    expect(candidates[0]).toMatchObject({
      id: 'skill:docx',
      kind: 'skill',
      actionKind: 'select-skill',
      skillLibraryId: 'office',
      skillMounted: true,
      skillSelected: true,
      slashText: '/skills:docx',
    });
  });

  it('limits empty query to high-frequency and currently relevant entries', () => {
    const commands = [
      createCommandCandidate({ id: 'context', label: 'Context', description: 'Open context inspector' }),
      createCommandCandidate({
        id: 'goal',
        label: 'Goal',
        description: 'Start autonomous goal mode',
        emptyQueryVisible: true,
        emptyQueryRank: 5,
      }),
      createCommandCandidate({
        id: 'new',
        label: 'New Chat',
        description: 'Start a new chat',
        emptyQueryVisible: true,
        emptyQueryRank: 1,
      }),
    ];

    expect(filterAndRankSlashCandidates(commands, '').map((cmd) => cmd.id)).toEqual(['new', 'goal']);
  });

  it('searches prompt command content while keeping prompt selection as prefill', () => {
    const prompt = createPromptCandidate({
      name: 'review',
      description: 'Review current diff',
      source: 'file',
      scope: 'project',
      hints: ['$ARGUMENTS'],
      contentPreview: '请做安全审查...',
      contentSearchText: '请做安全审查，关注权限风险和回滚方案。',
    });

    const [matched] = filterAndRankSlashCandidates([prompt], '权限风险');
    expect(matched).toMatchObject({
      id: 'prompt:review',
      actionKind: 'prefill-prompt',
      effectLabel: '预填后补参数',
      promptContentPreview: '请做安全审查...',
    });
  });

  it('merges recommended skills into the picker and lets slash select the same skill', () => {
    const candidates = createSkillCandidates({
      availableSkills: [makeSkill({
        name: 'docx',
        description: 'Word document helper',
        basePath: '/repo/libraries/office/docx',
      })],
      mountedSkills: [],
      selectedSkillIds: [],
      recommendations: [{
        skillName: 'docx',
        libraryId: 'office',
        reason: '当前输入提到 Word 文档',
        action: 'mount',
      }],
    });

    expect(candidates[0]).toMatchObject({
      group: 'suggested',
      slashText: '/skills:docx',
      effectLabel: '挂载并选入本轮',
      emptyQueryVisible: true,
    });
    expect(filterAndRankSlashCandidates(candidates, 'doc').map((item) => item.id)).toEqual(['skill:docx']);
  });

  it('groups mixed slash results without repeating headings', () => {
    const groups = groupSlashCandidates([
      createCommandCandidate({ id: 'low', label: 'Low', description: 'Low effort' }),
      createPromptCandidate({ name: 'lowdown', description: 'Explain risk', source: 'file', hints: [] }),
      createCommandCandidate({ id: 'loop', label: 'Loop', description: 'Repeat task' }),
    ]);

    expect(groups.map((group) => group.group)).toEqual(['command', 'prompt']);
    expect(groups[0]?.items.map((item) => item.id)).toEqual(['low', 'loop']);
  });

  it('effectLabel/描述装饰走注入 labels（en 传入则输出英文，缺省回退中文）', () => {
    const pickerEn = en.slashCommands.picker;
    expect(createCommandCandidate(
      { id: 'goal', label: 'Goal', description: 'Set goal', actionKind: 'prefill-leading-command' },
      pickerEn,
    ).effectLabel).toBe(pickerEn.prefillCommand);
    expect(createCommandCandidate({ id: 'x', label: 'X', description: 'X' }, pickerEn).effectLabel)
      .toBe(pickerEn.executeNow);

    const prompt = createPromptCandidate(
      { name: 'sum', description: 'Summarize', source: 'file', hints: ['$ARGUMENTS'] },
      pickerEn,
    );
    expect(prompt.effectLabel).toBe(pickerEn.prefillPromptWithArgs);
    expect(prompt.description).toContain(pickerEn.paramsPrefix.trim());

    const agentCandidates = createAgentCandidates(agents, pickerEn);
    expect(agentCandidates.find((c) => c.agentId === 'reviewer')?.effectLabel).toBe(pickerEn.setAgentForTurn);
    expect(agentCandidates.find((c) => c.agentId === null)?.effectLabel).toBe(pickerEn.restoreAutoAgent);
    expect(agentCandidates.find((c) => c.agentId === null)?.description).toBe(pickerEn.defaultAgentDescription);

    const skills = createSkillCandidates({
      availableSkills: [makeSkill({ basePath: '/repo/libraries/office/docx' })],
      mountedSkills: [],
      selectedSkillIds: [],
    }, pickerEn);
    expect(skills[0]?.effectLabel).toBe(pickerEn.mountAndSelect);

    // 缺省回退中文（zh 键即历史硬编码文案）
    expect(createCommandCandidate({ id: 'x', label: 'X', description: 'X' }).effectLabel)
      .toBe(zh.slashCommands.picker.executeNow);
  });

  it('creates connector and MCP candidates for the unified slash picker', () => {
    const connector = {
      kind: 'connector',
      id: 'mail',
      key: 'connector:mail',
      label: 'Mail',
      selected: false,
      available: true,
      blocked: false,
      visibleInWorkbench: true,
      health: 'healthy',
      lifecycle: {
        installState: 'not_applicable',
        mountState: 'not_applicable',
        connectionState: 'connected',
      },
      connected: true,
      readiness: 'ready',
      capabilities: ['search mail'],
    } satisfies WorkbenchCapabilityRegistryItem;
    const mcp = {
      kind: 'mcp',
      id: 'github',
      key: 'mcp:github',
      label: 'GitHub',
      selected: true,
      available: true,
      blocked: false,
      visibleInWorkbench: true,
      health: 'healthy',
      lifecycle: {
        installState: 'not_applicable',
        mountState: 'not_applicable',
        connectionState: 'lazy',
      },
      status: 'lazy',
      enabled: true,
      transport: 'stdio',
      toolCount: 12,
      resourceCount: 0,
    } satisfies WorkbenchCapabilityRegistryItem;

    expect(createWorkbenchCapabilityCandidates([connector, mcp], ['connector:mail'])).toEqual([
      expect.objectContaining({
        id: 'connector:mail',
        group: 'suggested',
        actionKind: 'select-connector',
        connectorConnected: true,
        emptyQueryVisible: true,
      }),
      expect.objectContaining({
        id: 'mcp:github',
        group: 'mcp',
        actionKind: 'select-mcp',
        mcpConnected: true,
        emptyQueryVisible: true,
      }),
    ]);
  });
});

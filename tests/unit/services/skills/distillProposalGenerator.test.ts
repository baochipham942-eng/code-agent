import { describe, expect, it } from 'vitest';
import {
  buildDistillProposalPrompt,
  parseDistillProposals,
} from '../../../../src/main/services/skills/distillProposalGenerator';
import type { DistillVerifiedCandidate } from '../../../../src/main/services/skills/distillService';

function candidate(id: string): DistillVerifiedCandidate {
  return {
    candidateId: id,
    signal: {
      id: 'sig-1',
      title: 'weekly deploy report workflow',
      content: 'run deploy checklist and produce markdown report',
      queries: ['deploy report'],
      sessionId: 'sess-1',
      sourceKind: 'message',
    },
    frequency: 3,
    sessionBreadth: 2,
    lastSeenAt: Date.UTC(2026, 5, 10),
    score: 0.7,
    evidence: [
      { sessionId: 'sess-1', messageId: 'msg-1', snippet: 'deploy checklist run', timestamp: Date.UTC(2026, 5, 10) },
    ],
  };
}

describe('distillProposalGenerator', () => {
  describe('parseDistillProposals', () => {
    it('解析 ```json 围栏中的提案数组', () => {
      const content = [
        '以下是提案：',
        '```json',
        JSON.stringify([
          { candidateId: 'cand-1', form: 'command', name: 'deploy-report', description: 'd', body: 'b' },
        ]),
        '```',
      ].join('\n');
      const proposals = parseDistillProposals(content);
      expect(proposals).toHaveLength(1);
      expect(proposals[0]).toMatchObject({ candidateId: 'cand-1', form: 'command', name: 'deploy-report' });
    });

    it('解析裸 JSON 数组', () => {
      const proposals = parseDistillProposals(
        JSON.stringify([{ candidateId: 'c', form: 'skill', name: 'n', description: 'd', body: 'b' }]),
      );
      expect(proposals).toHaveLength(1);
    });

    it('解析失败（坏 JSON / 非数组 / 空输出）→ 空数组，本轮零产出', () => {
      expect(parseDistillProposals('not json at all')).toEqual([]);
      expect(parseDistillProposals('{"single": "object"}')).toEqual([]);
      expect(parseDistillProposals('')).toEqual([]);
    });

    it('缺字段/字段类型错误的条目被丢弃，合法条目保留', () => {
      const proposals = parseDistillProposals(
        JSON.stringify([
          { candidateId: 'c1', form: 'command', name: 'good-one', description: 'd', body: 'b' },
          { candidateId: 'c2', form: 'command', name: 'no-body', description: 'd' },
          { candidateId: 42, form: 'command', name: 'bad-cid', description: 'd', body: 'b' },
          'not-an-object',
        ]),
      );
      expect(proposals).toHaveLength(1);
      expect(proposals[0].name).toBe('good-one');
    });
  });

  describe('buildDistillProposalPrompt', () => {
    it('prompt 携带候选证据、candidateId 约束与现有资产名单', () => {
      const prompt = buildDistillProposalPrompt([candidate('cand-abc')], {
        inventory: {
          commands: [{ name: 'existing-cmd' }],
          skills: [{ name: 'existing-skill' }],
          agents: ['coder'],
          rejectedNames: [],
        },
        mode: 'manual',
      });
      expect(prompt).toContain('cand-abc');
      expect(prompt).toContain('weekly deploy report workflow');
      expect(prompt).toContain('frequency=3');
      expect(prompt).toContain('existing-cmd');
      expect(prompt).toContain('candidateId');
    });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MultiagentExecutionResult } from '../../../../src/host/agent/multiagentExecutionTypes';

const mocks = vi.hoisted(() => ({
  archiveText: vi.fn(),
}));

vi.mock('../../../../src/host/services/library/libraryService', () => ({
  getLibraryService: () => ({ archiveText: mocks.archiveText }),
}));

import { archiveTeamResult } from '../../../../src/host/services/team/teamRecipeLaunchService';

const meta = {
  projectId: 'project_1',
  title: '产品规格·会员增长',
  sourceSessionId: 'session_1',
};

function result(overrides: Partial<MultiagentExecutionResult> = {}): MultiagentExecutionResult {
  return { success: true, output: '团队聚合产物', ...overrides };
}

describe('archiveTeamResult', () => {
  beforeEach(() => vi.clearAllMocks());

  it('归档成功团队的非空聚合产物', () => {
    archiveTeamResult(result(), meta);

    expect(mocks.archiveText).toHaveBeenCalledWith({
      projectId: meta.projectId,
      title: meta.title,
      text: '团队聚合产物',
      tags: ['定稿'],
      sourceSessionId: meta.sourceSessionId,
    });
  });

  it('部分失败团队仍归档，并标明缺席成员', () => {
    archiveTeamResult(result({ success: false, error: '青禾超时' }), meta);

    expect(mocks.archiveText).toHaveBeenCalledWith({
      projectId: meta.projectId,
      title: `${meta.title}（部分成员缺席）`,
      text: '团队聚合产物\n\n> 缺席成员：青禾超时',
      tags: ['定稿'],
      sourceSessionId: meta.sourceSessionId,
    });
  });

  it.each([undefined, '', '   '])('空聚合产物 %j 不归档', (output) => {
    archiveTeamResult(result({ output }), meta);

    expect(mocks.archiveText).not.toHaveBeenCalled();
  });

  it('归档失败不影响已完成团队', () => {
    mocks.archiveText.mockImplementation(() => { throw new Error('library unavailable'); });

    expect(() => archiveTeamResult(result(), meta)).not.toThrow();
  });
});

import { describe, expect, it } from 'vitest';
import { parseRepoUrl } from '../../../../src/host/services/skills/gitDownloader';

describe('parseRepoUrl', () => {
  it.each([
    [
      'https://github.com/anthropics/skills',
      { source: 'github', owner: 'anthropics', repo: 'skills', branch: 'main' },
    ],
    [
      'https://github.com/anthropics/skills/tree/dev',
      { source: 'github', owner: 'anthropics', repo: 'skills', branch: 'dev' },
    ],
    [
      'github.com/anthropics/skills.git',
      { source: 'github', owner: 'anthropics', repo: 'skills', branch: 'main' },
    ],
    [
      'anthropics/skills',
      { source: 'github', owner: 'anthropics', repo: 'skills', branch: 'main' },
    ],
  ])('parses GitHub form %s', (url, expected) => {
    expect(parseRepoUrl(url)).toEqual(expected);
  });

  it.each([
    [
      'https://www.modelscope.cn/ms-agent/skill_examples',
      {
        source: 'modelscope',
        owner: 'ms-agent',
        repo: 'skill_examples',
        branch: 'master',
        repoType: 'model',
      },
    ],
    [
      'https://modelscope.cn/models/ms-agent/skill_examples/skills',
      {
        source: 'modelscope',
        owner: 'ms-agent',
        repo: 'skill_examples',
        branch: 'master',
        repoType: 'model',
      },
    ],
    [
      'https://www.modelscope.cn/skills/@halcyon666/write-skills',
      {
        source: 'modelscope',
        owner: 'halcyon666',
        repo: 'write-skills',
        branch: 'master',
        repoType: 'skill',
      },
    ],
    [
      'https://modelscope.cn/skills/halcyon666/write-skills/summary',
      {
        source: 'modelscope',
        owner: 'halcyon666',
        repo: 'write-skills',
        branch: 'master',
        repoType: 'skill',
      },
    ],
  ])('parses ModelScope form %s', (url, expected) => {
    expect(parseRepoUrl(url)).toEqual(expected);
  });

  it.each([
    '',
    'https://modelscope.cn',
    'http://modelscope.cn/owner/repo',
    'https://user@modelscope.cn/owner/repo',
    'https://modelscope.cn.evil.example/owner/repo',
    'https://modelscope.cn/owner%2Frewrite/repo',
    'https://modelscope.cn/owner/repo/arbitrary/nested/path',
    'https://github.example.com/owner/repo',
    'https://github.com/../repo',
    'javascript:alert(1)',
  ])('rejects malformed or unsafe input %s', (url) => {
    expect(parseRepoUrl(url)).toBeNull();
  });
});

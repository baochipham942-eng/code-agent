import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message, ToolCall } from '../../../src/shared/contract';
import { attachDocumentOrigin, checkDocumentEvidenceClaims, documentClaimPreflight } from '../../../src/host/agent/runtime/documentEvidenceBoundary';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const call = (name: string, path: string): ToolCall => ({ id: `${name}-${path}`, name, arguments: { file_path: path } });
const user: Message = { id: 'user', role: 'user', content: '整理来源与空间盘点', timestamp: 1 };

describe('document evidence boundary', () => {
  it('keeps transcript and generated minutes in one digest-bound origin family across sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'document-origins-')); roots.push(root);
    const transcript = join(root, 'transcript.md'); const minutes = join(root, 'minutes.md');
    const ledger = join(root, 'ledger.jsonl');
    await writeFile(transcript, 'Source: latency estimate 400ms');
    const input = await attachDocumentOrigin(call('Read', transcript), { toolCallId: 'read', success: true, output: 'source' }, [], root, ledger);
    await writeFile(minutes, 'Summary: latency estimate 400ms');
    await attachDocumentOrigin(call('Write', minutes), { toolCallId: 'write', success: true }, [user,
      { ...user, id: 'source', role: 'tool', toolResults: [input] }], root, ledger);
    const later = await attachDocumentOrigin(call('Read', minutes), { toolCallId: 'later', success: true }, [], root, ledger);
    expect(later.metadata?.documentOrigin).toMatchObject({ kind: 'derived', roots: (input.metadata?.documentOrigin as { roots: string[] }).roots });
    expect(later.output).toContain('source independence unverified');
    await writeFile(minutes, 'Externally replaced document');
    const changed = await attachDocumentOrigin(call('Read', minutes), { toolCallId: 'changed', success: true }, [], root, ledger);
    expect(changed.metadata?.documentOrigin).toMatchObject({ kind: 'unclassified' });
    expect((await readFile(ledger, 'utf8')).trim().split('\n')).toHaveLength(1);
  });

  it.each([
    '至少两处相互独立的记载口径一致',
    '✅ 双记录一致：纪要 + 逐字稿',
    '✅ 官网两条新闻互证，同源',
    'Confirmed by independent sources',
  ])('rejects an unsupported independence upgrade: %s', (text) => {
    expect(checkDocumentEvidenceClaims(text, [user])).toContain('SOURCE_INDEPENDENCE_UNVERIFIED');
  });

  it.each([
    ['空间主人 | Neo 登录用户，owner | 实测', 'SPACE_OWNER_UNVERIFIED'],
    ['成员与专家 | agents/ 下的本地专家名册 | 实测', 'SPACE_MEMBERS_UNVERIFIED'],
    ['定时自动化 | registered:[]，当前没有定时任务 | 实测', 'SPACE_AUTOMATIONS_UNVERIFIED'],
  ])('rejects machine facts as space measurements: %s', (text, code) => {
    expect(checkDocumentEvidenceClaims(text, [user])).toContain(code);
  });

  it('accepts scoped owner and empty automation evidence only from a matching successful query', () => {
    const query: ToolCall = { id: 'query', name: 'space_query', arguments: { projectId: 'project-fixture' } };
    const messages: Message[] = [user,
      { ...user, id: 'call', role: 'assistant', toolCalls: [query] },
      { ...user, id: 'result', role: 'tool', toolResults: [{ toolCallId: 'query', success: true,
        output: JSON.stringify({ space: { id: 'project-fixture', cloudProjectId: 'cloud-fixture' },
          cloudMembers: [{ projectId: 'cloud-fixture', role: 'owner', userId: 'owner-fixture' }],
          capabilities: { automations: [] } }) }] },
    ];
    const report = '空间 project-fixture。\n空间主人 owner-fixture，实测。\n当前没有定时自动化。';
    expect(checkDocumentEvidenceClaims(report, messages)).toEqual([]);
    expect(checkDocumentEvidenceClaims(report.replace('project-fixture', 'other-project'), messages)).toContain('SPACE_OWNER_UNVERIFIED');
    expect(checkDocumentEvidenceClaims(report.replace('owner-fixture', 'login-user'), messages)).toContain('SPACE_OWNER_UNVERIFIED');
  });

  it('does not allow an unrelated caveat to license an unsupported measured row', () => {
    expect(checkDocumentEvidenceClaims('空间字段待补。\n空间主人 | 登录用户 owner | 实测', [user])).toContain('SPACE_OWNER_UNVERIFIED');
  });

  it('allows explicit evidence boundaries', () => {
    expect(checkDocumentEvidenceClaims('纪要和逐字稿同源，不能证明独立来源。\n空间主人待查。\n定时自动化当前状态未知，日志仅能说明启动时点。', [user])).toEqual([]);
  });

  it('blocks Write and Edit before mutation, while allowing a qualified correction', () => {
    const write = { ...call('Write', 'report.md'), arguments: { file_path: 'report.md', content: '✅ 双记录互证：纪要和逐字稿' } };
    expect(documentClaimPreflight(write, [user])).toEqual(['SOURCE_INDEPENDENCE_UNVERIFIED']);
    const edit = { ...call('Edit', 'report.md'), arguments: { file_path: 'report.md', new_string: '纪要和逐字稿同源，独立来源未经核验' } };
    expect(documentClaimPreflight(edit, [user])).toEqual([]);
  });
});

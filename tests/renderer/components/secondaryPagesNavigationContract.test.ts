import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sourceRoot = resolve(process.cwd(), 'src/renderer/components/features');

const PRIMARY_PAGE_HEADERS = [
  ['活动', 'activity/ActivityPanel.tsx'],
  ['时间能力', 'timeCapability/TimeCapabilityPanel.tsx'],
  ['实验室', 'lab/LabPage.tsx'],
  ['提示词管理', 'prompts/PromptManagerModal.tsx'],
  ['协作空间列表', 'projectSpace/ProjectSpacePage.tsx'],
  ['本机操作', 'localOps/LocalOpsPage.tsx'],
  ['评测中心', 'evalCenter/EvalCenterPage.tsx'],
  ['自动化', 'cron/CronCenterPanel.tsx'],
  ['资料库', 'knowledge/LibraryPanel.tsx'],
] as const;

function fullScreenPageHeaderProps(relativePath: string): string {
  const source = readFileSync(resolve(sourceRoot, relativePath), 'utf8');
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line.includes('<FullScreenPageHeader'));
  expect(start, `${relativePath} should render a FullScreenPageHeader`).toBeGreaterThanOrEqual(0);

  const end = lines.findIndex((line, index) => index > start && line.trim() === '/>');
  expect(end, `${relativePath} FullScreenPageHeader should be self-closed`).toBeGreaterThan(start);
  return lines.slice(start, end + 1).join('\n');
}

describe('一级二级页与下钻页的返回按钮契约', () => {
  it.each(PRIMARY_PAGE_HEADERS)('%s 的一级入口页头不声明返回按钮', (_label, relativePath) => {
    expect(fullScreenPageHeaderProps(relativePath)).not.toMatch(/\bonClose\s*=/);
  });

  it('专家详情仍保留回到能力中心的返回按钮', () => {
    const props = fullScreenPageHeaderProps('expert/RoleDetailPage.tsx');
    expect(props).toContain('onClose={closeDetail}');
    expect(props).toContain('closeLabel={t.capabilityHub.title}');
  });

  it('协作空间详情仍保留回到列表的返回按钮', () => {
    const props = fullScreenPageHeaderProps('projectSpace/ProjectSpaceView.tsx');
    expect(props).toContain('onClose={onBackToList}');
    expect(props).toContain('closeLabel={ps.backToList}');
  });
});

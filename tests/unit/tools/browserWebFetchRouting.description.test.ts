import { describe, it, expect } from 'vitest';
import { browserSchema } from '../../../src/host/plugins/builtin/browserControl/browser.schema';
import { webFetchUnifiedSchema } from '../../../src/host/tools/modules/network/webFetchUnified.schema';

// 注入卫生工单（2026-08-01）修 3：真机走查实证「打开 example.com 看看」两次被路由到
// WebFetch/UA 抓取而非浏览器 surface。两个工具的 description 各补一句分流措辞——
// prompt 层改动，static-contract 档：只钉住关键句存在，模型行为改善本单未做付费真跑验证。
describe('Browser / WebFetch tool description 分流措辞', () => {
  it('Browser 工具 description 提示：用户要"看现场"时用它，别静默降级成纯文本抓取', () => {
    expect(browserSchema.description).toContain('watch it happen');
    expect(browserSchema.description).toContain('workbench browser tab');
  });

  it('WebFetch 工具 description 提示：只做文本抓取分析，"看现场"类请求应转 Browser', () => {
    expect(webFetchUnifiedSchema.description).toContain('watch the page live');
    expect(webFetchUnifiedSchema.description).toContain('Browser tool');
  });
});

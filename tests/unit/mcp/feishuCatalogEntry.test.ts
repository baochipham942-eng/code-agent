import { describe, expect, it } from 'vitest';
import { createStdioMCPEnv } from '../../../src/host/mcp/mcpTransport';
import { FEISHU_CALENDAR_MIN_PAGE_SIZE } from '../../../src/shared/constants/feishu';
import { RECOMMENDED_MCP_SERVERS } from '../../../src/shared/constants/mcpCatalog';

const larkEntry = RECOMMENDED_MCP_SERVERS.find((server) => server.id === 'lark');

function getLarkTools(): string[] {
  const rawTools = larkEntry?.connection?.env?.LARK_TOOLS;
  expect(rawTools).toBeTruthy();
  return rawTools!.split(',');
}

describe('Feishu MCP catalog entry', () => {
  // 自证测试（断言常量等于自己的字面量）永远不会红。改成钉「用户看得见的引导里
  // 真的写了这个下限」：日历接口传 <50 会 99992402，这条事实必须到得了用户眼前。
  it('surfaces the calendar page-size minimum in the user-facing guidance', () => {
    expect(larkEntry?.description).toContain(String(FEISHU_CALENDAR_MIN_PAGE_SIZE));
  });

  // 代理绕过的 host 必须跟实际请求的域名同源，否则改了域名就绕不过去
  it('derives the proxy-bypass host from the configured domain', () => {
    const domainHost = new URL(larkEntry!.connection!.env!.LARK_DOMAIN).hostname;
    expect(larkEntry?.connection?.env?.MCP_NO_PROXY_HOSTS).toBe(domainHost);
  });

  it('includes calendar event listing', () => {
    expect(getLarkTools()).toContain('calendar.v4.calendarEvent.list');
  });

  it('does not use lark-mcp presets', () => {
    expect(getLarkTools().some((tool) => tool.startsWith('preset.'))).toBe(false);
  });

  it('does not expose calendar enumeration', () => {
    expect(getLarkTools()).not.toContain('calendar.v4.calendar.list');
  });

  it('does not expose write tools', () => {
    const writeSuffixes = ['.create', '.update', '.delete', '.batchCreate'];
    expect(
      getLarkTools().some((tool) => writeSuffixes.some((suffix) => tool.endsWith(suffix))),
    ).toBe(false);
  });

  it('pins the lark-mcp package version in the launch arguments', () => {
    expect(
      larkEntry?.connection?.args?.some((arg) => arg.includes('@0.5.1')),
    ).toBe(true);
  });
});

describe('stdio MCP NO_PROXY augmentation', () => {
  it('appends and deduplicates bypass hosts after an existing NO_PROXY value', () => {
    const env = createStdioMCPEnv(
      { MCP_NO_PROXY_HOSTS: 'open.feishu.cn, foo.com, ,' },
      { NO_PROXY: 'foo.com' },
    );

    expect(env.NO_PROXY).toBe('foo.com,open.feishu.cn');
  });

  it('does not pass the internal bypass marker to the child process', () => {
    const env = createStdioMCPEnv(
      { MCP_NO_PROXY_HOSTS: 'open.feishu.cn' },
      {},
    );

    expect(env).not.toHaveProperty('MCP_NO_PROXY_HOSTS');
  });

  it('creates NO_PROXY when the host environment has no bypass list', () => {
    const env = createStdioMCPEnv(
      { MCP_NO_PROXY_HOSTS: 'open.feishu.cn' },
      {},
    );

    expect(env.NO_PROXY).toBe('open.feishu.cn');
  });

  it('honors lowercase no_proxy and keeps both variants consistent', () => {
    const env = createStdioMCPEnv(
      { MCP_NO_PROXY_HOSTS: 'open.feishu.cn' },
      { no_proxy: 'foo.com' },
    );

    expect(env.NO_PROXY).toBe('foo.com,open.feishu.cn');
    expect(env.no_proxy).toBe('foo.com,open.feishu.cn');
  });
});

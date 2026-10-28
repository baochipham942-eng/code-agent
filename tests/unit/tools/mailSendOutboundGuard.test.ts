// ============================================================================
// mail_send 出站掩码（N-OUTBOUND-SENSITIVE-GUARD 验收③）
// ----------------------------------------------------------------------------
// 真 ToolExecutor + 真 protocol registry 的 mail_send 模块 + 假 mail 连接器：
// 掩码发生在进权限管道之前，所以审批卡（details/reason）、工具体内 canUseTool
// 的短路匹配（isSameTopLevelInput 对顶层批准参数）、真实发送（connector.execute
// 收到的 args）三方一致——掩码若放在工具体内会弹第二张审批卡。
// 身份证号是测试内按 GB 11643 算法现造的校验位有效假号，非真实证件号。
// ============================================================================
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/host/services/infra/logger', () => {
  const fake = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { createLogger: vi.fn(() => fake), logger: fake, default: fake };
});

import { getToolCache } from '../../../src/host/services/infra/toolCache';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import {
  hasProtocolTool,
  registerProtocolTool,
  unregisterProtocolTool,
} from '../../../src/host/tools/protocolToolRegistration';
import { mailSendSchema } from '../../../src/host/tools/modules/connectors/mailSend.schema';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import type { PermissionRequestData } from '../../../src/host/tools/types';
import { getConnectorRegistry } from '../../../src/host/connectors';
import type { Connector } from '../../../src/host/connectors/base';
import { maskMailSendOutboundParams, OUTBOUND_MASK_REASON_LINE } from '../../../src/host/tools/outboundGuard';

const TEST_CHINA_ID = '110101199001011237';

/** GB 11643 校验位算法：现场造一个校验位有效的假身份证。 */
function makeValidChinaId(): string {
  const base = '11010119900101123';
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const codes = '10X98765432';
  let sum = 0;
  for (let index = 0; index < 17; index += 1) {
    sum += Number(base[index]) * weights[index];
  }
  return base + codes[sum % 11];
}

describe('mail_send outbound sensitive guard', () => {
  let permissionRequests: PermissionRequestData[];
  let connectorExecute: Connector['execute'];
  let connectorCalls: Array<{ action: string; payload: Record<string, unknown> }>;
  let sid = 0;
  let bridgedToolNames: string[] = [];

  beforeAll(() => {
    // mail_send 只在 darwin 注册（modules/index.ts 连接器组平台门）；Linux CI 上缺席时
    // executor.execute 在 resolve 阶段 unknown-tool 失败，权限闸根本没跑到（PR#2555 实录）。
    // 补注册桥：缺席才补、loader 消费真实模块（用例要过权限闸进 handler 调用链），
    // afterAll 只注销自己补的——盲 unregister 会把 darwin 的原生注册也摘掉。
    getProtocolRegistry();
    bridgedToolNames = [mailSendSchema]
      .filter((schema) => !hasProtocolTool(schema.name))
      .map((schema) => {
        registerProtocolTool(schema, async () => {
          const { mailSendModule } = await import(
            '../../../src/host/tools/modules/connectors/mailSend'
          );
          return mailSendModule;
        });
        return schema.name;
      });
  });

  afterAll(() => {
    for (const name of bridgedToolNames) unregisterProtocolTool(name);
    bridgedToolNames = [];
  });

  beforeEach(() => {
    permissionRequests = [];
    connectorCalls = [];
    sid += 1;
    getToolCache().clear();
    const recordedExecute: Connector['execute'] = async (action, payload) => {
      connectorCalls.push({ action, payload });
      return {
        data: {
          subject: '已发出', to: ['a@example.com'], cc: [], bcc: [], attachments: [], sent: true,
        },
      };
    };
    connectorExecute = recordedExecute;
    const fakeConnector: Connector = {
      id: 'mail',
      label: 'Mail',
      capabilities: ['send_message'],
      getStatus: async () => ({ connected: true, capabilities: ['send_message'] }),
      execute: connectorExecute,
    };
    getConnectorRegistry().register(fakeConnector);
  });

  afterEach(() => {
    getConnectorRegistry().unregister('mail');
    getToolCache().clear();
  });

  function buildExecutor(): ToolExecutor {
    const executor = new ToolExecutor({
      workingDirectory: '/tmp/workbench',
      forcePermissionHandler: true,
      requestPermission: async (request: PermissionRequestData) => {
        permissionRequests.push(request);
        return true;
      },
    });
    executor.setAuditEnabled(false);
    return executor;
  }

  it('masks content with a valid fake ID before the permission pipeline; card shows masked + note, connector gets the same masked text, exactly one ask', async () => {
    const fakeId = makeValidChinaId();
    expect(fakeId).toBe(TEST_CHINA_ID); // 造号算法与守卫判据同源，钉住夹具可复算。
    const dirtyContent = `客户资料：证件号 ${fakeId}，请登记。`;
    const maskedContent = `客户资料：证件号 [id number hidden]，请登记。`;
    const executor = buildExecutor();

    const result = await executor.execute(
      'mail_send',
      { subject: '登记通知', to: ['a@example.com'], content: dirtyContent },
      { sessionId: `mail-outbound-${sid}` },
    );

    expect(result.success).toBe(true);
    // 恰好一张审批卡：顶层一次，工具体内短路不再问。
    expect(permissionRequests).toHaveLength(1);
    const request = permissionRequests[0];
    expect(request.tool).toBe('mail_send');
    expect(request.reason).toContain(OUTBOUND_MASK_REASON_LINE);
    expect(request.details.subject).toBe('登记通知');
    expect(request.details.content).toBe(maskedContent);
    // 连接器（真实发送侧）收到的是同一份掩码后正文。
    expect(connectorCalls).toHaveLength(1);
    expect(connectorCalls[0]).toMatchObject({
      action: 'send_message',
      payload: { subject: '登记通知', content: maskedContent },
    });
    expect(JSON.stringify(connectorCalls)).not.toContain(fakeId);
  });

  it('masks card numbers in subject as well', async () => {
    const executor = buildExecutor();
    const result = await executor.execute(
      'mail_send',
      { subject: '卡 4111 1111 1111 1111 已扣款', to: ['a@example.com'], content: '正文干净。' },
      { sessionId: `mail-outbound-${sid}` },
    );

    expect(result.success).toBe(true);
    expect(permissionRequests).toHaveLength(1);
    expect(permissionRequests[0].details.subject).toBe('卡 [credit card hidden] 已扣款');
    expect(permissionRequests[0].details.content).toBe('正文干净。');
    expect(permissionRequests[0].reason).toContain(OUTBOUND_MASK_REASON_LINE);
    expect(connectorCalls[0]).toMatchObject({
      action: 'send_message',
      payload: { subject: '卡 [credit card hidden] 已扣款' },
    });
  });

  it('clean mail asks once with no mask note and sends byte-identical text', async () => {
    const executor = buildExecutor();
    const content = '季度报告见附件，明细 https://example.com/r?q=3。';
    const result = await executor.execute(
      'mail_send',
      { subject: '季度报告', to: ['a@example.com'], content },
      { sessionId: `mail-outbound-${sid}` },
    );

    expect(result.success).toBe(true);
    expect(permissionRequests).toHaveLength(1);
    expect(permissionRequests[0].reason).not.toContain(OUTBOUND_MASK_REASON_LINE);
    expect(permissionRequests[0].details.content).toBe(content);
    expect(connectorCalls[0]).toMatchObject({
      action: 'send_message',
      payload: { subject: '季度报告', content },
    });
  });

  it('other tools pass through the mask untouched (scope pin)', async () => {
    // 掩码只收 mail_send：换一个工具名、同款脏参数，helper 恒等直通（引用不变）。
    const dirty = { subject: 'x', content: `证 ${TEST_CHINA_ID}` };
    const untouched = maskMailSendOutboundParams('web_fetch', dirty);
    expect(untouched.redacted).toBe(false);
    expect(untouched.params).toBe(dirty);
  });
});

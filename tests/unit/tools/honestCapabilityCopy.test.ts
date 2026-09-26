// ============================================================================
// 能力口径诚实（N-HONEST-CAPABILITY-COPY，借鉴 Muse 产品契约 P1-4）
// ----------------------------------------------------------------------------
// 四类对用户说话的口径写死在模型一定会读到的注入位置（工具 description / 共享片段），
// 本门钉住它们不回退。与 delegateTaskRenameCompat 同一判据：模型对工具 description 的
// 遵循度远高于系统提示词，口径写在模型即将行动那一刻读到的描述里才真正送达。
//
// 覆盖的四类口径：
// 1. 定时检查是轮询、不是监视（间隔检查 / 漏掉两次检查间复原的变化 / 时间有几分钟偏差 /
//    只说「每 N 分钟查一次」绝不说「一发生就通知」/ 监视只能事后提醒拦不住事件本身）
// 2. 定时任务「跑没跑」以运行记录为准，不以日程定义为准
// 3. 排队、交接或后台运行成功 ≠ 用户已收到；成功前只能说「已开始/已排队」
// 4. 连接状态取自本轮的状态检查；鉴权失败先重新检查；scope 不足重连也没用
// ============================================================================

import { describe, expect, it } from 'vitest';
import { sleepUntilSchema, wakeOnEventSchema, wakeOnSchema } from '../../../src/host/tools/modules/selfwake/selfWake.schema';
import { mailSchema } from '../../../src/host/tools/modules/connectors/mail.schema';
import { calendarSchema } from '../../../src/host/tools/modules/connectors/calendar.schema';
import { remindersSchema } from '../../../src/host/tools/modules/connectors/reminders.schema';
import { mcpUnifiedSchema } from '../../../src/host/tools/modules/mcp/mcpUnified.schema';
import { delegateTaskSchema } from '../../../src/host/tools/modules/commandCenter/sessionCommandCenter.schema';

describe('能力口径诚实：口径落在对应注入位置', () => {
  it('口径 1a：wake_on_event 写明轮询语义与「绝不说一发生就通知」', () => {
    const description = wakeOnEventSchema.description;
    expect(description).toContain('polls on its schedule');
    expect(description).toContain('nothing watches continuously between checks');
    expect(description).toContain('a change that appears and reverts between checks is missed');
    expect(description).toContain('never "the moment it happens"');
    // 监视只能事后提醒，拦不住事件本身
    expect(description).toContain('cannot block or stop the event itself');
  });

  it('口径 1b：sleep_until 写明醒来时间有几分钟偏差', () => {
    const description = sleepUntilSchema.description;
    expect(description).toContain('give or take a few minutes');
    // 偏差承诺只在 app 运行中成立；休眠/退出后延迟到下次启动（ai-review Important 2）
    expect(description).toContain('while the app is running');
    expect(description).toContain('delivered on the next launch');
  });

  it('口径 2：wake_on 写明跑没跑以运行记录为准', () => {
    const description = wakeOnSchema.description;
    expect(description).toContain('answered from its run history');
    expect(description).toContain('never from the fact that it is scheduled');
  });

  it('口径 3：delegate_task 写明排队/后台跑完 ≠ 用户已收到', () => {
    const description = delegateTaskSchema.description;
    expect(description).toContain('不等于用户已收到');
    expect(description).toContain('「已开始／已排队」');
    // 原有 accepted ≠ 完成 契约仍在（不是替换而是补齐）
    expect(description).toContain('accepted 只代表已接单，不代表完成');
    // 状态分层不混写（ai-review Important 1）：排队/交接=已受理，后台跑完=执行结束
    expect(description).toContain('排队或交接只代表已受理还没开始跑');
    expect(description).toContain('后台跑完也只代表执行结束');
  });

  it('口径 4：连接器/MCP 工具共享「连接状态只认本轮检查」片段', () => {
    const fragments = [
      mailSchema.description,
      calendarSchema.description,
      remindersSchema.description,
      mcpUnifiedSchema.description,
    ];
    for (const description of fragments) {
      expect(description).toContain('from a status check made this turn');
      expect(description).toContain('never from memory of earlier turns');
      expect(description).toContain('re-check status before calling the connector disconnected');
      expect(description).toContain('a scope/permission error will not be fixed by reconnecting');
    }
  });
});

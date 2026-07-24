// ============================================================================
// 把 HTML 产物人工编辑的落库后动作接到 web 层：让消息投影失效
// ============================================================================
// web /run 读的是 webSessionStore 的消息投影缓存，不是 DB 也不是 orchestrator。
// 编辑落库后不失效这层，下一轮模型读旧投影、看不到用户的修改（dogfood 抓到的崩法 A）。
// 抽成独立 wiring 只为不给 webServer.ts 增行（它卡在 max-lines 边缘），且让 knip
// 跟得到 invalidateSessionMessagesProjection 的用法。

import { setGenerativeUiEditProjectionInvalidator } from '../../host/services/generativeUI/generativeUIEditPersistence';
import { invalidateSessionMessagesProjection } from './webSessionStore';

export function wireGenerativeUiEditProjectionInvalidation(): void {
  setGenerativeUiEditProjectionInvalidator(invalidateSessionMessagesProjection);
}

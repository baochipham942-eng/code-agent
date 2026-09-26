// 能力口径诚实（N-HONEST-CAPABILITY-COPY，借鉴 Muse 产品契约）：连接状态只认本轮状态检查。
// 单一真源，当前接入 mail / calendar / reminders（native 只读三件套）与 MCPUnified 的 schema
// description，其余连接器工具（tmeet 等）后续接入时复用——模型对工具描述的遵循度远高于
// 系统提示词，口径写在它即将调用的工具上才真正送达。
export const CONNECTION_STATE_HONESTY =
  'Connection state comes from a status check made this turn (get_status / status), never from memory of '
  + 'earlier turns. If a call fails with an auth or connection error, re-check status before calling the '
  + 'connector disconnected; a scope/permission error will not be fixed by reconnecting — report that '
  + 'instead of retrying.';

// 停车审批（pending_approvals）呈现常量（N-PARKED-APPROVAL-SURVIVE-RESTART-PERSIST）。

/**
 * 停车审批参数预览（argsPreview）脱敏后的截断上限。预览只要「一眼可辨这步要干什么」，
 * 完整入参不入库（库文件、收件箱渲染、SSE 事件三处都背着这份字符串，别放大）。
 */
export const PARKED_APPROVAL_PREVIEW_MAX_CHARS = 300;

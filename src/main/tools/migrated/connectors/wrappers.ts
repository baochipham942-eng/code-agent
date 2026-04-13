// ============================================================================
// connectors/ batch — calendar wrapper 模式实现
//
// macOS native integrations: calendar
// 委托给 legacy Tool 实现，调用 EventKit / AppleScript。
// mail/* 和 reminders/* 已迁到 native（见 ./mail.ts 等）。
// ============================================================================

import { calendarTool } from '../../connectors/calendar';
import { calendarCreateEventTool } from '../../connectors/calendarCreateEvent';
import { calendarUpdateEventTool } from '../../connectors/calendarUpdateEvent';
import { calendarDeleteEventTool } from '../../connectors/calendarDeleteEvent';
import { wrapLegacyTool } from '../_helpers/legacyAdapter';

// connectors 没有专属 category，归到 mcp（外部系统集成）
const READ = {
  category: 'mcp' as const,
  permissionLevel: 'read' as const,
  readOnly: true,
  allowInPlanMode: true,
};
const WRITE = {
  category: 'mcp' as const,
  permissionLevel: 'write' as const,
  readOnly: false,
  allowInPlanMode: false,
};

// ── calendar ────────────────────────────────────────────────────────────
export const calendarModule = wrapLegacyTool(calendarTool, READ);
export const calendarCreateEventModule = wrapLegacyTool(calendarCreateEventTool, WRITE);
export const calendarUpdateEventModule = wrapLegacyTool(calendarUpdateEventTool, WRITE);
export const calendarDeleteEventModule = wrapLegacyTool(calendarDeleteEventTool, WRITE);

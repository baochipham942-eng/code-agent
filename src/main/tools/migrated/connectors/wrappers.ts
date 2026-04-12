// ============================================================================
// connectors/ batch — 11 工具的 wrapper 模式实现
//
// macOS native integrations: mail / reminders / calendar
// 全部委托给 legacy Tool 实现，调用 AppleScript / EventKit 等。
// ============================================================================

import { mailTool } from '../../connectors/mail';
import { mailSendTool } from '../../connectors/mailSend';
import { mailDraftTool } from '../../connectors/mailDraft';
import { remindersTool } from '../../connectors/reminders';
import { remindersCreateTool } from '../../connectors/remindersCreate';
import { remindersUpdateTool } from '../../connectors/remindersUpdate';
import { remindersDeleteTool } from '../../connectors/remindersDelete';
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

// ── mail ────────────────────────────────────────────────────────────────
export const mailModule = wrapLegacyTool(mailTool, READ); // 列邮件/搜索是 read
export const mailSendModule = wrapLegacyTool(mailSendTool, WRITE);
export const mailDraftModule = wrapLegacyTool(mailDraftTool, WRITE);

// ── reminders ───────────────────────────────────────────────────────────
export const remindersModule = wrapLegacyTool(remindersTool, READ);
export const remindersCreateModule = wrapLegacyTool(remindersCreateTool, WRITE);
export const remindersUpdateModule = wrapLegacyTool(remindersUpdateTool, WRITE);
export const remindersDeleteModule = wrapLegacyTool(remindersDeleteTool, WRITE);

// ── calendar ────────────────────────────────────────────────────────────
export const calendarModule = wrapLegacyTool(calendarTool, READ);
export const calendarCreateEventModule = wrapLegacyTool(calendarCreateEventTool, WRITE);
export const calendarUpdateEventModule = wrapLegacyTool(calendarUpdateEventTool, WRITE);
export const calendarDeleteEventModule = wrapLegacyTool(calendarDeleteEventTool, WRITE);

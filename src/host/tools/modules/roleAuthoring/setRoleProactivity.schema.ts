// Schema-only file (single source of truth) — set_role_proactivity 工具
import type { ToolSchema } from '../../../protocol/tools';

export const SET_ROLE_PROACTIVITY_TOOL_NAME = 'set_role_proactivity';

export const setRoleProactivitySchema: ToolSchema = {
  name: SET_ROLE_PROACTIVITY_TOOL_NAME,
  description:
    "Change how often and about what a persistent role proactively reaches out to the user " +
    "(proactivity level, daily-brief schedule, quiet hours, include/exclude topics). " +
    'Call this when the user says things like "以后每天只跟我说一次" / "别再提天气了" / "晚上十点后别打扰我". ' +
    'The change ALWAYS shows the user a confirmation card restating old -> new before anything is written. ' +
    'Ambiguous complaints such as "少烦我" / "太吵了" WITHOUT a concrete direction are NOT a change: ' +
    'first ask ONE clarifying question with ask_user_question offering 每天一次 / 只在有重要进展时 / 完全不主动, ' +
    'then apply the choice the user picks. Never map an ambiguous complaint to silent. ' +
    'level "silent" is only for when the user CLEARLY asks to stop all proactive updates (e.g. "别再主动找我了"). ' +
    'When the user wants "once a day" use once_a_day=true (sets level daily + 09:00 daily brief), not a raw level. ' +
    'Topics are appended/removed incrementally via add_/remove_ args — existing topics the user did not mention are kept.',
  outputSchema: { type: 'string' },
  inputSchema: {
    type: 'object',
    properties: {
      roleId: {
        type: 'string',
        description:
          'Target role id. Omit when chatting inside that role\'s expert thread (defaults to the thread\'s role). ' +
          'Required in any other conversation; must be an existing persistent role.',
      },
      level: {
        type: 'string',
        enum: ['silent', 'daily', 'realtime'],
        description:
          'Proactivity level: silent = never wake up (ONLY when the user clearly says stop); ' +
          'daily = daily brief; realtime = may also wake on progress. For "once a day" prefer once_a_day=true.',
      },
      once_a_day: {
        type: 'boolean',
        description:
          'true = level daily + daily brief at 09:00 every day (replaces any custom schedule). ' +
          'Use for requests like "每天只跟我说一次" / "一天一次就好".',
      },
      add_exclude: {
        type: 'array',
        items: { type: 'string' },
        description: 'Topics the role must NEVER mention again (e.g. ["天气"]). Appended to existing exclusions.',
      },
      remove_exclude: {
        type: 'array',
        items: { type: 'string' },
        description: 'Topics to lift from the never-mention list (e.g. ["天气"]). Existing others are kept.',
      },
      add_include: {
        type: 'array',
        items: { type: 'string' },
        description: 'Topics to prioritize in proactive suggestions. Appended to existing inclusions.',
      },
      remove_include: {
        type: 'array',
        items: { type: 'string' },
        description: 'Topics to drop from the priority list. Existing others are kept.',
      },
      quiet_hours: {
        type: ['object', 'null'],
        properties: {
          start: { type: 'string', description: 'HH:mm local time, e.g. "22:00"' },
          end: { type: 'string', description: 'HH:mm local time, e.g. "08:00"; must differ from start' },
        },
        required: ['start', 'end'],
        description: 'Quiet window in HH:mm (start inclusive, end exclusive, may cross midnight). null clears quiet hours.',
      },
    },
    required: [],
  },
  category: 'fs',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: false,
  accesses: [
    { kind: 'write', expression: 'resource(role, proactivity)' },
  ],
  touchesWorkDirectory: false,
};

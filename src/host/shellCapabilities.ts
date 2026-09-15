// ============================================================================
// Shell Capability Manifest
// ============================================================================

import {
  makeShellCapabilityId,
  makeTauriCommandCapabilityId,
  SHELL_CAPABILITY_DOMAINS,
  shellCapabilityLayerForDomain,
  type ShellCapability,
  type ShellCapabilitiesManifest,
  type ShellCapabilityRisk,
} from '../shared/contract/shellCapabilities';
import { IPC_DOMAINS, type IPCDomain } from '../shared/ipc/domains';
import { sessionRoutes } from './ipc/domainRoutes/sessionRoutes';
import { MemorySchemas } from '../shared/ipc/schemas/memory';
import { DesktopSchemas } from '../shared/ipc/schemas/desktop';
import { TagSchemas } from '../shared/ipc/schemas/tag';
import { CronSchemas } from '../shared/ipc/schemas/cron';
import { PromptSchemas } from '../shared/ipc/schemas/prompt';
import { DiagnosticsSchemas } from '../shared/ipc/schemas/diagnostics';
import { DataSchemas } from '../shared/ipc/schemas/data';
import { LoopSchemas } from '../shared/ipc/schemas/loop';
import { SyncSchemas } from '../shared/ipc/schemas/sync';
import { DeviceSchemas } from '../shared/ipc/schemas/device';
import { WindowSchemas } from '../shared/ipc/schemas/window';
import { ProjectSchemas } from '../shared/ipc/schemas/project';
import { TaskSchemas } from '../shared/ipc/schemas/task';
import { GenerativeUISchemas } from '../shared/ipc/schemas/generativeUI';
import { FolderTrustSchemas } from '../shared/ipc/schemas/folderTrust';
import { HookSchemas } from '../shared/ipc/schemas/hook';
import { WorkspaceSchemas } from '../shared/ipc/schemas/workspace';
import { AuthSchemas } from '../shared/ipc/schemas/auth';
import { RolesSchemas } from '../shared/ipc/schemas/roles';
import { ConnectorSchemas } from '../shared/ipc/schemas/connector';
import { AgentSchemas } from '../shared/ipc/schemas/agent';
import { SettingsSchemas } from '../shared/ipc/schemas/settings';
import { McpSchemas } from '../shared/ipc/schemas/mcp';
import { LibrarySchemas } from '../shared/ipc/schemas/library';
import { AgentEngineSchemas } from '../shared/ipc/schemas/agentEngine';
import { CapabilitySchemas } from '../shared/ipc/schemas/capability';
import { PiiSchemas } from '../shared/ipc/schemas/pii';
import { ActivitySchemas } from '../shared/ipc/schemas/activity';
import { StatusSchemas } from '../shared/ipc/schemas/status';
import { NotificationSchemas } from '../shared/ipc/schemas/notification';
import { OpenchronicleSchemas } from '../shared/ipc/schemas/openchronicle';
import { SoulSchemas } from '../shared/ipc/schemas/soul';
import { PlanningSchemas } from '../shared/ipc/schemas/planning';
import { TerminalSchemas } from '../shared/ipc/schemas/terminal';

const DEFAULT_SINCE_VERSION = '0.16.93';

const NATIVE_TAURI_COMMANDS = [
  'appshots_read_image_data_url',
  'appshots_read_image_data_url_by_id',
  'appshots_report_composer_slot',
  'appshots_set_enabled',
  'appshots_set_motion_enabled',
  'appshots_set_target_session',
  'appshots_skip_motion',
  'appshots_trigger',
  'check_for_update',
  'desktop_capture_screenshot',
  'desktop_get_app_icon',
  'desktop_get_capabilities',
  'desktop_get_collector_status',
  'desktop_get_frontmost_context',
  'desktop_get_permission_status',
  'desktop_list_recent_events',
  'desktop_open_system_settings',
  'desktop_request_microphone_permission',
  'desktop_start_audio_rec',
  'desktop_start_collector',
  'desktop_stop_audio_rec',
  'desktop_stop_collector',
  'desktop_update_analyze_text',
  'get_app_version',
  'install_update',
  'open_update_url',
  'pip_frame',
  'pip_control',
  'pip_controls',
  'pip_hide',
  'pip_show',
  'renderer_ready',
  'shutdown_web_server_for_update',
  'warm_compile_cache_after_install',
] as const;

// session 域自 RQ-183 刀 4 起从单源路由表派生（方案 2.4）：action 集合的真源是
// sessionRoutes 表，本清单不再手工维护——加/删 action 改表即可，这里自动跟。
// 手工只剩 since 版本（DEFAULT_SINCE_VERSION）与高危标记（HIGH_RISK_CAPABILITIES）。
// 其余域表化后照此逐域切换（挂后续单）；未表化域仍手工维护，由 domainRouteParity
// 的全域单向门盯「清单 ⊆ 实际 handler」+ 缺报棘轮。
const SESSION_TABLE_ACTIONS: readonly string[] = Object.keys(sessionRoutes.actions);

const CAPABILITY_DOMAIN_ACTIONS = {
  // activity 域：派生自 schema action 集合（== activity 表 keys，parity 门三面对账），手工清单已删
  [IPC_DOMAINS.ACTIVITY]: ActivitySchemas.ACTIONS,
  [IPC_DOMAINS.ADMIN]: [
    'createInviteCode',
    'listControlPlaneAuditEvents',
    'listControlPlaneRolloutSummary',
    'listInviteCodes',
    'listUsers',
    'setUserAdmin',
    'setSharedRelay',
    'updateInviteCode',
  ],
  // agent 域：派生自 schema action 集合（== agent 表 keys，parity 门三面对账），手工清单已删
  [IPC_DOMAINS.AGENT]: AgentSchemas.ACTIONS,
  // agentEngine 域：派生自 schema action 集合（== agentEngine 表 keys，parity 门三面对账），手工清单已删
  [IPC_DOMAINS.AGENT_ENGINE]: AgentEngineSchemas.ACTIONS,
  [IPC_DOMAINS.AGENT_REGISTRY]: [
    'list',
  ],
  // backgroundTasks 域：defineHandler schema 化注册（BackgroundTaskSchemas.REQUEST），renderer 的任务面板 / 通知同步在调；
  // 此前整域未登记（缺报 5 项），parity 门的缺报棘轮按 defineHandler 提取对账
  [IPC_DOMAINS.BACKGROUND_TASKS]: [
    'drainNotifications',
    'getTask',
    'listTasks',
    'markNotificationDelivered',
    'readTaskLog',
  ],
  // auth 域：派生自 schema action 集合（== auth 表 keys，parity 门三面对账），手工清单已删
  [IPC_DOMAINS.AUTH]: AuthSchemas.ACTIONS,
  // capability 域：派生自 schema action 集合（== capability 表 keys，parity 门三面对账），手工清单已删
  [IPC_DOMAINS.CAPABILITY]: CapabilitySchemas.ACTIONS,
  [IPC_DOMAINS.CAPTURE]: [
    'capture',
    'delete',
    'get',
    'importFiles',
    'list',
    'search',
    'selectFiles',
    'stats',
    'wechatStatus',
  ],
  [IPC_DOMAINS.VOICE]: [
    'injectUserText',
    'reportFailure',
    // 通话录音（N-L7-REC）：设置页与导出勾选框都读它，旧壳不认识要降级。
    'recordingOverview',
    // 声纹身份（N-L7-SPK）：热更新的 renderer 会调这四个，旧壳不认识就得降级，
    // 所以要在这里登记成壳能力（renderer-capability-diff 门守的就是这个）。
    'voiceprintClear',
    'voiceprintOverview',
    'voiceprintPrepareModel',
    'voiceprintRegister',
  ],
  // connector 域：派生自 schema action 集合（== connector 表 keys，parity 门三面对账），手工清单已删
  [IPC_DOMAINS.CONNECTOR]: ConnectorSchemas.ACTIONS,
  // data 域：派生自 schema action 集合（== data 表 keys，parity 门三面对账），手工清单已删
  [IPC_DOMAINS.DATA]: DataSchemas.ACTIONS,
  // folderTrust 域：派生自 schema action 集合（== folderTrust 表 keys，parity 门三面对账），手工清单已删
  [IPC_DOMAINS.FOLDER_TRUST]: FolderTrustSchemas.ACTIONS,
  // cron 域：派生自 schema action 集合（== cron 表 keys，parity 门三面对账）
  [IPC_DOMAINS.CRON]: CronSchemas.ACTIONS,
  // device 域：派生自 schema action 集合（== device 表 keys，parity 门三面对账）
  [IPC_DOMAINS.DEVICE]: DeviceSchemas.ACTIONS,
  // desktop 域：派生自 schema action 集合（== desktop 表 keys，parity 门三面对账），手工清单已删
  [IPC_DOMAINS.DESKTOP]: DesktopSchemas.ACTIONS,
  // diagnostics 域：派生自 schema action 集合（== diagnostics 表 keys，parity 门三面对账），手工清单已删
  [IPC_DOMAINS.DIAGNOSTICS]: DiagnosticsSchemas.ACTIONS,
  // generativeUI 域：派生自 schema action 集合（== generativeUI 表 keys，parity 门三面对账），手工清单已删
  [IPC_DOMAINS.GENERATIVE_UI]: GenerativeUISchemas.ACTIONS,
  // hook 域：派生自 schema action 集合（== hook 表 keys，parity 门三面对账），手工清单已删
  [IPC_DOMAINS.HOOK]: HookSchemas.ACTIONS,
  [IPC_DOMAINS.LIVE_PREVIEW]: [
    'applyTweak',
    'detectFramework',
    'getDevServerLogs',
    'getDevServerSession',
    'listDevServers',
    'ping',
    'resolveSourceLocation',
    'startDevServer',
    'stopDevServer',
    'validateDevServerUrl',
    'waitDevServerReady',
  ],
  // loop 域：派生自 schema action 集合（== loop 表 keys，parity 门三面对账）
  [IPC_DOMAINS.LOOP]: LoopSchemas.ACTIONS,
  // mcp 域：派生自 schema action 集合（== mcp 表 keys，parity 门三面对账），手工清单已删
  [IPC_DOMAINS.MCP]: McpSchemas.ACTIONS,
  // memory 域：派生自 schema action 集合（== memoryRoutes 表 keys，parity 门三面对账），手工清单已删
  [IPC_DOMAINS.MEMORY]: MemorySchemas.ACTIONS,
  // notification 域：派生自 schema action 集合（== notification 表 keys，parity 门三面对账），手工清单已删
  [IPC_DOMAINS.NOTIFICATION]: NotificationSchemas.ACTIONS,
  // openchronicle 域：派生自 schema action 集合（== openchronicle 表 keys，parity 门三面对账），手工清单已删
  [IPC_DOMAINS.OPENCHRONICLE]: OpenchronicleSchemas.ACTIONS,
  // pii 域：派生自 schema action 集合（== pii 表 keys，parity 门三面对账），手工清单已删
  [IPC_DOMAINS.PII]: PiiSchemas.ACTIONS,
  // planning 域：派生自 schema action 集合（== planning 表 keys，parity 门三面对账），手工清单已删
  [IPC_DOMAINS.PLANNING]: PlanningSchemas.ACTIONS,
  // project 域：派生自 schema action 集合（== project 表 keys，parity 门三面对账），手工清单已删
  [IPC_DOMAINS.PROJECT]: ProjectSchemas.ACTIONS,
  [IPC_DOMAINS.QUEUED_INPUT]: [
    'enqueue',
    'list',
    'markSending',
    'reportSendOutcome',
    'reorder',
    'requeue',
    'retract',
    'sendNow',
    'update',
  ],
  // library 域：派生自 schema action 集合（== library 表 keys，parity 门三面对账），手工清单已删
  [IPC_DOMAINS.LIBRARY]: LibrarySchemas.ACTIONS,
  // prompt 域：派生自 schema action 集合（== prompt 表 keys，parity 门三面对账）；此前清单整域缺报 7 项
  [IPC_DOMAINS.PROMPT]: PromptSchemas.ACTIONS,
  [IPC_DOMAINS.PROVIDER]: [
    'delete_realtime_voice_provider',
    'discover_models',
    'getHealthStatus',
    'get_search_capabilities',
    'get_thinking_capabilities',
    'list_realtime_voice_providers',
    'run_diagnostics',
    'run_doctor',
    'save_realtime_voice_provider',
    'test_connection',
    'test_realtime_voice_provider',
  ],
  // roles 域：派生自 schema action 集合（== roles 表 keys，parity 门三面对账），手工清单已删
  [IPC_DOMAINS.ROLES]: RolesSchemas.ACTIONS,
  // session 域：派生自 sessionRoutes 表（见上），手工清单已删
  [IPC_DOMAINS.SESSION]: SESSION_TABLE_ACTIONS,
  [IPC_DOMAINS.SESSION_AUTOMATION]: [
    'countPendingReview',
    'getSessionSummary',
    'listBySession',
    'listParkedApprovals',
    'listPendingReview',
    'markReviewed',
    'summarizeSessions',
  ],
  // status 域：派生自 schema action 集合（== status 表 keys，parity 门三面对账），手工清单已删
  [IPC_DOMAINS.STATUS]: StatusSchemas.ACTIONS,
  [IPC_DOMAINS.SURFACE_EXECUTION]: [
    'control',
    'deletePersistedTerminalFrames',
    'getFrame',
    'getOutput',
    'getPersistedTerminalFrame',
    'getSnapshot',
    'persistTerminalFrame',
    'startLiveStream',
    'stopLiveStream',
  ],
  // settings 域：派生自 schema action 集合（== settings 表 keys，parity 门三面对账），手工清单已删
  [IPC_DOMAINS.SETTINGS]: SettingsSchemas.ACTIONS,
  // soul 域：派生自 schema action 集合（== soul 表 keys，parity 门三面对账），手工清单已删
  [IPC_DOMAINS.SOUL]: SoulSchemas.ACTIONS,
  // sync 域：派生自 schema action 集合（== sync 表 keys，parity 门三面对账），手工清单已删
  [IPC_DOMAINS.SYNC]: SyncSchemas.ACTIONS,
  // tag 域：派生自 schema action 集合（== tag 表 keys，parity 门三面对账）
  [IPC_DOMAINS.TAG]: TagSchemas.ACTIONS,
  // task 域：派生自 schema action 集合（== task 表 keys，parity 门三面对账），手工清单已删
  [IPC_DOMAINS.TASK]: TaskSchemas.ACTIONS,
  // terminal 域：派生自 schema action 集合（== terminal 表 keys，parity 门三面对账），手工清单已删
  [IPC_DOMAINS.TERMINAL]: TerminalSchemas.ACTIONS,
  [IPC_DOMAINS.TEAM]: [
    'confirmDraft',
    'knownRoles',
    'launchRecipe',
    'listDrafts',
    'recipeCreate',
    'recipeDelete',
    'recipeList',
    'recipeUpdate',
    'rejectDraft',
  ],
  [IPC_DOMAINS.UPDATE]: [
    'check',
    'download',
    'getInfo',
    'openFile',
    'openUrl',
    'prepareRuntimeAssets',
    'rendererBundleStatus',
    'runtimeAssetsStatus',
    'startAutoCheck',
    'stopAutoCheck',
  ],
  // window 域：派生自 schema action 集合（== window 表 keys，parity 门三面对账）
  [IPC_DOMAINS.WINDOW]: WindowSchemas.ACTIONS,
  // workspace 域：派生自 schema action 集合（== workspace 表 keys，parity 门三面对账），手工清单已删
  [IPC_DOMAINS.WORKSPACE]: WorkspaceSchemas.ACTIONS,
} satisfies Partial<Record<IPCDomain, readonly string[]>>;

const HIGH_RISK_CAPABILITIES = new Set([
  makeShellCapabilityId(IPC_DOMAINS.AGENT, 'send'),
  // oauthSetSecret 落用户机密、oauthSaveDescriptor 改授权与注入边界、oauthConnect 发起
  // 对外授权；inferRisk 按动作名前缀猜会把 oauth* 判成 low，风险显示不出来。
  makeShellCapabilityId(IPC_DOMAINS.CONNECTOR, 'oauthConnect'),
  makeShellCapabilityId(IPC_DOMAINS.CONNECTOR, 'oauthSaveDescriptor'),
  makeShellCapabilityId(IPC_DOMAINS.CONNECTOR, 'oauthSetSecret'),
  makeShellCapabilityId(IPC_DOMAINS.DESKTOP, 'ensureManagedBrowserSession'),
  makeShellCapabilityId(IPC_DOMAINS.DESKTOP, 'importBrowserProfileCookies'),
  makeShellCapabilityId(IPC_DOMAINS.DESKTOP, 'observeComputerSurface'),
  makeShellCapabilityId(IPC_DOMAINS.DESKTOP, 'openManagedBrowserUrl'),
  // recoverHistory's import action writes sessions/messages/forks and creates a
  // receipt table; inferRisk's prefix regex doesn't match "recoverHistory" so it
  // would silently fall through to low.
  makeShellCapabilityId(IPC_DOMAINS.SESSION, 'recoverHistory'),
  makeShellCapabilityId(IPC_DOMAINS.SESSION, 'restoreWorkspaceFilesAtCheckpoint'),
  makeShellCapabilityId(IPC_DOMAINS.SESSION, 'turnCheckout'),
  makeShellCapabilityId(IPC_DOMAINS.SESSION, 'turnRedo'),
  makeShellCapabilityId(IPC_DOMAINS.SURFACE_EXECUTION, 'control'),
  makeShellCapabilityId(IPC_DOMAINS.TERMINAL, 'write'),
  makeShellCapabilityId(IPC_DOMAINS.WORKSPACE, 'writeFile'),
  makeTauriCommandCapabilityId('install_update'),
]);

function inferRisk(domain: string, action: string): ShellCapabilityRisk {
  const id = makeShellCapabilityId(domain, action);
  if (HIGH_RISK_CAPABILITIES.has(id)) return 'high';
  if (/^(add|archive|cancel|capture|clear|close|confirm|create|delete|disconnect|download|force|import|install|interrupt|open|pause|prepare|probe|refresh|reject|remove|rename|repair|report|reset|resume|resync|retry|save|select|send|set|sign|start|stop|switch|unarchive|update|write)/i.test(action)) {
    return 'medium';
  }
  return 'low';
}

export function getShellCapabilities(): ShellCapability[] {
  const domainCapabilities = Object.entries(CAPABILITY_DOMAIN_ACTIONS)
    .flatMap(([domain, actions]) => actions.map((action) => ({
      id: makeShellCapabilityId(domain, action),
      domain,
      action,
      layer: shellCapabilityLayerForDomain(domain),
      since: DEFAULT_SINCE_VERSION,
      risk: inferRisk(domain, action),
    })));
  const nativeCapabilities = NATIVE_TAURI_COMMANDS.map((command) => ({
    id: makeTauriCommandCapabilityId(command),
    domain: SHELL_CAPABILITY_DOMAINS.TAURI,
    action: command,
    layer: shellCapabilityLayerForDomain(SHELL_CAPABILITY_DOMAINS.TAURI),
    since: DEFAULT_SINCE_VERSION,
    risk: inferRisk(SHELL_CAPABILITY_DOMAINS.TAURI, command),
  }));

  return [...domainCapabilities, ...nativeCapabilities]
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function getShellCapabilityIds(): string[] {
  return getShellCapabilities().map((capability) => capability.id);
}

export function getShellCapabilitiesManifest(
  appVersion: string,
  generatedAt = new Date().toISOString(),
): ShellCapabilitiesManifest {
  return {
    schemaVersion: 1,
    appVersion,
    generatedAt,
    capabilities: getShellCapabilities(),
  };
}

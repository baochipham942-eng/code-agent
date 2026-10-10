import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';

// ============================================================================
// renderer 凭据边界（RQ-262 静态契约）：凭据形状成员名 + provider 客户端 import
// 不得出现在前端可见面里。只做静态扫描，不做运行时脱敏。
//   规则 A：扫描根（src/renderer 与 src/shared/ipc，本仓为 Tauri 结构、无
//           src/preload）的非测试 .ts/.tsx 中，成员/属性名（接口/类型成员、
//           对象字面量键、对象解构字段；标识符或引号键）命中
//           access_?token|refresh_?token|api_?key|secret（大小写不敏感、整名段
//           对齐：client_secret / apiKey / secretKey / apiKeyConfigured 均算）
//           即违规，除非在 ALLOWLIST 登记。双向核对：多出的命中判红，不再命中
//           的陈旧条目也判红。最小口径：散文字符串与 i18n 文案值不扫
//           （i18n 的键仍是对象字面量键，会扫到、走 allowlist）。
//   规则 B：src/renderer 的 import / export-from / import() / require() /
//           import 类型 引入 provider 客户端包（PROVIDER_CLIENT_PACKAGES 显式
//           denylist）即违规，无 allowlist。
// fail-closed：扫描根被改名/挪走（不存在、非目录、根下 0 个目标源文件）直接
// throw，不允许目录漂移后门禁静默恒绿。
// ============================================================================

const repoRoot = path.resolve(__dirname, '../../..');
const SCAN_ROOTS = ['src/renderer', 'src/shared/ipc'];
const RENDERER_ROOT = 'src/renderer';
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

/** 凭据形状名字 token；整名段对齐匹配见 isCredentialMemberName */
const CREDENTIAL_NAME_TOKENS = ['access_?token', 'refresh_?token', 'api_?key', 'secret'];

/** model / 搜索 / connector provider 客户端包：进 renderer 即红（无 allowlist） */
const PROVIDER_CLIENT_PACKAGES = [
  '@anthropic-ai/sdk',
  '@ai-sdk/anthropic',
  '@ai-sdk/deepseek',
  '@ai-sdk/google',
  '@ai-sdk/openai-compatible',
  '@openrouter/ai-sdk-provider',
  'groq-sdk',
  '@supabase/supabase-js',
  '@modelcontextprotocol/client',
  '@modelcontextprotocol/core',
  '@modelcontextprotocol/server',
  '@larksuiteoapi/node-sdk',
];

type AllowlistEntry = { file: string; name: string; reason: string };

/**
 * 规则 A 登记表：file+name 对应扫描原始命中（行号会漂，不进 key）。每条必须有
 * 非空 reason（说明为何不是泄漏，如「用户手输、只写不回显」）；条目不再对应任何
 * 真实命中时判「陈旧」红，逼着删除时同步清理登记。
 */
const ALLOWLIST: AllowlistEntry[] = [
  // ---- IPC 契约层（src/shared/ipc）——逐条人工审过 ----
  // 死类型面：SETTINGS_GET_SERVICE_KEYS 只在这两张类型表里出现，无 handler、无调用方。
  // 返回形状若复活必须改成 apiKeyConfigured 式布尔，不得回传原始 service key。
  { file: 'src/shared/ipc/handlers.ts', name: 'langfuse_secret', reason: 'SETTINGS_GET_SERVICE_KEYS 返回类型成员：死类型面（全仓无实现、无调用方）；若复活需改为 configured 布尔，不得回传裸 key' },
  // SETTINGS_SET_SERVICE_KEY 载荷成员：renderer→host 只写方向，值是用户手输的 service key。
  { file: 'src/shared/ipc/handlers.ts', name: 'apiKey', reason: 'SETTINGS_SET_SERVICE_KEY 请求载荷成员：renderer→host 只写，用户手输' },
  // AUTH_PASSWORD_RESET_CALLBACK 事件载荷：OAuth 恢复链接深链带来的 token，renderer 收到后转交 host 建会话（写穿）。
  { file: 'src/shared/ipc/handlers.ts', name: 'accessToken', reason: 'AUTH_PASSWORD_RESET_CALLBACK 事件载荷：深链恢复 token 写穿转发给 host，非 host 存量凭据回传' },
  { file: 'src/shared/ipc/handlers.ts', name: 'refreshToken', reason: 'AUTH_PASSWORD_RESET_CALLBACK 事件载荷：深链恢复 token 写穿转发给 host，非 host 存量凭据回传' },
  // IPC 通道名字符串常量，不是数据载荷。
  { file: 'src/shared/ipc/legacy-channels.ts', name: 'SETTINGS_TEST_API_KEY', reason: 'IPC 通道名字符串常量（settings:test-api-key），非凭据数据' },
  { file: 'src/shared/ipc/legacy-channels.ts', name: 'SECURITY_CHECK_API_KEY_CONFIGURED', reason: 'IPC 通道名字符串常量，非凭据数据' },

  // ---- 密码重置深链流（token 来自 OAuth 恢复链接，renderer 转交 host，前端短暂持有的既有暴露面）----
  { file: 'src/renderer/stores/authStore.ts', name: 'accessToken', reason: '密码重置回调 token：来自恢复链接深链，转发 host 建会话后仅暂存供改密弹窗用，非 host 回传的存量凭据' },
  { file: 'src/renderer/stores/authStore.ts', name: 'refreshToken', reason: '密码重置回调 token：来自恢复链接深链，转发 host 建会话后仅暂存供改密弹窗用，非 host 回传的存量凭据' },

  // ---- UI 状态（与凭据无关的同名物）----
  { file: 'src/renderer/components/features/chat/ActiveConversationRewindBanner.tsx', name: 'refreshToken', reason: '同名异物：会话重做后的 UI 重取计数器（number），与认证 token 无关' },
  { file: 'src/renderer/components/StatusBar/modelSwitcherHelpers.tsx', name: 'api_key_payg', reason: '计费模式判别值 api_key_payg（按量付费徽标样式键），非凭据' },

  // ---- 设置/接入表单：apiKey 均为用户手输的表单态，写向 host，回显只走掩码/布尔 ----
  { file: 'src/renderer/App.tsx', name: 'apiKey', reason: '读取 settings 契约里的 providerConfig.apiKey 填充模型配置（既有 settings 回传面），非新增暴露' },
  { file: 'src/renderer/stores/appStore.ts', name: 'apiKey', reason: '默认模型配置占位空串，真实值仅用户输入后由 host 存储' },
  { file: 'src/renderer/components/design/CustomImageModelManager.tsx', name: 'apiKey', reason: '自定义图像模型表单态：用户手输、保存时写向 host' },
  { file: 'src/renderer/components/design/designFiles.ts', name: 'apiKey', reason: 'invoke 载荷成员：用户手输的 key 写向 host（只写方向）' },
  { file: 'src/renderer/components/features/settings/tabs/AddProviderCard.tsx', name: 'apiKey', reason: '新增 provider 表单态：用户手输、只写' },
  { file: 'src/renderer/components/features/settings/tabs/AddProviderCard.tsx', name: 'onApiKeyChange', reason: '表单变更回调 prop，不承载存量凭据' },
  { file: 'src/renderer/components/features/settings/tabs/ChannelsSettings.tsx', name: 'apiKey', reason: 'http-api 渠道表单：本地生成 UUID 或用户填写，保存时写向 host' },
  { file: 'src/renderer/components/features/settings/tabs/ChannelsSettings.tsx', name: 'appSecret', reason: 'feishu/lark 渠道表单：用户手输，保存时写向 host' },
  { file: 'src/renderer/components/features/settings/tabs/JevKeyConfig.tsx', name: 'apiKey', reason: 'setServiceApiKey 载荷成员：用户手输草稿，只写；回显走 maskApiKey' },
  { file: 'src/renderer/components/features/settings/tabs/ModelSettings.tsx', name: 'apiKey', reason: 'provider 设置表单态：用户手输草稿，只写；回显只走掩码' },
  { file: 'src/renderer/components/features/settings/tabs/ModelSettings.tsx', name: 'apiKeyConfigured', reason: '布尔存在标志，不承载 key 值' },
  { file: 'src/renderer/components/features/settings/tabs/ModelSettings.tsx', name: 'needsApiKey', reason: '布尔存在标志，不承载 key 值' },
  { file: 'src/renderer/components/features/settings/tabs/ModelSettings.tsx', name: 'hasStoredApiKey', reason: '布尔存在标志，不承载 key 值' },
  { file: 'src/renderer/components/features/settings/tabs/ModelSettings.helpers.tsx', name: 'apiKey', reason: 'provider 设置表单归一化：用户手输草稿，只写' },
  { file: 'src/renderer/components/features/settings/tabs/ModelSettings.helpers.tsx', name: 'apiKeyConfigured', reason: '布尔存在标志，不承载 key 值' },
  { file: 'src/renderer/components/features/settings/tabs/ModelSettings.helpers.tsx', name: 'needsApiKey', reason: '布尔存在标志，不承载 key 值' },
  { file: 'src/renderer/components/features/settings/tabs/ModelSettings.helpers.tsx', name: 'hasStoredApiKey', reason: '布尔存在标志，不承载 key 值' },
  { file: 'src/renderer/components/features/settings/tabs/ProviderDetailSections.tsx', name: 'apiKey', reason: 'provider 详情表单态：用户手输草稿，只写' },
  { file: 'src/renderer/components/features/settings/tabs/ProviderDetailSections.tsx', name: 'needsApiKey', reason: '布尔存在标志，不承载 key 值' },
  { file: 'src/renderer/components/features/settings/tabs/ProviderDetailSections.tsx', name: 'hasStoredApiKey', reason: '布尔存在标志，不承载 key 值' },
  { file: 'src/renderer/components/features/settings/tabs/ProviderDetailSections.tsx', name: 'onApiKeyChange', reason: '表单变更回调 prop，不承载存量凭据' },
  { file: 'src/renderer/components/features/settings/tabs/ProviderModelsSection.tsx', name: 'hasApiKey', reason: '布尔存在标志，不承载 key 值' },
  { file: 'src/renderer/components/features/settings/tabs/SearchSettings.tsx', name: 'apiKey', reason: '搜索 service key 表单态：setServiceApiKey 只写，回显走 maskApiKey' },
  { file: 'src/renderer/components/features/settings/tabs/VisualModelsSettings.tsx', name: 'apiKey', reason: '视觉模型表单态：用户手输、只写' },
  { file: 'src/renderer/components/features/settings/tabs/VoiceApiKeyConfig.tsx', name: 'apiKey', reason: '语音 key 表单态：用户手输、只写' },
  { file: 'src/renderer/components/features/settings/tabs/VoiceModelSettings.tsx', name: 'apiKey', reason: '语音 provider 表单态：用户手输、只写' },
  { file: 'src/renderer/components/onboarding/modelOnboarding.ts', name: 'apiKey', reason: 'onboarding 选型入参：用户手输 key 写向 host' },
  { file: 'src/renderer/components/onboarding/ModelOnboardingModal.tsx', name: 'apiKey', reason: 'onboarding 表单态：用户手输 key 写向 host' },

  // ---- MCP / SaaS 连接器：名字列表与布尔，不承载密钥值 ----
  { file: 'src/renderer/components/features/settings/McpServerEditor.tsx', name: 'secretEnvKeys', reason: '环境变量名字列表（标识哪些槽位是密钥），非密钥值' },
  { file: 'src/renderer/components/features/settings/McpServerEditor.tsx', name: 'secretHeaderKeys', reason: 'header 名字列表（标识哪些槽位是密钥），非密钥值' },
  { file: 'src/renderer/components/features/settings/tabs/MCPSettings.tsx', name: 'secretEnvKeys', reason: '环境变量名字列表，非密钥值' },
  { file: 'src/renderer/components/features/settings/tabs/MCPSettings.tsx', name: 'secretHeaderKeys', reason: 'header 名字列表，非密钥值' },
  { file: 'src/renderer/components/features/settings/sections/CustomOAuthConnectorForm.tsx', name: 'requiresClientSecret', reason: '布尔能力标志（该 OAuth provider 是否需要 client secret），非值' },
  { file: 'src/renderer/components/features/settings/sections/SaaSConnectorCardFooter.tsx', name: 'requiresClientSecret', reason: '布尔能力标志，非值' },
  { file: 'src/renderer/components/features/settings/sections/SaaSConnectorCardFooter.tsx', name: 'clientSecretConfigured', reason: '布尔存在标志，不承载 secret 值' },
  { file: 'src/renderer/components/features/settings/sections/SaaSConnectorCardFooter.tsx', name: 'clientSecretSaved', reason: 'i18n 文案键（保存成功提示文案），非凭据' },
  { file: 'src/renderer/components/features/settings/sections/SaaSConnectorsModel.ts', name: 'requiresClientSecret', reason: '布尔能力标志，非值' },
  { file: 'src/renderer/components/features/settings/sections/SaaSConnectorsModel.ts', name: 'clientSecretConfigured', reason: '布尔存在标志，不承载 secret 值' },
  { file: 'src/renderer/components/features/settings/sections/SaaSConnectorsSection.tsx', name: 'requiresClientSecret', reason: '布尔能力标志，非值' },
  { file: 'src/renderer/components/features/settings/sections/SaaSConnectorsSection.tsx', name: 'clientSecret', reason: '用户手输的 OAuth client secret 草稿：oauthSetSecret 只写，提交后立即清空' },

  // ---- i18n 文案键：值为界面标签/提示文案，不含凭据 ----
  { file: 'src/renderer/i18n/en.ts', name: 'api_key_payg', reason: 'i18n 计费模式标签键（按量付费），非凭据' },
  { file: 'src/renderer/i18n/en.ts', name: 'apiKeyLabel', reason: 'i18n 文案键，值为界面标签' },
  { file: 'src/renderer/i18n/en.ts', name: 'apiKeyPlaceholder', reason: 'i18n 文案键，值为输入框占位文案' },
  { file: 'src/renderer/i18n/en.ts', name: 'apiKeyRequired', reason: 'i18n 文案键，值为校验提示文案' },
  { file: 'src/renderer/i18n/enSettingsCore.ts', name: 'apiKey', reason: 'i18n 文案键，值为设置页标签' },
  { file: 'src/renderer/i18n/enSettingsModels.ts', name: 'apiKey', reason: 'i18n 文案键，值为设置页标签' },
  { file: 'src/renderer/i18n/enSettingsModels.ts', name: 'apiKeyHint', reason: 'i18n 文案键，值为提示文案' },
  { file: 'src/renderer/i18n/enSettingsModels.ts', name: 'apiKeyLabel', reason: 'i18n 文案键，值为界面标签' },
  { file: 'src/renderer/i18n/enSettingsModels.ts', name: 'apiKeyPlaceholder', reason: 'i18n 文案键，值为输入框占位文案' },
  { file: 'src/renderer/i18n/enSettingsModels.ts', name: 'apiKeyRequired', reason: 'i18n 文案键，值为校验提示文案' },
  { file: 'src/renderer/i18n/enSettingsModels.ts', name: 'apiKeySaved', reason: 'i18n 文案键，值为保存成功提示' },
  { file: 'src/renderer/i18n/enSettingsModels.ts', name: 'apiKeyStoredHint', reason: 'i18n 文案键，值为提示文案' },
  { file: 'src/renderer/i18n/enSettingsModels.ts', name: 'localNoApiKeyPlaceholder', reason: 'i18n 文案键，值为占位文案' },
  { file: 'src/renderer/i18n/enSettingsModels.ts', name: 'needsApiKeyEmpty', reason: 'i18n 文案键，值为提示文案' },
  { file: 'src/renderer/i18n/enSettingsModels.ts', name: 'noApiKey', reason: 'i18n 文案键，值为徽标文案' },
  { file: 'src/renderer/i18n/enSettingsModels.ts', name: 'secretInNextStep', reason: 'i18n 文案键，值为提示文案' },
  { file: 'src/renderer/i18n/enSettingsModels.ts', name: 'storedApiKeyPlaceholder', reason: 'i18n 文案键，值为占位文案' },
  { file: 'src/renderer/i18n/enSettingsModels.ts', name: 'waitingApiKey', reason: 'i18n 文案键，值为等待提示' },
  { file: 'src/renderer/i18n/enSettingsSystem.ts', name: 'clientSecretSaved', reason: 'i18n 文案键，值为保存成功提示' },
  { file: 'src/renderer/i18n/enSettingsSystem.ts', name: 'needsSecret', reason: 'i18n 文案键，值为提示文案' },
  { file: 'src/renderer/i18n/enSettingsSystem.ts', name: 'noSecretRequired', reason: 'i18n 文案键，值为提示文案' },
  { file: 'src/renderer/i18n/enSettingsSystem.ts', name: 'noticeWithSecret', reason: 'i18n 文案键，值为提示文案' },
  { file: 'src/renderer/i18n/enSettingsSystem.ts', name: 'noticeWithoutSecret', reason: 'i18n 文案键，值为提示文案' },
  { file: 'src/renderer/i18n/enSettingsSystem.ts', name: 'requiresClientSecret', reason: 'i18n 文案键，值为说明文案' },
  { file: 'src/renderer/i18n/enSettingsSystem.ts', name: 'secret', reason: 'i18n 文案键，值为表单标签' },
  { file: 'src/renderer/i18n/enSettingsWork.ts', name: 'apiKeyCopied', reason: 'i18n 文案键，值为复制成功提示' },
  { file: 'src/renderer/i18n/enSettingsWork.ts', name: 'apiKeyPlaceholder', reason: 'i18n 文案键，值为输入框占位文案' },
  { file: 'src/renderer/i18n/enSettingsWork.ts', name: 'copyApiKey', reason: 'i18n 文案键，值为按钮文案' },
  { file: 'src/renderer/i18n/onboarding.ts', name: 'apiKeyPlaceholder', reason: 'i18n 文案键，值为输入框占位文案' },
  { file: 'src/renderer/i18n/onboarding.ts', name: 'missingApiKey', reason: 'i18n 文案键，值为校验提示文案' },
  { file: 'src/renderer/i18n/surfaceExecution.ts', name: 'secret', reason: 'i18n 文案键，值为界面标签' },
  { file: 'src/renderer/i18n/voice.ts', name: 'apiKeyChange', reason: 'i18n 文案键，值为按钮文案' },
  { file: 'src/renderer/i18n/voice.ts', name: 'apiKeyClearConfirm', reason: 'i18n 文案键，值为确认文案' },
  { file: 'src/renderer/i18n/voice.ts', name: 'apiKeyCleared', reason: 'i18n 文案键，值为清除成功提示' },
  { file: 'src/renderer/i18n/voice.ts', name: 'apiKeyClearMessage', reason: 'i18n 文案键，值为提示文案' },
  { file: 'src/renderer/i18n/voice.ts', name: 'apiKeyClearTitle', reason: 'i18n 文案键，值为弹窗标题' },
  { file: 'src/renderer/i18n/voice.ts', name: 'apiKeyDescription', reason: 'i18n 文案键，值为说明文案' },
  { file: 'src/renderer/i18n/voice.ts', name: 'apiKeyDescriptionCustom', reason: 'i18n 文案键，值为说明文案' },
  { file: 'src/renderer/i18n/voice.ts', name: 'apiKeyDescriptionOpenAI', reason: 'i18n 文案键，值为说明文案' },
  { file: 'src/renderer/i18n/voice.ts', name: 'apiKeyPlaceholder', reason: 'i18n 文案键，值为输入框占位文案' },
  { file: 'src/renderer/i18n/voice.ts', name: 'apiKeySave', reason: 'i18n 文案键，值为按钮文案' },
  { file: 'src/renderer/i18n/voice.ts', name: 'apiKeySaved', reason: 'i18n 文案键，值为保存成功提示' },
  { file: 'src/renderer/i18n/voice.ts', name: 'apiKeySaveFailedPrefix', reason: 'i18n 文案键，值为失败提示前缀' },
  { file: 'src/renderer/i18n/voice.ts', name: 'apiKeySaving', reason: 'i18n 文案键，值为进行中提示' },
  { file: 'src/renderer/i18n/voice.ts', name: 'apiKeyTitle', reason: 'i18n 文案键，值为区块标题' },
  { file: 'src/renderer/i18n/zh.ts', name: 'api_key_payg', reason: 'i18n 计费模式标签键（按量付费），非凭据' },
  { file: 'src/renderer/i18n/zh.ts', name: 'apiKeyLabel', reason: 'i18n 文案键，值为界面标签' },
  { file: 'src/renderer/i18n/zh.ts', name: 'apiKeyPlaceholder', reason: 'i18n 文案键，值为输入框占位文案' },
  { file: 'src/renderer/i18n/zh.ts', name: 'apiKeyRequired', reason: 'i18n 文案键，值为校验提示文案' },
  { file: 'src/renderer/i18n/zhSettingsCore.ts', name: 'apiKey', reason: 'i18n 文案键，值为设置页标签' },
  { file: 'src/renderer/i18n/zhSettingsModels.ts', name: 'apiKey', reason: 'i18n 文案键，值为设置页标签' },
  { file: 'src/renderer/i18n/zhSettingsModels.ts', name: 'apiKeyHint', reason: 'i18n 文案键，值为提示文案' },
  { file: 'src/renderer/i18n/zhSettingsModels.ts', name: 'apiKeyLabel', reason: 'i18n 文案键，值为界面标签' },
  { file: 'src/renderer/i18n/zhSettingsModels.ts', name: 'apiKeyPlaceholder', reason: 'i18n 文案键，值为输入框占位文案' },
  { file: 'src/renderer/i18n/zhSettingsModels.ts', name: 'apiKeyRequired', reason: 'i18n 文案键，值为校验提示文案' },
  { file: 'src/renderer/i18n/zhSettingsModels.ts', name: 'apiKeySaved', reason: 'i18n 文案键，值为保存成功提示' },
  { file: 'src/renderer/i18n/zhSettingsModels.ts', name: 'apiKeyStoredHint', reason: 'i18n 文案键，值为提示文案' },
  { file: 'src/renderer/i18n/zhSettingsModels.ts', name: 'localNoApiKeyPlaceholder', reason: 'i18n 文案键，值为占位文案' },
  { file: 'src/renderer/i18n/zhSettingsModels.ts', name: 'needsApiKeyEmpty', reason: 'i18n 文案键，值为提示文案' },
  { file: 'src/renderer/i18n/zhSettingsModels.ts', name: 'noApiKey', reason: 'i18n 文案键，值为徽标文案' },
  { file: 'src/renderer/i18n/zhSettingsModels.ts', name: 'secretInNextStep', reason: 'i18n 文案键，值为提示文案' },
  { file: 'src/renderer/i18n/zhSettingsModels.ts', name: 'storedApiKeyPlaceholder', reason: 'i18n 文案键，值为占位文案' },
  { file: 'src/renderer/i18n/zhSettingsModels.ts', name: 'waitingApiKey', reason: 'i18n 文案键，值为等待提示' },
  { file: 'src/renderer/i18n/zhSettingsSystem.ts', name: 'clientSecretSaved', reason: 'i18n 文案键，值为保存成功提示' },
  { file: 'src/renderer/i18n/zhSettingsSystem.ts', name: 'needsSecret', reason: 'i18n 文案键，值为提示文案' },
  { file: 'src/renderer/i18n/zhSettingsSystem.ts', name: 'noSecretRequired', reason: 'i18n 文案键，值为提示文案' },
  { file: 'src/renderer/i18n/zhSettingsSystem.ts', name: 'noticeWithSecret', reason: 'i18n 文案键，值为提示文案' },
  { file: 'src/renderer/i18n/zhSettingsSystem.ts', name: 'noticeWithoutSecret', reason: 'i18n 文案键，值为提示文案' },
  { file: 'src/renderer/i18n/zhSettingsSystem.ts', name: 'requiresClientSecret', reason: 'i18n 文案键，值为说明文案' },
  { file: 'src/renderer/i18n/zhSettingsSystem.ts', name: 'secret', reason: 'i18n 文案键，值为表单标签' },
  { file: 'src/renderer/i18n/zhSettingsWork.ts', name: 'apiKeyCopied', reason: 'i18n 文案键，值为复制成功提示' },
  { file: 'src/renderer/i18n/zhSettingsWork.ts', name: 'apiKeyPlaceholder', reason: 'i18n 文案键，值为输入框占位文案' },
  { file: 'src/renderer/i18n/zhSettingsWork.ts', name: 'copyApiKey', reason: 'i18n 文案键，值为按钮文案' },
];

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

function isExcluded(filePath: string): boolean {
  const posix = toPosix(filePath);
  const name = path.basename(filePath);
  return posix.includes('/__tests__/') || /\.(?:test|spec)\.(?:ts|tsx)$/.test(name) || name.endsWith('.d.ts');
}

function collectFiles(root: string, files: Set<string>): void {
  if (!fs.existsSync(root)) throw new Error(`扫描根不存在：${toPosix(root)}`);
  if (!fs.statSync(root).isDirectory()) throw new Error(`扫描根不是目录：${toPosix(root)}`);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') collectFiles(fullPath, files);
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name)) && !isExcluded(fullPath)) {
      files.add(fullPath);
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const CREDENTIAL_NAME_PATTERN = new RegExp(`(?:${CREDENTIAL_NAME_TOKENS.join('|')})`, 'gi');
// 文本预筛：成员名 / 包说明符都是源文本里的字面量子串，源文本不含 token 就不可能
// 命中，可跳过整棵 AST 解析（~1100 个文件只解析几十个）。
const PRE_FILTER_PATTERN = new RegExp(
  [...CREDENTIAL_NAME_TOKENS, ...PROVIDER_CLIENT_PACKAGES.map(escapeRegExp)].join('|'),
  'i',
);

/** 规则 A 名字判据：token 命中必须对齐整名边界（名字开头 / 下划线后 / 驼峰峰位） */
function isCredentialMemberName(name: string): boolean {
  for (const match of name.matchAll(CREDENTIAL_NAME_PATTERN)) {
    const index = match.index ?? 0;
    if (index === 0 || name[index - 1] === '_'
      || (/[a-z0-9]/.test(name[index - 1]!) && /[A-Z]/.test(name[index]!))) return true;
  }
  return false;
}

function memberNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  return null;
}

/** 规则 A 的三类成员位：类型成员、对象字面量键（含简写）、对象解构字段（含别名两侧） */
function memberNameOf(node: ts.Node): string | null {
  if (ts.isPropertySignature(node) || ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
    return memberNameText(node.name);
  }
  if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
    if (ts.isIdentifier(node.name) && isCredentialMemberName(node.name.text)) return node.name.text;
    return node.propertyName ? memberNameText(node.propertyName) : null;
  }
  return null;
}

function specifierText(node: ts.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function providerPackageOf(specifier: string | null): string | null {
  if (!specifier) return null;
  for (const pkg of PROVIDER_CLIENT_PACKAGES) {
    if (specifier === pkg || specifier.startsWith(`${pkg}/`)) return pkg;
  }
  return null;
}

/** 规则 B 的引入位：静态 import / export-from / import() / require() / import 类型 */
function providerImportOf(node: ts.Node): { kind: string; specifier: string } | null {
  let kind: string | null = null;
  let raw: string | null = null;
  if (ts.isImportDeclaration(node)) {
    kind = 'import';
    raw = specifierText(node.moduleSpecifier);
  } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
    kind = 'export-from';
    raw = specifierText(node.moduleSpecifier);
  } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    kind = 'import()';
    raw = specifierText(node.arguments[0]);
  } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
    kind = 'require()';
    raw = specifierText(node.arguments[0]);
  } else if (ts.isImportTypeNode(node)) {
    kind = 'import-type';
    const arg = node.argument;
    raw = specifierText(ts.isLiteralTypeNode(arg) ? arg.literal : arg);
  }
  if (!kind || !providerPackageOf(raw)) return null;
  return { kind, specifier: raw! };
}

type ScanReport = {
  fileCount: number;
  perRootFileCount: Record<string, number>;
  credentialNameHits: { file: string; line: number; name: string }[];
  providerImportHits: { file: string; line: number; kind: string; specifier: string }[];
};

function scan(rootDir: string): ScanReport {
  if (typeof rootDir !== 'string' || rootDir.trim() === '') throw new Error('扫描根目录无效');
  const root = path.resolve(rootDir);
  const files = new Set<string>();
  const perRootFileCount: Record<string, number> = {};
  for (const rel of SCAN_ROOTS) {
    const before = files.size;
    collectFiles(path.join(root, rel), files);
    perRootFileCount[rel] = files.size - before;
    if (perRootFileCount[rel] === 0) throw new Error(`扫描根下没有目标源文件：${rel}`);
  }

  const credentialNameHits: ScanReport['credentialNameHits'] = [];
  const providerImportHits: ScanReport['providerImportHits'] = [];
  for (const file of [...files].sort()) {
    const source = fs.readFileSync(file, 'utf8');
    if (!PRE_FILTER_PATTERN.test(source)) continue;
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const parseDiagnostics = (sourceFile as ts.SourceFile & { parseDiagnostics?: readonly unknown[] }).parseDiagnostics;
    if ((parseDiagnostics ?? []).length > 0) {
      throw new Error(`TypeScript 解析失败：${toPosix(path.relative(root, file))}`);
    }
    const relFile = toPosix(path.relative(root, file));
    const scanImports = relFile.startsWith(`${RENDERER_ROOT}/`);
    const visit = (node: ts.Node): void => {
      const name = memberNameOf(node);
      if (name !== null && isCredentialMemberName(name)) {
        credentialNameHits.push({ file: relFile, line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1, name });
      }
      if (scanImports) {
        const importHit = providerImportOf(node);
        if (importHit) providerImportHits.push({ file: relFile, line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1, ...importHit });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  credentialNameHits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.name.localeCompare(b.name));
  providerImportHits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { fileCount: files.size, perRootFileCount, credentialNameHits, providerImportHits };
}

/** 双向核对：未登记命中 / 陈旧条目 / 空 reason / 规则 B 命中，全部产出红行 */
function boundaryViolations(report: ScanReport, allowlist: AllowlistEntry[] = ALLOWLIST): string[] {
  const violations: string[] = [];
  const matched = new Set<string>();
  for (const hit of report.credentialNameHits) {
    const key = `${hit.file}\0${hit.name}`;
    const entry = allowlist.find((item) => `${item.file}\0${item.name}` === key);
    if (!entry) violations.push(`${hit.file}:${hit.line} 规则A：凭据形状成员名「${hit.name}」未登记 allowlist`);
    else matched.add(key);
  }
  for (const entry of allowlist) {
    const key = `${entry.file}\0${entry.name}`;
    if (!entry.reason.trim()) violations.push(`allowlist 条目 ${entry.file}「${entry.name}」缺 reason`);
    if (!matched.has(key)) violations.push(`allowlist 陈旧条目：${entry.file}「${entry.name}」已无对应命中`);
  }
  for (const hit of report.providerImportHits) {
    violations.push(`${hit.file}:${hit.line} 规则B：renderer 引入 provider 客户端 ${hit.specifier}（${hit.kind}）`);
  }
  return violations;
}

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRepo(files: Record<string, string> = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), 'renderer-token-boundary-'));
  tempRoots.push(root);
  mkdirSync(path.join(root, 'src/renderer'), { recursive: true });
  mkdirSync(path.join(root, 'src/shared/ipc'), { recursive: true });
  const base: Record<string, string> = {
    'src/renderer/ok.ts': 'export const ok = 1;\n',
    'src/shared/ipc/ok.ts': 'export const ok = 1;\n',
  };
  for (const [rel, content] of Object.entries({ ...base, ...files })) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

function ruleAHits(files: Record<string, string>) {
  return scan(makeRepo(files)).credentialNameHits;
}

function ruleBHits(files: Record<string, string>) {
  return scan(makeRepo(files)).providerImportHits;
}

describe('renderer 凭据边界门（静态契约）', () => {
  it('规则A：类型成员、对象字面量键（含简写/引号键）、解构字段判红', () => {
    expect(ruleAHits({
      'src/renderer/session.ts': [
        'interface Session { accessToken: string }',
        'type Refresh = { "refresh_token"?: string };',
        'export const payload = { apiKey: 1, client_secret: 2 };',
        'const token = { accessToken };',
        'export const { refreshToken } = payload;',
        'const { apiKey: renamed } = payload;',
        '',
      ].join('\n'),
    })).toEqual([
      { file: 'src/renderer/session.ts', line: 1, name: 'accessToken' },
      { file: 'src/renderer/session.ts', line: 2, name: 'refresh_token' },
      { file: 'src/renderer/session.ts', line: 3, name: 'apiKey' },
      { file: 'src/renderer/session.ts', line: 3, name: 'client_secret' },
      { file: 'src/renderer/session.ts', line: 4, name: 'accessToken' },
      { file: 'src/renderer/session.ts', line: 5, name: 'refreshToken' },
      { file: 'src/renderer/session.ts', line: 6, name: 'apiKey' },
    ]);
  });

  it('规则A：下划线后缀段与驼峰组合（secretKey / apiKeyConfigured / githubSecret）判红，未对齐子串不判红', () => {
    expect(ruleAHits({
      'src/renderer/compound.ts': 'export const view = { secretKey: 1, apiKeyConfigured: true, githubSecret: 2, my_access_token: 3 };',
      'src/renderer/inert.ts': 'export const inert = { sentinel: 1, busecret: 2, token: 3, keyValue: 4 };',
    })).toEqual([
      { file: 'src/renderer/compound.ts', line: 1, name: 'apiKeyConfigured' },
      { file: 'src/renderer/compound.ts', line: 1, name: 'githubSecret' },
      { file: 'src/renderer/compound.ts', line: 1, name: 'my_access_token' },
      { file: 'src/renderer/compound.ts', line: 1, name: 'secretKey' },
    ]);
  });

  it('规则A：src/shared/ipc 的 IPC 返回类型同样受约束', () => {
    expect(ruleAHits({
      'src/shared/ipc/api.ts': 'export interface ChannelInfo { apiKey: string }\n',
    })).toEqual([
      { file: 'src/shared/ipc/api.ts', line: 1, name: 'apiKey' },
    ]);
  });

  it('规则A 最小口径：散文字符串与注释里的凭据词不扫', () => {
    expect(ruleAHits({
      'src/renderer/labels.ts': [
        "export const label = 'apiKey';",
        'export const hint = `client_secret 说明`;',
        '// accessToken 只会出现在注释里',
        'export const ok = 1;',
        '',
      ].join('\n'),
    })).toEqual([]);
  });

  it('规则B：renderer 引入 provider 客户端判红（import / export-from / import() / require / import 类型 / 子路径）', () => {
    expect(ruleBHits({
      'src/renderer/clients.ts': [
        "import Anthropic from '@anthropic-ai/sdk';",
        "export { Groq } from 'groq-sdk';",
        "const lazy = () => import('@supabase/supabase-js');",
        "const req = require('groq-sdk/extra');",
        "export type McpClient = import('@modelcontextprotocol/client/stdio').Client;",
        "import { useState } from 'react';",
        "import { invoke } from '@tauri-apps/api/core';",
        'export const value = { Anthropic, lazy, req, useState, invoke };',
        '',
      ].join('\n'),
    })).toEqual([
      { file: 'src/renderer/clients.ts', line: 1, kind: 'import', specifier: '@anthropic-ai/sdk' },
      { file: 'src/renderer/clients.ts', line: 2, kind: 'export-from', specifier: 'groq-sdk' },
      { file: 'src/renderer/clients.ts', line: 3, kind: 'import()', specifier: '@supabase/supabase-js' },
      { file: 'src/renderer/clients.ts', line: 4, kind: 'require()', specifier: 'groq-sdk/extra' },
      { file: 'src/renderer/clients.ts', line: 5, kind: 'import-type', specifier: '@modelcontextprotocol/client/stdio' },
    ]);
  });

  it('规则B 只约束 src/renderer；ipc 根引入 provider 客户端由规则A/架构门另行看管', () => {
    expect(ruleBHits({
      'src/shared/ipc/host.ts': "import Anthropic from '@anthropic-ai/sdk';\nexport const value = Anthropic;\n",
    })).toEqual([]);
  });

  it('allowlist 双向核对：未登记命中、陈旧条目、空 reason 都判红', () => {
    const report = scan(makeRepo({
      'src/renderer/kept.ts': 'export const view = { apiKey: 1 };\n',
    }));
    expect(boundaryViolations(report, [
      { file: 'src/renderer/kept.ts', name: 'apiKey', reason: '用户手输、只写不回显' },
      { file: 'src/renderer/kept.ts', name: 'accessToken', reason: '已不存在的命中' },
      { file: 'src/renderer/kept.ts', name: 'apiKey', reason: '  ' },
    ])).toEqual([
      'allowlist 陈旧条目：src/renderer/kept.ts「accessToken」已无对应命中',
      'allowlist 条目 src/renderer/kept.ts「apiKey」缺 reason',
    ]);
    expect(boundaryViolations(report, [
      { file: 'src/renderer/kept.ts', name: 'apiKey', reason: '用户手输入站表单，写向 host、不回显' },
    ])).toEqual([]);
  });

  it('fail-closed：扫描根不存在或根下 0 个目标源文件直接 throw', () => {
    const missingRoot = mkdtempSync(path.join(tmpdir(), 'renderer-token-boundary-'));
    tempRoots.push(missingRoot);
    mkdirSync(path.join(missingRoot, 'src/renderer'), { recursive: true });
    writeFileSync(path.join(missingRoot, 'src/renderer/ok.ts'), 'export const ok = 1;\n');
    expect(() => scan(missingRoot)).toThrow(/扫描根不存在：/);

    const emptyRoot = mkdtempSync(path.join(tmpdir(), 'renderer-token-boundary-'));
    tempRoots.push(emptyRoot);
    mkdirSync(path.join(emptyRoot, 'src/renderer'), { recursive: true });
    mkdirSync(path.join(emptyRoot, 'src/shared/ipc'), { recursive: true });
    writeFileSync(path.join(emptyRoot, 'src/renderer/ok.ts'), 'export const ok = 1;\n');
    expect(() => scan(emptyRoot)).toThrow(/扫描根下没有目标源文件：src\/shared\/ipc/);
  });

  it('真实仓库：命中全部登记（无未登记、无陈旧、无空 reason），provider 客户端零引入', () => {
    const report = scan(repoRoot);
    expect(report.fileCount).toBeGreaterThan(0);
    expect(report.perRootFileCount['src/renderer']).toBeGreaterThan(0);
    expect(report.perRootFileCount['src/shared/ipc']).toBeGreaterThan(0);
    expect(boundaryViolations(report)).toEqual([]);
  });
});

// ============================================================================
// IReadConfigService — 主进程 ConfigService 与 CLI 共享的 read-only 视图
// ============================================================================
//
// 历史背景：
// 在 4c8b5d7d 之前，CLI/webServer 走 src/cli/config.ts 的 CLIConfigService，
// Tauri main 走 src/main/services/core/configService.ts 的 ConfigService。
// 两个类各自维护 read 路径与 fallback，导致"UI 选了 A、推理走 B"事故
// （UI 显示 MiMo v2.5 Pro，webServer 实际把请求路由到 zhipu/glm-5）。
//
// 4c8b5d7d 仅对齐了文件路径（同读 ~/.code-agent/config.json），但两个类还在。
// 任何加新 getter / 新 fallback 的修改都得手动同步两边，否则同样故障会换姿势复发。
//
// 解决：抽取 read-only 接口，main ConfigService implements，CLI 直接复用 main
// ConfigService 实例（CLI 模式下 keytar 不加载，initialize 跳过 keychain 路径，
// configPath 通过 electronMock 的 app.getPath('userData') 解析到 ~/.code-agent）。
// 此后两边走同一份代码、同一份配置文件，"配置双胞胎"故障路径根除。
// ============================================================================

import type { AppSettings } from './settings';
import type { ModelProvider } from './model';

/**
 * 服务级（非模型）API Key 标识
 *
 * 与 ConfigService.getServiceApiKey 的 service 联合类型保持一致；
 * CLI 历史上仅用 langfuse_*，但接口定义按 main 完整集合，
 * 让两边复用时不需要再做类型 narrow。
 */
export type ServiceApiKey =
  | 'brave'
  | 'langfuse_public'
  | 'langfuse_secret'
  | 'github'
  | 'openrouter'
  | 'openai'
  | 'exa'
  | 'firecrawl'
  | 'perplexity'
  | 'tavily'
  | 'skillsmp';

/**
 * read-only ConfigService 视图
 *
 * 涵盖 webServer / CLI 入口在构建 ModelConfig、解析 API Key、读取设置时
 * 用到的所有 getter。main ConfigService 实现完整版（含 keychain / cloud sync
 * / budget 等），但通过此接口暴露给 CLI 时只允许读，避免 CLI 路径误触发
 * 写盘 / keychain 同步。
 */
export interface IReadConfigService {
  /** 获取完整设置（深拷贝；API Key 已从 secureStorage 注入） */
  getSettings(): AppSettings;

  /**
   * 获取 provider 的 API Key
   *
   * 优先级：secureStorage > config.json (legacy) > 环境变量
   * 找不到时返回 undefined（CLI 调用方负责 || '' fallback）
   */
  getApiKey(provider: ModelProvider): string | undefined;

  /**
   * 获取非模型类服务 API Key（Brave / Langfuse / GitHub 等）
   *
   * 优先级：secureStorage > cloud managed fallback > 环境变量
   */
  getServiceApiKey(service: ServiceApiKey): string | undefined;

  /**
   * 获取非模型类服务的可选 API Base URL。
   *
   * 目前主要给 OpenAI-compatible 搜索源使用：团队共享 key 可能来自 NewAPI 这类
   * 兼容端点，key 与 baseUrl 必须一起下发，不能误打官方 OpenAI 域名。
   */
  getServiceApiBaseUrl(service: ServiceApiKey): string | undefined;
}

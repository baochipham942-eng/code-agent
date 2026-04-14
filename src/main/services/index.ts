// ============================================================================
// Services - 服务统一导出
// ============================================================================

// Core Services - 核心服务
export * from './core';

// Auth Services - 认证服务
export * from './auth';

// Sync Services - 同步服务
export * from './sync';

// Cloud Services - 云端服务
export * from './cloud';

// Infra Services - 基础设施服务
export * from './infra';

// Lab Services - 实验室服务
export * from './lab';

// Checkpoint Services - 检查点服务
export * from './checkpoint';

// Desktop Services - 原生桌面活动 / 视觉 / 音频
// 仅 re-export 原本在根部暴露的 nativeDesktopService 部分，
// 保持与迁移前的顶层 API 兼容；其他 desktop 子模块请按路径直接 import。
export {
  NativeDesktopService,
  getNativeDesktopService,
} from './desktop/nativeDesktopService';

// NOTE: knowledge / connectors / plugins / learning / core-promptSuggestions
// 故意不在此处聚合 — 这些模块携带重下游依赖（plugins/tools/model），
// 透过顶层 barrel 暴露会引发 services ↔ tools/plugins/model 循环依赖。
// 使用方请 `import ... from '@main/services/<domain>/<file>'` 直接引用。

// Live Preview dev server 类型与协议
// V2-A devServerManager 使用，renderer / main 共享

export type Framework = 'vite' | 'next' | 'cra' | 'unknown';

export type PackageManager = 'bun' | 'pnpm' | 'yarn' | 'npm';

export interface FrameworkDetectionResult {
  framework: Framework;
  packageManager: PackageManager;
  /** 从 package.json scripts.dev 取到的命令；为空表示项目没有 dev 脚本 */
  devScript: string | null;
  /** V2-A 是否被 manager 支持启动；false 时返回 reason 给 UI 展示 */
  supported: boolean;
  reason?: string;
}

export type DevServerStatus = 'starting' | 'ready' | 'stopped' | 'failed';

export interface DevServerSession {
  sessionId: string;
  projectPath: string;
  framework: Framework;
  packageManager: PackageManager;
  status: DevServerStatus;
  /** ready 后填充；失败/未就绪时为 null */
  url: string | null;
  pid: number | null;
  startedAt: number;
  /** failed 状态时填充 */
  error?: string;
}

export interface DevServerLogEntry {
  ts: number;
  stream: 'stdout' | 'stderr';
  line: string;
}

/** package.json 探测时只读这两个字段，不需要全量类型 */
export interface PackageJsonShape {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

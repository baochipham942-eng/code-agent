/**
 * `scripts/lib/tmp-sandbox.mjs` 的类型声明——门工具链刻意保持零依赖 ESM（见 gates-local-lock.mjs
 * 同款约定），用 .d.mts 让 TS 调用方（eval-ci 等）拿到类型而不引入构建步骤。
 */

export interface CreateOwnedTmpOptions {
  /** 临时目录的父目录，缺省 os.tmpdir()；eval 的 case 级目录建在自己的数据根下。 */
  parentDir?: string;
  /** 显式覆盖 keep-tmp 判定；缺省时看 --keep-tmp 参数 / CODE_AGENT_KEEP_TMP=1。 */
  keepTmp?: boolean;
}

export interface ReleaseOwnedTmpOptions {
  /** 显式覆盖 keep-tmp 判定；缺省时看 --keep-tmp 参数 / CODE_AGENT_KEEP_TMP=1。 */
  keepTmp?: boolean;
}

/** 建目录、登记进模块内 Set、一次性注册 exit/信号钩子，返回目录路径。 */
export declare function createOwnedTmp(prefix: string, options?: CreateOwnedTmpOptions): string;

/** 正常路径主动释放：摘登记并删除；keep-tmp 生效时保留并打印路径。 */
export declare function releaseOwnedTmp(dir: string, options?: ReleaseOwnedTmpOptions): void;

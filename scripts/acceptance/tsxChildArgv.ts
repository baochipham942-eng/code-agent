import { pathToFileURL } from 'node:url';

/**
 * `--import` 必须是 file:// URL。Windows 的 ESM loader 把 `D:\…` 读成
 * scheme `d:`（ERR_UNSUPPORTED_ESM_URL_SCHEME），子进程起不来。
 * `--require` 保持文件系统路径：CommonJS require 接受它，nightly 的失败
 * 也不在这条上。
 *
 * `windows` 选择 pathToFileURL 的路径语义（Node 22.1+，本仓 Node 24）。
 * 生产传入 `process.platform === 'win32'`，两平台同一条调用。
 * POSIX 上的单测对 `D:\` 传入 true，否则反斜杠会被编成 %5C。
 */
export function assembleTsxChildArgv(
  paths: {
    preflightPath: string;
    loaderPath: string;
    childEntry: string;
  },
  childArgs: readonly string[],
  windows: boolean,
): string[] {
  return [
    '--require', paths.preflightPath,
    '--import', pathToFileURL(paths.loaderPath, { windows }).href,
    paths.childEntry,
    ...childArgs,
  ];
}

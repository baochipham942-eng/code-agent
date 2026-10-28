export function mapTauriResourcePath(entry, target) {
  if (target === 'darwin-arm64') {
    return entry;
  }
  if (target === 'darwin-x64') {
    return entry.replaceAll('darwin-arm64', 'darwin-x64');
  }
  if (target === 'win32-x64') {
    return entry
      .replaceAll('better-sqlite3/prebuilds/darwin-arm64.node', 'better-sqlite3/prebuilds/win32-x64.node')
      .replaceAll('node-pty/prebuilds/darwin-arm64', 'node-pty/prebuilds/win32-x64')
      .replaceAll('@img/sharp-darwin-arm64', '@img/sharp-win32-x64')
      .replace('@img/sharp-win32-x64/lib/**/*.node', '@img/sharp-win32-x64/lib/**/*')
      .replace(/^\.\.\/scripts\/rtk$/, '../scripts/rtk.exe')
      .replace(/^\.\.\/scripts\/uv$/, '../scripts/uv.exe')
      .replace(/^scripts\/rtk$/, 'scripts/rtk.exe')
      .replace(/^scripts\/uv$/, 'scripts/uv.exe');
  }
  throw new Error(`Unsupported Tauri resource target: ${target}`);
}

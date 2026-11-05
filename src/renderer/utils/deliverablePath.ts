// 交付物路径的统一解析与去重键规整（纯字符串操作，不碰文件系统）。
// resolveDeliverablePath：打开/发布用的真实路径拼装（原 DeliverableCardList 内同名函数原样迁出）。
// deliverableDedupeKeyPath：仅供去重键——在 resolve 语义上再做 `./` `../` 的词法清理，
// 让 `./a.html` 与同一文件的绝对路径折叠成一张卡；键只用于内部比对，不外显、不落盘。

const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/;

function isAbsoluteDeliverablePath(filePath: string): boolean {
  return filePath.startsWith('/') || WINDOWS_ABSOLUTE_PATH.test(filePath);
}

export function resolveDeliverablePath(filePath: string, workingDirectory: string | null): string {
  if (isAbsoluteDeliverablePath(filePath) || !workingDirectory) return filePath;
  return `${workingDirectory.replace(/[\\/]$/, '')}/${filePath}`;
}

// 词法规整：折叠重复分隔符、去 `.` 段，`..` 与前面的段两两抵消。绝对路径的 `..`
// 不会越过根（根上的 `..` 直接丢弃）；相对路径没有已知基准，弹空后的 `..` 原样
// 保留——不同基准的写法不许被猜成同一个文件。Windows 盘符路径先把 `\` 统一成
// `/` 再规整（盘符语境下反斜杠就是分隔符），POSIX 文件名里的 `\` 不是分隔符，不动。
function lexicalNormalizePathKey(value: string): string {
  const unified = WINDOWS_ABSOLUTE_PATH.test(value) ? value.replace(/\\/g, '/') : value;
  const drive = unified.match(/^[a-zA-Z]:/)?.[0] ?? null;
  const body = drive ? unified.slice(drive.length) : unified;
  const isUnc = !drive && body.startsWith('//');
  const isAbsolute = Boolean(drive) || body.startsWith('/');
  const prefix = drive ?? (isUnc ? '//' : isAbsolute ? '/' : '');
  const segments: string[] = [];
  for (const segment of (isUnc ? body.slice(1) : body).split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length > 0 && segments[segments.length - 1] !== '..') {
        segments.pop();
      } else if (!isAbsolute) {
        segments.push('..');
      }
      continue;
    }
    segments.push(segment);
  }
  return prefix + segments.join('/');
}

// 去重键：已知工作目录时把相对路径锚到它——`./report.html`、`report.html` 与该文件
// 的绝对路径得到同一个键；未知工作目录时相对路径只做词法清理、不加前缀——
// `./a.html` 与 `a.html` 仍折叠，绝对路径与相对路径保持分离（不猜基准）。
export function deliverableDedupeKeyPath(filePath: string, workingDirectory: string | null | undefined): string {
  if (!filePath) return filePath;
  if (!isAbsoluteDeliverablePath(filePath) && workingDirectory) {
    return lexicalNormalizePathKey(`${workingDirectory.replace(/[\\/]$/, '')}/${filePath}`);
  }
  return lexicalNormalizePathKey(filePath);
}

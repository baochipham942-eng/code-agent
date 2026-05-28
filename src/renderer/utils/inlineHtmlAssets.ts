// ============================================================================
// inlineHtmlAssets - 把 HTML 里同目录(相对路径)的 <link>/<script src> 内联进来
//
// 背景：PreviewPanel 用 <iframe srcDoc={html}> 渲染产物。srcdoc iframe 没有文档
// URL 基准，相对引用 href="style.css" 会解析到 app 自身 origin(localhost:8180)
// → 404 → 多文件产物预览丢样式、丢脚本。这里在渲染前把相对的 css/js 读出来内联，
// 让 todo-app 这类 HTML+CSS+JS 分文件产物能正常预览。只用于预览渲染，不改写盘内容。
// ============================================================================

function isExternalRef(url: string): boolean {
  const u = url.trim();
  return (
    u === '' ||
    /^[a-z][a-z0-9+.-]*:/i.test(u) || // http:, https:, data:, blob: ...
    u.startsWith('//') ||
    u.startsWith('/') || // 绝对路径不按产物同目录解析
    u.startsWith('#')
  );
}

// 把相对路径基于 HTML 文件所在目录解析成绝对路径（处理 ./ 和 ../）。
function resolveRelative(fileDir: string, rel: string): string {
  const stack = fileDir.replace(/\/+$/, '').split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (stack.length > 1) stack.pop();
    } else {
      stack.push(seg);
    }
  }
  return stack.join('/');
}

/**
 * 内联 HTML 中相对引用的样式表与脚本。
 * @param html      原始 HTML 内容
 * @param fileDir   该 HTML 文件所在目录（绝对路径）
 * @param readText  读取同目录文件文本的函数（失败时抛错，对应引用会原样保留）
 */
export async function inlineHtmlAssets(
  html: string,
  fileDir: string,
  readText: (absPath: string) => Promise<string>,
): Promise<string> {
  if (!fileDir) return html;
  let out = html;

  // 1) <link rel="stylesheet" href="relative.css"> → <style>…</style>
  const linkTags = out.match(/<link\b[^>]*>/gi) || [];
  for (const tag of linkTags) {
    if (!/rel\s*=\s*["']?\s*stylesheet/i.test(tag)) continue;
    const href = tag.match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!href || isExternalRef(href)) continue;
    try {
      const css = await readText(resolveRelative(fileDir, href));
      // 用函数替换避免 css 里的 $ 被当成替换模式
      out = out.replace(tag, () => `<style data-inlined-from="${href}">\n${css}\n</style>`);
    } catch {
      /* 读不到就原样保留该 <link> */
    }
  }

  // 2) <script src="relative.js"></script> → <script>…</script>（保留 type）
  const scriptTags = out.match(/<script\b[^>]*\bsrc\s*=\s*["'][^"']+["'][^>]*>\s*<\/script>/gi) || [];
  for (const tag of scriptTags) {
    const src = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!src || isExternalRef(src)) continue;
    try {
      const js = await readText(resolveRelative(fileDir, src));
      const type = tag.match(/\btype\s*=\s*["']([^"']+)["']/i)?.[1];
      const typeAttr = type ? ` type="${type}"` : '';
      out = out.replace(tag, () => `<script${typeAttr} data-inlined-from="${src}">\n${js}\n</script>`);
    } catch {
      /* 读不到就原样保留该 <script src> */
    }
  }

  return out;
}

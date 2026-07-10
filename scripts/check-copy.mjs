#!/usr/bin/env node
// ============================================================================
// check-copy — 文案 lint 门（maka check-copy 同款，A2 借鉴项）
// ============================================================================
//
// 规则（作用于「字符串字面量 + JSX 文本节点里的中文文案」，注释先剥掉再匹配——
// maka #663 教训：纯文本 ban 不剥注释，上线 3 分钟被自己的解释注释绊倒崩 main。
// JSX 文本按启发式收集：code 态里含 CJK 的连续文本块即视为用户可见文案，
// 合法 TS/TSX 中非字符串非注释位置出现中文只可能是 JSX 文本——CJK 标识符本仓不用）：
//   1. pressure-word : 营销压力词禁用（轻松/一键/只需/立即体验）。棘轮基线，只拦新增。
//   2. ellipsis      : 中文串里的 "..." 必须写省略号 "…"。棘轮基线，只拦新增。
//   3. jargon        : 工程黑话裸露给用户 —— 只报 warning 列清单，不拦（判断类留人工）。
//
// 豁免：违规所在行带 `// copy-allow: <理由>` 注释。
// 扫描面：src/renderer/**/*.{ts,tsx}（i18n locale 文件 + 组件内联中文串 + JSX 文本都在内），
//         排除 tests/**、*.test.*、*.d.ts。
//
// 棘轮（与 console-scan / knip-ratchet 同构）：命中数 <= 基线通过；清理后手动调小（只降不升）。
//
// 用法：node scripts/check-copy.mjs [扫描根，默认 src/renderer]

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

// 基线上限。2026-07-10 存量（压力词 13 / 省略号 99）已全部清零，棘轮转硬闸：
// 任何新增违规直接拦，豁免走行内 // copy-allow: <理由>。
// 同日二轮：口径补上 JSX 文本节点（原先只扫字符串字面量是盲区），
// 补扫出的存量（压力词 6 / 省略号 39）已一并清零，基线仍为 0。
export const PRESSURE_BASELINE_MAX = 0;
export const ELLIPSIS_BASELINE_MAX = 0;

export const ALLOW_COMMENT = 'copy-allow:';

// 营销压力词（对 cowork 非程序员用户构成行动压力/夸大承诺的措辞）。
// 词表按 Neo 文案实情起步，扩词须重测基线。
export const PRESSURE_WORDS = ['轻松', '一键', '只需', '立即体验'];

// 工程黑话（裸露给用户时体验差，但存在合法技术语境 → 只 warning 不拦）
export const JARGON_WORDS = ['幂等', '序列化', '反序列化', '单一真源', '落库', '死锁', '脏数据'];

const CJK_RE = /[一-鿿]/;
const ELLIPSIS_RE = /\.{3}/;

// ---------------------------------------------------------------------------
// 迷你词法器：剥注释 + 提取字符串字面量（' " ` 三种，含模板串 ${} 嵌套）
// + code 态含 CJK 的文本块（= JSX 文本节点，见头注启发式说明）。
// 正则字面量按「前一个有效字符」启发式识别并整体跳过（regex 里的引号/斜杠
// 否则会打开幻影字符串，把后续代码当文案捕获——实测 modelStrategyRecommendation.ts 中招）。
// ponytail: 启发式覆盖不了除法 vs regex 的全部歧义，剩余误判只会漏/多捕一段
// 垃圾串，垃圾串几乎不可能同时含中文+违规词；真解析需完整 lexer。
// ---------------------------------------------------------------------------
// regex 字面量可出现的上文尾字符（运算符/分隔符/关键字尾），其余按除法处理。
// `<` 故意不在类里：TSX 中 `</tag>` 的 `/` 前一字符正是 `<`，进类会把闭合标签
// 当 regex 开头、吞掉同行后续 JSX 文本（实测 PreferenceStage.tsx 漏检）；
// `x < /re/.test()` 这种真 regex 场景罕见到可忽略。
const REGEX_PRECEDER_RE = /(?:^|[(,=:[!&|?{};+\-*%>~^]|\breturn|\btypeof|\bcase|\bin|\bof|\bnew|\bdo|\belse|\bvoid|\bdelete|\byield|\bawait)\s*$/;

// code 态文本块的切分符：JSX 表达式/标签边界 + spread(... 必跟在 ( , [ { 后)的前导符。
// 切分越细，含 CJK 的块越贴近纯文案，`{...props}`/`[...xs]` 等 spread 永远落在无 CJK 块里不误报。
const CODE_CHUNK_DELIM_RE = /[<>{}()[\],;\n]/;

export function extractStrings(source) {
  const out = [];
  const stack = []; // 模板串 ${} 插值帧：{ braceDepth, buf, bufLine, startLine }
  let state = 'code';
  let i = 0;
  let line = 1;
  let buf = '';
  let bufLine = 0;
  let codeTail = ''; // code 态最近的非空白字符尾巴（regex 启发式用，保留 8 个字符够判关键字）
  let codeChunk = ''; // code 态当前文本块（JSX 文本捕获用）
  let codeChunkLine = 0;
  const flushCodeChunk = () => {
    if (CJK_RE.test(codeChunk)) out.push({ value: codeChunk, line: codeChunkLine });
    codeChunk = '';
  };
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '\n') line++;
    if (state === 'code') {
      if (ch === '/' && next === '/') { flushCodeChunk(); state = 'lineComment'; i += 2; continue; }
      if (ch === '/' && next === '*') { flushCodeChunk(); state = 'blockComment'; i += 2; continue; }
      if (ch === '/' && REGEX_PRECEDER_RE.test(codeTail)) {
        flushCodeChunk();
        // regex 字面量：跳到未转义的闭合 /（字符类 [...] 内的 / 不算闭合），换行止损
        let j = i + 1;
        let inClass = false;
        while (j < source.length) {
          const rc = source[j];
          if (rc === '\\') { j += 2; continue; }
          if (rc === '\n') break;
          if (rc === '[') inClass = true;
          else if (rc === ']') inClass = false;
          else if (rc === '/' && !inClass) { j++; break; }
          j++;
        }
        i = j;
        codeTail = '';
        continue;
      }
      if (ch === "'") { flushCodeChunk(); state = 'squote'; buf = ''; bufLine = line; i++; continue; }
      if (ch === '"') { flushCodeChunk(); state = 'dquote'; buf = ''; bufLine = line; i++; continue; }
      if (ch === '`') { flushCodeChunk(); state = 'template'; buf = ''; bufLine = line; i++; continue; }
      if (stack.length > 0) {
        const top = stack[stack.length - 1];
        if (ch === '{') top.braceDepth++;
        else if (ch === '}') {
          if (top.braceDepth === 0) {
            flushCodeChunk();
            stack.pop();
            state = 'template';
            // 按插值实际消费的换行数补占位，保持后续 segment 行号精确
            // （同行插值补 0 个换行，跨 N 行插值补 N 个——否则 copy-allow 豁免错行失效/误豁免）；
            // 同行插值用空格占位，防止插值两侧文案拼接出幻影违规词
            buf = top.buf + (line > top.startLine ? '\n'.repeat(line - top.startLine) : ' ');
            bufLine = top.bufLine;
            i++;
            continue;
          }
          top.braceDepth--;
        }
      }
      if (CODE_CHUNK_DELIM_RE.test(ch)) {
        flushCodeChunk();
      } else {
        if (codeChunk === '') codeChunkLine = line;
        codeChunk += ch;
      }
      codeTail = (codeTail + (ch === '\n' ? ' ' : ch)).slice(-12);
      i++;
      continue;
    }
    if (state === 'lineComment') {
      if (ch === '\n') state = 'code';
      i++;
      continue;
    }
    if (state === 'blockComment') {
      if (ch === '*' && next === '/') { state = 'code'; i += 2; continue; }
      i++;
      continue;
    }
    if (state === 'squote' || state === 'dquote') {
      const quote = state === 'squote' ? "'" : '"';
      if (ch === '\\') {
        if (next === '\n') line++;
        buf += next ?? '';
        i += 2;
        continue;
      }
      if (ch === quote) { out.push({ value: buf, line: bufLine }); state = 'code'; codeTail = ')'; i++; continue; }
      if (ch === '\n') { state = 'code'; i++; continue; } // 未闭合串，止损
      buf += ch;
      i++;
      continue;
    }
    // state === 'template'
    if (ch === '\\') {
      if (next === '\n') line++;
      buf += next ?? '';
      i += 2;
      continue;
    }
    if (ch === '`') { out.push({ value: buf, line: bufLine }); state = 'code'; codeTail = ')'; i++; continue; }
    if (ch === '$' && next === '{') {
      stack.push({ braceDepth: 0, buf, bufLine, startLine: line });
      buf = '';
      state = 'code';
      codeTail = '('; // 插值开头允许直接跟 regex 字面量
      i += 2;
      continue;
    }
    buf += ch;
    i++;
    continue;
  }
  if (state === 'code') flushCodeChunk();
  return out;
}

// ---------------------------------------------------------------------------
// 扫描
// ---------------------------------------------------------------------------
const sourceExtensions = new Set(['.ts', '.tsx']);

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function isExcluded(filePath) {
  const posix = toPosix(filePath);
  return (
    posix.includes('/node_modules/') ||
    posix.includes('/tests/') ||
    posix.endsWith('.test.ts') ||
    posix.endsWith('.test.tsx') ||
    posix.endsWith('.d.ts')
  );
}

function walk(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walk(full, acc);
    } else if (entry.isFile() && sourceExtensions.has(path.extname(entry.name))) {
      if (!isExcluded(full)) acc.push(full);
    }
  }
}

export function scanCopy(rootDir) {
  const root = path.resolve(rootDir ?? path.join(repoRoot, 'src/renderer'));
  const files = [];
  if (fs.existsSync(root)) {
    const stat = fs.statSync(root);
    if (stat.isDirectory()) walk(root, files);
    else if (stat.isFile()) files.push(root);
  }
  // 自检：扫到 0 个文件 = 门在空转（目录改名后静默恒绿），fail loud
  if (files.length === 0) {
    throw new Error(`[check-copy] 自检失败：扫描根 ${root} 不存在或匹配 0 个源文件。若目录结构调整过，请同步更新本脚本。`);
  }

  const violations = { 'pressure-word': [], ellipsis: [] };
  const warnings = { jargon: [] };

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf-8');
    const rawLines = source.split('\n');
    const rel = toPosix(path.relative(repoRoot, file));
    for (const str of extractStrings(source)) {
      // 多行模板串逐物理行检查，行号 = 起始行 + 偏移
      str.value.split('\n').forEach((segment, offset) => {
        if (!CJK_RE.test(segment)) return;
        const lineNo = str.line + offset;
        const rawLine = rawLines[lineNo - 1] ?? '';
        if (rawLine.includes(ALLOW_COMMENT)) return;
        const loc = `${rel}:${lineNo}`;
        for (const word of PRESSURE_WORDS) {
          if (segment.includes(word)) violations['pressure-word'].push(`${loc}\t「${word}」\t${segment.trim().slice(0, 60)}`);
        }
        if (ELLIPSIS_RE.test(segment)) violations.ellipsis.push(`${loc}\t${segment.trim().slice(0, 60)}`);
        for (const word of JARGON_WORDS) {
          if (segment.includes(word)) warnings.jargon.push(`${loc}\t「${word}」\t${segment.trim().slice(0, 60)}`);
        }
      });
    }
  }
  return { violations, warnings, fileCount: files.length };
}

// ---------------------------------------------------------------------------
// CLI（被 import 时不执行）
// ---------------------------------------------------------------------------
if (process.argv[1] && process.argv[1].endsWith('check-copy.mjs')) {
  const { violations, warnings, fileCount } = scanCopy(process.argv[2]);
  const gates = [
    { rule: 'pressure-word', hits: violations['pressure-word'], max: PRESSURE_BASELINE_MAX, hint: '换成陈述式措辞（如「一键安装」→「安装全部」），或加 // copy-allow: 理由' },
    { rule: 'ellipsis', hits: violations.ellipsis, max: ELLIPSIS_BASELINE_MAX, hint: '中文串用省略号 …（U+2026），不用三个点' },
  ];

  let failed = false;
  console.log(`[check-copy] 扫描 ${fileCount} 个文件`);
  for (const g of gates) {
    const count = g.hits.length;
    if (count > g.max) {
      failed = true;
      console.error(`[check-copy] ✗ [${g.rule}] 命中 ${count} 处 > 基线 ${g.max}（+${count - g.max}）。${g.hint}`);
      for (const v of g.hits.slice(0, 30)) console.error(`  ${v}`);
      if (g.hits.length > 30) console.error(`  …以及另外 ${g.hits.length - 30} 处`);
    } else if (count < g.max) {
      console.log(`[check-copy] ✓ [${g.rule}] ${count} 处，低于基线 ${g.max} —— 可把脚本里的基线调小到 ${count} 收紧棘轮`);
    } else {
      console.log(`[check-copy] = [${g.rule}] 守住基线 ${g.max}，通过（未新增）`);
    }
  }

  if (warnings.jargon.length > 0) {
    console.log(`[check-copy] ⚠ [jargon] 工程黑话裸露给用户 ${warnings.jargon.length} 处（不拦，请人工判断措辞）：`);
    for (const w of warnings.jargon.slice(0, 30)) console.log(`  ${w}`);
  }

  if (failed) {
    console.error('\n[check-copy] 文案门失败：禁止引入超出基线的新违规。');
    process.exit(1);
  }
  console.log('\n[check-copy] ✓ 文案门通过');
}

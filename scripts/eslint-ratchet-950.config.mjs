// 950-tier 专用最小 flat config（eslint-ratchet.mjs 第二遍 eslint 用）。
// 只开 max-lines、不带 parserOptions.project：纯行数计数不需要 TS 类型信息，
// 计数与主配置逐文件一致（N-MAXLINES-MINEFIELD-2 实测对照 99 处 max-lines 全等），
// 但跳过 TS program 构建，单遍 ~13s（类型感知遍 ~2min）。
//
// 文件面必须与主 eslint.config.js 对 `src` 的扫描面**完全一致**（ratchet 里有
// 文件数守卫，漂移即 fail loud）：ESLint 10 已不认 `--ext`，目录展开会带上默认
// JS 扩展，所以这里要镜像主配置的两处特例——ppt __tests__ 的 .mjs 忽略项、
// webServerBootstrap.cjs 的 CommonJS 块。主配置改这两处时同步改这里。
// max-lines 白名单在这里**有意不存在**：CLI/本配置的规则会盖掉 off，白名单由
// eslint-ratchet.mjs 读主配置后在 JS 侧排除。
import tseslint from 'typescript-eslint';

const maxLines = ['error', { max: 949, skipBlankLines: true, skipComments: true }];

export default [
  {
    ignores: ['src/host/tools/media/ppt/__tests__/**/*.mjs'],
  },
  {
    files: ['src/web/webServerBootstrap.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
    },
    rules: {
      'max-lines': maxLines,
    },
  },
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      'max-lines': maxLines,
    },
  },
];

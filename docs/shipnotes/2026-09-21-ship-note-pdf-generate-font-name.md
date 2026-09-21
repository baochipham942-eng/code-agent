# Ship note · 2026-09-21 · pdf_generate academic 主题字体名修复（issue #1996）

## 根因

`src/host/tools/modules/network/pdfGenerate.ts` 的主题表用 `fontFamily + '-Bold'` / `fontFamily + '-Oblique'` 拼粗体/斜体名。academic 主题 fontFamily 是 `Times-Roman`，拼出的 `Times-Roman-Bold` / `Times-Roman-Oblique` 都不是 PDF 标准 14 字体的合法名（正确名是 `Times-Bold` / `Times-Italic`）。pdfkit 的 `PDFFontFactory.open` 对任何非标准字体名一律当文件路径走 `fs.readFileSync(src)`。

esbuild bundle（cli/web 两个 target）里 pdfkit 被 alias 到 `pdfkit/js/pdfkit.standalone.js`，该 standalone 构建内部模块表把 `fs` 映射到 browserify 空垫片（`{}`），于是 `fs.readFileSync` 不存在，抛 `m.readFileSync is not a function`（`m` 是 minify 后的变量名）；未打包环境同一行则是 `ENOENT`。夜跑 2026-09-20 证据 13 次 / 7 会话全是这个串。工单假设的「工具自身 fs import 被 interop 改坏」不成立——`pdfGenerate.ts` 的 `import * as fs from 'fs'` 在 bundle 后正常，出错的是 pdfkit standalone 内部的垫片 fs，触发条件是非法字体名。

## 修法

`ThemeConfig` 增加显式 `boldFont` / `obliqueFont` 字段，三个主题全部写真实存在的标准 14 字体名（Helvetica→Helvetica-Bold/Helvetica-Oblique，Times-Roman→Times-Bold/Times-Italic），删除字符串拼接。字体名合法性由真实 pdfkit 渲染路径在测试里钉死。

## 反向变异

1. `git stash push -- src/host/tools/modules/network/pdfGenerate.ts` 后跑
   `npx vitest run tests/unit/tools/modules/network/pdfGenerate.real.test.ts`：
   academic 用例红（`PDF 生成失败: ENOENT: no such file or directory, open 'Times-Roman-Bold'`），
   default/minimal 绿；stash pop 后 3/3 绿。
2. 用生产同款配置（esbuild minify + `alias: pdfkit→pdfkit/js/pdfkit.standalone.js`）打最小 bundle
   直调 `executePdfGenerate`：修复前 academic 复现原错
   `PDF 生成失败: w.readFileSync is not a function`（变量名随 build 变化，与工单 `m.` 同形），
   修复后 default/academic/minimal 三主题全部 OK 并产出真实 PDF。

## 测试证据

- 新增 `tests/unit/tools/modules/network/pdfGenerate.real.test.ts`：不 mock pdfkit/fs，真实渲染
  全 3 主题 × 全 block 类型（标题/正文/有序无序列表/引用/代码），断言产出文件以 `%PDF-` 开头、
  大小与 metadata 一致。既有 `pdfGenerate.test.ts`（mock 版 16 例）未动。
- `npx vitest run tests/unit/tools/modules/network/pdfGenerate.real.test.ts tests/unit/tools/modules/network/pdfGenerate.test.ts tests/unit/tools/modules/network/pdfAutomate.test.ts`：41/41 通过。
- `npm run typecheck`：通过。
- `npm run gates:fast -- --regressions <json>`：通过（pdfGenerate.ts 不在规则表内，手工回归声明见 PR 描述）。

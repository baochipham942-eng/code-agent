# 魔搭 Skill 源后端批交付报告

日期：2026-07-27  
分支：`feat/skill-source-multiorigin`  
基点：`d2b3c0e6528ae5794a09f0d25bab5e8526374bf3`

## 改动清单

### L1 多源解析、下载与更新

- 新增 `parseRepoUrl`，统一解析 GitHub 和 ModelScope：
  - GitHub 保留原有完整 URL、`tree/<branch>`、无协议 URL、`owner/repo` 短格式。
  - ModelScope 支持仓库根 URL、`/models/<namespace>/<name>`、`/skills/@<namespace>/<name>` 及已验证的页面后缀。
  - 对协议、域名、凭据、端口、编码路径穿透和畸形 segment 做拒绝处理。
- ModelScope 下载采用两级策略：
  1. `git clone --depth 1 --branch <branch> https://www.modelscope.cn/<namespace>/<name>.git`
  2. clone 失败后回退 `/api/v1/{models|skills}/.../archive/zip/<revision>`
- clone 成功后读取 commit 并剥离 `.git`；archive 回退通过 repo files API 解析最新 commit。
- `.meta.json` 增加 `source`，旧 meta 缺字段时按 `github` 读取；ModelScope 额外记录仓库类型，供更新与 archive 路由使用。
- `checkForUpdates` 对 ModelScope 先执行 `git ls-remote <clone-url> HEAD`，skill archive-only 仓库再回退 repo API；`updateRepository` 按 meta source 重新下载。
- 删除无生产消费者的 URL 解析内部类型导出，dead-export 棘轮无新增。

### L1.5 包结构自动探测

- 新增统一布局探测：
  1. 根目录 `SKILL.md`：`single-skill`
  2. `skills/*/SKILL.md`：`library`，`skillsPath=skills`
  3. 一级子目录 `*/SKILL.md`：`library`，`skillsPath=.`
  4. 无命中：明确报错 `No SKILL.md found in repository`
- GitHub 与 ModelScope 均保留完整仓库根目录，下载后再探测布局。
- 单 skill 仓库按根目录解析；library 按探测出的直接子目录扫描。
- 探测结果回写仓库配置和 `.meta.json`，更新与重启扫描继续使用相同语义。

### L3 staged 安装 IPC

- 新增共享契约：
  - `SkillRepoSourceType`
  - `StagedSkillPreview`
  - `StageRepositoryResult`
- 新增 IPC：
  - `skill:repo:stage`
  - `skill:repo:confirm`
  - `skill:repo:cancel`
- stage：
  - 下载到 `skills/.staging/<stageId>`
  - 探测布局、解析所有 skill、返回完整 `SKILL.md`
  - 不写 `skill-config.json`，不加入正式 libraries
- confirm：
  - repoId 或正式目录冲突时拒绝，不覆盖
  - 同文件系统 `rename` 原子迁移到 `skills/<repoId>`
  - 迁移后写配置并注册 library
- cancel：删除对应 staging 目录。
- initialize：清空上次进程遗留的 `.staging` 孤儿目录。
- 原有 `addCustomRepository` IPC 保持可用。

## 提交记录

1. `a8ff19393` `feat(skills): support ModelScope repository sources`
2. `6b7e668df` `feat(skills): detect repository package layouts`
3. `787c911f0` `feat(skills): add staged repository install IPC`
4. `bd0c8488d` `test(skills): cover multi-source staged installs`
5. `1fe1f1ab1` `fix(skills): keep repository parser types internal`

## 门运行结果

| 门 | 结果 |
|---|---|
| `npm run typecheck` | PASS，0 errors |
| `npm run --silent lint -- --format json` | PASS，2827 files，0 errors，425 warnings，1 fixable warning；与基线持平 |
| 新增单测 | PASS，3 files / 24 tests |
| URL 解析单测复跑 | PASS，18 tests |
| `node scripts/knip-ratchet.mjs` | PASS，2692 / 2692，无新增 dead exports/types |
| `node scripts/knip-production-ratchet.mjs` | PASS，67 / 67，无新增生产不可达文件 |
| `git diff --check origin/main...HEAD` | PASS |

新增单测文件：

- `tests/unit/services/skills/gitDownloader.parseRepoUrl.test.ts`
- `tests/unit/services/skills/skillRepositoryLayout.test.ts`
- `tests/unit/services/skills/skillRepositoryStaging.test.ts`

说明：

- Vitest 首次在 sandbox 内因共享 `node_modules/.vite-temp` 无写权限启动失败；获准写该测试临时目录后，最终测试全绿。
- knip 首次被 `~/.npm` cache 权限阻断；改用隔离的 `/tmp/modelscope-knip-npm-cache` 后两道棘轮通过，未修改用户 npm 目录。

## 变异验证记录

### URL 解析变异

- 临时变异：把 `/skills/...` 的 `repoType` 从 `skill` 改成 `model`。
- 结果：URL 测试 2 failed / 16 passed，两个 ModelScope skill 页面形态均准确打红。
- 恢复后：18 / 18 passed。

### 布局探测变异

- 临时变异：把根目录存在 `SKILL.md` 的结果从 `single-skill` 改成 `library`。
- 结果：布局测试 1 failed / 3 passed，根目录单 skill 用例准确打红。
- 恢复后：4 / 4 passed。

两处变异均已恢复，未进入提交；变异点也记录在测试提交 `bd0c8488d` 的 commit body。

## 真实 ModelScope 证词

### URL / clone 模式实证

- `git ls-remote --symref https://www.modelscope.cn/ms-agent/skill_examples.git HEAD`
  - 默认分支：`master`
  - HEAD：`859cd00021c647b3f82c0cea73db6ca940bb2fd5`
- `git clone --depth 1 https://www.modelscope.cn/ms-agent/skill_examples.git`
  - 成功
  - 一级子目录发现 3 个 skill：`creating-financial-models`、`pdf`、`algorithmic-art`
- `/skills/@halcyon666/write-skills` 对应的普通 clone URL实测返回 not found；回退接口
  `/api/v1/skills/@halcyon666/write-skills/archive/zip/master` 返回有效 ZIP。

### 真实 stage → confirm

隔离目录：`/tmp/modelscope-stage-runtime.f2yCzW`  
源：`https://www.modelscope.cn/skills/@halcyon666/write-skills`

stage：

- `success=true`
- `stageId=24e2e53b-7244-45a3-b5f4-5b6e415110fb`
- `repoId=halcyon666-write-skills`
- `sourceType=modelscope`
- `layout=single-skill`
- `skillCount=1`
- `skillNames=["write-skills"]`
- 完整 `SKILL.md` 长度：9012 字符
- stage 后 `skill-config.json` 不存在
- stage 后正式 libraries 数：0
- archive commit：`85d7976865dd4874b03da1214f65394418ec6bad`

confirm：

- `success=true`
- `repoId=halcyon666-write-skills`
- `skillCount=1`
- `skillNames=["write-skills"]`
- 正式 libraries 数：1
- 正式路径：`/tmp/modelscope-stage-runtime.f2yCzW/skills/halcyon666-write-skills`
- 配置已注册该 repo，staging 目录已迁出。

## 遗留事项

- UI / renderer 装前预览界面不在本批范围，未修改。
- 未 push、未开 PR、未改 main。
- 后端范围内无已知阻塞项。

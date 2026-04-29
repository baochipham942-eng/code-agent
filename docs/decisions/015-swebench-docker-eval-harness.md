# ADR-015: SWE-bench docker-based eval harness

> 状态: accepted
> 日期: 2026-04-29

## 背景

`docs/decisions/005-eval-engineering.md` 记录了 Excel benchmark 时代的内部评测体系（v3 → v32，132 → 164 分）。这套体系的根本局限：
- 评测内容是项目自定义 case（117 个 mock 断言），业界不认这个数字
- 评分靠"我亲自看每个输出"，主观且无 ground truth
- LLM-as-Judge（SwissCheese 4 reviewer）只评 chat agent 会话质量，不评编程任务的"真测是否通过"

要拿到**业界对齐、可写简历、能跟 OpenAI/Anthropic/Aider 数据直接对比的数字**，必须接业界标准的 SWE-bench Verified harness。但接入面临三个工程问题：
1. 500 case 涉及 12 个 repo + 不同 Python/依赖版本，本地不可能装齐
2. SWE-bench 官方提供 docker image 但每个 instance 一个 ~4GB image，磁盘紧
3. 需要把"agent 改完代码"这一步嵌入 SWE-bench 的"apply test_patch + 跑 FAIL_TO_PASS"流程

## 决策

搭建独立的 SWE-bench docker harness（`eval/swe-bench/`），**不污染 chat agent 主链路**，与产品代码完全解耦。

### D1: 容器运行时 — colima 而非 Docker Desktop

`brew install colima docker` 命令行装好 4GB ARM VM，跟 Docker CLI 100% 兼容。原因：
- Docker Desktop 需 GUI 接受 license，CI/自动化不友好
- colima `--cpu 4 --memory 4 --disk 20` 可控
- 共享 docker layer：5 个 SWE-bench image 报告各 4GB，实际 disk 只占 ~5GB（base + env layer 共享）

### D2: 双层 executable validation 路径

`validation.ts` 提供两个互斥实现：
- `runExecutableValidation(sandboxRoot, ...)`：本地 Python + Django runtests.py（fallback，兼容老路径）
- `runExecutableValidationDocker(instanceId, ...)`：docker run SWE-bench 官方 image（默认）

CLI 支持 `--mode docker | python`，**默认 docker**。本地 Python 路径在 Python 3.13+ 上跑不动 Django 2.2（cgi 模块移除），只用作 fallback。

### D3: Test label 三级 fallback 推断

SWE-bench 的 `FAIL_TO_PASS` 字段格式不统一——有 dotted path（`method (module.Class)`），也有自然语言描述（`"settings.FIXTURE_DIRS cannot contain..."`）。需要按优先级 fallback：

| 级 | 来源 | 适用 |
|---|------|------|
| 1 | `FAIL_TO_PASS` 标准格式 `method (module.Class)` | 大部分 django case |
| 2 | `test_patch` hunks 推 method + class（hunk header / 上下文行） | FAIL_TO_PASS 是描述性的 case（如 16642） |
| 3 | 跑整个 `<module>` | 极端兜底 |

实现：`buildDjangoTestLabelsFromPatchOnly(testPatch, failToPass)`。

### D4: Judge × Executable 决策融合 — executable 优先

`decideRunOutcome` 不再用 AND 拒绝逻辑。新口径：

```
if executable.passed:  return PASSED                  # 真测是 ground truth
if executable.failed:  return FAILED + reasons         # 真测失败即真败
if executable.skipped/error:                          # 真测缺席时 fallback
    return PASSED if (judge >= 70 and !impl_mismatch and shape_passed)
            else FAILED + reasons
```

驱动场景：django-15987 case agent 在不同位置做了等价修复，judge 给 30 分（认为不等价），docker 真测 PASS。如果信 judge 会误杀。

### D5: LLM-as-Judge 用 DeepSeek 而非 mimo / Claude

`patchEquivalence.ts` 用 DeepSeek-chat（独立于被评 mimo 模型）：
- 避免被评 mimo 自评偏差
- 国内 API 免代理，零成本（~10 次调用约 ¥0.05）
- 在 patch 语义对比上够用

### D6: SWE-bench instance image 命名规则 — `<repo>_<numeric_id>_<instance>`

实测 docker hub 的 swebench/ 命名为 `swebench/sweb.eval.x86_64.django_1776_django-10880` 而非 instance_id 直接命名。numeric_id 是 SWE-bench 内部对每个 repo 的固定 ID（django=1776）。维护 `REPO_NUMERIC_ID` 映射，新 repo 按需扩。

## 选项考虑

### B vs C — 本地 Python (legacy-cgi) vs docker

| 路径 | 时间 | 真 e2e 程度 |
|------|------|-----------|
| C-lite: pip install legacy-cgi 给 Python 3.14 打补丁 | 5 秒 | 可能撞下一个 deprecation（imp/distutils） |
| C-pyenv: pyenv + Python 3.7 | 30 min | Django 2.2 在 3.7 跑得动，但 SWE-bench 12 repo 跨版本仍踩坑 |
| **C-docker（已采用）** | 1-2 hr 首次 | 100% 业界标准 |

C-docker 的"求职作品集硬通货"价值压倒短期工程成本。

### Docker Desktop vs colima vs OrbStack

- Docker Desktop: GUI 需 license，ARM Mac 上 amd64 emulation 慢
- OrbStack: 付费，速度好但锁定平台
- **colima（已采用）**: CLI 全自动 + 跟 docker hub image 100% 兼容 + 免费

## 后果

### 积极

- **业界对齐数字**：mimo-v2.5-pro 在 SWE-bench Verified Django <15min 子集 10 case 上跑出 9/10 = 90% first-shot pass rate（详见 `docs/knowledge/eval-tracking.md`）
- **架构解耦**：`eval/swe-bench/` 独立子树，不污染产品代码，可独立演化
- **多层证据**：每个 run 落盘 `agent.diff` + `standard.patch` + `result.json`（含 judge + executable 双层结果），可追溯
- **修了一个评测体系长期 bug**：原 `decideRunOutcome` 用 AND 逻辑会让 judge 30 分否决 docker PASS 的 case，本次改成 executable 优先

### 消极

- **磁盘门槛**：单 case ~4GB image（共享后增量 ~100MB），跑 50 case 子集要 ~25GB 余量
- **arm64 emulation 慢**：M 系列 Mac 跑 x86_64 image 通过 qemu，docker test 比原生慢 2-3x（但 Django test 跑 1 个 ~5s 还能接受）
- **REPO_NUMERIC_ID 维护负担**：每加新 repo 要查 docker hub 命名，目前只有 django

### 风险

- **SWE-bench 设计陷阱**：部分 case 的 test 是按 maintainer 实际 commit 写的，agent 跟着 problem_statement 提示给的"works" 方案修反而 fail（如 django-10999）。这是 SWE-bench 本身的局限，不是 agent 的错。报数字时要诚实标注子集
- **judge 过严**：在"位置不同但功能等价"的修复（如 django-15987）会判低分。executable 优先策略已部分缓解，但 executable skipped 时仍可能误杀
- **agent loop 在难 case 上自我验证陷死循环**（如 16642 旧版跑满 15 轮没 finish）。已通过 system prompt 加"不要瞎编 / 不要陷死循环"提示部分缓解

## 相关文档

- [docs/knowledge/eval-tracking.md](../knowledge/eval-tracking.md) — 2026-04-29 SWE-bench 跑分记录
- [docs/decisions/005-eval-engineering.md](005-eval-engineering.md) — Excel benchmark 时代的内部评测体系
- [eval/swe-bench/validation.ts](../../eval/swe-bench/validation.ts) — docker + 本地 Python 双路径
- [eval/swe-bench/run-one-case.ts](../../eval/swe-bench/run-one-case.ts) — agent runner
- [eval/swe-bench/judges/patchEquivalence.ts](../../eval/swe-bench/judges/patchEquivalence.ts) — DeepSeek judge

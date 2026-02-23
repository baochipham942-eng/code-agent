# Demystifying Evals for AI Agents — 深度笔记

> 来源：[Anthropic Engineering Blog](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
> 整理日期：2026-02-08
> 用途：优化评测系统的参考指南

---

## 1. 核心概念

**Eval = 给 AI 系统的测试**：给 AI 一个输入，用评分逻辑（grader）对输出打分，衡量成功与否。

Agent eval 比传统 LLM eval 难的三个原因：
1. Agent 跨多轮对话使用工具，修改环境状态
2. 错误会**传播和累积**（一个错误导致后续全错）
3. 前沿模型会发现**创造性解法**，超出静态 eval 的预设边界

## 2. 关键术语

| 术语 | 含义 |
|------|------|
| **Task** | 单个测试用例，有明确输入和成功标准 |
| **Trial** | 对一个 task 的一次尝试；多次 trial 可统计稳定性 |
| **Grader** | 评分逻辑，一个 task 可含多个 grader |
| **Transcript** | 完整的试验记录（输出、工具调用、推理过程） |
| **Outcome** | 最终环境状态（不是 agent 说的，而是实际发生的） |
| **Eval Harness** | 端到端评测基础设施（提供指令、工具、并发执行、记录、评分、聚合） |
| **Agent Harness** | 让模型具备 agent 能力的脚手架（如 Claude Code） |
| **Eval Suite** | 衡量特定能力的 task 集合 |

## 3. 三类 Grader

### 3.1 代码评分器（Code-Based）

- **方法**：字符串匹配（精确/正则/模糊）、二值测试、静态分析、结果验证、工具调用验证、transcript 分析
- **优点**：快、便宜、客观、可复现、可调试
- **缺点**：对有效变体脆弱，缺乏细微判断力，不适合主观任务
- **适用**：编码 agent（测试是否通过？代码能运行吗？）

### 3.2 模型评分器（Model-Based / LLM-as-Judge）

- **方法**：基于 rubric 打分、自然语言断言、成对比较、参考答案评估、多评委共识
- **优点**：灵活、可扩展、能捕捉细微差别、处理开放式任务和自由格式输出
- **缺点**：非确定性、更贵、需要与人类评分校准
- **适用**：对话质量、研究报告质量、代码风格

### 3.3 人类评分器（Human）

- **方法**：SME 评审、众包判断、抽样检查、A/B 测试、评分者间一致性
- **优点**：金标准质量，匹配专家用户判断，校准模型评分器
- **缺点**：贵、慢、难规模化
- **适用**：校准模型评分器、评估主观或模糊任务

### 选择原则

> **能用代码评分就用代码，需要灵活性时用模型评分，人类评分用于校准和验证。**

### 评分组合方式

- **加权制**：各 grader 分数加权，总分需达阈值
- **二值制**：所有 grader 必须全部通过
- **混合制**：关键 grader 必须通过 + 其他加权

## 4. 能力 Eval vs 回归 Eval

| 维度 | 能力 Eval (Capability) | 回归 Eval (Regression) |
|------|----------------------|----------------------|
| 核心问题 | "agent 能做好什么？" | "agent 还能正确处理已知任务吗？" |
| 起始通过率 | 低，逐步提升 | 接近 100% |
| 目标 | 发现改进空间 | 防止退化 |
| 生命周期 | 能力 eval 通过率达标后 → **毕业为回归 eval** |

两者形成良性循环：能力 eval 提高 → 毕业为回归 eval → 持续防止退化 → 新的能力 eval 继续推动进步。

## 5. 四类 Agent 的评测策略

### 5.1 编码 Agent

- **主 grader**：确定性测试（单元测试通过即可）
- **辅 grader**：LLM rubric 评代码质量、静态分析（lint/type check/安全扫描）
- **代表 benchmark**：SWE-bench Verified、Terminal-Bench
- **要点**：软件测试天然适合确定性评分；除 pass/fail 外，transcript 评分也有价值（代码质量启发式、工具使用模式）

```yaml
# 编码 eval 示例结构
task:
  id: "fix-auth-bypass_1"
  desc: "Fix authentication bypass when password field is empty..."
  graders:
    - type: deterministic_tests
      required: [test_empty_pw_rejected.py, test_null_pw_rejected.py]
    - type: llm_rubric
      rubric: prompts/code_quality.md
    - type: static_analysis
      commands: [ruff, mypy, bandit]
    - type: state_check
      expect:
        security_logs: {event_type: "auth_blocked"}
    - type: tool_calls
      required:
        - {tool: read_file, params: {path: "src/auth/*"}}
        - {tool: edit_file}
        - {tool: run_tests}
  tracked_metrics:
    - type: transcript
      metrics: [n_turns, n_toolcalls, n_total_tokens]
    - type: latency
      metrics: [time_to_first_token, output_tokens_per_sec, time_to_last_token]
```

### 5.2 对话 Agent

- **核心方法**：第二个 LLM 模拟用户（对抗性多轮压力测试）
- **多维评分**：任务解决（状态检查）+ 交互质量（LLM rubric）+ 轮次限制（transcript 约束）
- **代表 benchmark**：τ-Bench、τ2-Bench
- **要点**：交互质量本身就是被评测对象；对话成功是多维的

```yaml
# 对话 eval 示例结构
graders:
  - type: llm_rubric
    rubric: prompts/support_quality.md
    assertions:
      - "Agent showed empathy for customer's frustration"
      - "Resolution was clearly explained"
      - "Agent's response grounded in fetch_policy tool results"
  - type: state_check
    expect:
      tickets: {status: resolved}
      refunds: {status: processed}
  - type: tool_calls
    required:
      - {tool: verify_identity}
      - {tool: process_refund, params: {amount: "<=100"}}
      - {tool: send_confirmation}
  - type: transcript
    max_turns: 10
```

### 5.3 研究 Agent

- **最主观**，需频繁人类校准
- **三层检查**：
  1. 事实依据性（claims 是否有源支撑）
  2. 覆盖度（关键事实是否遗漏）
  3. 来源质量（是否引用权威来源而非随便抓到的）
- **代表 benchmark**：BrowseComp
- **要点**：客观事实部分用精确匹配；综合分析部分用 LLM 标记无支撑声明、覆盖空白

### 5.4 计算机使用 Agent

- **方法**：在真实/沙盒环境中运行，检查最终状态
- **关键**：不仅看页面显示，还要查后端状态（数据库是否真的生成了订单）
- **代表 benchmark**：WebArena、OSWorld
- **权衡**：DOM 交互快但 token 多 vs 截图交互慢但 token 省

## 6. 非确定性处理：pass@k vs pass^k

Agent 行为在不同运行间天然变化，两个指标捕捉不同维度：

### pass@k — 至少成功一次

k 次尝试中**至少成功一次**的概率。k 越大，概率越高。

$$\text{pass@k} = 1 - (1-p)^k$$

适用场景：单次成功就够（编码工具、搜索任务）

### pass^k — 全部成功

k 次尝试**全部成功**的概率。k 越大，概率越低。

$$\text{pass}^k = p^k$$

适用场景：面向用户、要求可靠性的 agent

### 计算示例

单次成功率 p = 75%，k = 3 次试验：
- pass@3 = 1 - (0.25)³ ≈ **98.4%**
- pass^3 = (0.75)³ ≈ **42.2%**

选择哪个指标取决于产品需求。

## 7. 从 0 到 1 路线图（8 步）

### Step 0: 尽早开始

- **20-50 个真实失败案例就够了**，不需等到完美
- 早期产品需求天然转化为 test case；拖到后期需要逆向工程
- 有 eval 的团队几天内完成新模型评估；没有的需要数周

### Step 1: 从手动测试转化

- 开发阶段的手工检查 → 自动化 task
- bug tracker 和客服工单 → 按用户影响优先级排列的 task

### Step 2: 写无歧义的 Task + 参考解

- 两个独立领域专家应对 pass/fail 达成一致
- 0% 通过率（多次 trial）**多半是 task 有问题**，不是 agent 不行
- 创建参考解（已知能通过所有 grader 的输出）验证 task 可解性

### Step 3: 构建平衡的问题集

- **同时测试"应该做"和"不应该做"的行为**
- 例：搜索 eval 既测"该搜的"（天气）也测"不该搜的"（常识问题）
- 单侧 eval → 单侧优化（agent 会变成什么都搜）

### Step 4: 搭建稳健的 Eval Harness

- **每次 trial 从干净状态开始**，隔离共享状态
- 防止：残留文件、缓存数据、资源耗尽导致的关联失败
- 防止：agent 利用前次 trial 留下的信息（如 git 历史）获得不公平优势

### Step 5: 精心设计 Grader

- **评判产出而非路径**（不要检查特定步骤顺序，agent 经常发现更好的路径）
- **支持部分得分**（正确识别问题但未完成退款 > 立即失败）
- LLM 评分器需与人类校准，给 LLM 逃生路线（"Unknown"选项）
- 用独立 LLM 分维度评分，而非单个 LLM 评所有维度
- **防止作弊**：task 和 grader 设计应要求真正解决问题

### Step 6: 检查 Transcript（核心技能）

- 失败时看：是 agent 真的错了还是 grader 误判了？
- 分数不涨时需确认：是 agent 性能问题还是 eval 问题？
- **Eval 得分不能面值接受，必须读 transcript**

> 案例：Opus 4.5 在 CORE-Bench 从 42% 跳到 95%，原因是修复了 grader 精度要求、歧义 task、随机性 task。

### Step 7: 监控 Eval 饱和

- 接近 100% = eval 太简单了，只能做回归测试不能驱动改进
- 饱和会让大的能力提升看起来只有微小的分数增长
- 需要持续补充更难的任务

### Step 8: 保持 Eval Suite 健康

- Eval suite 是活的产物，需要持续维护和明确的 owner
- **Eval-driven development**：先建 eval 定义目标能力 → 再迭代 agent 直到通过
- 产品经理、客户成功、销售最了解用户，让他们也能贡献 eval task

## 8. Eval 与其他质量保障方法的配合

### 方法对比

| 方法 | 优点 | 缺点 | 适用阶段 |
|------|------|------|----------|
| **自动 Eval** | 快速迭代、完全可复现、无用户影响、每次提交可运行 | 前期投入高、需持续维护、可能与真实使用偏离 | 上线前 + CI/CD |
| **生产监控** | 反映真实行为、捕获 eval 遗漏的问题 | 被动响应、信号噪声大 | 上线后 |
| **A/B 测试** | 衡量真实用户结果、控制混淆因素 | 慢（天/周级）、需足够流量 | 重大变更验证 |
| **用户反馈** | 发现未预料问题、真实案例 | 稀疏、偏向严重问题、未自动化 | 持续 |
| **手动 Transcript 审阅** | 建立失败模式直觉、捕捉自动检查遗漏的微妙质量问题 | 耗时、不可规模化 | 定期抽样 |
| **系统性人类研究** | 金标准质量判断 | 贵、慢 | 校准 LLM grader |

### 瑞士奶酪模型

> 没有单一评测层能捕获所有问题。多层叠加才最有效：
> 自动 eval（快速迭代）+ 生产监控（ground truth）+ 定期人工审阅（校准）

## 9. 关键洞见总结

1. **Eval 的价值是复利式增长的**：前期成本可见，好处随时间累积（基线、回归测试、延迟/成本/错误率跟踪免费获得）
2. **Eval 加速模型切换**：有 eval → 几天；无 eval → 数周
3. **Eval 是产品-研究的高带宽沟通渠道**
4. **评判产出而非路径**：不要检查特定工具调用顺序
5. **20-50 个 task 就能起步**：不需等到完美
6. **0% 通过率多半是 task/grader 的问题**：先检查 eval 再怀疑 agent
7. **平衡正反案例**：避免单侧优化
8. **读 Transcript 是核心技能**：分数不可面值接受
9. **Eval-driven development**：先建 eval，再建 agent

## 10. 推荐框架

| 框架 | 特点 | 适用场景 |
|------|------|----------|
| **Harbor** | 容器化 agent 环境，标准化 task/grader 格式，支持云扩展 | 需要隔离环境的 agent eval |
| **Promptfoo** | 轻量开源，YAML 声明式配置，Anthropic 内部使用 | 快速开始、prompt 测试 |
| **Braintrust** | 离线 eval + 生产监控 + 实验追踪 | 需要开发+生产双重覆盖 |
| **LangSmith** | 追踪 + eval + 数据集管理，LangChain 生态 | LangChain 用户 |
| **Langfuse** | 开源自托管，类似 LangSmith | 有数据驻留要求的团队 |

> 框架只是加速器。**核心价值在 task 和 grader 的质量上，不在框架选择上。**

---

## 附：实操 Checklist

- [ ] 收集 20-50 个真实失败案例作为初始 task
- [ ] 每个 task 写清无歧义的描述 + 参考解
- [ ] 正反案例平衡（应该做 vs 不应该做）
- [ ] 选择合适的 grader 组合（代码优先，模型补充）
- [ ] 评判产出而非路径，支持部分得分
- [ ] 每次 trial 干净隔离
- [ ] LLM grader 与人类评分校准
- [ ] 定期读 transcript 验证 eval 质量
- [ ] 监控 eval 饱和，持续补充更难的 task
- [ ] 将成熟的能力 eval 毕业为回归 eval

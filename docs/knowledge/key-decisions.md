# 关键技术决策

## Active Context

**Current Focus**: Light Memory + 桌面活动视觉分析
**Key Deadline**: [none]
**Blockers**: 模板 .pptx 文件待从开源项目提取（P2 planned）

## Key Decisions in Effect

- P5 输出检测: 显式路径 + 脚本未执行检测 + xlsx-vs-csv 检测（Workspace Diff 已移除）
- P7 结构验证: pandas 读取 xlsx 后注入模型核对 + 自动质量检查
- P8 任务模式检测: 异常检测/透视分析/数据清洗/多轮任务 → 针对性提示注入
- maxOutputFileNudges = 3
- bash 预处理: JSON-wrapper + heredoc 截断 + 工具混淆检测 + stderr 合并输出
- maxTokens: 按模型查表（MODEL_MAX_OUTPUT_TOKENS），DEFAULT=16384, EXTENDED=32768
- 工具描述: Claude Code 风格（明确边界 + 交叉引用 + 后果说明）

- 桌面活动截图格式: JPG（替代 PNG，~80% 空间节省）
- 桌面活动视觉分析: 后台智谱 GLM-4V-Plus 生成 analyzeText（对标 StepFun analyze_text）
- Light Memory: File-as-Memory 架构，~700 行代码替代旧 13K+ 行 vector/embedding 系统

## Critical Preferences

- **语言**: 内部思考用英文，回复用户用中文 (Think in English, reply in Chinese)

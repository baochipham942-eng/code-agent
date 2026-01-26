# nanoGPT 2.0 实验室模块规划

## 一、项目对比

| 特性 | GPT-1 (minimal-gpt1) | GPT-2 (nanoGPT) |
|------|---------------------|-----------------|
| 参数量 | ~11M | 124M (GPT-2 small) |
| 分词器 | SentencePiece Unigram | GPT-2 BPE (tiktoken) |
| 上下文长度 | 128 | 256-1024 |
| 数据集 | 对话数据 | Shakespeare / OpenWebText |
| 训练类型 | 仅预训练 | 预训练 + 微调 |
| 重点 | 教育理解 | 实用性能 |

## 二、学习阶段设计（6 阶段）

### Stage 1: 数据准备
**目标**：理解不同数据集的准备流程

**内容**：
- Shakespeare 字符级数据准备
  - 原始文本 → 字符编码 → train.bin/val.bin
  - 词汇表大小约 65 个字符
- OpenWebText 预训练数据（可选）
  - 大规模网页文本
  - GPT-2 BPE 分词（50257 词汇）
- 自定义数据集上传

**可视化**：
- 数据集统计（字符数、词汇分布）
- 训练/验证集划分
- Token 序列预览

---

### Stage 2: 分词器
**目标**：对比字符级分词与 BPE 分词

**内容**：
- 字符级分词（Shakespeare）
  - 每个字符一个 token
  - 简单但序列长
- GPT-2 BPE 分词
  - 子词单元
  - tiktoken 库实现
  - 50257 词汇表

**可视化**：
- 同一文本的两种分词对比
- Token 数量差异
- 压缩率比较

---

### Stage 3: 模型架构
**目标**：理解 GPT-2 架构的改进

**内容**：
- 与 GPT-1 的区别
  - Layer Normalization 位置（Pre-LN vs Post-LN）
  - 更深的网络（12-48 层）
  - 更大的上下文窗口
- 模型规模对比
  - GPT-2 Small: 124M (12层, 768维, 12头)
  - GPT-2 Medium: 350M
  - GPT-2 Large: 774M
  - GPT-2 XL: 1.5B

**可视化**：
- 交互式架构图
- 参数量计算器
- 各规模模型对比

---

### Stage 4: 预训练
**目标**：理解大规模预训练过程

**内容**：
- 训练配置
  - batch_size, learning_rate, max_iters
  - 梯度累积
  - 混合精度训练 (AMP)
- 分布式训练概念
  - 数据并行 (DDP)
  - 多 GPU 策略
- 训练监控
  - Loss 曲线
  - 验证集评估

**可视化**：
- 实时 Loss 曲线
- GPU 显存使用
- 训练速度指标

---

### Stage 5: 微调 (Fine-tuning) ⭐ 新增
**目标**：理解后训练的核心概念

**内容**：
- 什么是微调
  - 加载预训练权重
  - 适应特定任务/领域
- 微调策略
  - 全参数微调
  - 学习率调整（更小的 LR）
  - Early stopping
- 实践：Shakespeare 微调
  - 加载 GPT-2 预训练权重
  - 在莎士比亚文本上微调
  - 生成莎士比亚风格文本

**可视化**：
- 预训练 vs 微调对比
- Loss 下降曲线
- 生成样本质量对比

---

### Stage 6: 推理与生成
**目标**：掌握文本生成技巧

**内容**：
- 采样策略
  - Temperature 控制
  - Top-k 采样
  - Top-p (Nucleus) 采样
- 生成参数调优
  - 创造性 vs 确定性
  - 重复惩罚
- 交互式对话

**可视化**：
- 参数滑块实时调整
- Token 概率分布
- 多样本对比

---

## 三、模式设计

### 模拟模式（学习优先）
- 预计算的训练曲线
- 模拟的 token 分布
- 即时响应的推理演示

### 真实模式（实践优先）
- 实际克隆 nanoGPT 仓库
- 真实 Python 训练
- 支持 CPU/MPS/CUDA

---

## 四、后端扩展

### 新增类型
```typescript
interface NanoGPTConfig {
  // 模型规模
  modelSize: 'small' | 'medium' | 'large' | 'xl' | 'custom';

  // 自定义配置
  nLayer?: number;
  nHead?: number;
  nEmbd?: number;
  blockSize?: number;

  // 训练配置
  batchSize: number;
  learningRate: number;
  maxIters: number;
  gradientAccumulationSteps: number;

  // 微调配置
  initFrom: 'scratch' | 'gpt2' | 'gpt2-medium' | 'gpt2-large' | 'gpt2-xl';

  // 设备
  device: 'cpu' | 'cuda' | 'mps';
  compiledModel: boolean; // torch.compile()
}
```

### IPC 扩展
- `lab:nanogpt:prepare-data` - 准备数据集
- `lab:nanogpt:download-weights` - 下载预训练权重
- `lab:nanogpt:start-training` - 开始训练
- `lab:nanogpt:start-finetuning` - 开始微调

---

## 五、UI 组件

### 新增组件
```
src/renderer/components/features/lab/nanogpt/
├── NanoGPTLab.tsx           # 主组件
├── stages/
│   ├── DataPreparation.tsx  # 数据准备
│   ├── Tokenizer.tsx        # BPE vs 字符分词
│   ├── ModelArchitecture.tsx # GPT-2 架构
│   ├── Pretraining.tsx      # 预训练
│   ├── Finetuning.tsx       # 微调 ⭐
│   └── Inference.tsx        # 推理
└── RealModePanel.tsx        # 真实训练面板
```

---

## 六、学习路径

```
GPT-1 (基础理解)
    ↓
nanoGPT 预训练 (规模化)
    ↓
nanoGPT 微调 (任务适应) ← 核心新增
    ↓
未来: SFT / RLHF (对齐)
```

---

## 七、实现优先级

### Phase 1: 核心功能
- [ ] NanoGPTLab 主框架
- [ ] 数据准备模块
- [ ] 分词器对比模块
- [ ] 模型架构模块

### Phase 2: 训练功能
- [ ] 预训练模块（模拟 + 真实）
- [ ] 微调模块（重点）
- [ ] 推理测试模块

### Phase 3: 进阶功能
- [ ] 多 GPU 支持说明
- [ ] 混合精度训练
- [ ] 模型导出/部署

---

## 八、与 GPT-1 模块复用

可复用组件：
- `RealModePanel` 框架
- 训练日志显示
- 进度条组件
- 推理测试界面

需要新建：
- BPE 分词可视化
- 微调配置 UI
- 预训练权重下载
- 模型规模选择器

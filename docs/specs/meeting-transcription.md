# Meeting Real-Time Transcription Spec

> 基于开源项目和论文调研，指导 Code Agent 会议记录转录功能的架构设计。

## 调研来源

| 项目/论文 | 核心方案 | 关键启发 |
|-----------|----------|----------|
| [Whisper-Streaming (ufal)](https://github.com/ufal/whisper_streaming) + [论文 arXiv:2307.14743](https://arxiv.org/abs/2307.14743) | LocalAgreement-2 策略 + 滚动音频缓冲 | **confirmed/unconfirmed 文本分离** |
| [WhisperLive (Collabora)](https://github.com/collabora/WhisperLive) | VAD (Silero) + WebSocket + faster_whisper | **VAD 过滤非语音再送 Whisper** |
| [VoiceStreamAI](https://github.com/alesaccoia/VoiceStreamAI) | 5s chunk + SilenceAtEndOfChunk | **静音边界避免截断词语** |
| [Meetily](https://github.com/Zackriya-Solutions/meetily) | Rust cpal + whisper.cpp + Ollama 摘要 | **系统音频 + 麦克风混录 + VAD** |
| [Baseten Whisper V3 Tutorial](https://www.baseten.co/blog/zero-to-real-time-transcription-the-complete-whisper-v3-websockets-tutorial/) | AudioWorklet PCM + VAD + partial/final | **partial 实时反馈 + final 确认** |
| [OpenAI Realtime Transcription API](https://developers.openai.com/api/docs/guides/realtime-transcription/) | server_vad / semantic_vad + delta/completed | **delta 增量 + completed 最终确认** |
| [Qwen3-ASR](https://github.com/QwenLM/Qwen3-ASR) | vLLM streaming + 2s window + rollback | **encoder 缓存 + rollback 5 token** |

## 核心架构原则

### 1. 音频采集：AudioWorklet PCM 替代 MediaRecorder WebM

**问题**：MediaRecorder 输出 WebM/Opus 压缩格式，每个 chunk 不是独立可解码的音频段。chunk[0] 是 EBML header，后续 chunk 是续接数据。将 header + 部分 chunk 拼接成 WebM 再送 ASR，本质上是在做"伪流式"——每次构造一个有效但不完整的文件。

**业界标准做法**：
```
浏览器 AudioWorklet → 原始 PCM (16kHz 16bit mono)
  → 通过 IPC / WebSocket 发送到 ASR 引擎
  → ASR 引擎直接处理 PCM 流
```

**优势**：
- PCM 是连续的采样点流，天然可以任意切分、拼接
- 不需要 WebM header hack
- ASR 模型本身期望的输入就是 PCM
- Electron 环境下 AudioWorklet 可直接在 renderer 运行

**参考实现**：
```javascript
// AudioWorklet processor (在 renderer 进程)
class PCMProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0][0]; // Float32 mono
    if (input) {
      // 转为 Int16 PCM
      const int16 = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        int16[i] = Math.max(-32768, Math.min(32767, input[i] * 32768));
      }
      this.port.postMessage(int16.buffer, [int16.buffer]);
    }
    return true;
  }
}
```

### 2. VAD 前置过滤：只在有语音时送 ASR

**问题**：当前实现无 VAD，环境噪音（鸟叫、风扇）也被送给 ASR，产生"嗯"等幻觉文本。

**业界标准做法**（WhisperLive / VoiceStreamAI / OpenAI）：
```
PCM 音频流 → VAD 检测（Silero / WebRTC VAD）
  → 有语音: 送入 ASR
  → 无语音: 丢弃（或仅记录静音时长）
```

**Silero VAD** 是最常用的方案（~1MB 模型，CPU 推理 < 1ms/帧）。对于 Electron 桌面端，有两种集成方式：
- **Python 端**：在 ASR 服务进程中用 `silero_vad` 做前置过滤
- **JS 端**：用 `@ricky0123/vad-web`（Silero ONNX）在 renderer 端检测

**推荐**：Python 端集成，减少跨进程通信。

**参数参考**（OpenAI Realtime API）：
```json
{
  "threshold": 0.5,
  "min_silence_duration_ms": 500,
  "speech_pad_ms": 300,
  "prefix_padding_ms": 300
}
```

### 3. 转录策略：滚动缓冲 + LocalAgreement 确认

**问题**：当前要么全量重转录（慢），要么增量转录（重复/遗漏）。

**业界标准做法（Whisper-Streaming 论文）**：

```
维护一个滚动音频缓冲区 (max ~30s)
每次新音频到达:
  1. 将新音频追加到缓冲区
  2. 对整个缓冲区运行 ASR → 得到 transcript_current
  3. 与上一次的 transcript_previous 做 LocalAgreement-2:
     - 找两次输出的最长公共前缀 → 标记为 "confirmed"
     - 前缀之后的部分 → 标记为 "unconfirmed"（可能随新音频改变）
  4. 当 confirmed 部分包含句子结束标点时，裁剪缓冲区
```

**显示策略**：
```
已确认文本（不可变，黑色）
当前未确认文本（灰色/斜体，会随下次 ASR 更新而变化）
```

**Qwen3-ASR 的变体**：
- 2 秒 chunk window
- 编码器缓存已完成的 window，只重新编码当前 tail window
- 解码器 prompt 包含之前输出 - rollback 5 token（容错）

### 4. 结果显示：Confirmed + Unconfirmed 双层

**问题**：当前实现是追加模式，每次 ASR 结果直接 append，导致重复。

**正确做法**：
```typescript
interface TranscriptSegment {
  text: string;
  isConfirmed: boolean;
  timestamp: number;
  speaker?: string;
}

// 显示逻辑
// confirmedSegments: 已确认的段落（不可变）
// pendingText: 当前未确认的文本（每次 ASR 刷新替换）
```

**OpenAI 的 delta/completed 模型**：
- `delta` 事件：增量部分文本（实时更新 UI 上的"pending"区域）
- `completed` 事件：最终确认文本（移入 confirmed 列表，清空 pending）

### 5. 简化方案（适合当前 Qwen3-ASR 离线模型）

Qwen3-ASR 0.6B 是离线模型（非流式），不像 Whisper-Streaming 那样可以做 LocalAgreement。对于离线模型的实时转录，更实用的方案是：

**VAD 分句 + 整句送 ASR + 替换显示**：

```
PCM 音频流
  → VAD 检测语音段
  → 当检测到 ≥500ms 静音（一句话结束）:
      将这整句话的音频送给 ASR
      ASR 返回结果 → 追加到 confirmed 列表
  → 当前正在说话中（VAD 活跃）:
      显示 "正在聆听..." 或实时波形
```

**优势**：
- 每次送给 ASR 的是完整的一句话（自然语音段），转录质量最高
- 不会有重复问题（每段只转录一次）
- 不会有背景噪音幻觉（VAD 过滤）
- 延迟 = 语音段结束的静音检测时间 (~500ms) + ASR 推理时间

**这是 VoiceStreamAI 的核心策略**：5s chunk + SilenceAtEndOfChunk。

## 实施路线图

### Phase 1: VAD 集成 + PCM 采集（核心修复）

1. **Renderer 端**：AudioWorklet 采集 PCM 16kHz mono
   - 替代 MediaRecorder WebM
   - 通过 IPC 发送 PCM buffer 到 main 进程

2. **Main 进程 ASR 服务**：集成 Silero VAD
   - Python 脚本中加入 VAD 前置过滤
   - VAD 检测语音段边界（onset/offset）
   - 只将语音段音频送给 Qwen3-ASR

3. **结果显示**：confirmed 列表
   - 每个 VAD 语音段转录后加入 confirmed
   - VAD 活跃时显示"正在聆听..."

### Phase 2: 流式优化（可选）

1. **Streaming ASR**：如果 Qwen3-ASR 支持 vLLM streaming，可实现真正的流式
2. **LocalAgreement**：对 Whisper 等模型实现 confirmed/unconfirmed 双层显示
3. **Speaker Diarization**：说话人分离（CAM++ 或 pyannote）

### Phase 3: 产品化增强（可选）

1. 系统音频捕获（Mac: ScreenCaptureKit / BlackHole）
2. 实时翻译
3. AI 摘要（Ollama / Cloud LLM）

## 核心算法详解

### A. Silero VAD 语音活动检测算法

**模型**：~2MB JIT/ONNX 模型，支持 8kHz/16kHz，每 30ms chunk < 1ms CPU 推理。

**状态机工作原理**：

```
               ┌─────────┐
   ──audio──►  │ Silero   │──► probability (0.0 ~ 1.0)
               │ Neural   │
               │ Network  │
               └─────────┘
                    │
                    ▼
            ┌───────────────┐
            │  State Machine │
            │                │
  IDLE ─────┤  prob ≥ threshold (0.5)  ────► SPEECH_START
            │                │               │
            │  prob < threshold - 0.15 ◄─────┘
            │       │
            │  等待 min_silence_duration_ms
            │       │
            │  静音持续够长 ────► SPEECH_END
            │  静音未够长 ────► 继续 SPEECH   (hangover)
            └───────────────┘
```

**关键参数及推荐值**：

| 参数 | 默认值 | 会议场景推荐 | 作用 |
|------|--------|-------------|------|
| `threshold` | 0.5 | 0.4~0.5 | 语音概率阈值，低=灵敏，高=严格 |
| `min_speech_duration_ms` | 250 | 500 | 最短语音段，过滤咳嗽/唇响 |
| `min_silence_duration_ms` | 100 | 500~800 | 句间静音判定，**核心分句参数** |
| `speech_pad_ms` | 30 | 100~200 | 语音段前后 padding，防截断首尾字 |
| `window_size_samples` | 512 (16kHz) | 512 | 处理窗口大小 |

**分句算法 = VAD onset/offset**：
```python
speech_timestamps = get_speech_timestamps(
    audio_pcm,
    model,
    threshold=0.45,
    min_speech_duration_ms=500,    # 忽略 <500ms 的噪音
    min_silence_duration_ms=600,   # 600ms 静音 = 一句话结束
    speech_pad_ms=150,             # 前后各留 150ms 余量
    return_seconds=True
)
# 返回: [{'start': 0.5, 'end': 2.3}, {'start': 3.1, 'end': 5.8}, ...]
# 每个 segment 就是一个完整的语音段（≈一句话）
```

**Hangover 机制**（防止句中停顿被误判为句尾）：
- 当 prob 降到 threshold - 0.15 以下时，不立即判定为静音
- 等待 `min_silence_duration_ms` 持续静音才确认句子结束
- 这样"嗯...那个...就是说"中的短停顿不会被切断

### B. 说话人分离（Speaker Diarization）算法

**核心流程**：

```
语音段音频 → Speaker Embedding 模型 → 192/256维向量
                                          │
                                ┌─────────▼──────────┐
                                │  与已知说话人匹配    │
                                │  cosine_similarity   │
                                │                      │
                                │  max_sim ≥ 阈值(0.7) │
                                │    → 匹配已有 Speaker │
                                │  max_sim < 阈值      │
                                │    → 创建新 Speaker   │
                                └──────────────────────┘
```

**Step 1: Speaker Embedding 提取**

使用预训练模型将语音段映射为固定维度向量：

| 模型 | 维度 | 大小 | 特点 |
|------|------|------|------|
| ECAPA-TDNN (SpeechBrain) | 192 | ~80MB | 最成熟，社区最广 |
| CAM++ (ModelScope/3D-Speaker) | 192 | ~7MB | 轻量，中文优化 |
| WeSpeaker ResNet34-LM | 256 | ~55MB | PyAnnote 原生支持 |

```python
# SpeechBrain ECAPA-TDNN 示例
from speechbrain.inference import EncoderClassifier
classifier = EncoderClassifier.from_hparams(
    source="speechbrain/spkrec-ecapa-voxceleb"
)
embedding = classifier.encode_batch(audio_tensor)  # → [1, 192]
```

**Step 2: 增量聚类 (Online Incremental Clustering)**

```python
class SpeakerTracker:
    def __init__(self, threshold=0.7):
        self.speakers = {}          # speaker_id → [embeddings 平均值]
        self.threshold = threshold
        self.next_id = 1

    def identify(self, embedding):
        """对一个新语音段的 embedding 做说话人识别"""
        if not self.speakers:
            # 第一个说话人
            self.speakers[1] = {'centroid': embedding, 'count': 1}
            self.next_id = 2
            return 1

        # 计算与所有已知说话人的 cosine similarity
        best_id, best_sim = None, -1
        for spk_id, profile in self.speakers.items():
            sim = cosine_similarity(embedding, profile['centroid'])
            if sim > best_sim:
                best_sim = sim
                best_id = spk_id

        if best_sim >= self.threshold:
            # 匹配已有说话人，更新 centroid（移动平均）
            profile = self.speakers[best_id]
            n = profile['count']
            profile['centroid'] = (profile['centroid'] * n + embedding) / (n + 1)
            profile['count'] = n + 1
            return best_id
        else:
            # 新说话人
            new_id = self.next_id
            self.speakers[new_id] = {'centroid': embedding, 'count': 1}
            self.next_id += 1
            return new_id
```

**关键参数**：

| 参数 | 推荐值 | 说明 |
|------|--------|------|
| `cosine_threshold` | 0.65~0.75 | 低=容易合并（适合同性别少人），高=容易分裂 |
| `min_segment_for_embedding` | 1.0s | 语音段 < 1s 的 embedding 质量差，跳过 |
| `centroid_update` | 移动平均 | 每次匹配后更新 centroid，提高后续准确度 |

**阈值选择指南**：
- 2 人会议 → 0.65（宽松，不容易误分裂）
- 3~5 人会议 → 0.70（平衡）
- 5+ 人会议 → 0.75（严格，减少误合并）

**Diart 实时方案**（更高级）：
- 5s 滚动窗口，500ms 步进
- PyAnnote segmentation 模型做 overlap-aware 分割
- Cannot-link 约束防止同窗口内两个说话人被合并
- 延迟 ~5s，DER ~15%

### C. 整句判定算法

"整句"的判定本质上就是 VAD 的 offset 检测 + 后处理：

```
方案 1: 纯 VAD（推荐，适合离线 ASR）
─────────────────────────────────────
  语音段 = VAD onset → VAD offset
  整句 = min_silence_duration_ms (600ms) 后确认

  优点: 简单可靠，不需要语言模型
  缺点: 同一人连续快速说话可能合并

方案 2: VAD + 最大长度限制
─────────────────────────────────────
  if 语音段 > max_speech_duration (15s):
      在最近的能量低谷处强制切分

  防止一个人滔滔不绝时缓冲区过大

方案 3: VAD + ASR 标点（高级）
─────────────────────────────────────
  先用 VAD 粗切 → ASR 转录 → 检查末尾标点
  if 末尾无句号/问号:
      与下一个 VAD 段合并后重新转录

  优点: 语义完整
  缺点: 增加延迟和复杂度
```

**推荐 Phase 1 采用方案 2**：VAD + 最大 15s 限制，简单且足够好。

### D. 端到端流水线

```
╔═══════════════════════════════════════════════════════════╗
║                    实时转录流水线                           ║
╠═══════════════════════════════════════════════════════════╣
║                                                           ║
║  [Renderer] AudioWorklet                                  ║
║      │  PCM 16kHz 16bit mono, 每 30ms 一帧               ║
║      │                                                    ║
║  ────┼──── IPC ────────────────────────────────           ║
║      │                                                    ║
║  [Main] ASR Service (Python subprocess)                   ║
║      │                                                    ║
║      ▼                                                    ║
║  ┌─────────┐   prob < 0.45    ┌──────────┐               ║
║  │ Silero  │ ───────────────► │  丢弃     │               ║
║  │  VAD    │                  │ (静音/噪音)│               ║
║  │         │   prob ≥ 0.45    └──────────┘               ║
║  │         │ ────┐                                        ║
║  └─────────┘     │                                        ║
║                  ▼                                        ║
║  ┌──────────────────────┐                                 ║
║  │ 音频缓冲区 (PCM)      │                                 ║
║  │ 持续累积语音帧         │                                 ║
║  └──────────┬───────────┘                                 ║
║             │                                             ║
║    静音 ≥ 600ms OR 长度 ≥ 15s                              ║
║             │                                             ║
║             ▼                                             ║
║  ┌──────────────────────┐                                 ║
║  │ Speaker Embedding    │  (可选 Phase 2)                  ║
║  │ ECAPA-TDNN / CAM++   │                                 ║
║  │ → cosine matching    │                                 ║
║  │ → speaker_id         │                                 ║
║  └──────────┬───────────┘                                 ║
║             │                                             ║
║             ▼                                             ║
║  ┌──────────────────────┐                                 ║
║  │ Qwen3-ASR 0.6B      │                                 ║
║  │ 转录整段语音          │                                 ║
║  │ → text               │                                 ║
║  └──────────┬───────────┘                                 ║
║             │                                             ║
║  ────────── │ ── IPC 返回 ──────────────────              ║
║             ▼                                             ║
║  [Renderer] 显示                                          ║
║  ┌─────────────────────────────┐                          ║
║  │ Speaker 1: 你好呀。          │  confirmed               ║
║  │ Speaker 2: 嗯，你好。        │  confirmed               ║
║  │ Speaker 1: 今天开会讨论...   │  confirmed               ║
║  │ ● 正在聆听...               │  listening indicator     ║
║  └─────────────────────────────┘                          ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 音频采集 | AudioWorklet PCM | 业界标准，避免 WebM container 问题 |
| VAD | Silero VAD (Python 端) | 最成熟的开源方案，<1ms 延迟 |
| 分句策略 | VAD onset/offset | 离线 ASR 模型的最佳拍档 |
| 显示策略 | confirmed 列表 + pending 指示 | 避免追加重复 |
| ASR 模型 | Qwen3-ASR 0.6B (当前) | 已部署，中文质量好 |
| 通信方式 | IPC (Electron) | 桌面端不需要 WebSocket |

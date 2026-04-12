// ============================================================================
// Lab 实验室类型定义
// 用于模型训练实验室的类型定义
// ============================================================================

/**
 * 项目类型
 */
export type LabProjectType = 'gpt1' | 'nanogpt';

/**
 * 项目状态
 */
export interface LabProjectStatus {
  /** 项目是否已下载 */
  downloaded: boolean;
  /** 项目路径 */
  projectPath: string | null;
  /** 是否有自定义数据集 */
  hasCustomData: boolean;
  /** 是否有训练好的模型 */
  hasTrainedModel: boolean;
  /** 最后训练时间 */
  lastTrainingTime: number | null;
}

/**
 * Python 环境状态
 */
export interface PythonEnvStatus {
  /** Python 是否已安装 */
  pythonInstalled: boolean;
  /** Python 版本 */
  pythonVersion: string | null;
  /** PyTorch 是否已安装 */
  pytorchInstalled: boolean;
  /** PyTorch 版本 */
  pytorchVersion: string | null;
  /** SentencePiece 是否已安装 */
  sentencepieceInstalled: boolean;
  /** 缺失的依赖 */
  missingDependencies: string[];
}

/**
 * 训练配置
 */
export interface TrainingConfig {
  /** 批次大小 */
  batchSize: number;
  /** 学习率 */
  learningRate: number;
  /** 最大迭代次数 */
  maxIters: number;
  /** 评估间隔 */
  evalInterval: number;
  /** 设备 (cpu/cuda/mps) */
  device: 'cpu' | 'cuda' | 'mps';
  /** 初始化来源 (nanoGPT 用) */
  initFrom?: 'scratch' | 'gpt2' | 'gpt2-medium' | 'gpt2-large' | 'gpt2-xl' | 'resume';
  /** 数据集 (nanoGPT 用) */
  dataset?: string;
}

/**
 * 训练进度事件
 */
export interface TrainingProgressEvent {
  /** 事件类型 */
  type: 'progress' | 'log' | 'complete' | 'error';
  /** 项目类型 */
  projectType?: LabProjectType;
  /** 当前迭代 */
  iteration?: number;
  /** 总迭代 */
  totalIterations?: number;
  /** 当前步数 (nanoGPT 使用) */
  step?: number;
  /** 当前 loss */
  loss?: number;
  /** 验证 loss */
  valLoss?: number;
  /** 日志消息 */
  message?: string;
  /** 错误信息 */
  error?: string;
  /** 时间戳 */
  timestamp: number;
}

/**
 * 推理结果
 */
export interface InferenceResult {
  /** 生成的文本 */
  text: string;
  /** Token 概率分布 */
  tokenProbabilities?: Array<{ token: string; probability: number }>;
  /** 生成时间 (ms) */
  generationTime: number;
}

/**
 * 下载项目请求
 */
export interface DownloadProjectRequest {
  /** 项目类型 */
  projectType: LabProjectType;
  /** 目标目录 (可选) */
  targetDirectory?: string;
}

/**
 * 下载项目响应
 */
export interface DownloadProjectResponse {
  success: boolean;
  projectPath?: string;
  error?: string;
}

/**
 * 上传数据请求
 */
export interface UploadDataRequest {
  /** 项目类型 */
  projectType: LabProjectType;
  /** 数据内容 */
  data: string;
  /** 文件名 */
  filename?: string;
}

/**
 * 上传数据响应
 */
export interface UploadDataResponse {
  success: boolean;
  filePath?: string;
  error?: string;
}

/**
 * 开始训练请求
 */
export interface StartTrainingRequest {
  /** 项目类型 */
  projectType: LabProjectType;
  /** 训练配置 */
  config?: Partial<TrainingConfig>;
}

/**
 * 开始训练响应
 */
export interface StartTrainingResponse {
  success: boolean;
  processId?: number;
  error?: string;
}

/**
 * 推理请求
 */
export interface InferenceRequest {
  /** 项目类型 */
  projectType: LabProjectType;
  /** 输入文本 */
  prompt: string;
  /** 温度 */
  temperature?: number;
  /** Top-K */
  topK?: number;
  /** 最大生成 token 数 */
  maxTokens?: number;
}

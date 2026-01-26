// ============================================================================
// LabService - 实验室服务
// 处理模型训练项目的下载、数据上传、训练执行和推理
// ============================================================================

import { spawn, ChildProcess, execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import { app, BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../../../shared/ipc';
import type {
  LabProjectType,
  LabProjectStatus,
  PythonEnvStatus,
  TrainingConfig,
  TrainingProgressEvent,
  DownloadProjectRequest,
  DownloadProjectResponse,
  UploadDataRequest,
  UploadDataResponse,
  StartTrainingRequest,
  StartTrainingResponse,
  InferenceRequest,
  InferenceResult,
} from '../../../shared/types/lab';

const execFileAsync = promisify(execFile);

// 项目 GitHub URL
const PROJECT_URLS: Record<LabProjectType, string> = {
  gpt1: 'https://github.com/yolaucn/minimal-gpt1-pytorch.git',
  nanogpt: 'https://github.com/karpathy/nanoGPT.git',
};

// 默认训练配置
const DEFAULT_TRAINING_CONFIG: TrainingConfig = {
  batchSize: 32,
  learningRate: 3e-4,
  maxIters: 5000,
  evalInterval: 500,
  device: 'cpu',
};

export class LabService {
  private labDir: string;
  private trainingProcesses: Map<LabProjectType, ChildProcess> = new Map();
  private mainWindow: BrowserWindow | null = null;

  constructor() {
    // 实验室目录位于应用数据目录下
    this.labDir = path.join(app.getPath('userData'), 'lab');
    this.ensureLabDir();
  }

  /**
   * 设置主窗口引用（用于发送事件）
   */
  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
  }

  /**
   * 确保实验室目录存在
   */
  private ensureLabDir(): void {
    if (!fs.existsSync(this.labDir)) {
      fs.mkdirSync(this.labDir, { recursive: true });
    }
  }

  /**
   * 获取项目路径
   */
  private getProjectPath(projectType: LabProjectType): string {
    return path.join(this.labDir, projectType);
  }

  /**
   * 检查 Python 环境
   */
  async checkPythonEnv(): Promise<PythonEnvStatus> {
    const result: PythonEnvStatus = {
      pythonInstalled: false,
      pythonVersion: null,
      pytorchInstalled: false,
      pytorchVersion: null,
      sentencepieceInstalled: false,
      missingDependencies: [],
    };

    try {
      // 检查 Python
      const { stdout: pythonVersion } = await execFileAsync('python3', ['--version']);
      result.pythonInstalled = true;
      result.pythonVersion = pythonVersion.trim().replace('Python ', '');
    } catch {
      result.missingDependencies.push('python3');
      return result;
    }

    try {
      // 检查 PyTorch
      const { stdout: torchVersion } = await execFileAsync('python3', ['-c', 'import torch; print(torch.__version__)']);
      result.pytorchInstalled = true;
      result.pytorchVersion = torchVersion.trim();
    } catch {
      result.missingDependencies.push('torch');
    }

    try {
      // 检查 SentencePiece
      await execFileAsync('python3', ['-c', 'import sentencepiece']);
      result.sentencepieceInstalled = true;
    } catch {
      result.missingDependencies.push('sentencepiece');
    }

    return result;
  }

  /**
   * 获取项目状态
   */
  async getProjectStatus(projectType: LabProjectType): Promise<LabProjectStatus> {
    const projectPath = this.getProjectPath(projectType);
    const downloaded = fs.existsSync(projectPath);

    let hasCustomData = false;
    let hasTrainedModel = false;
    let lastTrainingTime: number | null = null;

    if (downloaded) {
      // 检查是否有自定义数据
      const customDataPath = path.join(projectPath, 'data', 'custom.txt');
      hasCustomData = fs.existsSync(customDataPath);

      // 检查是否有训练好的模型（根据项目类型）
      const modelPath = projectType === 'gpt1'
        ? path.join(projectPath, 'out', 'model.pt')
        : path.join(projectPath, 'out-shakespeare-char', 'ckpt.pt');

      if (fs.existsSync(modelPath)) {
        hasTrainedModel = true;
        const stats = fs.statSync(modelPath);
        lastTrainingTime = stats.mtimeMs;
      }
    }

    return {
      downloaded,
      projectPath: downloaded ? projectPath : null,
      hasCustomData,
      hasTrainedModel,
      lastTrainingTime,
    };
  }

  /**
   * 下载项目
   */
  async downloadProject(request: DownloadProjectRequest): Promise<DownloadProjectResponse> {
    const { projectType, targetDirectory } = request;
    const projectPath = targetDirectory || this.getProjectPath(projectType);

    try {
      // 如果目录已存在，先删除
      if (fs.existsSync(projectPath)) {
        fs.rmSync(projectPath, { recursive: true, force: true });
      }

      // 确保父目录存在
      const parentDir = path.dirname(projectPath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }

      // 克隆仓库 - 使用 execFile 避免命令注入
      const gitUrl = PROJECT_URLS[projectType];
      await execFileAsync('git', ['clone', '--depth', '1', gitUrl, projectPath]);

      return {
        success: true,
        projectPath,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 上传自定义数据
   */
  async uploadData(request: UploadDataRequest): Promise<UploadDataResponse> {
    const { projectType, data, filename } = request;
    const projectPath = this.getProjectPath(projectType);

    if (!fs.existsSync(projectPath)) {
      return {
        success: false,
        error: '项目未下载，请先下载项目',
      };
    }

    try {
      // 确保 data 目录存在
      const dataDir = path.join(projectPath, 'data');
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      // 写入数据文件
      const filePath = path.join(dataDir, filename || 'custom.txt');
      fs.writeFileSync(filePath, data, 'utf-8');

      return {
        success: true,
        filePath,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 开始训练
   */
  async startTraining(request: StartTrainingRequest): Promise<StartTrainingResponse> {
    const { projectType, config } = request;
    const projectPath = this.getProjectPath(projectType);

    if (!fs.existsSync(projectPath)) {
      return {
        success: false,
        error: '项目未下载，请先下载项目',
      };
    }

    // 如果已有训练进程在运行，先停止
    if (this.trainingProcesses.has(projectType)) {
      await this.stopTraining(projectType);
    }

    const trainingConfig = { ...DEFAULT_TRAINING_CONFIG, ...config };

    try {
      // 根据项目类型选择训练脚本
      let trainScript: string;
      let args: string[];

      if (projectType === 'gpt1') {
        trainScript = 'train.py';
        args = [
          trainScript,
          `--batch_size=${trainingConfig.batchSize}`,
          `--learning_rate=${trainingConfig.learningRate}`,
          `--max_iters=${trainingConfig.maxIters}`,
          `--eval_interval=${trainingConfig.evalInterval}`,
          `--device=${trainingConfig.device}`,
        ];
      } else {
        // nanoGPT 训练
        trainScript = 'train.py';
        const initFrom = trainingConfig.initFrom || 'scratch';
        const dataset = trainingConfig.dataset || 'shakespeare_char';

        args = [
          trainScript,
          `config/train_${dataset}.py`,
          `--batch_size=${trainingConfig.batchSize}`,
          `--learning_rate=${trainingConfig.learningRate}`,
          `--max_iters=${trainingConfig.maxIters}`,
          `--eval_interval=${trainingConfig.evalInterval}`,
          `--device=${trainingConfig.device}`,
          `--init_from=${initFrom}`,
        ];
      }

      // 启动训练进程 - 使用 spawn 而非 exec
      const process = spawn('python3', args, {
        cwd: projectPath,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.trainingProcesses.set(projectType, process);

      // 处理 stdout
      process.stdout?.on('data', (data: Buffer) => {
        const message = data.toString();
        this.parseAndSendProgress(projectType, message, trainingConfig.maxIters);
      });

      // 处理 stderr
      process.stderr?.on('data', (data: Buffer) => {
        const message = data.toString();
        // stderr 可能包含进度信息（tqdm）
        this.parseAndSendProgress(projectType, message, trainingConfig.maxIters);
      });

      // 处理进程结束
      process.on('close', (code) => {
        this.trainingProcesses.delete(projectType);
        this.sendTrainingEvent({
          type: code === 0 ? 'complete' : 'error',
          message: code === 0 ? '训练完成' : `训练异常退出，退出码: ${code}`,
          error: code !== 0 ? `Exit code: ${code}` : undefined,
          timestamp: Date.now(),
        }, projectType);
      });

      process.on('error', (error) => {
        this.trainingProcesses.delete(projectType);
        this.sendTrainingEvent({
          type: 'error',
          message: `训练进程错误: ${error.message}`,
          error: error.message,
          timestamp: Date.now(),
        }, projectType);
      });

      return {
        success: true,
        processId: process.pid,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 解析训练输出并发送进度事件
   */
  private parseAndSendProgress(projectType: LabProjectType, message: string, totalIterations: number): void {
    // 解析常见的训练输出格式
    // GPT-1: "iter 100: loss 2.5432, val_loss 2.6543"
    // nanoGPT: "step 100: train loss 2.5432, val loss 2.6543"
    const iterMatch = message.match(/(?:iter|step)\s+(\d+)/i);
    const lossMatch = message.match(/(?:train\s+)?loss\s+([\d.]+)/i);
    const valLossMatch = message.match(/val(?:_|\s+)loss\s+([\d.]+)/i);

    const event: TrainingProgressEvent = {
      type: 'progress',
      timestamp: Date.now(),
      message: message.trim(),
    };

    if (iterMatch) {
      const stepNum = parseInt(iterMatch[1], 10);
      event.iteration = stepNum;
      event.step = stepNum;
      event.totalIterations = totalIterations;
    }

    if (lossMatch) {
      event.loss = parseFloat(lossMatch[1]);
    }

    if (valLossMatch) {
      event.valLoss = parseFloat(valLossMatch[1]);
    }

    // 如果没有解析出任何数值，只发送日志消息
    if (!iterMatch && !lossMatch) {
      event.type = 'log';
    }

    this.sendTrainingEvent(event, projectType);
  }

  /**
   * 发送训练事件到渲染进程
   */
  private sendTrainingEvent(event: TrainingProgressEvent, projectType?: LabProjectType): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(IPC_CHANNELS.LAB_TRAINING_PROGRESS, {
        ...event,
        projectType,
      });
    }
  }

  /**
   * 停止训练
   */
  async stopTraining(projectType: LabProjectType): Promise<{ success: boolean; error?: string }> {
    const process = this.trainingProcesses.get(projectType);

    if (!process) {
      return {
        success: false,
        error: '没有正在运行的训练进程',
      };
    }

    try {
      process.kill('SIGTERM');
      this.trainingProcesses.delete(projectType);

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 推理测试
   */
  async inference(request: InferenceRequest): Promise<InferenceResult> {
    const { projectType, prompt, temperature = 0.8, topK = 20, maxTokens = 50 } = request;
    const projectPath = this.getProjectPath(projectType);

    if (!fs.existsSync(projectPath)) {
      throw new Error('项目未下载，请先下载项目');
    }

    const startTime = Date.now();

    try {
      // 根据项目类型选择推理脚本
      let script: string;
      let args: string[];

      if (projectType === 'gpt1') {
        script = 'generate.py';
        args = [
          script,
          `--prompt=${prompt}`,
          `--temperature=${temperature}`,
          `--top_k=${topK}`,
          `--max_tokens=${maxTokens}`,
        ];
      } else {
        script = 'sample.py';
        args = [
          script,
          `--start=${prompt}`,
          `--temperature=${temperature}`,
          `--top_k=${topK}`,
          '--num_samples=1',
          `--max_new_tokens=${maxTokens}`,
        ];
      }

      const { stdout } = await execFileAsync('python3', args, {
        cwd: projectPath,
        timeout: 60000, // 60 秒超时
      });

      const generationTime = Date.now() - startTime;

      return {
        text: stdout.trim(),
        generationTime,
      };
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * 清理资源
   */
  dispose(): void {
    // 停止所有训练进程
    for (const [projectType] of this.trainingProcesses) {
      this.stopTraining(projectType);
    }
  }
}

// 单例
let labServiceInstance: LabService | null = null;

export function getLabService(): LabService {
  if (!labServiceInstance) {
    labServiceInstance = new LabService();
  }
  return labServiceInstance;
}

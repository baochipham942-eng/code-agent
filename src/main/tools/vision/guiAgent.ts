// ============================================================================
// GUI Agent Tool - AI-driven GUI automation via UI-TARS SDK
// Gen 6: 使用 doubao-seed-1-6-vision 视觉模型执行桌面 GUI 任务
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import { createLogger } from '../../services/infra/logger';
import { MODEL_API_ENDPOINTS } from '../../../shared/constants';

const execAsync = promisify(exec);
const logger = createLogger('GUIAgent');

const SCREENSHOT_PATH = '/tmp/gui_agent_screenshot.png';

// ============================================================================
// macOS Operator - 使用 screencapture + AppleScript 实现桌面操作
// ============================================================================

interface ScreenshotOutput {
  base64: string;
  scaleFactor: number;
}

interface ActionInputs {
  content?: string;
  start_box?: string;
  end_box?: string;
  key?: string;
  hotkey?: string;
  direction?: string;
  start_coords?: [number, number] | [];
  end_coords?: [number, number] | [];
}

interface ParsedPrediction {
  action_type: string;
  action_inputs: ActionInputs;
  thought: string;
  reflection: string | null;
}

interface ExecuteParams {
  prediction: string;
  parsedPrediction: ParsedPrediction;
  screenWidth: number;
  screenHeight: number;
  scaleFactor: number;
  factors: [number, number];
}

/**
 * macOS 桌面操作器
 * 使用 screencapture 截屏 + AppleScript/cliclick 执行鼠标键盘操作
 * 无需 nut-js 等 native 依赖
 */
class MacOSOperator {
  static MANUAL = {
    ACTION_SPACES: [
      "click(start_box='[x1, y1, x2, y2]')",
      "left_double(start_box='[x1, y1, x2, y2]')",
      "right_single(start_box='[x1, y1, x2, y2]')",
      "drag(start_box='[x1, y1, x2, y2]', end_box='[x3, y3, x4, y4]')",
      "hotkey(key='')",
      "type(content='')",
      "scroll(start_box='[x1, y1, x2, y2]', direction='down or up or right or left')",
      "wait()",
      "finished()",
      "call_user()",
    ],
  };

  async screenshot(): Promise<ScreenshotOutput> {
    await execAsync(`screencapture -x "${SCREENSHOT_PATH}"`);
    const buffer = fs.readFileSync(SCREENSHOT_PATH);
    const base64 = buffer.toString('base64');

    // macOS Retina 默认 scaleFactor=2
    let scaleFactor = 2;
    try {
      const { stdout } = await execAsync(
        `system_profiler SPDisplaysDataType 2>/dev/null | grep 'Resolution' | head -1`
      );
      // 如果有 "Retina" 字样则 scaleFactor=2，否则 1
      if (!stdout.includes('Retina')) {
        scaleFactor = 1;
      }
    } catch {
      // 默认 Retina
    }

    return { base64, scaleFactor };
  }

  async execute(params: ExecuteParams): Promise<{ status?: string } | void> {
    const { parsedPrediction, scaleFactor } = params;
    const { action_type, action_inputs } = parsedPrediction;

    // 从归一化坐标（0-1）转为屏幕像素坐标
    const screenW = params.screenWidth;
    const screenH = params.screenHeight;

    const getCoords = (box?: string, coords?: [number, number] | []): { x: number; y: number } | null => {
      if (coords && coords.length === 2) {
        return { x: coords[0] / scaleFactor, y: coords[1] / scaleFactor };
      }
      if (box) {
        // 解析 "[x1,y1,x2,y2]" 格式，取中心点
        const nums = box.replace(/[\[\]]/g, '').split(',').map(Number);
        if (nums.length >= 2) {
          const cx = nums.length >= 4 ? (nums[0] + nums[2]) / 2 : nums[0];
          const cy = nums.length >= 4 ? (nums[1] + nums[3]) / 2 : nums[1];
          // 归一化坐标 (0-1) → 像素
          return { x: cx * screenW, y: cy * screenH };
        }
      }
      return null;
    };

    try {
      switch (action_type) {
        case 'click': {
          const pos = getCoords(action_inputs.start_box, action_inputs.start_coords);
          if (pos) {
            await execAsync(
              `cliclick c:${Math.round(pos.x)},${Math.round(pos.y)} 2>/dev/null || ` +
              `osascript -e 'tell application "System Events" to click at {${Math.round(pos.x)}, ${Math.round(pos.y)}}'`
            );
          }
          break;
        }

        case 'left_double': {
          const pos = getCoords(action_inputs.start_box, action_inputs.start_coords);
          if (pos) {
            await execAsync(
              `cliclick dc:${Math.round(pos.x)},${Math.round(pos.y)} 2>/dev/null || ` +
              `osascript -e 'tell application "System Events" to click at {${Math.round(pos.x)}, ${Math.round(pos.y)}}' && ` +
              `osascript -e 'tell application "System Events" to click at {${Math.round(pos.x)}, ${Math.round(pos.y)}}'`
            );
          }
          break;
        }

        case 'right_single': {
          const pos = getCoords(action_inputs.start_box, action_inputs.start_coords);
          if (pos) {
            await execAsync(
              `cliclick rc:${Math.round(pos.x)},${Math.round(pos.y)} 2>/dev/null || ` +
              `osascript -e 'tell application "System Events" to click at {${Math.round(pos.x)}, ${Math.round(pos.y)}} with control down'`
            );
          }
          break;
        }

        case 'drag': {
          const start = getCoords(action_inputs.start_box, action_inputs.start_coords);
          const end = getCoords(action_inputs.end_box, action_inputs.end_coords);
          if (start && end) {
            await execAsync(
              `cliclick dd:${Math.round(start.x)},${Math.round(start.y)} ` +
              `dm:${Math.round(end.x)},${Math.round(end.y)} ` +
              `du:${Math.round(end.x)},${Math.round(end.y)} 2>/dev/null`
            );
          }
          break;
        }

        case 'hotkey': {
          const key = action_inputs.key || action_inputs.hotkey || '';
          const parts = key.toLowerCase().split(/[\s+]+/);
          const modifiers: string[] = [];
          let mainKey = '';

          for (const part of parts) {
            if (['command', 'cmd', 'meta'].includes(part)) modifiers.push('command down');
            else if (['control', 'ctrl'].includes(part)) modifiers.push('control down');
            else if (['alt', 'option'].includes(part)) modifiers.push('option down');
            else if (['shift'].includes(part)) modifiers.push('shift down');
            else mainKey = part;
          }

          const modStr = modifiers.length > 0 ? ` using {${modifiers.join(', ')}}` : '';

          // 特殊按键映射
          const specialKeys: Record<string, number> = {
            'return': 36, 'enter': 36, 'tab': 48, 'space': 49,
            'delete': 51, 'escape': 53, 'esc': 53,
            'up': 126, 'down': 125, 'left': 123, 'right': 124,
            'f1': 122, 'f2': 120, 'f3': 99, 'f4': 118, 'f5': 96,
          };

          if (specialKeys[mainKey]) {
            await execAsync(
              `osascript -e 'tell application "System Events" to key code ${specialKeys[mainKey]}${modStr}'`
            );
          } else if (mainKey.length === 1) {
            await execAsync(
              `osascript -e 'tell application "System Events" to keystroke "${mainKey}"${modStr}'`
            );
          } else if (mainKey) {
            // 尝试作为 keystroke
            await execAsync(
              `osascript -e 'tell application "System Events" to keystroke "${mainKey}"${modStr}'`
            );
          }
          break;
        }

        case 'type': {
          const content = action_inputs.content || '';
          // 分段输入避免 AppleScript 长字符串问题
          const escaped = content.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          if (content.endsWith('\n')) {
            await execAsync(
              `osascript -e 'tell application "System Events" to keystroke "${escaped.slice(0, -1)}"' && ` +
              `osascript -e 'tell application "System Events" to key code 36'`
            );
          } else {
            await execAsync(
              `osascript -e 'tell application "System Events" to keystroke "${escaped}"'`
            );
          }
          break;
        }

        case 'scroll': {
          const dir = action_inputs.direction || 'down';
          const amount = 5;
          const deltaY = dir === 'up' ? -amount : (dir === 'down' ? amount : 0);
          const deltaX = dir === 'left' ? -amount : (dir === 'right' ? amount : 0);
          await execAsync(
            `osascript -e 'tell application "System Events" to scroll {${deltaX}, ${deltaY}}'`
          );
          break;
        }

        case 'wait':
          await new Promise(r => setTimeout(r, 3000));
          break;

        case 'finished':
          return { status: 'end' };

        case 'call_user':
          return { status: 'call_user' };

        default:
          logger.warn(`未知动作: ${action_type}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`执行动作 ${action_type} 失败: ${msg}`);
    }
  }
}

// ============================================================================
// Tool Definition
// ============================================================================

export const guiAgentTool: Tool = {
  name: 'gui_agent',
  description: `Run an AI-driven GUI automation task on the desktop.

Uses UI-TARS SDK with Doubao vision model to: screenshot → analyze → execute actions → repeat.

When to use:
- Automate desktop application interactions (open app, click buttons, fill forms)
- E2E testing of Electron/desktop UI
- Cross-application workflows that can't be done via CLI

Parameters:
- task (required): Natural language description of what to do
- model (optional): Vision model ID (default: doubao-seed-1-6-vision-250815)
- max_steps (optional): Maximum action steps (default: 25)
- timeout_ms (optional): Timeout in milliseconds (default: 120000)

IMPORTANT:
- Requires screen access permission on macOS
- Only works with Volcengine Doubao vision models (GUI grounding trained)
- Uses doubao-seed-1-6-vision-250815 by default (only model with native UI-TARS coordinate format)
- Costs ~84K tokens (~¥0.30) per typical task`,
  generations: ['gen6', 'gen7', 'gen8'],
  requiresPermission: true,
  permissionLevel: 'execute',
  inputSchema: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: 'Natural language task description (e.g. "打开计算器，计算 123+456")',
      },
      model: {
        type: 'string',
        description: 'Vision model ID (default: doubao-seed-1-6-vision-250815)',
      },
      max_steps: {
        type: 'number',
        description: 'Maximum action steps (default: 25)',
      },
      timeout_ms: {
        type: 'number',
        description: 'Timeout in milliseconds (default: 120000)',
      },
    },
    required: ['task'],
  },

  async execute(
    params: Record<string, unknown>,
    _context: ToolContext
  ): Promise<ToolExecutionResult> {
    const task = params.task as string;
    const model = (params.model as string) || 'doubao-seed-1-6-vision-250815';
    const maxSteps = (params.max_steps as number) || 25;
    const timeoutMs = (params.timeout_ms as number) || 120_000;

    // 获取火山引擎 API Key（非标准 ModelProvider，直接从环境变量读取）
    const apiKey = process.env.VOLCENGINE_API_KEY || process.env.DOUBAO_API_KEY;

    if (!apiKey) {
      return {
        success: false,
        error: '未配置火山引擎 API Key。请在 .env 中设置 VOLCENGINE_API_KEY',
      };
    }

    // macOS only
    if (process.platform !== 'darwin') {
      return {
        success: false,
        error: 'GUI Agent 目前仅支持 macOS',
      };
    }

    try {
      // 动态导入 UI-TARS SDK（避免 CJS/ESM 冲突）
      const { GUIAgent, StatusEnum } = await import('@ui-tars/sdk');

      const operator = new MacOSOperator();
      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), timeoutMs);

      const steps: Array<{ step: number; action: string; thought: string }> = [];
      let stepCount = 0;
      let finalStatus = 'unknown';

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MacOSOperator 实现了 Operator 接口但未继承 SDK 抽象类
      const guiAgent = new GUIAgent({
        model: {
          baseURL: MODEL_API_ENDPOINTS.volcengine,
          apiKey,
          model,
          temperature: 0,
        },
        operator: operator as any,
        signal: abortController.signal,
        maxLoopCount: maxSteps,
        loopIntervalInMs: 1000,

        onData: ({ data }: { data: { status: string; conversations: Array<{ from: string; value?: string; predictionParsed?: ParsedPrediction[] }> } }) => {
          if (data.status === String(StatusEnum.RUNNING) && data.conversations?.length > 0) {
            for (const conv of data.conversations) {
              if (conv.from === 'gpt' && conv.predictionParsed) {
                stepCount++;
                const pred = conv.predictionParsed[0];
                if (pred) {
                  steps.push({
                    step: stepCount,
                    action: pred.action_type,
                    thought: pred.thought?.substring(0, 100) || '',
                  });
                  logger.info(`[${stepCount}] ${pred.action_type} - ${pred.thought?.substring(0, 80)}`);
                }
              }
            }
          }
          const terminalStatuses = [String(StatusEnum.END), String(StatusEnum.ERROR), String(StatusEnum.MAX_LOOP), String(StatusEnum.USER_STOPPED)];
          if (terminalStatuses.includes(data.status)) {
            finalStatus = data.status;
          }
        },
        onError: ({ error }: { error: Error }) => {
          logger.error(`GUI Agent 错误: ${error.message}`);
        },
      } as any);

      const startTime = Date.now();
      await guiAgent.run(task);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      clearTimeout(timeout);

      // 构建结果摘要
      const summary = [
        `任务: ${task}`,
        `模型: ${model}`,
        `状态: ${finalStatus}`,
        `步数: ${steps.length}`,
        `耗时: ${elapsed}s`,
        '',
        '执行步骤:',
        ...steps.map(s => `  ${s.step}. [${s.action}] ${s.thought}`),
      ].join('\n');

      return {
        success: finalStatus === 'end',
        output: summary,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: `GUI Agent 执行失败: ${msg}`,
      };
    }
  },
};

// ============================================================================
// GUI Agent - 基于 Claude Computer Use 的屏幕控制能力
// ============================================================================

import { screen, desktopCapturer, clipboard } from 'electron';
import { exec } from 'child_process';
import { promisify } from 'util';
import type {
  GUIAgentConfig,
  ScreenCapture,
  ComputerAction,
  ModelConfig,
} from '../../shared/types';
import { ModelRouter } from '../model/modelRouter';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('GUIAgent');
const execAsync = promisify(exec);

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

interface GUIAgentState {
  isRunning: boolean;
  lastScreenshot: ScreenCapture | null;
  actionHistory: ComputerAction[];
}

type ActionCallback = (action: ComputerAction, result: unknown) => void;

// ----------------------------------------------------------------------------
// GUI Agent
// ----------------------------------------------------------------------------

export class GUIAgent {
  private config: GUIAgentConfig;
  private modelRouter: ModelRouter;
  private modelConfig: ModelConfig;
  private state: GUIAgentState;
  private actionCallback?: ActionCallback;

  constructor(
    config: GUIAgentConfig,
    modelConfig: ModelConfig,
    modelRouter: ModelRouter
  ) {
    this.config = {
      screenshotQuality: 80,
      displayWidth: config.displayWidth || 1920,
      displayHeight: config.displayHeight || 1080,
    };

    this.modelConfig = {
      ...modelConfig,
      computerUse: true, // 强制启用 Computer Use
    };

    this.modelRouter = modelRouter;

    this.state = {
      isRunning: false,
      lastScreenshot: null,
      actionHistory: [],
    };
  }

  // --------------------------------------------------------------------------
  // Public Methods
  // --------------------------------------------------------------------------

  /**
   * 截取当前屏幕
   */
  async captureScreen(): Promise<ScreenCapture> {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.size;

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: this.config.displayWidth,
        height: this.config.displayHeight,
      },
    });

    const primarySource = sources[0];
    if (!primarySource) {
      throw new Error('No screen source available');
    }

    const thumbnail = primarySource.thumbnail;
    const dataUrl = thumbnail.toDataURL();
    const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');

    const capture: ScreenCapture = {
      width,
      height,
      data: base64Data,
      timestamp: Date.now(),
    };

    this.state.lastScreenshot = capture;
    return capture;
  }

  /**
   * 执行计算机操作
   */
  async executeAction(action: ComputerAction): Promise<unknown> {
    this.state.actionHistory.push(action);

    let result: unknown;

    switch (action.type) {
      case 'screenshot':
        result = await this.captureScreen();
        break;

      case 'click':
        result = await this.performClick(action.coordinate);
        break;

      case 'type':
        result = await this.performType(action.text);
        break;

      case 'key':
        result = await this.performKey(action.key);
        break;

      case 'scroll':
        result = await this.performScroll(action.direction, action.amount);
        break;

      case 'move':
        result = await this.performMove(action.coordinate);
        break;

      default:
        throw new Error(`Unknown action type: ${action.type}`);
    }

    if (this.actionCallback) {
      this.actionCallback(action, result);
    }

    return result;
  }

  /**
   * 运行 GUI Agent 循环
   */
  async run(
    task: string,
    onAction?: ActionCallback,
    maxIterations: number = 20
  ): Promise<string> {
    this.state.isRunning = true;
    this.actionCallback = onAction;

    const messages: Array<{ role: string; content: any }> = [
      {
        role: 'system',
        content: this.buildSystemPrompt(),
      },
      {
        role: 'user',
        content: task,
      },
    ];

    let iterations = 0;
    let finalResult = '';

    try {
      while (this.state.isRunning && iterations < maxIterations) {
        iterations++;

        // 获取当前屏幕截图
        const screenshot = await this.captureScreen();

        // 添加截图到消息
        const lastMessage = messages[messages.length - 1];
        if (lastMessage.role === 'user') {
          lastMessage.content = [
            {
              type: 'text',
              text: typeof lastMessage.content === 'string' ? lastMessage.content : task,
            },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: screenshot.data,
              },
            },
          ];
        }

        // 调用模型
        const response = await this.modelRouter.inference(
          messages,
          [], // Computer Use 工具由 Claude 原生支持
          this.modelConfig
        );

        if (response.type === 'text') {
          // 任务完成
          finalResult = response.content || '';
          break;
        }

        if (response.type === 'tool_use' && response.toolCalls) {
          // 执行工具调用
          const results: string[] = [];

          for (const toolCall of response.toolCalls) {
            if (toolCall.name === 'computer') {
              const action = this.parseComputerAction(toolCall.arguments);
              const result = await this.executeAction(action);
              results.push(JSON.stringify(result));
            }
          }

          // 添加工具结果
          messages.push({
            role: 'assistant',
            content: `Executed actions. Results: ${results.join(', ')}`,
          });

          messages.push({
            role: 'user',
            content: 'Please continue with the task or confirm completion.',
          });
        }
      }
    } finally {
      this.state.isRunning = false;
    }

    return finalResult;
  }

  /**
   * 停止 GUI Agent
   */
  stop(): void {
    this.state.isRunning = false;
  }

  /**
   * 获取操作历史
   */
  getActionHistory(): ComputerAction[] {
    return [...this.state.actionHistory];
  }

  /**
   * 清空操作历史
   */
  clearHistory(): void {
    this.state.actionHistory = [];
  }

  // --------------------------------------------------------------------------
  // Private Methods - Action Execution
  // --------------------------------------------------------------------------

  private async performClick(coordinate?: [number, number]): Promise<{ clicked: boolean }> {
    if (!coordinate) {
      throw new Error('Click requires coordinate');
    }

    const [x, y] = coordinate;
    logger.info(` Click at (${x}, ${y})`);

    // 使用 AppleScript 实现鼠标点击 (macOS)
    if (process.platform === 'darwin') {
      const script = `
        tell application "System Events"
          click at {${x}, ${y}}
        end tell
      `;
      try {
        await execAsync(`osascript -e '${script}'`);
      } catch (error) {
        // 备用方案：使用 cliclick（如果已安装）
        try {
          await execAsync(`cliclick c:${x},${y}`);
        } catch {
          logger.warn(' Click failed, cliclick not available');
        }
      }
    }

    return { clicked: true };
  }

  private async performType(text?: string): Promise<{ typed: boolean }> {
    if (!text) {
      throw new Error('Type requires text');
    }

    logger.info(` Type: ${text}`);

    // 使用剪贴板 + 粘贴的方式输入文本（更可靠）
    clipboard.writeText(text);

    // 触发 Cmd+V 粘贴 (macOS)
    if (process.platform === 'darwin') {
      const script = `
        tell application "System Events"
          keystroke "v" using command down
        end tell
      `;
      try {
        await execAsync(`osascript -e '${script}'`);
      } catch (error) {
        logger.warn(' Paste failed:', error);
      }
    }

    return { typed: true };
  }

  private async performKey(key?: string): Promise<{ pressed: boolean }> {
    if (!key) {
      throw new Error('Key press requires key');
    }

    logger.info(` Press key: ${key}`);

    // macOS 按键映射
    if (process.platform === 'darwin') {
      const keyMap: Record<string, string> = {
        enter: 'return',
        escape: 'escape',
        tab: 'tab',
        backspace: 'delete',
        delete: 'forward delete',
        up: 'up arrow',
        down: 'down arrow',
        left: 'left arrow',
        right: 'right arrow',
        space: 'space',
        home: 'home',
        end: 'end',
        pageup: 'page up',
        pagedown: 'page down',
      };

      const mappedKey = keyMap[key.toLowerCase()] || key;
      const script = `
        tell application "System Events"
          key code (key code "${mappedKey}")
        end tell
      `;

      // 简化的按键实现
      const simpleScript = `
        tell application "System Events"
          keystroke "${key.length === 1 ? key : ''}"
          ${key.toLowerCase() === 'enter' ? 'keystroke return' : ''}
          ${key.toLowerCase() === 'escape' ? 'key code 53' : ''}
          ${key.toLowerCase() === 'tab' ? 'keystroke tab' : ''}
        end tell
      `;

      try {
        await execAsync(`osascript -e '${simpleScript}'`);
      } catch (error) {
        logger.warn(' Key press failed:', error);
      }
    }

    return { pressed: true };
  }

  private async performScroll(
    direction?: 'up' | 'down' | 'left' | 'right',
    amount?: number
  ): Promise<{ scrolled: boolean }> {
    if (!direction) {
      throw new Error('Scroll requires direction');
    }

    const scrollAmount = amount || 3;
    logger.info(` Scroll ${direction} by ${scrollAmount}`);

    // macOS 滚动实现
    if (process.platform === 'darwin') {
      // 计算滚动方向和量
      let deltaX = 0;
      let deltaY = 0;

      switch (direction) {
        case 'up':
          deltaY = scrollAmount;
          break;
        case 'down':
          deltaY = -scrollAmount;
          break;
        case 'left':
          deltaX = scrollAmount;
          break;
        case 'right':
          deltaX = -scrollAmount;
          break;
      }

      // 使用 AppleScript 模拟滚动
      const script = `
        tell application "System Events"
          ${deltaY !== 0 ? `scroll (${deltaY > 0 ? 'up' : 'down'}) ${Math.abs(deltaY)}` : ''}
        end tell
      `;

      // 备用方案：使用按键模拟
      const keyScript = direction === 'up' || direction === 'down'
        ? `tell application "System Events" to key code ${direction === 'up' ? '126' : '125'} using {option down}`
        : '';

      try {
        if (keyScript) {
          await execAsync(`osascript -e '${keyScript}'`);
        }
      } catch (error) {
        logger.warn(' Scroll failed:', error);
      }
    }

    return { scrolled: true };
  }

  private async performMove(coordinate?: [number, number]): Promise<{ moved: boolean }> {
    if (!coordinate) {
      throw new Error('Move requires coordinate');
    }

    const [x, y] = coordinate;
    logger.info(` Move to (${x}, ${y})`);

    // macOS 鼠标移动
    if (process.platform === 'darwin') {
      try {
        // 使用 cliclick（如果已安装）
        await execAsync(`cliclick m:${x},${y}`);
      } catch {
        // AppleScript 不直接支持鼠标移动，记录日志
        logger.warn(' Mouse move requires cliclick: brew install cliclick');
      }
    }

    return { moved: true };
  }

  // --------------------------------------------------------------------------
  // Private Methods - Helpers
  // --------------------------------------------------------------------------

  private buildSystemPrompt(): string {
    return `You are a computer use agent that can control the user's computer screen.
You have access to the following actions:

1. screenshot - Take a screenshot of the current screen
2. click - Click at a specific coordinate [x, y]
3. type - Type text using the keyboard
4. key - Press a specific key (e.g., "enter", "escape", "tab")
5. scroll - Scroll the screen (up, down, left, right)
6. move - Move the mouse to a coordinate [x, y]

Screen dimensions: ${this.config.displayWidth}x${this.config.displayHeight}

When you receive a task:
1. First, analyze the current screenshot
2. Plan the sequence of actions needed
3. Execute actions one at a time
4. Verify the result after each action
5. Continue until the task is complete

Be precise with coordinates. The top-left corner is (0, 0).

If you cannot complete a task or encounter an error, explain what went wrong.`;
  }

  private parseComputerAction(args: Record<string, unknown>): ComputerAction {
    const action: ComputerAction = {
      type: args.action as ComputerAction['type'],
    };

    if (args.coordinate) {
      action.coordinate = args.coordinate as [number, number];
    }
    if (args.text) {
      action.text = args.text as string;
    }
    if (args.key) {
      action.key = args.key as string;
    }
    if (args.direction) {
      action.direction = args.direction as ComputerAction['direction'];
    }
    if (args.amount) {
      action.amount = args.amount as number;
    }

    return action;
  }
}

// ----------------------------------------------------------------------------
// Factory
// ----------------------------------------------------------------------------

let guiAgentInstance: GUIAgent | null = null;

export function getGUIAgent(): GUIAgent | null {
  return guiAgentInstance;
}

export function initGUIAgent(
  config: GUIAgentConfig,
  modelConfig: ModelConfig,
  modelRouter: ModelRouter
): GUIAgent {
  guiAgentInstance = new GUIAgent(config, modelConfig, modelRouter);
  return guiAgentInstance;
}

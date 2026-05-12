import type { RuntimeContext } from '../runtimeContext';
import { getToolSearchService } from '../../../services/toolSearch';
import { createLogger } from '../../../services/infra/logger';

const logger = createLogger('ContextAssembly');

type RuntimeForDeferredToolPreload = Pick<
  RuntimeContext,
  'enableToolDeferredLoading' | 'executionIntent' | 'messages'
>;

const COMPUTER_INTENT_RE =
  /\bcomputer[\s_-]?use\b|\bcomputer surface\b|\bscreenshot\b|\bscreen\s+capture\b|\bcapture\s+(?:the\s+)?(?:current\s+)?screen\b|\b(?:current\s+)?desktop\s+(?:context|browser|window|app)\b|frontmost|notepad|\bnotes\b|桌面|当前屏幕|屏幕|截屏|截图|鼠标|键盘|点击|双击|右键|滚动|拖拽|打开(?:记事本|备忘录|应用|窗口|app)/i;

const BROWSER_AUTOMATION_INTENT_RE =
  /\bbrowser[\s_-]?action\b|\bbrowser automation\b|\bplaywright\b|托管浏览器|浏览器自动化|打开(?:网页|网站|url)|访问(?:网页|网站|url)/i;

function getLatestUserText(runtime: RuntimeForDeferredToolPreload): string {
  for (let index = runtime.messages.length - 1; index >= 0; index -= 1) {
    const message = runtime.messages[index];
    if (message?.role === 'user' && message.visibility !== 'rewound') {
      return message.content || '';
    }
  }
  return '';
}

export function getDeferredToolsToPreloadForTurn(
  runtime: RuntimeForDeferredToolPreload,
): string[] {
  if (!runtime.enableToolDeferredLoading) {
    return [];
  }

  const tools = new Set<string>();
  const intent = runtime.executionIntent;
  const userText = getLatestUserText(runtime);

  if (intent?.browserSessionMode === 'desktop' || COMPUTER_INTENT_RE.test(userText)) {
    tools.add('Computer');
  }

  if (intent?.browserSessionMode === 'managed' && intent.allowBrowserAutomation !== false) {
    tools.add('Browser');
    tools.add('Computer');
  } else if (intent?.allowBrowserAutomation !== false && BROWSER_AUTOMATION_INTENT_RE.test(userText)) {
    tools.add('Browser');
  }

  return Array.from(tools);
}

export function preloadDeferredToolsForTurn(
  runtime: RuntimeForDeferredToolPreload,
): string[] {
  const toolNames = getDeferredToolsToPreloadForTurn(runtime);
  if (toolNames.length === 0) {
    return [];
  }

  const service = getToolSearchService();
  const loaded = new Set<string>();

  for (const toolName of toolNames) {
    try {
      const result = service.selectTool(toolName);
      for (const loadedTool of result.loadedTools) {
        loaded.add(loadedTool);
      }
    } catch (error) {
      logger.debug('[ContextAssembly] Deferred tool preload skipped', {
        toolName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const loadedTools = Array.from(loaded);
  if (loadedTools.length > 0) {
    logger.info('[ContextAssembly] Pre-loaded deferred tools for turn', {
      tools: loadedTools,
    });
  }
  return loadedTools;
}

import type { ToolExecutionResult } from '../types';
import { getBrowserService } from '../../services/infra/browserPool.js';

export type SmartComputerActionName =
  | 'locate_element'
  | 'locate_text'
  | 'locate_role'
  | 'smart_click'
  | 'smart_type'
  | 'smart_hover'
  | 'get_elements';

export interface BrowserSmartComputerAction {
  action: string;
  selector?: string;
  text?: string;
  role?: string;
  name?: string;
  exact?: boolean;
  timeout?: number;
}

export function isSmartAction(action: string): action is SmartComputerActionName {
  return [
    'locate_element',
    'locate_text',
    'locate_role',
    'smart_click',
    'smart_type',
    'smart_hover',
    'get_elements',
  ].includes(action);
}

export async function executeSmartAction(
  action: BrowserSmartComputerAction,
  agentId?: string,
): Promise<ToolExecutionResult> {
  const browser = getBrowserService(agentId);
  if (!browser.isRunning()) {
    return {
      success: false,
      error: 'Browser not running. Use browser_action with action="launch" first, then "new_tab" to open a page.',
    };
  }

  const activeTab = browser.getActiveTab();
  if (!activeTab) {
    return {
      success: false,
      error: 'No active tab. Use browser_action with action="new_tab" first.',
    };
  }

  const page = activeTab.page;
  const timeout = action.timeout || 5000;

  switch (action.action) {
    case 'locate_element':
      return locateBySelector(page, action.selector, timeout);
    case 'locate_text':
      return locateByText(page, action.text, action.exact, timeout);
    case 'locate_role':
      return locateByRole(page, action.role, action.name, action.exact, timeout);
    case 'smart_click':
      return smartClick(page, action, timeout);
    case 'smart_type':
      return smartType(page, action, timeout);
    case 'smart_hover':
      return smartHover(page, action, timeout);
    case 'get_elements':
      return getInteractiveElements(page);
    default:
      return { success: false, error: `Unknown smart action: ${action.action}` };
  }
}

async function locateBySelector(
  page: import('playwright').Page,
  selector: string | undefined,
  timeout: number,
): Promise<ToolExecutionResult> {
  if (!selector) {
    return { success: false, error: 'selector required for locate_element' };
  }
  try {
    const element = await page.waitForSelector(selector, { timeout });
    if (!element) {
      return { success: false, error: `Element not found: ${selector}` };
    }
    const box = await element.boundingBox();
    if (!box) {
      return { success: false, error: 'Element has no bounding box (may be hidden)' };
    }
    const centerX = Math.round(box.x + box.width / 2);
    const centerY = Math.round(box.y + box.height / 2);
    return {
      success: true,
      output: `Element found at (${centerX}, ${centerY})\nBounding box: x=${Math.round(box.x)}, y=${Math.round(box.y)}, width=${Math.round(box.width)}, height=${Math.round(box.height)}`,
      metadata: { x: centerX, y: centerY, box },
    };
  } catch {
    return { success: false, error: `Element not found within ${timeout}ms: ${selector}` };
  }
}

async function locateByText(
  page: import('playwright').Page,
  text: string | undefined,
  exact: boolean | undefined,
  timeout: number,
): Promise<ToolExecutionResult> {
  if (!text) {
    return { success: false, error: 'text required for locate_text' };
  }
  try {
    const textSelector = exact ? `text="${text}"` : `text=${text}`;
    const element = await page.waitForSelector(textSelector, { timeout });
    if (!element) {
      return { success: false, error: `Text not found: "${text}"` };
    }
    const box = await element.boundingBox();
    if (!box) {
      return { success: false, error: 'Element has no bounding box (may be hidden)' };
    }
    const centerX = Math.round(box.x + box.width / 2);
    const centerY = Math.round(box.y + box.height / 2);
    return {
      success: true,
      output: `Text "${text}" found at (${centerX}, ${centerY})`,
      metadata: { x: centerX, y: centerY, box },
    };
  } catch {
    return { success: false, error: `Text not found within ${timeout}ms: "${text}"` };
  }
}

async function locateByRole(
  page: import('playwright').Page,
  role: string | undefined,
  name: string | undefined,
  exact: boolean | undefined,
  timeout: number,
): Promise<ToolExecutionResult> {
  if (!role) {
    return { success: false, error: 'role required for locate_role' };
  }
  try {
    type RoleType = Parameters<typeof page.getByRole>[0];
    const locator = name
      ? page.getByRole(role as RoleType, { name, exact })
      : page.getByRole(role as RoleType);

    await locator.waitFor({ timeout });
    const box = await locator.boundingBox();
    if (!box) {
      return { success: false, error: 'Element has no bounding box (may be hidden)' };
    }
    const centerX = Math.round(box.x + box.width / 2);
    const centerY = Math.round(box.y + box.height / 2);
    return {
      success: true,
      output: `Role="${role}"${name ? ` name="${name}"` : ''} found at (${centerX}, ${centerY})`,
      metadata: { x: centerX, y: centerY, box },
    };
  } catch {
    return { success: false, error: `Role not found within ${timeout}ms: role="${role}"${name ? ` name="${name}"` : ''}` };
  }
}

async function smartClick(
  page: import('playwright').Page,
  action: BrowserSmartComputerAction,
  timeout: number,
): Promise<ToolExecutionResult> {
  if (!action.selector && !action.text && !action.role) {
    return { success: false, error: 'selector, text, or role required for smart_click' };
  }
  try {
    if (action.selector) {
      await page.click(action.selector, { timeout });
      return { success: true, output: `Clicked element: ${action.selector}` };
    }
    if (action.text) {
      const textSelector = action.exact ? `text="${action.text}"` : `text=${action.text}`;
      await page.click(textSelector, { timeout });
      return { success: true, output: `Clicked text: "${action.text}"` };
    }
    if (action.role) {
      type RoleType = Parameters<typeof page.getByRole>[0];
      const locator = action.name
        ? page.getByRole(action.role as RoleType, { name: action.name, exact: action.exact })
        : page.getByRole(action.role as RoleType);
      await locator.click({ timeout });
      return { success: true, output: `Clicked role="${action.role}"${action.name ? ` name="${action.name}"` : ''}` };
    }
    return { success: false, error: 'No valid target specified' };
  } catch (error) {
    return { success: false, error: `Click failed: ${error instanceof Error ? error.message : 'Unknown error'}` };
  }
}

async function smartType(
  page: import('playwright').Page,
  action: BrowserSmartComputerAction,
  timeout: number,
): Promise<ToolExecutionResult> {
  if (!action.selector && !action.role) {
    return { success: false, error: 'selector or role required for smart_type' };
  }
  if (action.text === undefined) {
    return { success: false, error: 'text required for smart_type' };
  }
  try {
    const lengthPreview = `${action.text.length} chars`;
    if (action.selector) {
      await page.fill(action.selector, action.text, { timeout });
      return { success: true, output: `Typed ${lengthPreview} into ${action.selector}` };
    }
    if (action.role) {
      type RoleType = Parameters<typeof page.getByRole>[0];
      const locator = action.name
        ? page.getByRole(action.role as RoleType, { name: action.name, exact: action.exact })
        : page.getByRole(action.role as RoleType);
      await locator.fill(action.text, { timeout });
      return { success: true, output: `Typed ${lengthPreview} into role="${action.role}"` };
    }
    return { success: false, error: 'No valid target specified' };
  } catch (error) {
    return { success: false, error: `Type failed: ${error instanceof Error ? error.message : 'Unknown error'}` };
  }
}

async function smartHover(
  page: import('playwright').Page,
  action: BrowserSmartComputerAction,
  timeout: number,
): Promise<ToolExecutionResult> {
  if (!action.selector && !action.text) {
    return { success: false, error: 'selector or text required for smart_hover' };
  }
  try {
    if (action.selector) {
      await page.hover(action.selector, { timeout });
      return { success: true, output: `Hovered over: ${action.selector}` };
    }
    if (action.text) {
      const textSelector = action.exact ? `text="${action.text}"` : `text=${action.text}`;
      await page.hover(textSelector, { timeout });
      return { success: true, output: `Hovered over text: "${action.text}"` };
    }
    return { success: false, error: 'No valid target specified' };
  } catch (error) {
    return { success: false, error: `Hover failed: ${error instanceof Error ? error.message : 'Unknown error'}` };
  }
}

async function getInteractiveElements(
  page: import('playwright').Page,
): Promise<ToolExecutionResult> {
  try {
    const selector = 'button, a, input, select, textarea, [role="button"], [role="link"], [onclick], [tabindex]';
    const elements = await page.locator(selector).all();

    if (elements.length === 0) {
      return { success: true, output: 'No interactive elements found on page.' };
    }

    const results: Array<{
      index: number;
      tag: string;
      role: string;
      text: string;
      selector: string;
      x: number;
      y: number;
    }> = [];

    const limit = Math.min(elements.length, 30);
    for (let i = 0; i < limit; i++) {
      const element = elements[i];
      try {
        const box = await element.boundingBox();
        if (!box || box.width === 0 || box.height === 0) continue;

        const tagName = await element.evaluate((node) => node.tagName.toLowerCase());
        const role = await element.getAttribute('role') || '';
        const text = (await element.textContent() || '').trim().substring(0, 50);
        const placeholder = await element.getAttribute('placeholder') || '';
        const ariaLabel = await element.getAttribute('aria-label') || '';
        const id = await element.getAttribute('id');
        const className = await element.getAttribute('class');

        const displayText = text || placeholder || ariaLabel || '(no text)';
        const selectorHint = id ? `#${id}` : (className ? `.${className.split(' ').filter(Boolean)[0]}` : tagName);

        results.push({
          index: results.length + 1,
          tag: tagName,
          role,
          text: displayText,
          selector: selectorHint,
          x: Math.round(box.x + box.width / 2),
          y: Math.round(box.y + box.height / 2),
        });
      } catch {
        // Skip elements that cannot be queried after locator discovery.
      }
    }

    if (results.length === 0) {
      return { success: true, output: 'No visible interactive elements found on page.' };
    }

    const output = results.map((element) =>
      `${element.index}. <${element.tag}${element.role ? ` role="${element.role}"` : ''}> "${element.text}" at (${element.x}, ${element.y}) - ${element.selector}`,
    ).join('\n');

    return {
      success: true,
      output: `Found ${results.length} interactive elements:\n${output}`,
      metadata: { elements: results },
    };
  } catch (error) {
    return { success: false, error: `Failed to get elements: ${error instanceof Error ? error.message : 'Unknown error'}` };
  }
}

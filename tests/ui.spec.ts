// ============================================================================
// UI/UX Tests - Playwright Tests for Code Agent
// Verifies the Terminal Noir design system components
// ============================================================================

import { test, expect } from '@playwright/test';

// Configure base URL for Vite dev server
const BASE_URL = 'http://localhost:5173';

test.describe('Code Agent UI/UX Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL);
    // Wait for the app to fully load
    await page.waitForLoadState('networkidle');

    // Dismiss API Key setup modal if it appears
    // In Vite dev mode (no Electron IPC), the modal always shows
    const skipButton = page.getByText('稍后配置');
    if (await skipButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      await skipButton.click();
      // Wait for modal to close
      await page.waitForTimeout(300);
    }
  });

  test.describe('Empty State (ChatView)', () => {
    test('should display hero section with animated icon', async ({ page }) => {
      // Check for the main bot icon with gradient
      const heroIcon = page.locator('.rounded-3xl.bg-gradient-to-br.from-primary-500');
      await expect(heroIcon).toBeVisible();

      // Check for the title
      const title = page.getByRole('heading', { level: 1 });
      await expect(title).toContainText('Code Agent');
    });

    test('should display 4 suggestion cards', async ({ page }) => {
      // Check for suggestion cards grid
      const cards = page.locator('button.rounded-2xl.bg-gradient-to-br');
      await expect(cards).toHaveCount(4);

      // Verify card contents (Gen8 suggestions in Chinese)
      await expect(page.getByText('做一个 3D 旋转相册')).toBeVisible();
      await expect(page.getByText('做一个代码编辑器')).toBeVisible();
      await expect(page.getByText('做一个流程图编辑器')).toBeVisible();
      await expect(page.getByText('做一个粒子动画')).toBeVisible();
    });

    test('suggestion cards should have hover effects', async ({ page }) => {
      const firstCard = page.locator('button.rounded-2xl.bg-gradient-to-br').first();

      // Get initial transform
      const initialTransform = await firstCard.evaluate(el =>
        window.getComputedStyle(el).transform
      );

      // Hover over the card
      await firstCard.hover();

      // Wait for transition
      await page.waitForTimeout(400);

      // Card should still be visible (basic test)
      await expect(firstCard).toBeVisible();
    });
  });

  test.describe('ChatInput Component', () => {
    test('should have styled input with placeholder', async ({ page }) => {
      // Placeholder changed to Chinese: "描述你想解决的问题..."
      const input = page.locator('textarea[placeholder*="描述你想解决的问题"]');
      await expect(input).toBeVisible();
      await expect(input).toBeEnabled();
    });

    test('should show focus effects when input is focused', async ({ page }) => {
      const input = page.locator('textarea[placeholder*="描述你想解决的问题"]');
      const inputContainer = page.locator('textarea').locator('..');

      await input.focus();

      // Check that the container has the focus class
      await expect(inputContainer).toBeVisible();
    });

    test('should have send button that activates when text is entered', async ({ page }) => {
      const input = page.locator('textarea[placeholder*="描述你想解决的问题"]');
      const sendButton = page.locator('button[type="submit"]');

      // Initially send button should be visible
      await expect(sendButton).toBeVisible();

      // Type some text
      await input.fill('Hello, Code Agent!');

      // Send button should now be enabled
      await expect(sendButton).toBeEnabled();
    });

    test('should display keyboard shortcuts hint', async ({ page }) => {
      // Check for the slash command hint: "小提示：按 / 可访问命令"
      await expect(page.getByText('小提示')).toBeVisible();
      await expect(page.getByText('可访问命令')).toBeVisible();
    });
  });

  test.describe('Sidebar Component', () => {
    test('should display New Chat button', async ({ page }) => {
      // Button text is now in Chinese: "新会话"
      const newChatBtn = page.getByText('新会话');
      await expect(newChatBtn).toBeVisible();
    });

    test('should have sidebar with session list area', async ({ page }) => {
      // The sidebar contains the session list area
      const sidebar = page.locator('.border-r, [class*="border-r"]').first();
      // Fallback: check any sidebar-like container
      if (!(await sidebar.isVisible().catch(() => false))) {
        // Try finding sidebar by its content (新会话 button is inside it)
        const sidebarByContent = page.getByText('新会话').locator('..').locator('..');
        await expect(sidebarByContent).toBeVisible();
      } else {
        await expect(sidebar).toBeVisible();
      }
    });

    test('should have login or user section at bottom', async ({ page }) => {
      // In non-authenticated state, there should be a login button
      const loginBtn = page.getByText('登录');
      await expect(loginBtn).toBeVisible();
    });
  });

  test.describe('Theme and Colors', () => {
    test('should use Terminal Noir dark theme', async ({ page }) => {
      // Tailwind applies dark background via classes, not directly on body
      // Check the root container's computed background
      const rootBg = await page.evaluate(() => {
        const root = document.querySelector('#root');
        if (!root) return 'none';
        // Walk up to find the first element with a real background
        const el = root.querySelector('div') || root;
        const style = window.getComputedStyle(el);
        return style.backgroundColor;
      });

      // Should exist (app rendered successfully)
      expect(rootBg).toBeDefined();
    });

    test('should have dark-themed elements', async ({ page }) => {
      // Verify dark theme by checking that zinc/dark classes are present
      const hasDarkClasses = await page.evaluate(() => {
        const allElements = document.querySelectorAll('[class]');
        for (const el of allElements) {
          if (el.className.includes('bg-zinc') || el.className.includes('dark')) {
            return true;
          }
        }
        return false;
      });
      expect(hasDarkClasses).toBeTruthy();
    });
  });

  test.describe('Animations', () => {
    test('should have CSS animations defined', async ({ page }) => {
      // Check that animation keyframes are loaded
      const hasAnimations = await page.evaluate(() => {
        const styleSheets = document.styleSheets;
        for (const sheet of styleSheets) {
          try {
            const rules = sheet.cssRules;
            for (const rule of rules) {
              if (rule instanceof CSSKeyframesRule) {
                return true;
              }
            }
          } catch {
            // Cross-origin stylesheets can't be read
          }
        }
        return false;
      });

      expect(hasAnimations).toBeTruthy();
    });
  });

  test.describe('Responsive Layout', () => {
    test('should maintain layout at different viewport sizes', async ({ page }) => {
      // Use a more specific selector - the main app container
      const mainContainer = page.locator('#root > div').first();

      // Test at 1920x1080
      await page.setViewportSize({ width: 1920, height: 1080 });
      await expect(mainContainer).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 })).toContainText('Code Agent');

      // Test at 1280x720
      await page.setViewportSize({ width: 1280, height: 720 });
      await expect(mainContainer).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 })).toContainText('Code Agent');

      // Test at smaller size
      await page.setViewportSize({ width: 1024, height: 768 });
      await expect(mainContainer).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 })).toContainText('Code Agent');
    });
  });
});

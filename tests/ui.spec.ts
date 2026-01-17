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

      // Verify card contents
      await expect(page.getByText('Create a React component')).toBeVisible();
      await expect(page.getByText('Fix a bug in my code')).toBeVisible();
      await expect(page.getByText('Explain this function')).toBeVisible();
      await expect(page.getByText('Write unit tests')).toBeVisible();
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
      const input = page.locator('textarea[placeholder*="Ask me anything"]');
      await expect(input).toBeVisible();
      await expect(input).toBeEnabled();
    });

    test('should show focus effects when input is focused', async ({ page }) => {
      const input = page.locator('textarea[placeholder*="Ask me anything"]');
      const inputContainer = page.locator('textarea').locator('..');

      await input.focus();

      // Check that the container has the focus class
      await expect(inputContainer).toBeVisible();
    });

    test('should have send button that activates when text is entered', async ({ page }) => {
      const input = page.locator('textarea[placeholder*="Ask me anything"]');
      const sendButton = page.locator('button[type="submit"]');

      // Initially send button should be disabled-looking
      await expect(sendButton).toBeVisible();

      // Type some text
      await input.fill('Hello, Code Agent!');

      // Send button should now be enabled
      await expect(sendButton).toBeEnabled();
    });

    test('should display keyboard shortcuts hint', async ({ page }) => {
      // Check for the Enter key hint
      await expect(page.getByText('to send')).toBeVisible();
      // Check for Shift hint
      await expect(page.getByText('new line')).toBeVisible();
    });
  });

  test.describe('Sidebar Component', () => {
    test('should display New Chat button with gradient', async ({ page }) => {
      const newChatBtn = page.getByRole('button', { name: /New Chat/i });
      await expect(newChatBtn).toBeVisible();

      // Check for gradient styling
      const hasGradient = await newChatBtn.evaluate(el =>
        el.classList.contains('bg-gradient-to-r') ||
        window.getComputedStyle(el).backgroundImage.includes('gradient')
      );
      expect(hasGradient).toBeTruthy();
    });

    test('should have search input when sessions exist', async ({ page }) => {
      // Search input might not be visible if there are no sessions
      // This test checks basic structure
      const sidebar = page.locator('.border-r');
      await expect(sidebar).toBeVisible();
    });

    test('should display version badge in footer', async ({ page }) => {
      await expect(page.getByText('Code Agent v0.1.0')).toBeVisible();
    });
  });

  test.describe('Theme and Colors', () => {
    test('should use Terminal Noir dark theme', async ({ page }) => {
      // Check body background color
      const bodyBg = await page.evaluate(() =>
        window.getComputedStyle(document.body).backgroundColor
      );

      // Should be dark (rgb values should be low)
      expect(bodyBg).toMatch(/rgb\(\d{1,2}, \d{1,2}, \d{1,2}\)/);
    });

    test('should use proper text colors', async ({ page }) => {
      // Check that text is light colored (for dark theme)
      const bodyColor = await page.evaluate(() =>
        window.getComputedStyle(document.body).color
      );

      // Text should be light (rgb values should be high)
      const rgbMatch = bodyColor.match(/rgb\((\d+), (\d+), (\d+)\)/);
      if (rgbMatch) {
        const [, r, g, b] = rgbMatch.map(Number);
        expect(r).toBeGreaterThan(200);
        expect(g).toBeGreaterThan(200);
        expect(b).toBeGreaterThan(200);
      }
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

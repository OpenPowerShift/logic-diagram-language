import { test, expect } from '@playwright/test';

test.describe('LDL Visual Rendering', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('app loads with editor and viewer', async ({ page }) => {
    const editor = page.locator('ldl-editor');
    const viewer = page.locator('ldl-viewer');
    await expect(editor).toBeVisible();
    await expect(viewer).toBeVisible();
  });

  test('default example renders a diagram', async ({ page }) => {
    await page.waitForTimeout(1000);
    const svg = page.locator('ldl-viewer svg');
    await expect(svg).toBeVisible({ timeout: 5000 });
  });

  test('AND gate renders correctly', async ({ page }) => {
    await page.waitForTimeout(500);
    const svg = page.locator('ldl-viewer svg');
    await expect(svg).toBeVisible({ timeout: 5000 });

    const andGates = page.locator('.ldl-gate-and');
    await expect(andGates).toBeVisible({ timeout: 3000 });
  });

  test('screenshot comparison - basic logic', async ({ page }) => {
    await page.waitForTimeout(1000);
    await expect(page.locator('.pane-right')).toHaveScreenshot('basic-logic.png', {
      maxDiffPixelRatio: 0.05,
    });
  });
});
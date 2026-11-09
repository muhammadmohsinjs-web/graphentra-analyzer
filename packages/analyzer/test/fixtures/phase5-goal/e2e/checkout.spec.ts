import { test, expect } from '@playwright/test';

test.describe('checkout', () => {
  test('pays for an order', async ({ page }) => {
    await page.goto('/checkout');
    await page.getByRole('button', { name: 'Pay' }).click();
    await expect(page.getByText('Thanks')).toBeVisible();
  });
});

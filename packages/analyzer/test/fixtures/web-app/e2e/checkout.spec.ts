import { test, expect } from '@playwright/test';

test.describe('checkout', () => {
  test('customer places an order with a saved card', async ({ page }) => {
    await page.goto('/cart');
    await page.getByRole('link', { name: 'Proceed to checkout' }).click();
    await page.getByLabel('Card number').fill('4242 4242 4242 4242');
    await page.getByRole('button', { name: 'Place order' }).click();
    await expect(page.getByText('Order history')).toBeVisible();
  });
});

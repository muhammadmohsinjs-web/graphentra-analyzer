import assert from 'node:assert/strict';
import { test } from 'node:test';
import { outlineSource } from '../src/source-outline';

const sample = `
import { Card } from './card';
import { Card as Saved } from './card';
import { t } from '../i18n';

export const MINIMUM_ORDER = 1;

/** Charges the customer's saved card.
 * Second line is not kept. */
export function chargeCard(amount: number, card?: Card): boolean {
  const secret = 'never shown in the outline body';
  if (amount < 1) return false;
  return Boolean(card);
}

export class Checkout extends Base {
  total = 0;
  submit(order: Order): void {
    alert(t('labels.paymentDeclined'));
  }
  private reset = () => { this.total = 0; };
}

export const Toolbar = memo((props: Props) => <button>Proceed to checkout</button>);
`;

test('outline keeps declarations, docs, thresholds and visible text, and drops function bodies', () => {
  const outline = outlineSource('src/checkout.tsx', sample);
  assert.match(outline, /^\/\/ \d+ lines/);
  assert.match(outline, /^imports: \.\/card, \.\.\/i18n$/m, 'imports are listed once each');
  assert.match(outline, /^export const MINIMUM_ORDER = 1$/m);
  assert.match(outline, /^export function chargeCard\(amount: number, card\?: Card\): boolean {2}\/\/ Charges the customer's saved card\.$/m);
  assert.match(outline, /^export class Checkout extends Base$/m);
  assert.match(outline, /^ {2}submit\(order: Order\): void$/m);
  assert.match(outline, /^ {2}private reset = \(\)$/m);
  assert.match(outline, /^export const Toolbar = memo\(…\)$/m);
  assert.match(outline, /^checks: amount < 1$/m);
  assert.match(outline, /"t:labels\.paymentDeclined"/);
  assert.match(outline, /"Proceed to checkout"/);
  assert.doesNotMatch(outline, /Second line|return Boolean/);
});

test('outline is capped in size and deterministic', () => {
  const big = Array.from({ length: 400 }, (_, index) => `export function step${index}(value: number): number { return value + ${index}; }`).join('\n');
  const outline = outlineSource('src/steps.ts', big, 2_000);
  assert.ok(outline.length <= 2_000);
  assert.match(outline, /outline truncated$/);
  assert.equal(outlineSource('src/steps.ts', big, 2_000), outline);
});

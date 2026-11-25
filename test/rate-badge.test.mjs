// 倍率徽标契约测试：Host（Core 选择器 badge）与 Client（设置页角标）共用同一份规则。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatRate, rateBadge, rateBadgeNote, rateDiscountDays, FREE_RATE_LABEL } from '../src/rate-badge.mjs';

const NOW = Date.parse('2026-11-26T12:00:00+08:00');

test('formatRate 固定两位小数并带 x 前缀', () => {
  assert.equal(formatRate(2.5), 'x2.50');
  assert.equal(formatRate(4.5), 'x4.50');
  assert.equal(formatRate(0.875), 'x0.88');
  assert.equal(formatRate(7), 'x7.00');
  assert.equal(formatRate(Number.NaN), undefined);
  assert.equal(formatRate(-1), undefined);
  assert.equal(formatRate(undefined), undefined);
});

test('rateBadge 常规倍率为 neutral，活动期为 info', () => {
  assert.deepEqual(rateBadge({ multiplier: 4.5, regularMultiplier: 4.5, discounted: false }), { label: 'x4.50', tone: 'neutral' });
  assert.deepEqual(
    rateBadge({ multiplier: 3.6, regularMultiplier: 4.5, discounted: true, discountEndsAt: '2026-12-07T23:59:59+08:00' }),
    { label: 'x3.60', tone: 'info' }
  );
});

test('缺数据或非法倍率不给徽标，不谎报免费', () => {
  assert.equal(rateBadge(undefined), undefined);
  assert.equal(rateBadge(null), undefined);
  assert.equal(rateBadge({}), undefined);
  assert.equal(rateBadge({ multiplier: Number.NaN }), undefined);
  assert.equal(rateBadge({ multiplier: Number.POSITIVE_INFINITY }), undefined);
  assert.equal(rateBadge({ multiplier: -1 }), undefined);
});

test('点倍率 0 视为免费', () => {
  assert.deepEqual(rateBadge({ multiplier: 0, regularMultiplier: 0 }), { label: FREE_RATE_LABEL, tone: 'success' });
});

test('rateDiscountDays 只对有效未结束的截止时间给天数', () => {
  assert.equal(rateDiscountDays('2026-12-07T23:59:59+08:00', NOW), 12);
  assert.equal(rateDiscountDays('2026-11-26T23:00:00+08:00', NOW), 1);
  assert.equal(rateDiscountDays('2026-11-25T00:00:00+08:00', NOW), undefined);
  assert.equal(rateDiscountDays(undefined, NOW), undefined);
  assert.equal(rateDiscountDays('not-a-date', NOW), undefined);
});

test('rateBadgeNote 只在活动期给出剩余天数', () => {
  assert.equal(rateBadgeNote({ discounted: true, discountEndsAt: '2026-12-07T23:59:59+08:00' }, NOW), '活动 12 天');
  assert.equal(rateBadgeNote({ discounted: true }, NOW), '活动');
  assert.equal(rateBadgeNote({ discounted: false, discountEndsAt: '2026-12-07T23:59:59+08:00' }, NOW), undefined);
  assert.equal(rateBadgeNote(undefined, NOW), undefined);
});

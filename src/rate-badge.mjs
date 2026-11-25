// 倍率徽标共享契约：Host 用它给 Core 模型选择器补 LlmModelInfo.badge，Client 用它渲染设置页角标。
// 该模块必须保持浏览器安全：只做纯计算，不引入 node: 模块，也不读取时间以外的外部状态。

/**
 * 倍率格式化：两位小数并带 `x` 前缀（选择器徽标宽度有限，两位小数才可横向比较）。
 * 与 unified-router 的 `formatRate` 保持同一约定：`2.5 → x2.50`。
 * @param {unknown} multiplier
 * @returns {string|undefined}
 */
export function formatRate(multiplier) {
  const value = Number(multiplier);
  return Number.isFinite(value) && value >= 0 ? `x${value.toFixed(2)}` : undefined;
}

/** 免费或点倍率 0 时展示的文案；中英文同形，Core 要求 en 必填。 */
export const FREE_RATE_LABEL = '免费';

/**
 * 把 `resolveConsumption` 的结果翻成徽标视图。
 * 规则（与 unified-router 同口径）：
 * - 缺数据 / 非有限 / 负数 → undefined（**未知不给徽标**，不谎报免费）；
 * - 0 倍率 → `免费`，tone `success`；
 * - 活动折扣生效 → 当前倍率，tone `info`（这就是「活动标志」）；
 * - 其余 → 当前倍率，tone `neutral`。
 * @param {{multiplier?: number, discounted?: boolean}|null|undefined} consumption
 * @returns {{label: string, tone: 'neutral'|'info'|'success'}|undefined}
 */
export function rateBadge(consumption) {
  if (!consumption || typeof consumption !== 'object') return undefined;
  const value = Number(consumption.multiplier);
  if (!Number.isFinite(value) || value < 0) return undefined;
  if (value === 0) return { label: FREE_RATE_LABEL, tone: 'success' };
  const label = formatRate(value);
  if (!label) return undefined;
  return { label, tone: consumption.discounted === true ? 'info' : 'neutral' };
}

/**
 * 活动剩余整天数；没有有效截止时间或已结束时返回 undefined。
 * @param {unknown} endsAt ISO 时间串
 * @param {number} now 毫秒时间戳
 * @returns {number|undefined}
 */
export function rateDiscountDays(endsAt, now = Date.now()) {
  const ends = Date.parse(String(endsAt ?? ''));
  if (!Number.isFinite(ends) || !Number.isFinite(now) || ends <= now) return undefined;
  return Math.max(1, Math.ceil((ends - now) / 86400000));
}

/**
 * 设置页角标的辅助文案：活动期给出剩余天数，常规期返回空。
 * @param {{discounted?: boolean, discountEndsAt?: string}|null|undefined} consumption
 * @returns {string|undefined}
 */
export function rateBadgeNote(consumption, now = Date.now()) {
  if (consumption?.discounted !== true) return undefined;
  const days = rateDiscountDays(consumption.discountEndsAt, now);
  return days === undefined ? '活动' : `活动 ${days} 天`;
}

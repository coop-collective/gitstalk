import { describe, expect, it } from 'vitest';

import { intentCheckedBeans, withIntents } from './landed-since-fork';

describe('intentCheckedBeans', () => {
  it('reads every Intent-checked trailer, comma or space separated, without bean/ prefixes', () => {
    const message = [
      'Add $5 shipping in dollars',
      '',
      'Intent-checked: price-dollars, bean/tax',
      'intent-checked: rounding',
    ].join('\n');
    expect([...intentCheckedBeans(message)]).toEqual(['price-dollars', 'tax', 'rounding']);
  });

  it('names nothing without a message or a trailer', () => {
    expect(intentCheckedBeans(null).size).toBe(0);
    expect(intentCheckedBeans('Intent checked price-dollars by eye').size).toBe(0);
  });
});

describe('withIntents', () => {
  it('adds each landed bean’s intent and the files both beans changed', () => {
    const landed = [{ bean: 'price-dollars', files: ['src/price.mjs', 'src/checkout.mjs'] }];
    const intents = withIntents(landed, {
      files: ['src/checkout.mjs'],
      intent: (bean) => (bean === 'price-dollars' ? 'Price in dollars, not cents' : null),
    });
    expect(intents).toEqual([
      { ...landed[0], intent: 'Price in dollars, not cents', sharedFiles: ['src/checkout.mjs'] },
    ]);
  });
});

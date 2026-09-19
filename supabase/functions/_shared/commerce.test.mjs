import test from 'node:test';
import assert from 'node:assert/strict';

const environment = new Map([
  ['PORTONE_STORE_ID', 'store-test'],
  ['PORTONE_CHANNEL_KEY', 'channel-test'],
  ['SUPABASE_URL', 'https://whtejsviizgejauasqqt.supabase.co'],
]);
globalThis.Deno = { env: { get: (key) => environment.get(key) } };
const commerce = await import('./commerce.ts');

test('production checkout URLs never delegate the API origin to a query parameter', () => {
  const token = 'a'.repeat(43);
  const checkout = new URL(commerce.checkoutPageURL(token));
  assert.equal(checkout.origin, 'https://sidey-app.github.io');
  assert.equal(checkout.pathname, '/SIDEY/checkout/');
  assert.equal(checkout.search, '');
  assert.equal(checkout.hash, `#token=${token}`);
  const redirect = new URL(commerce.checkoutRedirectURL(token, 'character_tree'));
  assert.equal(redirect.searchParams.has('api'), false);
  assert.equal(redirect.searchParams.get('result'), 'complete');
  assert.equal(redirect.hash, `#token=${token}`);
});

test('LIVE verification requires the exact store, channel, amount, currency and payment method', () => {
  const order = { payment_id: 'payment-test', payment_environment: 'live', amount_krw: 1100, currency: 'KRW' };
  const payment = { id: 'payment-test', storeId: 'store-test', channel: { key: 'channel-test', type: 'LIVE' },
    version: 'V2', status: 'PAID', amount: { total: 1100 }, currency: 'KRW', method: { type: 'PaymentMethodEasyPay' } };
  assert.equal(commerce.validatePortOnePayment(payment, order, 'PAID'), payment);
  for (const patch of [{ storeId: 'other' }, { channel: { key: 'other', type: 'LIVE' } },
    { channel: { key: 'channel-test', type: 'TEST' } }, { amount: { total: 100 } },
    { currency: 'USD' }, { version: 'V1' }, { status: 'READY' }, { method: { type: 'PaymentMethodCard' } }]) {
    assert.throws(() => commerce.validatePortOnePayment({ ...payment, ...patch }, order, 'PAID'),
      { code: 'payment_verification_failed' });
  }
});

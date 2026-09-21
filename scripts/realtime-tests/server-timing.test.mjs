import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePostgrestServerTiming as parse } from '../../supabase/functions/_shared/realtime-server-timing.mjs';

test('PostgREST canonical stages return only numeric millisecond measurements', () => {
  assert.deepEqual(parse('jwt;dur=14.9, parse;dur=71.1, plan;dur=109.0, transaction;dur=353.2, response;dur=4.4'),
    { jwt: 14.9, parse: 71.1, plan: 109, transaction: 353.2, response: 4.4 });
  assert.deepEqual(parse(' JWT ; DUR = 0, transaction;dur=120000, unrelated;dur=10'), { jwt: 0, transaction: 120000 });
});

test('absent, oversized, malformed and nonfinite measurements never become zero samples', () => {
  for (const value of [undefined, null, 12, '', 'x'.repeat(4097), 'jwt;dur=1\r\nsecret: value',
    'jwt;dur=NaN', 'jwt;dur=Infinity', 'jwt;dur=-1', 'jwt;dur=1e3', 'jwt;dur=120001',
    'jwt;dur=00000000000000001', 'jwt;dur="1"', 'jwt', 'jwt;dur=1;desc="private"',
    'private;desc="unclosed, jwt;dur=1', Array(33).fill('private;dur=1').join(',')]) {
    assert.deepEqual(parse(value), {});
  }
});

test('descriptions cannot smuggle an allowlisted metric through commas or escaped quotes', () => {
  for (const value of ['private;desc="secret, jwt;dur=999", response;dur=2',
    'private;desc="secret\\\", jwt;dur=999", response;dur=2']) {
    assert.deepEqual(parse(value), { response: 2 });
  }
  assert.deepEqual(parse('__proto__;dur=1, constructor;dur=2, transaction;dur=3'), { transaction: 3 });
});

test('duplicate or ambiguous stages are omitted instead of choosing a favorable duration', () => {
  assert.deepEqual(parse('jwt;dur=100, jwt;dur=1, jwt;dur=0, parse;dur=2'), { parse: 2 });
  assert.deepEqual(parse('jwt;dur=invalid, jwt;dur=1, transaction;dur=4'), { transaction: 4 });
});

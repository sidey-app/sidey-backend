import test from 'node:test';
import assert from 'node:assert/strict';
import { approvedEdgeRegion, regionalLiveCapability, observedEdgeRegion } from '../../supabase/functions/_shared/realtime-region.mjs';
import { DIRECT_EVENTS } from '../../supabase/functions/_shared/realtime-direct-event.mjs';
import { PUBLISHER_WAKE } from '../../supabase/functions/_shared/realtime-publish-wake.mjs';

test('regional capabilities preserve the old absent-region contract and only copy approved fields', () => {
  for (const expected of [DIRECT_EVENTS, PUBLISHER_WAKE]) {
    assert.deepEqual(regionalLiveCapability(expected, expected), expected);
    for (const region of ['ap-northeast-2', 'ap-southeast-1']) {
      const input = { ...expected, region, url: 'https://untrusted', token: 'secret' };
      assert.deepEqual(regionalLiveCapability(input, expected), { ...expected, region });
      assert.equal(input.token, 'secret');
    }
  }
});

test('unknown regions, wrong endpoints and malformed capabilities cannot select a route', () => {
  for (const expected of [DIRECT_EVENTS, PUBLISHER_WAKE]) {
    for (const region of ['us-east-1', 'auto', '', null, 1, {}, 'ap-southeast-1\r\nx-extra: bad']) {
      assert.equal(regionalLiveCapability({ ...expected, region }, expected), undefined);
    }
    for (const input of [null, [], {}, { ...expected, endpoint: 'untrusted' }, { ...expected, protocolVersion: 2 }]) {
      assert.equal(regionalLiveCapability(input, expected), undefined);
    }
  }
});

test('runtime region observations expose only the two fixed SB_REGION values', () => {
  for (const region of ['ap-northeast-2', 'ap-southeast-1']) {
    assert.equal(approvedEdgeRegion(region), region);
    assert.deepEqual(observedEdgeRegion(key => { assert.equal(key, 'SB_REGION'); return region; }), { region });
  }
  for (const value of [undefined, null, 'private-provider-string', 'us-east-1']) {
    assert.equal(approvedEdgeRegion(value), undefined);
    assert.deepEqual(observedEdgeRegion(() => value), {});
  }
});

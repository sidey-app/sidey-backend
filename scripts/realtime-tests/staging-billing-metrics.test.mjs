import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createPublicKey, verify } from 'node:crypto';
import { collectBillingMetrics, METRICS, parseArguments, PROJECT, readAccessToken, readMonitoringAccessToken } from './staging-billing-metrics.mjs';

const start = Date.parse('2026-09-18T00:00:00Z'), end = start + 900000, now = end + 2 * 86400000;
const stamp = value => new Date(value).toISOString();
const argv = ['--read-staging', '--start', stamp(start), '--end', stamp(end)];
const prefix = 'firebasedatabase.googleapis.com/';
const json = value => new Response(JSON.stringify(value), { status: 200 });
function series(metric, points) {
  return { metric: { type: prefix + metric.path, labels: {} }, resource: { type: 'firebase_namespace',
    labels: { project_id: PROJECT, table_name: 'synthetic' } }, metricKind: metric.metricKind, valueType: metric.valueType,
    points: points || Array.from({ length: 15 }, (_, index) => ({
      interval: { startTime: stamp(start + index * 60000), endTime: stamp(start + (index + 1) * 60000) },
      value: metric.valueType === 'INT64' ? { int64Value: '10' } : { doubleValue: (index + 1) / 100 },
    })) };
}
function mockFetch(hook = () => undefined) {
  const calls = [];
  const fetcher = async (value, init) => {
    const url = new URL(value); calls.push({ url, init });
    assert.equal(url.origin, 'https://monitoring.googleapis.com');
    assert.ok(url.pathname.startsWith(`/v3/projects/${PROJECT}/`));
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error');
    assert.equal(init.headers.authorization, 'Bearer synthetic-secret-token');
    const descriptor = url.pathname.includes('/metricDescriptors/');
    const metric = METRICS.find(item => descriptor ? url.pathname.endsWith(prefix + item.path)
      : url.searchParams.get('filter').includes(`"${prefix + item.path}"`));
    assert.ok(metric);
    if (!descriptor) {
      assert.ok(url.searchParams.get('filter').includes(`resource.labels.project_id="${PROJECT}"`));
      assert.equal(url.searchParams.get('interval.startTime'), stamp(start));
      assert.equal(url.searchParams.get('interval.endTime'), stamp(end));
      assert.equal(url.searchParams.get('aggregation.alignmentPeriod'), null);
    }
    return await hook({ metric, descriptor, url }) || json(descriptor
      ? { type: prefix + metric.path, metricKind: metric.metricKind, valueType: metric.valueType, unit: metric.unit }
      : { timeSeries: [series(metric)] });
  };
  return { fetcher, calls };
}
function collect(mock = mockFetch(), options = {}) {
  return collectBillingMetrics(argv, { fetcher: mock.fetcher, getToken: async () => 'synthetic-secret-token', now, ...options });
}

test('only explicit staging and a completed window up to two hours reach authentication', async () => {
  assert.deepEqual(parseArguments(argv, now), { start: stamp(start), end: stamp(end) });
  for (const bad of [argv.slice(1), [...argv, '--project', 'production'], [...argv, '--read-staging'],
    ['--read-staging', '--start', stamp(start), '--end', stamp(start + 7200001)],
    ['--read-staging', '--start', stamp(end), '--end', stamp(start)],
    ['--read-staging', '--start', '2026-09-18', '--end', stamp(end)]]) {
    let authenticated = false;
    const report = await collectBillingMetrics(bad, { now, getToken: async () => { authenticated = true; }, fetcher: () => assert.fail('network') });
    assert.equal(report.status, 'BLOCKED'); assert.equal(authenticated, false);
  }
  assert.throws(() => parseArguments(argv, start), /invalid_time_window/);
});

test('gcloud token is captured without a shell, login or account mutation and failures expose no stderr', async () => {
  const token = await readAccessToken(async (command, args, options) => {
    assert.equal(command, 'gcloud');
    assert.deepEqual(args, ['auth', 'print-access-token', '--project', PROJECT, '--quiet']);
    assert.equal(options.shell, undefined); assert.equal(options.timeout, 15000);
    return { stdout: 'synthetic-secret-token\n', stderr: 'synthetic-private-account' };
  });
  assert.equal(token, 'synthetic-secret-token');
  await assert.rejects(readAccessToken(async () => { throw new Error('private-account secret'); }), /^Error: authentication_unavailable$/);
  const report = await collectBillingMetrics(argv, { now, getToken: async () => { throw new Error('private-account secret'); },
    fetcher: () => assert.fail('network') });
  assert.equal(report.reason, 'authentication_unavailable'); assert.ok(!JSON.stringify(report).includes('private-account'));
});

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const serviceAccount = () => ({ type: 'service_account', project_id: PROJECT,
  client_email: `metrics@${PROJECT}.iam.gserviceaccount.com`, private_key: privateKey });

test('staging service account signs only monitoring.read and uses bounded non-redirecting OAuth', async () => {
  const account = serviceAccount();
  const token = await readMonitoringAccessToken(account, { now, fetcher: async (url, init) => {
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error'); assert.ok(init.signal);
    assert.equal(init.body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [header, body, signature] = init.body.get('assertion').split('.');
    assert.ok(verify('RSA-SHA256', Buffer.from(`${header}.${body}`), createPublicKey(privateKey), Buffer.from(signature, 'base64url')));
    assert.deepEqual(JSON.parse(Buffer.from(body, 'base64url')), { iss: account.client_email,
      scope: 'https://www.googleapis.com/auth/monitoring.read', aud: url, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 300 });
    return json({ access_token: 'synthetic-monitoring-token', token_type: 'Bearer' });
  } });
  assert.equal(token, 'synthetic-monitoring-token');
});

test('service account rejects foreign project, foreign email, invalid key and account type before signing or network', async () => {
  for (const change of [{ project_id: 'sidey-realtime' }, { client_email: 'metrics@sidey-realtime.iam.gserviceaccount.com' },
    { private_key: '-----BEGIN PRIVATE KEY-----invalid' }, { type: 'authorized_user' }]) {
    let signed = false, requested = false;
    await assert.rejects(readMonitoringAccessToken({ ...serviceAccount(), ...change }, {
      signer: () => { signed = true; return 'assertion'; },
      fetcher: () => { requested = true; return json({}); },
    }), /^Error: authentication_unavailable$/);
    assert.equal(signed, false); assert.equal(requested, false);
  }
});

test('OAuth errors and malformed/oversized responses never disclose tokens, assertions or provider bodies', async () => {
  for (const fetcher of [
    async () => { throw new Error('private OAuth error'); },
    async () => new Response('private OAuth error', { status: 403 }),
    async () => new Response('private OAuth error'),
    async () => json({ access_token: 'invalid token', token_type: 'Bearer' }),
    async () => json({ access_token: 'private-token', token_type: 'unknown' }),
    async () => new Response('x'.repeat(16385)),
  ]) {
    const report = await collectBillingMetrics(argv, { now, fetcher: () => assert.fail('monitoring must not run'),
      getToken: () => readMonitoringAccessToken(serviceAccount(), { fetcher, signer: async () => 'private-assertion' }) });
    assert.equal(report.status, 'BLOCKED'); assert.equal(report.reason, 'authentication_unavailable');
    assert.ok(!JSON.stringify(report).includes('private'));
  }
  await assert.rejects(readMonitoringAccessToken(serviceAccount(), {
    signer: async () => { throw new Error('private signing failure'); }, fetcher: () => assert.fail('unexpected network'),
  }), /^Error: authentication_unavailable$/);
});

test('valid monitoring token does not convert missing IAM permissions into success', async () => {
  const mock = mockFetch(() => new Response('private IAM permission detail', { status: 403 }));
  const report = await collectBillingMetrics(argv, { now, fetcher: mock.fetcher,
    getToken: () => readMonitoringAccessToken(serviceAccount(), { signer: async () => 'synthetic-assertion',
      fetcher: async () => json({ access_token: 'synthetic-secret-token', token_type: 'Bearer' }) }) });
  assert.equal(report.status, 'BLOCKED');
  assert.ok(report.metrics.every(metric => metric.reason === 'monitoring_permission_denied'));
  assert.ok(!JSON.stringify(report).includes('private IAM'));
});

test('DELTA sums are exact strings, GAUGE values are sample averages/peaks per series, short storage remains blocked', async () => {
  const mock = mockFetch(), report = await collect(mock);
  assert.equal(mock.calls.length, METRICS.length * 2);
  assert.equal(report.metrics[0].observedDeltaSum, '150');
  assert.equal(report.metrics[0].series[0].coverageRatio, 1);
  assert.equal(report.metrics[0].status, 'PASS');
  const load = report.metrics.find(item => item.metric.endsWith('/database_load'));
  assert.equal(load.metricKind, 'GAUGE'); assert.equal(load.observedDeltaSum, undefined);
  assert.ok(Math.abs(load.series[0].sampleMean - 0.08) < 1e-12);
  assert.equal(load.series[0].samplePeak, 0.15);
  const storage = report.metrics.at(-1);
  assert.equal(storage.status, 'BLOCKED'); assert.equal(storage.sampleSeconds, 86400);
  assert.equal(report.status, 'BLOCKED');
  assert.ok(!JSON.stringify(report).includes('synthetic-secret-token'));
  assert.ok(!JSON.stringify(report).includes('table_name'));
});

test('pagination joins the same series and ignores duplicate points without double counting', async () => {
  const mock = mockFetch(({ metric, descriptor, url }) => {
    if (descriptor || metric !== METRICS[0]) return;
    const all = series(metric), second = url.searchParams.get('pageToken') === 'second';
    return json({ timeSeries: [{ ...all, points: second ? all.points.slice(7) : all.points.slice(0, 8) }],
      ...(second ? {} : { nextPageToken: 'second' }) });
  });
  const metric = (await collect(mock)).metrics[0];
  assert.equal(metric.collectionPages, 2); assert.equal(metric.seriesCount, 1);
  assert.equal(metric.observedDeltaSum, '150'); assert.equal(metric.series[0].duplicatePointsIgnored, 1);
});

test('partial DELTA intervals and missing interior intervals are not prorated or reported complete', async () => {
  const mock = mockFetch(({ metric, descriptor }) => {
    if (descriptor || metric !== METRICS[0]) return;
    const value = series(metric); value.points.splice(7, 1);
    value.points[0].interval.startTime = stamp(start - 1000);
    return json({ timeSeries: [value] });
  });
  const metric = (await collect(mock)).metrics[0];
  assert.equal(metric.status, 'BLOCKED'); assert.equal(metric.observedDeltaSum, '130');
  assert.equal(metric.series[0].excludedBoundaryPoints, 1);
  assert.equal(metric.series[0].coveredSeconds, 780);
});

test('INT64 byte sums do not lose precision and gauge series are never pooled into a misleading total', async () => {
  const mock = mockFetch(({ metric, descriptor }) => {
    if (descriptor) return;
    if (metric === METRICS[0]) {
      const value = series(metric); value.points[0].value.int64Value = '9007199254740993';
      return json({ timeSeries: [value] });
    }
    if (metric.path === 'io/database_load') {
      const one = series(metric), two = series(metric); two.metric.labels.type = 'broadcast';
      for (const point of two.points) point.value.doubleValue = 0.5;
      return json({ timeSeries: [one, two] });
    }
  });
  const report = await collect(mock);
  assert.equal(report.metrics[0].observedDeltaSum, '9007199254741133');
  const load = report.metrics.find(item => item.metric.endsWith('/database_load'));
  assert.equal(load.seriesCount, 2); assert.equal(load.sampleMean, undefined);
  assert.equal(load.series[1].sampleMean, 0.5);
});

test('missing samples, permission errors, unsupported descriptors and source errors are BLOCKED without provider text', async () => {
  for (const [response, reason, descriptorOnly] of [
    [() => json({}), 'no_samples', false],
    [() => new Response('secret-private-error', { status: 403 }), 'monitoring_permission_denied', true],
    [() => new Response('secret-private-error', { status: 404 }), 'metric_unavailable', true],
    [() => json({ metricKind: 'CUMULATIVE' }), 'metric_descriptor_mismatch', true],
    [() => json({ executionErrors: [{ message: 'secret-private-error' }] }), 'partial_monitoring_response', false],
  ]) {
    const mock = mockFetch(({ metric, descriptor }) => metric === METRICS[0] && descriptor === descriptorOnly ? response() : undefined);
    const report = await collect(mock);
    assert.equal(report.metrics[0].reason, reason); assert.equal(report.metrics[0].status, 'BLOCKED');
    assert.ok(!JSON.stringify(report).includes('secret-private-error'));
  }
});

test('repeating page tokens, foreign-project data and overlapping delta periods cannot become PASS', async () => {
  for (const [body, reason] of [
    [metric => ({ timeSeries: [series(metric)], nextPageToken: 'repeat' }), 'pagination_limit'],
    [metric => { const value = series(metric); value.resource.labels.project_id = 'production'; return { timeSeries: [value] }; }, 'unexpected_metric_series'],
    [metric => { const value = series(metric); value.points[1].interval.startTime = stamp(start + 50000); return { timeSeries: [value] }; }, 'overlapping_delta_intervals'],
  ]) {
    const mock = mockFetch(({ metric, descriptor }) => metric === METRICS[0] && !descriptor ? json(body(metric)) : undefined);
    assert.equal((await collect(mock)).metrics[0].reason, reason);
  }
});

test('recent gauge observations remain provisional during documented ingestion delay', async () => {
  const report = await collect(mockFetch(), { now: end + 1000 });
  const load = report.metrics.find(item => item.metric.endsWith('/database_load'));
  assert.equal(load.reason, 'provider_ingestion_delay'); assert.equal(load.status, 'BLOCKED');
});

test('no fully included source interval yields no fabricated zero-byte total', async () => {
  const mock = mockFetch(({ metric, descriptor }) => {
    if (descriptor || metric !== METRICS[0]) return;
    return json({ timeSeries: [series(metric, [{ interval: { startTime: stamp(start - 1000), endTime: stamp(end + 1000) },
      value: { int64Value: '1000' } }])] });
  });
  const metric = (await collect(mock)).metrics[0];
  assert.equal(metric.status, 'BLOCKED'); assert.equal(metric.observedDeltaSum, undefined);
  assert.equal(metric.series[0].reason, 'no_samples_in_window');
});

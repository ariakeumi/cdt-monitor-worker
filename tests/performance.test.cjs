const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  fmtTime, shanghaiDate,
  shanghaiMonth, shanghaiTimeStr, shanghaiHourMinute,
} = require('../.wrangler/tests/store.js');
const { Monitor } = require('../.wrangler/tests/monitor.js');
const { AliyunClient } = require('../.wrangler/tests/aliyun.js');
const worker = require('../.wrangler/tests/index.js').default;

test('Shanghai formatting preserves midnight, year and leap-day boundaries', () => {
  for (const [utc, expected] of [
    ['2025-12-31T15:59:59Z', '2025-12-31 23:59:59'],
    ['2025-12-31T16:00:00Z', '2026-01-01 00:00:00'],
    ['2024-02-28T16:00:00Z', '2024-02-29 00:00:00'],
    ['2024-02-29T16:00:00Z', '2024-03-01 00:00:00'],
  ]) {
    const ts = Date.parse(utc) / 1000;
    assert.equal(fmtTime(ts), expected);
    assert.equal(shanghaiDate(ts), expected.slice(0, 10));
  }
});

test('current-time helpers use Shanghai month and clock', (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2025-12-31T16:05:00Z'));
  assert.equal(shanghaiMonth(), '2026-01');
  assert.equal(shanghaiTimeStr(), '00:05');
  assert.deepEqual(shanghaiHourMinute(), { h: '00', m: '05' });
});

test('modern dates avoid Intl initialization on cold requests', (t) => {
  t.mock.method(Intl, 'DateTimeFormat', () => { throw new Error('Intl initialized'); });
  assert.equal(fmtTime(Date.parse('2026-10-27T03:05:00Z') / 1000), '2026-10-27 11:05:00');
});

test('historical Shanghai daylight saving time remains supported', () => {
  assert.equal(fmtTime(Date.parse('1991-07-01T00:00:00Z') / 1000), '1991-07-01 09:00:00');
  assert.equal(fmtTime(Date.parse('1991-12-01T00:00:00Z') / 1000), '1991-12-01 08:00:00');
});

test('static assets return without accessing D1', async () => {
  const response = await worker.fetch(new Request('https://example.com/vue.global.prod.js'), {
    get DB() { throw new Error('Static requests must not access D1'); },
    ASSETS: { fetch: async () => new Response('asset') },
  });
  assert.equal(await response.text(), 'asset');
});

function mockStore(settings = {}, accounts = []) {
  const calls = [];
  return {
    calls,
    settings,
    getAllSettings: async () => ({ ...settings }),
    getAccounts: async () => accounts,
    pruneLogs: async () => { calls.push('logs'); },
    pruneBillingCache: async () => { calls.push('billing'); },
    db: { prepare: () => ({ bind: () => ({ run: async () => { calls.push('login'); } }) }) },
    saveSetting: async (key, value) => { settings[key] = value; },
    updateLastRunTime: async () => {},
    getLastHeartbeatTime: async () => { calls.push('heartbeat-read'); return 0; },
    addLog: async (type) => { calls.push(type); },
    updateAccountStatus: async () => {},
  };
}

test('maintenance runs once per Shanghai day across Monitor instances', async (t) => {
  let time = Date.parse('2026-10-27T15:59:00Z');
  t.mock.method(Date, 'now', () => time);
  const store = mockStore();
  await new Monitor(store).monitor();
  await new Monitor(store).monitor();
  assert.deepEqual(store.calls, ['logs', 'billing', 'login']);
  assert.equal(store.settings.last_maintenance_date, '2026-10-27');
  time += 60000;
  await new Monitor(store).monitor();
  assert.deepEqual(store.calls, ['logs', 'billing', 'login', 'logs', 'billing', 'login']);
  assert.equal(store.settings.last_maintenance_date, '2026-10-28');
});

test('failed maintenance is retried without marking the day complete', async () => {
  const store = mockStore();
  store.pruneBillingCache = async () => { throw new Error('D1 unavailable'); };
  await assert.rejects(new Monitor(store).monitor(), /D1 unavailable/);
  assert.equal(store.settings.last_maintenance_date, undefined);
  store.pruneBillingCache = async () => { store.calls.push('billing'); };
  await new Monitor(store).monitor();
  assert.ok(store.settings.last_maintenance_date);
  assert.equal(store.calls.filter((c) => c === 'logs').length, 2);
});

test('multiple cached accounts share one heartbeat read and retain throttling', async (t) => {
  const time = Date.parse('2026-10-27T03:05:00Z');
  t.mock.method(Date, 'now', () => time);
  const accounts = [1, 2, 3].map((id) => ({
    id, access_key_id: `key-${id}`, traffic_used: 1, max_traffic: 100,
    instance_status: 'Running', updated_at: time / 1000,
  }));
  const store = mockStore({ last_maintenance_date: '2026-10-27' }, accounts);
  const output = await new Monitor(store).monitor();
  assert.equal(output.split('\n').length, 3);
  assert.deepEqual(store.calls, ['heartbeat-read', 'heartbeat']);
});

test('scheduled start still fires at the configured Shanghai minute', async (t) => {
  const time = Date.parse('2026-10-27T03:05:00Z');
  t.mock.method(Date, 'now', () => time);
  const operations = [];
  t.mock.method(AliyunClient.prototype, 'controlInstance', async (_account, action) => {
    operations.push(action);
    return true;
  });
  t.mock.method(AliyunClient.prototype, 'getTraffic', async () => 1);
  t.mock.method(AliyunClient.prototype, 'getInstanceStatus', async () => 'Starting');
  const store = mockStore({ last_maintenance_date: '2026-10-27' }, [{
    id: 1, access_key_id: 'key', traffic_used: 1, max_traffic: 100,
    instance_status: 'Stopped', updated_at: time / 1000,
    schedule_enabled: 1, start_time: '11:05', stop_time: '23:00',
  }]);
  const output = await new Monitor(store).monitor();
  assert.deepEqual(operations, ['start']);
  assert.match(output, /定时启动/);
  assert.match(output, /强制过渡态/);
});

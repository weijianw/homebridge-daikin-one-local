import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DaikinClient, RateLimitError } from '../dist/daikinClient.js';
import { parseThermostatInfo, parseDeviceInfo } from '../dist/types.js';
import { targetMode, equipmentState, displayUnits, temperatureUpdate, targetTemperature, validateControl, modeUpdate } from '../dist/mappings.js';
import { parseConfig, baseUrl } from '../dist/config.js';

export const actual = {
  name: 'Main Room', mode: 1, availableModes: [0, 1, 2, 3], state: 5, fan: 2, fanState: 0,
  tempUnits: 0, spaceTemp: 23.7, heatSetpoint: 22.2, coolSetpoint: 25, coolSetpointMax: 32.2,
  coolSetpointMin: 12, heatSetpointMax: 30.2, heatSetpointMin: 10, setpointDelta: 2, spaceHum: 50,
};
const reply = data => new Response(JSON.stringify(data));
test('actual status parsing, optional humidity, invalid fields and unknown enums', () => {
  assert.deepEqual(parseThermostatInfo(actual), actual);
  const { spaceHum: _humidity, ...noHumidity } = actual;
  assert.equal(parseThermostatInfo(noHumidity).spaceHum, undefined);
  for (const bad of [{ spaceTemp: '23' }, { spaceHum: 101 }, { setpointDelta: -1 }, { availableModes: [] }]) {
    assert.throws(() => parseThermostatInfo({ ...actual, ...bad }));
  }
  assert.equal(parseThermostatInfo({ ...actual, state: 99 }).state, 99);
  assert.throws(() => parseDeviceInfo({ api_ver: 2 }));
});
test('mode, equipment and display mappings retain Celsius temperatures', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 99].map(targetMode), [0, 1, 2, 3, 0, 0, 0, 0]);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 99].map(equipmentState), [0, 2, 2, 1, 0, 0, 0, 0, 1, 0]);
  assert.equal(displayUnits(0), 1);
  assert.equal(displayUnits(1), 0);
  assert.equal(targetTemperature(actual), 22.2);
  assert.equal(targetTemperature({ ...actual, mode: 2 }), 25);
  assert.deepEqual(temperatureUpdate(actual, 23), { heatSetpoint: 23 });
  assert.deepEqual(temperatureUpdate({ ...actual, mode: 2 }, 26), { coolSetpoint: 26 });
  for (const mode of [0, 3, 4, 5, 6]) { assert.throws(() => temperatureUpdate({ ...actual, mode }, 23)); }
});
test('bounds, supported modes and auto separation', () => {
  for (const update of [{ heatSetpoint: 9 }, { heatSetpoint: 31 }, { coolSetpoint: 11 }, { coolSetpoint: 33 },
    { mode: 4 }, { mode: 99 }, { heatSetpoint: NaN }]) {
    assert.throws(() => validateControl(actual, update));
  }
  validateControl(actual, { heatSetpoint: 10, coolSetpoint: 32.2 });
  assert.throws(() => validateControl(actual, { mode: 3, heatSetpoint: 24 }));
  assert.throws(() => validateControl({ ...actual, mode: 3 }, { coolSetpoint: 23 }));
  validateControl(actual, { mode: 3, heatSetpoint: 23, coolSetpoint: 25 });
});
test('read-only protection sends no HTTP requests', async () => {
  let calls = 0;
  const client = new DaikinClient('http://mock', false, async () => { calls++; return reply(actual); });
  await assert.rejects(client.control({ mode: 0 }), /Writes disabled/);
  assert.equal(calls, 0);
});
test('partial form control and verification preserve unrelated settings', async () => {
  const calls = [];
  let state = { ...actual };
  const client = new DaikinClient('http://mock', true, async (url, init) => {
    calls.push([url.pathname, init]);
    if (init.method === 'POST') {
      assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
      assert.equal(init.body, 'heatSetpoint=23');
      state = { ...state, heatSetpoint: 23 };
      return reply({ error: false });
    }
    return reply(state);
  });
  assert.equal((await client.control({ heatSetpoint: 23 })).heatSetpoint, 23);
  assert.deepEqual(calls.map(([path]) => path), ['/query/info', '/control', '/query/info']);
  assert.equal(client.latest.fan, 2);
  assert.equal(client.latest.coolSetpoint, 25);
});
test('fan control is rejected before any POST', async () => {
  const methods = [];
  const client = new DaikinClient('http://mock', true, async (_url, init) => {
    methods.push(init.method);
    return reply(actual);
  });
  await assert.rejects(client.control({ fan: 1 }), /Invalid or empty control update/);
  assert.deepEqual(methods, ['GET']);
});
test('writes serialize and validate against the latest state', async () => {
  let state = { ...actual, mode: 3 };
  let active = 0;
  const client = new DaikinClient('http://mock', true, async (_url, init) => {
    assert.equal(active++, 0);
    await new Promise(resolve => setTimeout(resolve, 1));
    active--;
    if (init.method === 'POST') {
      for (const [key, value] of new URLSearchParams(init.body)) { state[key] = Number(value); }
      return reply({ error: false });
    }
    return reply(state);
  });
  await Promise.all([client.control({ coolSetpoint: 27 }), client.control({ heatSetpoint: 25 })]);
  assert.equal(client.latest.heatSetpoint, 25);
  await assert.rejects(client.control({ heatSetpoint: 26 }), /above heating/);
});
test('HTTP, API and malformed JSON failures', async () => {
  for (const response of [new Response('', { status: 503 }), reply({ error: true, reason: 'disabled' }), new Response('invalid')]) {
    const client = new DaikinClient('http://mock', false, async () => response);
    await assert.rejects(client.info(), /Daikin GET/);
  }
});
test('timeout signal aborts the mocked HTTP operation', async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const client = new DaikinClient('http://mock', false, async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    }), 10);
    await assert.rejects(client.info(), /timeout/i);
  } finally { clearTimeout(keepAlive); }
});
test('disconnection preserves last reading, recovers, and coalesces concurrent polls', async () => {
  let offline = false;
  let calls = 0;
  const client = new DaikinClient('http://mock', false, async () => {
    calls++;
    if (offline) { throw new Error('connection refused'); }
    return reply(actual);
  });
  await Promise.all([client.info(), client.info(), client.info()]);
  assert.equal(calls, 1);
  offline = true;
  await assert.rejects(client.info(), /connection refused/);
  assert.equal(client.latest.spaceTemp, 23.7);
  offline = false;
  assert.equal((await client.info()).spaceTemp, 23.7);
});
test('control rejects API failure and unconfirmed result', async () => {
  for (const ack of [{ error: true, reason: 'bad command' }, { error: false }, {}]) {
    const client = new DaikinClient('http://mock', true, async (_url, init) => reply(init.method === 'POST' ? ack : actual));
    await assert.rejects(client.control({ mode: 2 }));
    assert.equal(client.latest.mode, 1);
  }
});
test('configuration validation and IPv6 URL', () => {
  assert.equal(parseConfig({ host: 'example.local' }).port, 80);
  assert.equal(parseConfig({ host: 'example.local' }).cacheTtl, 3_600_000);
  assert.equal(parseConfig({ host: 'example.local', cacheTtl: 0 }).cacheTtl, 0);
  assert.equal(baseUrl(parseConfig({ host: '::1', port: 8081 })), 'http://[::1]:8081');
  for (const bad of [{}, { host: 'http://host' }, { host: 'host', port: 0 }, { host: 'host', pollInterval: 1 },
    { host: 'host', cacheTtl: -1 }, { host: 'host', cacheTtl: 1.5 }, { host: 'host', enableWrites: 'false' }]) {
    assert.throws(() => parseConfig(bad));
  }
});

test('acknowledges before verification and tolerates delayed application without repeating POST', async () => {
  let accepted = false;
  let reads = 0;
  let posts = 0;
  const waits = [];
  const client = new DaikinClient('http://mock', true, async (_url, init) => {
    if (init.method === 'POST') { posts++; return reply({ error: false }); }
    reads++;
    if (reads > 1) { assert.equal(accepted, true); }
    return reply({ ...actual, mode: reads >= 2 ? 2 : 1 });
  }, 5000, async milliseconds => { waits.push(milliseconds); });
  const result = await client.control({ mode: 2 }, () => { accepted = true; });
  assert.equal(result.mode, 2);
  assert.equal(posts, 1);
  assert.deepEqual(waits, [500]);
});
test('rejected or malformed acknowledgements never invoke acceptance callback', async () => {
  for (const ack of [{ error: true }, {}]) {
    const client = new DaikinClient('http://mock', true, async (_url, init) => reply(init.method === 'POST' ? ack : actual));
    let accepted = false;
    await assert.rejects(client.control({ mode: 2 }, () => { accepted = true; }));
    assert.equal(accepted, false);
  }
});

test('empty successful control response is accepted and verified by a later read', async () => {
  let state = { ...actual };
  let posts = 0;
  let accepted = false;
  for (const status of [200, 204]) {
    state = { ...actual };
    const client = new DaikinClient('http://mock', true, async (_url, init) => {
      if (init.method === 'POST') {
        posts++;
        state = { ...state, heatSetpoint: 23 };
        return new Response(null, { status });
      }
      return reply(state);
    });
    const result = await client.control({ heatSetpoint: 23 }, () => { accepted = true; });
    assert.equal(accepted, true);
    assert.equal(result.heatSetpoint, 23);
  }
  assert.equal(posts, 2);
});

test('empty reads and nonempty invalid control responses remain errors', async () => {
  const emptyRead = new DaikinClient('http://mock', false, async () => new Response(null, { status: 204 }));
  await assert.rejects(emptyRead.info(), /Empty JSON response/);
  const malformedWrite = new DaikinClient('http://mock', true,
    async (_url, init) => init.method === 'POST' ? new Response('not JSON') : reply(actual));
  await assert.rejects(malformedWrite.control({ mode: 2 }), /Unexpected token|not valid JSON/);
});

test('entering Auto preserves the active setpoint and moves only the other threshold', () => {
  assert.deepEqual(modeUpdate({ ...actual, heatSetpoint: 26.7, coolSetpoint: 25 }, 3),
    { mode: 3, coolSetpoint: 28.7 });
  assert.deepEqual(modeUpdate({ ...actual, mode: 2, heatSetpoint: 26.7, coolSetpoint: 25 }, 3),
    { mode: 3, heatSetpoint: 23 });
  validateControl(actual, modeUpdate({ ...actual, heatSetpoint: 26.7, coolSetpoint: 25 }, 3));
});
test('control POSTs are spaced without extra verification reads', async () => {
  let now = 10000;
  const waits = [];
  let posts = 0;
  let reads = 0;
  let state = { ...actual };
  const client = new DaikinClient('http://mock', true, async (_url, init) => {
    if (init.method === 'POST') {
      posts++;
      for (const [key, value] of new URLSearchParams(init.body)) { state[key] = Number(value); }
      return new Response(null, { status: 200 });
    }
    reads++;
    return reply(state);
  }, 5000, async ms => { waits.push(ms); now += ms; }, () => now);
  await client.control({ heatSetpoint: 23 });
  await client.control({ heatSetpoint: 24 });
  assert.equal(posts, 2);
  assert.equal(reads, 4);
  assert.deepEqual(waits, [500, 2500, 500]);
});

test('rate-limited POST is not replayed; cooldown fails promptly and recovers', async () => {
  let now = 10000;
  let posts = 0;
  let reads = 0;
  const waits = [];
  let state = { ...actual };
  const client = new DaikinClient('http://mock', true, async (_url, init) => {
    if (init.method === 'POST') {
      posts++;
      if (posts === 1) { return reply({ error: true, reason: 'Too many requests' }); }
      state = { ...state, heatSetpoint: 23 };
      return new Response(null, { status: 200 });
    }
    reads++;
    return reply(state);
  }, 5000, async ms => { waits.push(ms); now += ms; }, () => now);
  await assert.rejects(client.control({ heatSetpoint: 23 }), RateLimitError);
  assert.equal(posts, 1);
  await assert.rejects(client.control({ heatSetpoint: 23 }), /retry in 10 seconds/);
  assert.equal(posts, 1);
  assert.equal(reads, 1);
  assert.deepEqual(waits, []);
  now += 10000;
  await client.control({ heatSetpoint: 23 });
  assert.equal(posts, 2);
  assert.equal(reads, 3);
  assert.deepEqual(waits, [500]);
});

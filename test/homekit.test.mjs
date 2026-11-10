import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as hap from '@homebridge/hap-nodejs';
import { DaikinAccessory } from '../dist/platformAccessory.js';
import { RateLimitError } from '../dist/daikinClient.js';
import { DaikinOneLocalPlatform } from '../dist/platform.js';

const info = {
  name: 'Test Room', mode: 3, availableModes: [0, 1, 2, 3], state: 5, fan: 2, fanState: 0,
  tempUnits: 0, spaceTemp: 23.7, heatSetpoint: 22.2, coolSetpoint: 25, coolSetpointMax: 32.2,
  coolSetpointMin: 12, heatSetpointMax: 30.2, heatSetpointMin: 10, setpointDelta: 2, spaceHum: 50,
};
const log = { info() {}, warn() {}, debug() {} };
class PlatformAccessory extends hap.Accessory { context = {}; }
function accessory() { return new PlatformAccessory('Test Room', hap.uuid.generate('test-device')); }
function setup(enableWrites) {
  const platform = { api: { hap }, options: { enableWrites }, log,
    client: { control: async () => { throw new Error('Writes disabled'); } } };
  const device = accessory();
  const handler = new DaikinAccessory(platform, device);
  handler.update(info);
  return { platform, device, handler, thermostat: device.getService(hap.Service.Thermostat) };
}
test('real HAP characteristics retain independent auto thresholds and device limits', async () => {
  const { thermostat, device } = setup(false);
  const C = hap.Characteristic;
  assert.ok(Math.abs(await thermostat.getCharacteristic(C.CurrentTemperature).handleGetRequest() - 23.7) < 1e-9);
  assert.equal(await thermostat.getCharacteristic(C.TemperatureDisplayUnits).handleGetRequest(), 1);
  assert.ok(Math.abs(await thermostat.getCharacteristic(C.HeatingThresholdTemperature).handleGetRequest() - 22.2) < 1e-9);
  assert.equal(await thermostat.getCharacteristic(C.CoolingThresholdTemperature).handleGetRequest(), 25);
  assert.equal(thermostat.getCharacteristic(C.HeatingThresholdTemperature).props.minValue, 10);
  assert.equal(thermostat.getCharacteristic(C.CoolingThresholdTemperature).props.maxValue, 32.2);
  assert.equal(await thermostat.getCharacteristic(C.CurrentRelativeHumidity).handleGetRequest(), 50);
  for (const type of [C.TargetTemperature, C.TargetHeatingCoolingState, C.HeatingThresholdTemperature,
    C.CoolingThresholdTemperature, C.TemperatureDisplayUnits]) {
    assert.equal(thermostat.getCharacteristic(type).props.perms.includes(hap.Perms.PAIRED_WRITE), false);
  }
  assert.equal(device.getService(hap.Service.Fanv2), undefined);
  await assert.rejects(thermostat.getCharacteristic(C.TargetTemperature).handleSetRequest(24));
});
test('cached permissions can be enabled and offline HAP readings recover', async () => {
  const { device, handler, thermostat, platform } = setup(false);
  const C = hap.Characteristic;
  handler.offline();
  await assert.rejects(thermostat.getCharacteristic(C.CurrentTemperature).handleGetRequest());
  handler.update({ ...info, state: 8, fanState: 1 });
  assert.equal(await thermostat.getCharacteristic(C.CurrentHeatingCoolingState).handleGetRequest(), 1);
  new DaikinAccessory({ ...platform, options: { enableWrites: true } }, device);
  assert.equal(thermostat.getCharacteristic(C.TargetTemperature).props.perms.includes(hap.Perms.PAIRED_WRITE), true);
});
test('manual identity survives restart/host change, connectivity transitions and shutdown clear timer', async t => {
  const events = new EventEmitter();
  let registrations = 0;
  let warnings = 0;
  let connections = 0;
  const api = Object.assign(events, { hap, platformAccessory: PlatformAccessory,
    registerPlatformAccessories() { registrations++; } });
  const platform = new DaikinOneLocalPlatform({ ...log, warn() { warnings++; }, info() { connections++; } },
    { platform: 'DaikinOneLocal', host: 'mock' }, api);
  t.after(() => api.emit('shutdown'));
  platform.client.deviceInfo = async () => ({ api_ver: 1, model: 'ONETOUCH', firmware: '4.1.6', brand: 'daikin', type: 'residential' });
  platform.client.info = async () => info;
  // Invoke the polling lifecycle directly to avoid wall-clock waiting.
  await platform.poll();
  assert.equal(registrations, 1);
  const cached = [...platform.accessories.values()][0];
  platform.client.info = async () => { throw new Error('offline'); };
  clearTimeout(platform.timer);
  await platform.poll();
  clearTimeout(platform.timer);
  await platform.poll();
  assert.equal(warnings, 1);
  platform.client.info = async () => info;
  clearTimeout(platform.timer);
  await platform.poll();
  assert.equal(connections, 2);
  api.emit('shutdown');
  assert.equal(platform.timer._destroyed, true);
  const otherApi = Object.assign(new EventEmitter(), { hap, platformAccessory: PlatformAccessory,
    registerPlatformAccessories() { registrations++; } });
  const restored = new DaikinOneLocalPlatform(log, { platform: 'DaikinOneLocal', host: 'new-host' }, otherApi);
  t.after(() => otherApi.emit('shutdown'));
  restored.configureAccessory(cached);
  restored.client.deviceInfo = platform.client.deviceInfo;
  restored.client.info = async () => info;
  await restored.poll();
  otherApi.emit('shutdown');
  assert.equal(registrations, 1);
  assert.equal([...restored.accessories.keys()][0], cached.UUID);
});

test('thermostat is primary on both new and restored accessories', () => {
  const { device, thermostat, platform } = setup(true);
  assert.equal(thermostat.isPrimaryService, true);
  assert.equal(device.category, hap.Categories.THERMOSTAT);
  new DaikinAccessory(platform, device);
  assert.equal(thermostat.isPrimaryService, true);
  assert.equal(device.getService(hap.Service.Fanv2), undefined);
});
test('cached fan service is removed without changing thermostat identity', () => {
  const { device, platform, thermostat } = setup(true);
  const uuid = device.UUID;
  const fan = device.addService(hap.Service.Fanv2, 'Circulation Fan');
  fan.getCharacteristic(hap.Characteristic.TargetFanState);
  new DaikinAccessory(platform, device);
  assert.equal(device.getService(hap.Service.Fanv2), undefined);
  assert.equal(device.getService(hap.Service.Thermostat), thermostat);
  assert.equal(device.UUID, uuid);
});
test('HomeKit write succeeds as soon as POST is accepted while verification remains pending', async () => {
  const { platform, thermostat, handler } = setup(true);
  handler.update({ ...info, mode: 1 });
  let finish;
  platform.client.control = async (_update, onAccepted) => {
    onAccepted();
    return new Promise(resolve => { finish = resolve; });
  };
  await thermostat.getCharacteristic(hap.Characteristic.TargetTemperature).handleSetRequest(23);
  assert.equal(typeof finish, 'function');
  finish({ ...info, mode: 1, heatSetpoint: 23 });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(await thermostat.getCharacteristic(hap.Characteristic.TargetTemperature).handleGetRequest(), 23);
});
test('delayed verification failure cannot turn an accepted HomeKit write into No Response', async () => {
  const { platform, thermostat, handler } = setup(true);
  handler.update({ ...info, mode: 1 });
  let fail;
  const warnings = [];
  platform.log = { ...log, warn(...args) { warnings.push(args); } };
  platform.client.control = async (_update, onAccepted) => {
    onAccepted();
    return new Promise((_resolve, reject) => { fail = reject; });
  };
  await thermostat.getCharacteristic(hap.Characteristic.TargetTemperature).handleSetRequest(23);
  fail(new Error('not yet confirmed'));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /Control accepted/);
});

test('HomeKit groups mode and threshold changes into one control request', async () => {
  const { platform, thermostat } = setup(true);
  let calls = 0;
  let combined;
  platform.client.control = async (update, onAccepted) => {
    calls++;
    combined = update({ ...info, mode: 1, heatSetpoint: 26.7, coolSetpoint: 25 });
    onAccepted();
    return { ...info, ...combined };
  };
  await Promise.all([
    thermostat.getCharacteristic(hap.Characteristic.TargetHeatingCoolingState).handleSetRequest(3),
    thermostat.getCharacteristic(hap.Characteristic.CoolingThresholdTemperature).handleSetRequest(29),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(combined, { mode: 3, coolSetpoint: 29 });
});

test('slow slider replaces unsent values while a command is in flight', async () => {
  const { platform, thermostat, handler } = setup(true);
  handler.update({ ...info, mode: 1 });
  const sent = [];
  const finish = [];
  platform.client.control = (update, onAccepted) => {
    const desired = update({ ...info, mode: 1, heatSetpoint: sent.length ? 23 : 22.2 });
    sent.push(desired);
    return new Promise(resolve => {
      finish.push(() => { onAccepted(); resolve({ ...info, mode: 1, ...desired }); });
    });
  };
  const target = thermostat.getCharacteristic(hap.Characteristic.TargetTemperature);
  const first = target.handleSetRequest(23);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.deepEqual(sent, [{ heatSetpoint: 23 }]);
  const second = target.handleSetRequest(24);
  await new Promise(resolve => setTimeout(resolve, 400));
  const third = target.handleSetRequest(25);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(sent.length, 1);
  finish[0]();
  await first;
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(sent, [{ heatSetpoint: 23 }, { heatSetpoint: 25 }]);
  finish[1]();
  await Promise.all([second, third]);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(await target.handleGetRequest(), 25);
});
test('rate limit rejects a HomeKit write with resource busy without waiting for cooldown', async () => {
  const { platform, thermostat, handler } = setup(true);
  handler.update({ ...info, mode: 1 });
  platform.client.control = async () => { throw new RateLimitError('retry later'); };
  await assert.rejects(thermostat.getCharacteristic(hap.Characteristic.TargetTemperature).handleSetRequest(23),
    error => error === hap.HAPStatus.RESOURCE_BUSY);
});

/** Local API temperatures are always Celsius; unknown integer enums are retained for safe reporting. */
export enum DaikinMode { Off = 0, Heat = 1, Cool = 2, Auto = 3, EmergencyHeat = 4, Fan = 5, Dry = 6 }
export interface DeviceInfo { api_ver: number; type: string; model: string; brand: string; firmware: string }
export interface ThermostatInfo {
  name: string;
  mode: number;
  availableModes: number[];
  state: number;
  fan: number;
  fanState: number;
  tempUnits: number;
  spaceTemp: number;
  heatSetpoint: number;
  coolSetpoint: number;
  coolSetpointMax: number;
  coolSetpointMin: number;
  heatSetpointMax: number;
  heatSetpointMin: number;
  setpointDelta: number;
  spaceHum?: number;
}
export interface ControlUpdate { mode?: DaikinMode; heatSetpoint?: number; coolSetpoint?: number }

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a JSON object');
  }
  return value as Record<string, unknown>;
}
function number(value: unknown, key: string, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    throw new Error(`Invalid numeric field: ${key}`);
  }
  return value;
}
function string(value: unknown, key: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Invalid string field: ${key}`);
  }
  return value;
}
export function parseDeviceInfo(value: unknown): DeviceInfo {
  const v = object(value);
  if (number(v.api_ver, 'api_ver', true) !== 1) {
    throw new Error(`Unsupported Local API version: ${v.api_ver}`);
  }
  return { api_ver: 1, type: string(v.type, 'type'), model: string(v.model, 'model'),
    brand: string(v.brand, 'brand'), firmware: string(v.firmware, 'firmware') };
}
export function parseThermostatInfo(value: unknown): ThermostatInfo {
  const v = object(value);
  const result: Record<string, unknown> = { name: string(v.name, 'name') };
  for (const key of ['mode', 'state', 'fan', 'fanState', 'tempUnits']) {
    result[key] = number(v[key], key, true);
  }
  for (const key of ['spaceTemp', 'heatSetpoint', 'coolSetpoint', 'coolSetpointMax', 'coolSetpointMin',
    'heatSetpointMax', 'heatSetpointMin', 'setpointDelta']) {
    result[key] = number(v[key], key);
  }
  if (!Array.isArray(v.availableModes) || !v.availableModes.length) {
    throw new Error('Invalid availableModes');
  }
  result.availableModes = v.availableModes.map(mode => number(mode, 'availableModes', true));
  if (v.spaceHum !== undefined) {
    const humidity = number(v.spaceHum, 'spaceHum');
    result.spaceHum = humidity;
    if (humidity < 0 || humidity > 100) {
      throw new Error('Humidity outside 0–100');
    }
  }
  const info = result as unknown as ThermostatInfo;
  if (info.heatSetpointMin > info.heatSetpointMax || info.coolSetpointMin > info.coolSetpointMax || info.setpointDelta < 0) {
    throw new Error('Invalid device setpoint limits');
  }
  return info;
}

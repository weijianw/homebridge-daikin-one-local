import { setTimeout as delay } from 'node:timers/promises';
import { parseDeviceInfo, parseThermostatInfo, type ControlUpdate, type DeviceInfo, type ThermostatInfo } from './types.js';
import { ControlValidationError, validateControl } from './mappings.js';

export class RateLimitError extends Error {}

export class DaikinClient {
  private queue: Promise<unknown> = Promise.resolve();
  private reading?: Promise<ThermostatInfo>;
  private lastControlAt?: number;
  private rateLimitedUntil = 0;
  public latest?: ThermostatInfo;
  constructor(private readonly baseUrl: string, private readonly enableWrites = false,
    private readonly request: typeof fetch = fetch, private readonly timeout = 5000,
    private readonly wait: (milliseconds: number) => Promise<unknown> = delay,
    private readonly now: () => number = Date.now) {}

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
  private async json(path: string, body?: URLSearchParams): Promise<unknown> {
    try {
      const response = await this.request(new URL(path, this.baseUrl), {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(this.timeout),
        ...(body ? { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() } : {}),
      });
      if (!response.ok) { throw new Error(`HTTP ${response.status} ${response.statusText}`); }
      const text = await response.text();
      // Some Local API implementations acknowledge /control with an empty 2xx body.
      // Only writes may use this form; GET responses must contain valid JSON.
      if (!text.trim()) {
        if (body) { return undefined; }
        throw new Error('Empty JSON response');
      }
      const data: unknown = JSON.parse(text);
      if (data && typeof data === 'object' && 'error' in data && data.error === true) {
        throw new Error(`API rejected request: ${'reason' in data ? String(data.reason) : 'unspecified reason'}`);
      }
      return data;
    } catch (error) {
      throw new Error(`Daikin ${body ? 'POST' : 'GET'} ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  deviceInfo(): Promise<DeviceInfo> {
    return this.serialized(async () => parseDeviceInfo(await this.json('/')));
  }
  private async read(): Promise<ThermostatInfo> {
    const info = parseThermostatInfo(await this.json('/query/info'));
    this.latest = info;
    return info;
  }
  info(): Promise<ThermostatInfo> {
    if (!this.reading) {
      this.reading = this.serialized(() => this.read()).finally(() => { this.reading = undefined; });
    }
    return this.reading;
  }
  /** onAccepted acknowledges the POST separately from eventual state verification. */
  control(update: ControlUpdate | ((info: ThermostatInfo) => ControlUpdate), onAccepted?: () => void): Promise<ThermostatInfo> {
    if (!this.enableWrites) { return Promise.reject(new ControlValidationError('Writes disabled: enableWrites is false')); }
    return this.serialized(async () => {
      const cooldown = this.rateLimitedUntil - this.now();
      if (cooldown > 0) { throw new RateLimitError(`Thermostat busy; retry in ${Math.ceil(cooldown / 1000)} seconds`); }
      // Fresh limits/mode also protect against changes made at the wall thermostat.
      const before = await this.read();
      const values = typeof update === 'function' ? update(before) : { ...update };
      validateControl(before, values);
      const body = new URLSearchParams();
      for (const [key, value] of Object.entries(values)) {
        if (value !== undefined) { body.set(key, String(value)); }
      }
      const pause = this.lastControlAt === undefined ? 0 : this.lastControlAt + 3000 - this.now();
      if (pause > 0) { await this.wait(pause); }
      this.lastControlAt = this.now();
      let ack: unknown;
      try {
        ack = await this.json('/control', body);
      } catch (error) {
        if (/Too many requests|HTTP 429/i.test(String(error))) {
          // Do not hold a HomeKit write open through the cooldown or replay rejected commands.
          this.rateLimitedUntil = this.now() + 10000;
          throw new RateLimitError('Thermostat rate limited; retry in 10 seconds', { cause: error });
        }
        throw error;
      }
      if (ack !== undefined && (!ack || typeof ack !== 'object' || !('error' in ack) || ack.error !== false)) {
        throw new Error('Invalid control acknowledgement; command outcome unknown');
      }
      onAccepted?.();
      // One delayed verification read limits request bursts; regular polling continues reconciliation.
      await this.wait(500);
      const after = await this.read();
      const confirmed = Object.entries(values).every(([key, value]) =>
        value === undefined || Math.abs(after[key as keyof ControlUpdate] - value) <= 0.11);
      if (confirmed) {
        return after;
      }
      throw new Error('Control accepted but not yet confirmed; polling will continue reconciling device state');
    });
  }
}

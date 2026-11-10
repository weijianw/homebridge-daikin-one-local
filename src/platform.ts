import { randomUUID } from 'node:crypto';
import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import { DaikinClient } from './daikinClient.js';
import { baseUrl, parseConfig, type Config } from './config.js';
import { DaikinAccessory } from './platformAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import type { DeviceInfo } from './types.js';

export class DaikinOneLocalPlatform implements DynamicPlatformPlugin {
  public readonly accessories = new Map<string, PlatformAccessory>();
  public readonly options: Config;
  public readonly client: DaikinClient;
  private handler?: DaikinAccessory;
  private device?: DeviceInfo;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private connected?: boolean;

  constructor(public readonly log: Logging, config: PlatformConfig, public readonly api: API) {
    this.options = parseConfig(config);
    this.client = new DaikinClient(baseUrl(this.options), this.options.enableWrites);
    api.on('didFinishLaunching', () => { void this.poll(); });
    api.on('shutdown', () => {
      this.stopped = true;
      clearTimeout(this.timer);
    });
  }
  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.set(accessory.UUID, accessory);
    // Bind cached services even when the thermostat is offline at startup.
    if (!this.handler) { this.handler = new DaikinAccessory(this, accessory); }
  }
  private async poll(): Promise<void> {
    try {
      this.device ??= await this.client.deviceInfo();
      const info = await this.client.info();
      if (this.stopped) { return; }
      if (!this.handler) {
        // One persistent manual slot; never derive identity from a mutable display name or IP.
        const accessory = new this.api.platformAccessory(info.name, this.api.hap.uuid.generate(randomUUID()));
        accessory.context.identity = accessory.UUID;
        this.handler = new DaikinAccessory(this, accessory);
        this.accessories.set(accessory.UUID, accessory);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
      this.handler.setDevice(this.device);
      this.handler.update(info);
      if (this.connected !== true) { this.log.info('Thermostat connected'); }
      this.connected = true;
    } catch (error) {
      this.handler?.offline();
      if (this.connected !== false) { this.log.warn('Thermostat unavailable:', String(error)); }
      else if (this.options.debug) { this.log.debug(String(error)); }
      this.connected = false;
    } finally {
      if (!this.stopped) { this.timer = setTimeout(() => { void this.poll(); }, this.options.pollInterval); }
    }
  }
}

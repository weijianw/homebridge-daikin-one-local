import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { DaikinOneLocalPlatform } from './platform.js';
import { RateLimitError } from './daikinClient.js';
import { ControlValidationError, displayUnits, equipmentState, modeUpdate, targetMode, targetTemperature, temperatureUpdate } from './mappings.js';
import type { ControlUpdate, DeviceInfo, ThermostatInfo } from './types.js';

export class DaikinAccessory {
  private readonly thermostat: Service;
  private current?: ThermostatInfo;
  private online = false;
  private pendingWrites: Array<{
    update: (info: ThermostatInfo) => ControlUpdate;
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];
  private writeTimer?: ReturnType<typeof setTimeout>;
  private activeWrite = false;
  constructor(private readonly platform: DaikinOneLocalPlatform, private readonly accessory: PlatformAccessory) {
    const { Service: S, Characteristic: C, Perms } = platform.api.hap;
    this.thermostat = accessory.getService(S.Thermostat) ?? accessory.addService(S.Thermostat);
    accessory.category = platform.api.hap.Categories.THERMOSTAT;
    this.thermostat.setPrimaryService(true);
    this.thermostat.setCharacteristic(C.Name, accessory.displayName);
    const cachedFan = accessory.getService(S.Fanv2);
    if (cachedFan) { accessory.removeService(cachedFan); }
    platform.api.on?.('shutdown', () => {
      clearTimeout(this.writeTimer);
      const error = new platform.api.hap.HapStatusError(platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      for (const write of this.pendingWrites.splice(0)) { write.reject(error); }
    });
    // Optional temperature characteristics start with HAP defaults outside some device ranges.
    // Leave them unset until the first validated reading supplies their limits and values.
    for (const type of [C.HeatingThresholdTemperature, C.CoolingThresholdTemperature]) {
      this.thermostat.getCharacteristic(type).value = null;
    }
    const read = (getter: (info: ThermostatInfo) => CharacteristicValue) => () => {
      if (!this.online || !this.current) {
        throw new platform.api.hap.HapStatusError(platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
      return getter(this.current);
    };
    this.thermostat.getCharacteristic(C.CurrentTemperature).setProps({ minValue: -100, maxValue: 100 })
      .onGet(read(info => info.spaceTemp));
    this.thermostat.getCharacteristic(C.CurrentHeatingCoolingState).onGet(read(info => equipmentState(info.state)));
    const mode = this.thermostat.getCharacteristic(C.TargetHeatingCoolingState).onGet(read(info => targetMode(info.mode)));
    const target = this.thermostat.getCharacteristic(C.TargetTemperature).onGet(read(targetTemperature));
    const heat = this.thermostat.getCharacteristic(C.HeatingThresholdTemperature).onGet(read(info => info.heatSetpoint));
    const cool = this.thermostat.getCharacteristic(C.CoolingThresholdTemperature).onGet(read(info => info.coolSetpoint));
    const units = this.thermostat.getCharacteristic(C.TemperatureDisplayUnits).onGet(read(info => displayUnits(info.tempUnits)));
    // Display units are reported from the thermostat. No /settings writes.
    units.setProps({ perms: [Perms.PAIRED_READ, Perms.NOTIFY] });
    for (const characteristic of [mode, target, heat, cool]) {
      characteristic.setProps({ perms: platform.options.enableWrites
        ? [Perms.PAIRED_READ, Perms.PAIRED_WRITE, Perms.NOTIFY] : [Perms.PAIRED_READ, Perms.NOTIFY] });
    }
    mode.onSet(value => this.write(info => {
      const modeValue = this.numeric(value);
      if (![0, 1, 2, 3].includes(modeValue)) { throw new ControlValidationError('Unsupported HomeKit mode'); }
      return modeUpdate(info, modeValue);
    }));
    target.onSet(value => this.write(info => temperatureUpdate(info, this.numeric(value))));
    heat.onSet(value => this.write(() => ({ heatSetpoint: this.numeric(value) })));
    cool.onSet(value => this.write(() => ({ coolSetpoint: this.numeric(value) })));
  }
  private numeric(value: CharacteristicValue): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) { throw new ControlValidationError('Expected a finite number'); }
    return value;
  }
  private write(update: (info: ThermostatInfo) => ControlUpdate): Promise<void> {
    return new Promise((resolve, reject) => {
      this.pendingWrites.push({ update, resolve, reject });
      clearTimeout(this.writeTimer);
      this.writeTimer = setTimeout(() => {
        this.writeTimer = undefined;
        if (!this.activeWrite) { this.flushWrites(); }
      }, 350);
    });
  }
  private flushWrites(): void {
    if (this.activeWrite || this.pendingWrites.length === 0) { return; }
    this.activeWrite = true;
    const writes = this.pendingWrites.splice(0);
    let accepted = false;
    void this.platform.client.control(info => {
      const combined: ControlUpdate = {};
      const next = { ...info };
      for (const write of writes) {
        const change = write.update(next);
        Object.assign(combined, change);
        Object.assign(next, change);
      }
      return combined;
    }, () => {
      accepted = true;
      for (const write of writes) { write.resolve(); }
    }).then(info => {
      if (this.pendingWrites.length === 0) { this.update(info); }
    }).catch(error => {
      if (this.pendingWrites.length === 0 && this.platform.client.latest) { this.update(this.platform.client.latest); }
      if (accepted) {
        this.platform.log.warn('Control accepted; readback verification incomplete:', String(error));
      } else {
        this.platform.log.warn('Control failed:', String(error));
        const failure = new this.platform.api.hap.HapStatusError(error instanceof ControlValidationError
          ? this.platform.api.hap.HAPStatus.INVALID_VALUE_IN_REQUEST : error instanceof RateLimitError
            ? this.platform.api.hap.HAPStatus.RESOURCE_BUSY : this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        for (const write of writes) { write.reject(failure); }
      }
    }).finally(() => {
      this.activeWrite = false;
      if (this.pendingWrites.length > 0 && !this.writeTimer) { this.flushWrites(); }
    });
  }
  setDevice(device: DeviceInfo): void {
    const C = this.platform.api.hap.Characteristic;
    this.accessory.getService(this.platform.api.hap.Service.AccessoryInformation)!
      .setCharacteristic(C.Manufacturer, device.brand).setCharacteristic(C.Model, device.model)
      .setCharacteristic(C.FirmwareRevision, device.firmware).setCharacteristic(C.SerialNumber, this.accessory.UUID);
  }
  offline(): void {
    this.online = false;
    const error = new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    const C = this.platform.api.hap.Characteristic;
    for (const type of [C.CurrentTemperature, C.CurrentHeatingCoolingState, C.TargetHeatingCoolingState,
      C.TargetTemperature, C.HeatingThresholdTemperature, C.CoolingThresholdTemperature, C.TemperatureDisplayUnits]) {
      this.thermostat.updateCharacteristic(type, error);
    }
    if (this.thermostat.testCharacteristic(C.CurrentRelativeHumidity)) {
      this.thermostat.updateCharacteristic(C.CurrentRelativeHumidity, error);
    }
  }
  update(info: ThermostatInfo): void {
    this.current = info;
    this.online = true;
    const C = this.platform.api.hap.Characteristic;
    this.thermostat.getCharacteristic(C.TargetHeatingCoolingState)
      .setProps({ validValues: [...new Set([0, ...info.availableModes.filter(mode => [0, 1, 2, 3].includes(mode))])] });
    this.thermostat.getCharacteristic(C.HeatingThresholdTemperature)
      .setProps({ minValue: info.heatSetpointMin, maxValue: info.heatSetpointMax, minStep: 0.1 });
    this.thermostat.getCharacteristic(C.CoolingThresholdTemperature)
      .setProps({ minValue: info.coolSetpointMin, maxValue: info.coolSetpointMax, minStep: 0.1 });
    const cooling = info.mode === 2;
    this.thermostat.getCharacteristic(C.TargetTemperature).setProps({
      minValue: cooling ? info.coolSetpointMin : info.heatSetpointMin,
      maxValue: cooling ? info.coolSetpointMax : info.heatSetpointMax, minStep: 0.1,
    });
    this.thermostat.updateCharacteristic(C.CurrentTemperature, info.spaceTemp)
      .updateCharacteristic(C.CurrentHeatingCoolingState, equipmentState(info.state))
      .updateCharacteristic(C.TargetHeatingCoolingState, targetMode(info.mode))
      .updateCharacteristic(C.TargetTemperature, targetTemperature(info))
      .updateCharacteristic(C.HeatingThresholdTemperature, info.heatSetpoint)
      .updateCharacteristic(C.CoolingThresholdTemperature, info.coolSetpoint)
      .updateCharacteristic(C.TemperatureDisplayUnits, displayUnits(info.tempUnits));
    if (info.spaceHum !== undefined) {
      this.thermostat.getCharacteristic(C.CurrentRelativeHumidity).onGet(() => {
        if (!this.online || this.current?.spaceHum === undefined) {
          throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
        return this.current.spaceHum;
      });
      this.thermostat.updateCharacteristic(C.CurrentRelativeHumidity, info.spaceHum);
    } else if (this.thermostat.testCharacteristic(C.CurrentRelativeHumidity)) {
      this.thermostat.updateCharacteristic(C.CurrentRelativeHumidity,
        new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
    }
  }
}

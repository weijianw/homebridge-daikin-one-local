import { DaikinMode, type ControlUpdate, type ThermostatInfo } from './types.js';

export class ControlValidationError extends Error {}

// HAP constants: target OFF/HEAT/COOL/AUTO = 0/1/2/3; current OFF/HEAT/COOL = 0/1/2.
export function targetMode(mode: number): number { return [0, 1, 2, 3].includes(mode) ? mode : 0; }
export function equipmentState(state: number): number {
  return [1, 2].includes(state) ? 2 : [3, 8].includes(state) ? 1 : 0;
}
export function displayUnits(units: number): number { return units === 0 ? 1 : 0; }
export function targetTemperature(info: ThermostatInfo): number {
  return info.mode === DaikinMode.Cool ? info.coolSetpoint : info.heatSetpoint;
}
export function temperatureUpdate(info: ThermostatInfo, value: number): ControlUpdate {
  if (info.mode === DaikinMode.Heat) { return { heatSetpoint: value }; }
  if (info.mode === DaikinMode.Cool) { return { coolSetpoint: value }; }
  throw new ControlValidationError('TargetTemperature can only be changed in Heat or Cool; use independent thresholds in Auto');
}
/** Enter Auto without losing the setpoint of the active Heat/Cool mode. */
export function modeUpdate(info: ThermostatInfo, mode: DaikinMode): ControlUpdate {
  if (mode !== DaikinMode.Auto || info.coolSetpoint - info.heatSetpoint >= info.setpointDelta - 1e-9) {
    return { mode };
  }
  const roundUp = (value: number) => Math.ceil((value - 1e-9) * 10) / 10;
  const roundDown = (value: number) => Math.floor((value + 1e-9) * 10) / 10;
  const cool = roundUp(info.heatSetpoint + info.setpointDelta);
  const heat = roundDown(info.coolSetpoint - info.setpointDelta);
  if (info.mode === DaikinMode.Cool) {
    if (heat >= info.heatSetpointMin) { return { mode, heatSetpoint: heat }; }
    if (cool <= info.coolSetpointMax) { return { mode, coolSetpoint: cool }; }
  } else {
    if (cool <= info.coolSetpointMax) { return { mode, coolSetpoint: cool }; }
    if (heat >= info.heatSetpointMin) { return { mode, heatSetpoint: heat }; }
  }
  throw new ControlValidationError('Cannot enter Auto within device setpoint limits');
}
export function validateControl(info: ThermostatInfo, update: ControlUpdate): void {
  const keys = Object.keys(update).filter(key => update[key as keyof ControlUpdate] !== undefined);
  if (!keys.length || keys.some(key => !['mode', 'heatSetpoint', 'coolSetpoint'].includes(key))) {
    throw new ControlValidationError('Invalid or empty control update');
  }
  if (update.mode !== undefined && (!Number.isInteger(update.mode) || update.mode < 0 || update.mode > 6
    || !info.availableModes.includes(update.mode))) {
    throw new ControlValidationError('Unsupported HVAC mode');
  }
  for (const key of ['heatSetpoint', 'coolSetpoint'] as const) {
    const value = update[key];
    if (value !== undefined && (!Number.isFinite(value) || value < info[`${key}Min`] || value > info[`${key}Max`])) {
      throw new ControlValidationError(`${key} must be within ${info[`${key}Min`]}–${info[`${key}Max`]} °C`);
    }
  }
  const changesTemperature = update.mode !== undefined || update.heatSetpoint !== undefined || update.coolSetpoint !== undefined;
  if (changesTemperature && (update.mode ?? info.mode) === DaikinMode.Auto
    && (update.coolSetpoint ?? info.coolSetpoint) - (update.heatSetpoint ?? info.heatSetpoint) < info.setpointDelta - 1e-9) {
    throw new ControlValidationError(`Auto cooling threshold must be at least ${info.setpointDelta} °C above heating threshold`);
  }
}

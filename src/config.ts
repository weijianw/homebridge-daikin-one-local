import { isIP } from 'node:net';
export interface Config {
  host: string;
  port: number;
  pollInterval: number;
  enableWrites: boolean;
  debug: boolean;
}
export function parseConfig(raw: Record<string, unknown>): Config {
  if (typeof raw.host !== 'string' || !raw.host.trim()) {
    throw new Error('Set host to the thermostat IP or hostname; automatic mDNS discovery is not implemented');
  }
  const host = raw.host.trim().toLowerCase();
  if (!isIP(host) && !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)) {
    throw new Error('host must be an IP address or hostname without a scheme, port, or path');
  }
  const port = raw.port ?? 80;
  const pollInterval = raw.pollInterval ?? 15000;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) { throw new Error('port must be 1–65535'); }
  if (typeof pollInterval !== 'number' || !Number.isInteger(pollInterval) || pollInterval < 5000 || pollInterval > 2147483647) {
    throw new Error('pollInterval must be 5000–2147483647 milliseconds');
  }
  for (const key of ['enableWrites', 'debug']) {
    if (raw[key] !== undefined && typeof raw[key] !== 'boolean') { throw new Error(`${key} must be a boolean`); }
  }
  return { host, port, pollInterval, enableWrites: raw.enableWrites === true, debug: raw.debug === true };
}
export function baseUrl(config: Config): string {
  return `http://${isIP(config.host) === 6 ? `[${config.host}]` : config.host}:${config.port}`;
}

# homebridge-daikin-one-local

Homebridge integration for Daikin One+ and One Touch thermostats using the [official Daikin One Local API v1.0](https://www.daikinac.com/dakin-one-local-api). It communicates directly over your LAN, with no cloud account. **So far, this plugin has only been tested on a Daikin One Touch thermostat connected to a Daikin FIT heat pump.** One+ support has not been verified on physical hardware.

## Features

- Native HomeKit Thermostat with Off, Heat, Cool, and Auto when supported by the device; indoor temperature and humidity; and separate heating and cooling thresholds.
- Setpoint limits and Auto-mode separation come from the thermostat.

## Setup

1. Update the thermostat firmware and enable **Settings → Wi-Fi → Local API → ON** on the thermostat.
2. Once published, install `homebridge-daikin-one-local` from the Homebridge UI Plugins tab.
3. Add this platform configuration in Homebridge UI or in the `platforms` array of `config.json`:

   ```json
   {
     "platform": "DaikinOneLocal",
     "name": "Daikin One Local",
     "host": "daikinone-thermostat-a1b2c3.local",
     "port": 80,
     "pollInterval": 15000,
     "enableWrites": false
   }
   ```

Replace the example hostname with your thermostat's mDNS hostname or reserved IP address. The host must not include `http://` or a port. Port 80 is the default for manual configuration; use the port your thermostat advertises if different. Automatic mDNS discovery is not implemented.

`pollInterval` sets the time between status checks in milliseconds; the default is 15,000 (15 seconds), and the minimum is 5,000.

Writes are disabled by default. After confirming readings, set `enableWrites` to `true` to control HVAC mode and setpoints.

The plugin can run in a Homebridge child bridge: enable **Child Bridge** in its plugin settings, then pair the child bridge with Apple Home. Keep the accessory cache and bridge pairing when updating the plugin.

## Limitations and troubleshooting

- One manually configured thermostat is supported. There is no automatic discovery, Away mode, schedule editing, fan control, or cloud integration.
- If the thermostat does not appear, check `http://HOST/query/info` from the Homebridge host or container. For mDNS issues, inspect `_http._tcp.local.` and its advertised port with a tool such as `avahi-browse -r _http._tcp`; a reserved IP may be more reliable across Docker network boundaries.
- The Local API uses **unauthenticated, unencrypted HTTP**. Keep the thermostat on a trusted LAN. Do not forward its port or expose it to the internet.

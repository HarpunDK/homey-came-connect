'use strict';

const Homey = require('homey');
const CameConnect = require('../../lib/cameconnect');
const { CameConnectError } = require('../../lib/cameconnect-errors');

module.exports = class GateDriver extends Homey.Driver {

  async onInit() {
    this.homey.log('[GateDriver] Init');
    this.api = new CameConnect(this.homey);
  }

  async onPairListDevices() {
    this.homey.log('[GateDriver] Pair list requested');

    try {
      const devices = await this.api.listDevices();
      this.homey.log('[GateDriver] Pair list result count', devices.length);

      return devices.map(d => ({
        name: d.name,
        data: { id: d.id }
      }));
    } catch (err) {
      const code = err && err.code ? err.code : 'UNKNOWN';
      const status = err && typeof err.status !== 'undefined' ? err.status : 'n/a';
      const message = err && err.message ? err.message : String(err);
      this.homey.error(`[GateDriver] Pair list failed code=${code} status=${status} message=${message}`);

      if (err instanceof CameConnectError && err.code === 'MISSING_CREDENTIALS') {
        throw new Error('Missing CAME settings. Open app settings and save Email/Password/Client ID/Client Secret first.');
      }

      if (err instanceof CameConnectError && err.code === 'REQUEST_TIMEOUT') {
        throw new Error('CAME API timeout. Try again and check that Homey has stable internet.');
      }

      if (err instanceof CameConnectError && err.code === 'NETWORK_DNS') {
        throw new Error('DNS/network error while contacting CAME API. Check internet and DNS on your network.');
      }

      if (err instanceof CameConnectError && err.code === 'LOGIN_FAILED') {
        throw new Error('Login failed against CAME API. Verify Email/Password/Client ID/Client Secret in app settings.');
      }

      if (err instanceof CameConnectError && err.code === 'REQUEST_FAILED' && err.status === 401) {
        throw new Error('Unauthorized from CAME API (401). Credentials or client configuration may be invalid.');
      }

      if (err instanceof CameConnectError && err.code === 'NO_DEVICES_FOUND') {
        throw new Error('Connected to CAME API, but no devices were found on this account.');
      }

      throw new Error(`Unable to fetch CAME devices: ${err && err.message ? err.message : 'Unknown error'}`);
    }
  }
};
'use strict';

const Homey = require('homey');
const CameConnect = require('../../lib/cameconnect');

module.exports = class GateDriver extends Homey.Driver {

  async onInit() {
    this.homey.log('[GateDriver] Init');
    this.api = new CameConnect(this.homey);
  }

  onPairListDevices() {
    return this.api.listDevices().then(devices => {
      return devices.map(d => ({
        name: d.name,
        data: { id: d.id }
      }));
    });
  }
};
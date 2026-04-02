'use strict';

const Homey = require('homey');
const CameConnect = require('../../lib/cameconnect');

module.exports = class GateDevice extends Homey.Device {

    async onInit() {
        this.homey.log('[GateDevice] Init', this.getName(), this.getData());
        this.api = new CameConnect(this.homey);
        this.pollIntervalMs = 15000;
        this.startPolling();
    }

    async startPolling() {
        if (this.pollInterval) clearInterval(this.pollInterval);

        this.pollInterval = setInterval(async () => {
            try {
                await this.api.ensureLoggedIn();
                const state = await this.api.getDeviceState(this.getData().id);

                const isOpen = !!state.isOpen;
                await this.setCapabilityValue('windowcoverings_state', isOpen ? 'open' : 'closed');
                //await this.setCapabilityValue('closed', !isOpen).catch(this.error);
            } catch (err) {
                this.error('[GateDevice] Poll error', err.message || err);
            }
        }, this.pollIntervalMs);
    }

    async onCapabilitySet(capability, value) {
        const id = this.getData().id;

        if (capability === 'windowcoverings_state') {
            if (value === 'open') {
                await this.api.sendCommand(id, 'open');
            }
            if (value === 'closed') {
                await this.api.sendCommand(id, 'close');
            }
            if (value === 'stopped') {
                await this.api.sendCommand(id, 'stop');
            }
        }
    }

    onDeleted() {
        if (this.pollInterval) clearInterval(this.pollInterval);
    }
};
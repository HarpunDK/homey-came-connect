'use strict';

const Homey = require('homey');
const CameConnect = require('../../lib/cameconnect');

function toLogString(value) {
    try {
        return JSON.stringify(value);
    } catch (err) {
        return String(value);
    }
}

module.exports = class GateDevice extends Homey.Device {

    async onInit() {
        this.homey.log('[GateDevice] Init', this.getName(), this.getData());
        this.api = new CameConnect(this.homey);
        this.pollIntervalMs = 15000;

        this.burstFastIntervalMs = 1000;
        this.burstSlowIntervalMs = 2500;
        this.burstFastDurationMs = 10000;
        this.burstTotalDurationMs = 30000;
        this.burstStableNeeded = 2;
        this.burstStableCount = 0;
        this.burstLastSignature = null;
        this.pollInProgress = false;

        // Warm up auth in the background so first user action is less likely to time out.
        this.api.ensureLoggedIn().catch(err => {
            this.error('[GateDevice] Initial login failed', err.message || err);
        });

        if (!this.hasCapability('came_phase')) {
            try {
                await this.addCapability('came_phase');
            } catch (err) {
                this.error('[GateDevice] Failed to add came_phase capability', err.message || err);
            }
        }

        this.registerCapabilityListener('garagedoor_closed', async value => {
            const id = this.getData().id;
            const command = value ? 'close' : 'open';

            // Do not block the capability listener on network/API latency.
            this.api.sendCommand(id, command)
                .then(response => {
                    this.homey.log('[GateDevice] Command response', command, toLogString(response));
                    this.startBurstPolling(command);
                })
                .catch(err => {
                    this.error('[GateDevice] Command error', err.message || err);
                });
        });

        this.startPolling();
    }

    async startPolling() {
        if (this.pollInterval) clearInterval(this.pollInterval);

        // Run one immediate poll so startup and first command do not show stale values.
        await this.pollState();

        this.pollInterval = setInterval(async () => {
            await this.pollState();
        }, this.pollIntervalMs);
    }

    async pollState() {
        if (this.pollInProgress) return null;

        this.pollInProgress = true;
        try {
            await this.api.ensureLoggedIn();
            const state = await this.api.getDeviceState(this.getData().id);
            this.homey.log('[GateDevice] Poll response', toLogString(state));

            const isOpen = !!state.isOpen;
            if (this.hasCapability('garagedoor_closed')) {
                await this.setCapabilityValue('garagedoor_closed', !isOpen);
            }

            if (this.hasCapability('alarm_connectivity') && state.isOnline !== null) {
                await this.setCapabilityValue('alarm_connectivity', !state.isOnline);
            }

            if (this.hasCapability('came_device_id') && state.id) {
                await this.setCapabilityValue('came_device_id', String(state.id));
            }

            if (this.hasCapability('came_position') && Number.isFinite(state.position)) {
                const clampedPosition = Math.max(0, Math.min(100, Math.round(state.position)));
                await this.setCapabilityValue('came_position', clampedPosition);
            }

            if (this.hasCapability('came_phase') && Number.isFinite(state.phase)) {
                await this.setCapabilityValue('came_phase', Math.round(state.phase));
            }

            return state;
        } catch (err) {
            this.error('[GateDevice] Poll error', err.message || err);
            return null;
        } finally {
            this.pollInProgress = false;
        }
    }

    startBurstPolling(command) {
        this.stopBurstPolling();
        this.burstStableCount = 0;
        this.burstLastSignature = null;

        this.homey.log('[GateDevice] Burst polling started', command);
        this.runBurstPoll();

        this.burstInterval = setInterval(() => {
            this.runBurstPoll();
        }, this.burstFastIntervalMs);

        this.burstPhaseTimer = setTimeout(() => {
            if (this.burstInterval) clearInterval(this.burstInterval);
            this.burstInterval = setInterval(() => {
                this.runBurstPoll();
            }, this.burstSlowIntervalMs);
            this.homey.log('[GateDevice] Burst polling switched to slow phase');
        }, this.burstFastDurationMs);

        this.burstStopTimer = setTimeout(() => {
            this.stopBurstPolling();
        }, this.burstTotalDurationMs);
    }

    async runBurstPoll() {
        const state = await this.pollState();
        if (!state) return;

        const signature = `${state.phase}|${state.position}|${state.isOpen}`;
        const isTerminalPhase = state.phase === 16 || state.phase === 17;

        if (signature === this.burstLastSignature && isTerminalPhase) {
            this.burstStableCount += 1;
        } else {
            this.burstStableCount = 0;
        }

        this.burstLastSignature = signature;

        if (this.burstStableCount >= this.burstStableNeeded) {
            this.homey.log('[GateDevice] Burst polling stopped early (stable state)');
            this.stopBurstPolling();
        }
    }

    stopBurstPolling() {
        if (this.burstInterval) {
            clearInterval(this.burstInterval);
            this.burstInterval = null;
        }

        if (this.burstPhaseTimer) {
            clearTimeout(this.burstPhaseTimer);
            this.burstPhaseTimer = null;
        }

        if (this.burstStopTimer) {
            clearTimeout(this.burstStopTimer);
            this.burstStopTimer = null;
        }
    }

    onDeleted() {
        if (this.pollInterval) clearInterval(this.pollInterval);
        this.stopBurstPolling();
    }
};
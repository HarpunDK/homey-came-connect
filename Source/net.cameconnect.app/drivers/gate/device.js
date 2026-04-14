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

function getIsMoving(state) {
    const activityCode = Number.isFinite(state.activityCode) ? Math.round(state.activityCode) : null;
    const phase = Number.isFinite(state.phase) ? Math.round(state.phase) : null;

    if (activityCode !== null) {
        return activityCode !== 0;
    }

    if (phase === 32 || phase === 33) {
        return true;
    }

    if (phase === 16 || phase === 17 || phase === 19) {
        return false;
    }

    return null;
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
        // Track current state to prevent redundant commands
        this.lastIsOpen = null;
        this.lastIsClosed = null;
        // Warm up auth in the background so first user action is less likely to time out.
        this.api.ensureLoggedIn().catch(err => {
            this.error('[GateDevice] Initial login failed', err.message || err);
        });

        for (const capabilityId of ['came_phase', 'came_position']) {
            if (!this.hasCapability(capabilityId)) continue;

            try {
                await this.removeCapability(capabilityId);
            } catch (err) {
                this.error('[GateDevice] Failed to remove legacy capability', capabilityId, err.message || err);
            }
        }

        for (const capabilityId of ['came_primary_code', 'came_activity_code', 'came_stopped']) {
            if (this.hasCapability(capabilityId)) continue;

            try {
                await this.addCapability(capabilityId);
            } catch (err) {
                this.error('[GateDevice] Failed to add raw status capability', capabilityId, err.message || err);
            }
        }

        this.registerCapabilityListener('garagedoor_closed', async value => {
            const command = value ? 'close' : 'open';
            this.executeCommand(command);
        });

        this.registerActionButton('button_open', 'open');
        this.registerActionButton('button_close', 'close');
        this.registerActionButton('button_stop', 'stop');
        this.registerActionButton('button_sequential', 'sequential');
        this.registerCapabilityListener('button_partial', async value => {
            if (value !== true) return;
            this.runPartialCommand();
        });

        this.startPolling();
    }

    registerActionButton(capabilityId, command) {
        if (!this.hasCapability(capabilityId)) return;

        this.registerCapabilityListener(capabilityId, async value => {
            if (value !== true) return;

            this.executeCommand(command);
        });
    }

    executeCommand(command) {
        const id = this.getData().id;

        this.api.sendCommand(id, command)
            .then(response => {
                this.homey.log('[GateDevice] Command response', command, toLogString(response));
                this.startBurstPolling(command);
            })
            .catch(err => {
                this.error('[GateDevice] Command error', err.message || err);
            });
    }

    async runPartialCommand() {
        this.executeCommand('partial');
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

            const primaryCode = Number.isFinite(state.primaryCode) ? Math.round(state.primaryCode) : null;
            const activityCode = Number.isFinite(state.activityCode) ? Math.round(state.activityCode) : null;
            const isClosed = primaryCode === 1 ? true : (primaryCode === 2 ? false : null);
            const isMoving = getIsMoving(state);

            if (this.hasCapability('garagedoor_closed') && isClosed !== null) {
                await this.setCapabilityValue('garagedoor_closed', isClosed);
            }

            if (this.hasCapability('alarm_connectivity') && state.isOnline !== null) {
                await this.setCapabilityValue('alarm_connectivity', !state.isOnline);
            }

            if (this.hasCapability('came_device_id') && state.id) {
                await this.setCapabilityValue('came_device_id', String(state.id));
            }

            if (this.hasCapability('came_primary_code') && primaryCode !== null) {
                await this.setCapabilityValue('came_primary_code', primaryCode);
            }

            if (this.hasCapability('came_activity_code') && activityCode !== null) {
                await this.setCapabilityValue('came_activity_code', activityCode);
            }

            if (this.hasCapability('came_stopped') && isMoving !== null) {
                await this.setCapabilityValue('came_stopped', !isMoving);
            }

            this.lastIsOpen = null;
            this.lastIsClosed = null;

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

        const signature = `${state.primaryCode}|${state.activityCode}`;
        const isStableIdle = state.primaryCode !== null && state.activityCode === 0;

        if (signature === this.burstLastSignature && isStableIdle) {
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
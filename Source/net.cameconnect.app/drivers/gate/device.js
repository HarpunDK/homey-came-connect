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
        // Track current state to prevent redundant commands
        this.lastIsOpen = null;
        this.lastIsClosed = null;
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
            
            // Prevent redundant commands based on current state
            if (command === 'open' && this.lastIsOpen === true) {
                this.homey.log('[GateDevice] Open command ignored - gate already open');
                return;
            }
            if (command === 'close' && this.lastIsClosed === true) {
                this.homey.log('[GateDevice] Close command ignored - gate already closed');
                return;
            }
            
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

            const clampedPosition = Number.isFinite(state.position)
                ? Math.max(0, Math.min(100, Math.round(state.position)))
                : null;
            const phase = Number.isFinite(state.phase) ? Math.round(state.phase) : null;
            const isOpen = phase === 16 || (clampedPosition !== null ? clampedPosition >= 99 : !!state.isOpen);
            const isClosed = phase === 17 || (clampedPosition !== null ? clampedPosition <= 1 : state.isOpen === false);

            if (this.hasCapability('garagedoor_closed')) {
                await this.setCapabilityValue('garagedoor_closed', isClosed);
            }

            if (this.hasCapability('alarm_connectivity') && state.isOnline !== null) {
                await this.setCapabilityValue('alarm_connectivity', !state.isOnline);
            }

            if (this.hasCapability('came_device_id') && state.id) {
                await this.setCapabilityValue('came_device_id', String(state.id));
            }

            if (this.hasCapability('came_position') && clampedPosition !== null) {
                await this.setCapabilityValue('came_position', clampedPosition);
            }

            if (this.hasCapability('came_phase') && phase !== null) {
                await this.setCapabilityValue('came_phase', phase);
            }

            if (this.hasCapability('button_open')) {
                await this.setCapabilityValue('button_open', isOpen);
            }

            if (this.hasCapability('button_close')) {
                await this.setCapabilityValue('button_close', isClosed);
            }
            
            // Store current state to prevent redundant commands
            this.lastIsOpen = isOpen;
            this.lastIsClosed = isClosed;

            if (this.hasCapability('button_partial')) {
                const isPartial = clampedPosition !== null
                    ? clampedPosition > 1 && clampedPosition < 99
                    : phase === 19;
                await this.setCapabilityValue('button_partial', isPartial);
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
        const isTerminalPhase = state.phase === 16 || state.phase === 17 || state.phase === 19;

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
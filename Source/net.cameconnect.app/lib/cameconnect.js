'use strict';

const fetch = require('node-fetch');
const { CameConnectError } = require('./cameconnect-errors');

module.exports = class CameConnect {

  constructor(homey) {
    this.homey = homey;
    this.baseUrl = 'https://api.cameconnect.net';
    this.clientId = 'DIN_CLIENT_ID';
    this.clientSecret = 'DIT_CLIENT_SECRET';
    this.loginInProgress = null;
  }

  get email() {
    return this.homey.settings.get('CameConnectEmail');
  }

  get password() {
    return this.homey.settings.get('CameConnectPassword');
  }

  get accessToken() {
    return this.homey.settings.get('CameConnectAccessToken');
  }

  set accessToken(token) {
    this.homey.settings.set('CameConnectAccessToken', token);
  }

  get refreshTokenValue() {
    return this.homey.settings.get('CameConnectRefreshToken');
  }

  set refreshTokenValue(token) {
    this.homey.settings.set('CameConnectRefreshToken', token);
  }

  async ensureLoggedIn() {
    if (this.accessToken) return;

    if (!this.loginInProgress) {
      this.loginInProgress = this.login()
        .catch(err => {
          this.homey.error('[CameConnect] Login failed', err);
          throw err;
        })
        .finally(() => {
          this.loginInProgress = null;
        });
    }

    return this.loginInProgress;
  }

  async login() {
    if (!this.email || !this.password) {
      throw new CameConnectError('Missing email/password in settings', 'MISSING_CREDENTIALS');
    }

    this.homey.log('[CameConnect] Logging in');

    const res = await fetch(`${this.baseUrl}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        username: this.email,
        password: this.password,
        grant_type: 'password'
      })
    });

    if (!res.ok) {
      const text = await res.text();
      throw new CameConnectError(`Login failed: ${res.status} ${text}`, 'LOGIN_FAILED', res.status);
    }

    const data = await res.json();
    this.accessToken = data.access_token;
    this.refreshTokenValue = data.refresh_token;
  }

  async refreshToken() {
    if (!this.refreshTokenValue) {
      this.homey.log('[CameConnect] No refresh token, logging in again');
      return this.login();
    }

    this.homey.log('[CameConnect] Refreshing token');

    const res = await fetch(`${this.baseUrl}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: this.refreshTokenValue,
        grant_type: 'refresh_token'
      })
    });

    if (!res.ok) {
      const text = await res.text();
      this.homey.error('[CameConnect] Refresh failed, clearing tokens', text);
      this.accessToken = null;
      this.refreshTokenValue = null;
      throw new CameConnectError('Refresh token failed', 'REFRESH_FAILED', res.status);
    }

    const data = await res.json();
    this.accessToken = data.access_token;
    this.refreshTokenValue = data.refresh_token;
  }

  async request(path, options = {}, retry = true) {
    await this.ensureLoggedIn();

    const url = `${this.baseUrl}${path}`;
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
      'Authorization': `Bearer ${this.accessToken}`
    };

    const res = await fetch(url, {
      ...options,
      headers
    });

    if (res.status === 401 && retry) {
      this.homey.log('[CameConnect] 401, trying refresh');
      await this.refreshToken();
      return this.request(path, options, false);
    }

    if (!res.ok) {
      const text = await res.text();
      throw new CameConnectError(`Request failed: ${res.status} ${text}`, 'REQUEST_FAILED', res.status);
    }

    if (res.status === 204) return null;

    return res.json();
  }

  async listDevices() {
    const raw = await this.request('/devices');
    // Her kan du mappe til et mere pænt format hvis nødvendigt
    return raw;
  }

  async getDeviceState(id) {
    const state = await this.request(`/devices/${id}/state`);
    // Tilpas mapping til { isOpen: bool } hvis nødvendigt
    return {
      ...state,
      isOpen: !!state.isOpen
    };
  }

  async sendCommand(id, command) {
    return this.request(`/devices/${id}/commands`, {
      method: 'POST',
      body: JSON.stringify({ command })
    });
  }
};
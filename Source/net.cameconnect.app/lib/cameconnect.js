'use strict';

const crypto = require('crypto');
const fetch = require('node-fetch');
const { CameConnectError } = require('./cameconnect-errors');

module.exports = class CameConnect {

  constructor(homey) {
    this.homey = homey;
    this.baseUrl = 'https://app.cameconnect.net/api';
    this.defaultRedirectUri = 'https://app.cameconnect.net/role';
    this.loginInProgress = null;
  }

  get email() {
    return this.homey.settings.get('CameConnectEmail');
  }

  get password() {
    return this.homey.settings.get('CameConnectPassword');
  }

  get clientId() {
    return this.homey.settings.get('CameConnectClientId');
  }

  get clientSecret() {
    return this.homey.settings.get('CameConnectClientSecret');
  }

  get redirectUri() {
    return this.homey.settings.get('CameConnectRedirectUri') || this.defaultRedirectUri;
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

  static randomString(length = 16) {
    return crypto.randomBytes(length).toString('hex').slice(0, length);
  }

  static generateCodeVerifier(length = 64) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    let verifier = '';
    for (let i = 0; i < length; i++) {
      const idx = crypto.randomInt(0, alphabet.length);
      verifier += alphabet[idx];
    }
    return verifier;
  }

  static generateCodeChallenge(codeVerifier) {
    return crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  }

  buildBasicAuthHeader() {
    const token = Buffer
      .from(`${this.clientId}:${this.clientSecret}`, 'utf8')
      .toString('base64');

    return {
      'Authorization': `Basic ${token}`,
      'Accept': 'application/json'
    };
  }

  async parseResponseBody(res) {
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('application/json')) {
      return res.json();
    }

    const text = await res.text();
    if (!text) return text;

    try {
      return JSON.parse(text);
    } catch (err) {
      return text;
    }
  }

  static normalizeList(payload) {
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== 'object') return [];

    for (const key of ['Data', 'data', 'Items', 'items']) {
      if (Array.isArray(payload[key])) return payload[key];
    }

    return [];
  }

  static extractDeviceId(device) {
    if (!device || typeof device !== 'object') return null;
    return device.id || device.Id || device.DeviceId || device.AutomationId || null;
  }

  static extractDeviceName(device, fallbackId) {
    if (!device || typeof device !== 'object') return String(fallbackId);
    return device.Name;
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
    if (!this.email || !this.password || !this.clientId || !this.clientSecret) {
      throw new CameConnectError('Missing credentials in settings', 'MISSING_CREDENTIALS');
    }

    this.homey.log(`[CameConnect] Logging in (${this.baseUrl})`);

    const codeVerifier = CameConnect.generateCodeVerifier(64);
    const codeChallenge = CameConnect.generateCodeChallenge(codeVerifier);

    const authCodeParams = new URLSearchParams({
      client_id: this.clientId,
      response_type: 'code',
      redirect_uri: this.redirectUri,
      state: CameConnect.randomString(16),
      nonce: CameConnect.randomString(16),
      code_challenge: codeChallenge,
      code_challenge_method: 'S256'
    });

    const authCodeBody = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.clientId,
      username: this.email,
      password: this.password
    });

    const authCodeRes = await fetch(`${this.baseUrl}/oauth/auth-code?${authCodeParams.toString()}`, {
      method: 'POST',
      headers: {
        ...this.buildBasicAuthHeader(),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: authCodeBody.toString()
    });

    const authCodeData = await this.parseResponseBody(authCodeRes);
    if (!authCodeRes.ok || !authCodeData || !authCodeData.code) {
      throw new CameConnectError(
        `Auth code failed: ${authCodeRes.status} ${JSON.stringify(authCodeData)}`,
        'LOGIN_FAILED',
        authCodeRes.status
      );
    }

    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code: authCodeData.code,
      redirect_uri: this.redirectUri,
      code_verifier: codeVerifier
    });

    const tokenRes = await fetch(`${this.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: {
        ...this.buildBasicAuthHeader(),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: tokenBody.toString()
    });

    const tokenData = await this.parseResponseBody(tokenRes);
    if (!tokenRes.ok || !tokenData || !tokenData.access_token) {
      throw new CameConnectError(
        `Token exchange failed: ${tokenRes.status} ${JSON.stringify(tokenData)}`,
        'LOGIN_FAILED',
        tokenRes.status
      );
    }

    this.accessToken = tokenData.access_token;
    this.refreshTokenValue = tokenData.refresh_token || null;
  }

  async refreshToken() {
    this.homey.log('[CameConnect] Refreshing by re-authenticating');
    this.accessToken = null;
    this.refreshTokenValue = null;
    return this.login();
  }

  async listDevices() {
    const endpoints = ['/automations', '/evo/v1/devices', '/devices'];
    let lastError = null;

    for (const endpoint of endpoints) {
      try {
        const raw = await this.request(endpoint);
        const devices = CameConnect.normalizeList(raw);
        if (!devices.length) continue;

        // console.log("API says", "Devices", devices);

        const mapped = devices
          .map(device => {
            const id = CameConnect.extractDeviceId(device);
            if (id === null || id === undefined) return null;

            return {
              id: String(id),
              name: CameConnect.extractDeviceName(device, id) + ` (${device.ModelName})`
            };
          })
          .filter(Boolean);

        if (mapped.length) {
          return mapped;
        }
      } catch (err) {
        lastError = err;
      }
    }

    if (lastError) throw lastError;
    throw new CameConnectError('No devices found from CAME API', 'NO_DEVICES_FOUND');
  }

  async getDeviceState(id) {
    const state = await this.request('/devicestatus', {
      method: 'GET'
    }, true, {
      devices: `[${id}]`
    });

    const rows = CameConnect.normalizeList(state);
    if (!rows.length) {
      throw new CameConnectError(`No state returned for device ${id}`, 'STATE_NOT_FOUND');
    }

    const row = rows[0] || {};
    const states = Array.isArray(row.States) ? row.States : [];
    const movementState = states[2] && Array.isArray(states[2].Data) ? states[2].Data : [];
    const phase = Number.isFinite(Number(movementState[0])) ? Number(movementState[0]) : null;
    const position = Number.isFinite(Number(movementState[1])) ? Number(movementState[1]) : null;

    const PHASE_OPEN = 16;
    const PHASE_CLOSED = 17;

    const isOpen = phase === PHASE_OPEN || (phase !== PHASE_CLOSED && position !== null && position > 0);

    return {
      raw: row,
      phase,
      position,
      isOpen
    };
  }

  async sendCommand(id, command) {
    const commandMap = {
      open: 2,
      close: 5,
      stop: 129
    };

    const commandId = commandMap[command];
    if (!commandId) {
      throw new CameConnectError(`Unsupported command: ${command}`, 'INVALID_COMMAND');
    }

    return this.request(`/automations/${id}/commands/${commandId}`, {
      method: 'POST',
      body: JSON.stringify({})
    });
  }

  async request(path, options = {}, retry = true, query = null) {
    await this.ensureLoggedIn();

    const base = `${this.baseUrl}${path}`;
    const qs = query ? new URLSearchParams(query).toString() : '';
    const url = qs ? `${base}?${qs}` : base;
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
      return this.request(path, options, false, query);
    }

    if (!res.ok) {
      const text = await res.text();
      throw new CameConnectError(`Request failed: ${res.status} ${text}`, 'REQUEST_FAILED', res.status);
    }

    if (res.status === 204) return null;

    return this.parseResponseBody(res);
  }
};
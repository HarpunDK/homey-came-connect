'use strict';

class CameConnectError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'CameConnectError';
    this.code = code;
    this.status = status;
  }
}

module.exports = {
  CameConnectError
};
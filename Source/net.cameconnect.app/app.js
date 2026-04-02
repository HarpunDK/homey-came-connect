'use strict';

const Homey = require('homey');

module.exports = class CameConnect extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('CameConnect has been initialized');
  }

};

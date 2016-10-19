var FoscamAccessory = require("homebridge-foscam-stream").FoscamAccessory;
var FoscamStreamLayer = require('foscam-binary-client').FoscamStreamLayer;
var Foscam = require("foscam-client");
var chalk = require("chalk");
var util = require("util");
var Accessory, Service, Characteristic, UUIDGen, hap;

module.exports = function (homebridge) {
  Accessory = homebridge.platformAccessory;
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  UUIDGen = homebridge.hap.uuid;
  hap = homebridge.hap;

  homebridge.registerPlatform("homebridge-foscamcamera", "FoscamCamera", FoscamPlatform, true);
}

function FoscamPlatform(log, config, api) {
  this.log = log;
  this.platformLog = function (msg) {log(chalk.cyan("[FoscamCamera]"), msg);};
  this.config = config || {"platform": "FoscamCamera"};
  this.cameras = this.config.cameras || [];

  // HomeKit Current State: 0 (STAY_ARM), 1 (AWAY_ARM), 2 (NIGHT_ARM), 3 (DISARMED), 4 (ALARM_TRIGGERED)
  this.armState = ["Armed (Stay).", "Armed (Away).", "Armed (Night).", "Disarmed.", "Alarm Triggered."];

  // Camera motion sensor sensitivity
  this.sensitivity = [4, 3, 0, 1, 2];

  // Global cache
  this.accessories = {};
  this.foscamBinary = {};
  this.cameraInfo = {};

  if (api) {
    this.api = api;
    if (api.version < 2.1) throw new Error("Unexpected API version.");
    this.api.on('didFinishLaunching', this.didFinishLaunching.bind(this));
  }
}

FoscamPlatform.prototype.configureAccessory = function (accessory) {
  // Won't be invoked
}

// Method to setup accessories from config.json
FoscamPlatform.prototype.didFinishLaunching = function () {
  var self = this;

  if (this.cameras) {
    this.cameras.forEach(function (cameraConfig) {
      if (cameraConfig.password && cameraConfig.host) {
        self.getInfo(cameraConfig, function (mac, error) {
          if (!error) {
            self.configureCamera(mac);
          } else {
            self.platformLog(error);
          }
        });
      } else {
        self.platformLog("Missing Required Information!");
      }
    });
  }
}

// Method to detect Foscam camera info and API version
FoscamPlatform.prototype.getInfo = function (cameraConfig, callback) {
  var self = this;

  // Setup for foscam-client
  var thisFoscamAPI = new Foscam({
    username: cameraConfig.username,
    password: cameraConfig.password,
    host: cameraConfig.host,
    port: cameraConfig.port,
    protocol: 'http',
    rejectUnauthorizedCerts: true
  });

  // Retrieve camera info
  Promise.all([thisFoscamAPI.getDevInfo(), thisFoscamAPI.getMotionDetectConfig(), thisFoscamAPI.getMotionDetectConfig1()]).then(function (output) {
    var info = output[0];
    var config = output[1];
    var config1 = output[2];

    if (info.result === 0) {
      var thisCamera = cameraConfig;

      // Initialize default config
      thisCamera.username = cameraConfig.username || "admin";
      thisCamera.port = cameraConfig.port || 88;
      thisCamera.linkage = [cameraConfig.stay || 0, cameraConfig.away || 0, cameraConfig.night || 0];
      if (thisCamera.sensitivity === undefined) {
        if (config.result === 0) thisCamera.sensitivity = self.sensitivity.indexOf(config.sensitivity);
        if (config1.result === 0) thisCamera.sensitivity = self.sensitivity.indexOf(config1.sensitivity);
      } else if (thisCamera.sensitivity < 0 || thisCamera.sensitivity > 4) {
        throw new Error("Sensitivity " + thisCamera.sensitivity + " is out of range.");
      }
      if (thisCamera.triggerInterval === undefined) {
        if (config.result === 0) thisCamera.triggerInterval = config.triggerInterval + 5;
        if (config1.result === 0) thisCamera.triggerInterval = config1.triggerInterval + 5;
      } else if (thisCamera.triggerInterval < 5 || thisCamera.triggerInterval > 15) {
        throw new Error("Trigger interval " + thisCamera.triggerInterval + " is out of range.");
      }
      thisCamera.speaker = {
        "enabled": cameraConfig.spkrEnable === undefined ? true : cameraConfig.spkrEnable,
        "compression": cameraConfig.spkrCompression === undefined ? true : cameraConfig.spkrCompression,
        "gain": cameraConfig.spkrGain || 0
      };
      thisCamera.log = function () {
        var msg = util.format.apply(util, Array.prototype.slice.call(arguments));
        self.log(chalk.cyan("[Foscam " + info.devName + "]"), msg);
      };
      delete thisCamera.stay;
      delete thisCamera.away;
      delete thisCamera.night;
      delete thisCamera.spkrEnable;
      delete thisCamera.spkrCompression;
      delete thisCamera.spkrGain;
      delete thisCamera.motionDetector;

      // Storing camera info
      thisCamera.name = info.devName.toString();
      thisCamera.model = info.productName.toString();
      thisCamera.serial = info.serialNo.toString();
      thisCamera.fw = info.firmwareVer.toString();
      thisCamera.hw = info.hardwareVer.toString();

      // Initialize global cache
      thisCamera.currentState = Characteristic.SecuritySystemCurrentState.DISARMED;
      thisCamera.motionAlarm = false;
      thisCamera.statusActive = false;

      // Older API
      if (config.result === 0) {
        // Older models only support 4-bit linkage
        thisCamera.linkage = thisCamera.linkage.map(function (k) {return (k & 0x0f)});

        // Promises for older models
        thisCamera.getConfig = thisFoscamAPI.getMotionDetectConfig();
        thisCamera.setConfig = function (config) {thisFoscamAPI.setMotionDetectConfig(config);};
      }

      // Newer API
      if (config1.result === 0) {
        // Newer models support push notification bit
        thisCamera.linkage = thisCamera.linkage.map(function (k) {return (k & 0x8f)});

        // Promises for newer models
        thisCamera.getConfig = thisFoscamAPI.getMotionDetectConfig1();
        thisCamera.setConfig = function (config) {thisFoscamAPI.setMotionDetectConfig1(config);};
      }

      // Workaround for empty serial number
      if (thisCamera.serial === "") thisCamera.serial = "Default-SerialNumber";

      // Workaround for Infinity MAC address
      var mac;
      if (info.mac === Infinity) {
        mac = UUIDGen.generate(info.devName).slice(-12).toUpperCase();
      } else {
        mac = info.mac;
      }

      // Store camera information
      self.cameraInfo[mac] = thisCamera;
      self.foscamBinary[mac] = null;
      callback(mac);
    } else {
      callback(null, "Failed to retrieve camera information!");
    }
  });
}

// Method to configure camera info for HomeKit
FoscamPlatform.prototype.configureCamera = function (mac) {
  var self = this;
  var thisCamera = this.cameraInfo[mac];
  var name = "Foscam " + thisCamera.name;
  var uuid = UUIDGen.generate(mac);

  // Setup for FoscamAccessory
  var cameraSource = new FoscamAccessory(hap, thisCamera, thisCamera.log);
  cameraSource.info().then(function () {
    // Setup accessory as CAMERA (17) category
    var newAccessory = new Accessory(name, uuid, 17);
    newAccessory.configureCameraSource(cameraSource);

    // Add HomeKit Security System Service
    newAccessory.addService(Service.SecuritySystem, name + " Motion Detection");

    // Add HomeKit Motion Sensor Service
    newAccessory.addService(Service.MotionSensor, name + " Motion Sensor");

    // Setup HomeKit accessory information
    newAccessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, "Foscam Digital Technologies LLC")
      .setCharacteristic(Characteristic.Model, thisCamera.model)
      .setCharacteristic(Characteristic.SerialNumber, thisCamera.serial)
      .setCharacteristic(Characteristic.FirmwareRevision, thisCamera.fw)
      .setCharacteristic(Characteristic.HardwareRevision, thisCamera.hw);

    // Setup listeners for different events
    newAccessory.getService(Service.SecuritySystem)
      .getCharacteristic(Characteristic.SecuritySystemCurrentState)
      .on('get', self.getCurrentState.bind(self, mac));

    newAccessory.getService(Service.SecuritySystem)
      .getCharacteristic(Characteristic.SecuritySystemTargetState)
      .on('get', self.getTargetState.bind(self, mac))
      .on('set', self.setTargetState.bind(self, mac));

    newAccessory.getService(Service.SecuritySystem)
      .getCharacteristic(Characteristic.StatusFault);

    newAccessory.getService(Service.MotionSensor)
      .getCharacteristic(Characteristic.MotionDetected)
      .on('get', self.getMotionDetected.bind(self, mac));

    newAccessory.getService(Service.MotionSensor)
      .getCharacteristic(Characteristic.StatusActive);

    newAccessory.getService(Service.MotionSensor)
      .getCharacteristic(Characteristic.StatusFault);

    newAccessory.on('identify', self.identify.bind(self, mac));

    // Publish accessories to HomeKit
    self.api.publishCameraAccessories("FoscamCamera", [newAccessory]);
    self.accessories[mac] = newAccessory;

    // Retrieve initial state
    self.getInitState(newAccessory);

    // Start listening to motion notification
    self.startMotionPolling(mac);
  });
}

// Method to retrieve initial state
FoscamPlatform.prototype.getInitState = function (accessory) {
  accessory.getService(Service.SecuritySystem)
    .getCharacteristic(Characteristic.SecuritySystemCurrentState)
    .getValue();

  accessory.getService(Service.SecuritySystem)
    .getCharacteristic(Characteristic.SecuritySystemTargetState)
    .getValue();
}

// Method to get the security system current state
FoscamPlatform.prototype.getCurrentState = function (mac, callback) {
  var self = this;
  var thisCamera = this.cameraInfo[mac];
  var thisAccessory = this.accessories[mac];

  thisCamera.getConfig.then(function (config) {
    if (config.result === 0) {
      // Compute current state and target state
      if (config.isEnable === 0) {
        thisCamera.currentState = Characteristic.SecuritySystemCurrentState.DISARMED;
      } else {
        if (thisCamera.linkage.indexOf(config.linkage) >= 0) {
          thisCamera.currentState = thisCamera.linkage.indexOf(config.linkage);
        } else {
          thisCamera.currentState = Characteristic.SecuritySystemCurrentState.STAY_ARM;
        }
      }

      // Set motion sensor status active
      thisAccessory.getService(Service.MotionSensor)
        .setCharacteristic(Characteristic.StatusActive, config.isEnable ? true : false);

      // Set security system status fault
      thisAccessory.getService(Service.SecuritySystem)
        .setCharacteristic(Characteristic.StatusFault, false);

      thisCamera.log("Current state: " + self.armState[thisCamera.currentState]);
      callback(null, thisCamera.currentState);
    } else {
      var error = "Failed to retrieve current state!";

      // Set security system status fault to 1 in case of error
      thisAccessory.getService(Service.SecuritySystem)
        .setCharacteristic(Characteristic.StatusFault, true);

      thisCamera.log(error);
      callback(new Error(error));
    }
  });
}

// Method to get the security system target state
FoscamPlatform.prototype.getTargetState = function (mac, callback) {
  setTimeout(function (mac) {
    callback(null, this.cameraInfo[mac].currentState);
  }.bind(this, mac), 1000);
}

// Method to set the security system target state
FoscamPlatform.prototype.setTargetState = function (mac, state, callback) {
  var self = this;
  var thisCamera = this.cameraInfo[mac];
  var thisAccessory = this.accessories[mac];

  // Convert target state to isEnable
  var enable = state < 3 ? 1 : 0;

  // Get current config
  thisCamera.getConfig.then(function (config) {
    if (config.result === 0) {
      // Change isEnable, linkage, sensitivity, triggerInterval to requested state
      config.isEnable = enable;
      if (enable) config.linkage = thisCamera.linkage[state];
      config.sensitivity = self.sensitivity[thisCamera.sensitivity];
      config.triggerInterval = thisCamera.triggerInterval - 5;

      // Update config with requested state
      thisCamera.setConfig(config);

      // Set motion sensor status
      thisAccessory.getService(Service.MotionSensor)
        .setCharacteristic(Characteristic.StatusActive, enable ? true : false);

      // Set security system current state
      thisCamera.currentState = state;
      thisAccessory.getService(Service.SecuritySystem)
        .setCharacteristic(Characteristic.SecuritySystemCurrentState, state);

      // Set status fault
      thisAccessory.getService(Service.SecuritySystem)
        .setCharacteristic(Characteristic.StatusFault, false);

      thisCamera.log(self.armState[state]);
      callback(null);
    } else {
      var error = "Failed to set target state!";

      // Set status fault to 1 in case of error
      thisAccessory.getService(Service.SecuritySystem)
        .setCharacteristic(Characteristic.StatusFault, true);

      thisCamera.log(error);
      callback(new Error(error));
    }
  });
}

// Method to get the motion sensor motion detected
FoscamPlatform.prototype.getMotionDetected = function (mac, callback) {
  callback(null, this.cameraInfo[mac].motionAlarm);
}

// Method to handle identify request
FoscamPlatform.prototype.identify = function (mac, paired, callback) {
  this.cameraInfo[mac].log("Identify requested!");
  callback();
}

// Method to start polling for motion
FoscamPlatform.prototype.startMotionPolling = function (mac, error) {
  var thisCamera = this.cameraInfo[mac];
  var thisFoscamBinary = this.foscamBinary[mac];
  if (error) thisCamera.log(error);

  if (thisFoscamBinary) {
    thisCamera.log("Resetting connection to server...");
    thisFoscamBinary.close();
    thisFoscamBinary = null;
  }

  // Connect to server for motion notification
  thisFoscamBinary = new FoscamStreamLayer(thisCamera.host, thisCamera.port, thisCamera.username, thisCamera.password);
  thisFoscamBinary.on('motion', this.motionDetected.bind(this, mac));
  thisFoscamBinary.on('error', this.startMotionPolling.bind(this, mac));
  thisFoscamBinary.connect();
  thisCamera.log("Connected to server for motion notification.");

  // Save to global
  this.foscamBinary[mac] = thisFoscamBinary;
}

// Method to configure motion sensor when motion is detected
FoscamPlatform.prototype.motionDetected = function (mac) {
  var thisCamera = this.cameraInfo[mac];
  var thisAccessory = this.accessories[mac];

  if (thisCamera.tout) clearTimeout(thisCamera.tout);

  // Set motion detected
  thisCamera.motionAlarm = true;
  thisAccessory.getService(Service.MotionSensor)
    .setCharacteristic(Characteristic.MotionDetected, thisCamera.motionAlarm);
  thisCamera.log("Motion Detected!");

  // Reset motion detected after trigger interval
  thisCamera.tout = setTimeout(function (thisCamera, thisAccessory) {
    thisCamera.tout = null;
    thisCamera.motionAlarm = false;
    thisAccessory.getService(Service.MotionSensor)
      .setCharacteristic(Characteristic.MotionDetected, thisCamera.motionAlarm);
  }.bind(this, thisCamera, thisAccessory), thisCamera.triggerInterval * 1000);
}
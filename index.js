var FoscamAccessory = require("homebridge-foscam-stream").FoscamAccessory;
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
  this.foscamAPI = {};
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

    if (info.result === 0) {
      // Create a copy of config
      var thisCamera = JSON.parse(JSON.stringify(cameraConfig));

      if (output[1].result === 0) {
        // Older API
        var config = output[1];
        var linkageMask = 0x0f;
        thisCamera.version = 0;
      } else if (output[2].result === 0) {
        // Newer API
        var config = output[2];
        var linkageMask = 0xff;
        thisCamera.version = 1;
      }
      
      // Initialize default config
      thisCamera.username = cameraConfig.username || "admin";
      thisCamera.port = cameraConfig.port || 88;
      thisCamera.linkage = [cameraConfig.stay || 0, cameraConfig.away || 0, cameraConfig.night || 0];
      thisCamera.linkage = thisCamera.linkage.map(function (k) {return (k & linkageMask)});

      // Compute sensivity
      if (thisCamera.sensitivity < 0 || thisCamera.sensitivity > 4) {
        throw new Error("Sensitivity " + thisCamera.sensitivity + " is out of range.");
      } else if (thisCamera.sensitivity === undefined) {
        thisCamera.sensitivity = self.sensitivity.indexOf(config.sensitivity);
      }

      // Compute triggerInterval
      if (thisCamera.triggerInterval < 5 || thisCamera.triggerInterval > 15) {
        throw new Error("Trigger interval " + thisCamera.triggerInterval + " is out of range.");
      } else if (thisCamera.triggerInterval === undefined) {
        thisCamera.triggerInterval = config.triggerInterval + 5;
      }

      // Setup config for 2-way audio
      thisCamera.speaker = {
        "enabled": cameraConfig.spkrEnable === undefined ? true : cameraConfig.spkrEnable,
        "compression": cameraConfig.spkrCompression === undefined ? true : cameraConfig.spkrCompression,
        "gain": cameraConfig.spkrGain || 0
      };

      // Function for logging
      thisCamera.log = function () {
        var msg = util.format.apply(util, Array.prototype.slice.call(arguments));
        self.log(chalk.cyan("[Foscam " + info.devName + "]"), msg);
      };

      // Remove unnecessary config
      delete thisCamera.stay;
      delete thisCamera.away;
      delete thisCamera.night;
      delete thisCamera.spkrEnable;
      delete thisCamera.spkrCompression;
      delete thisCamera.spkrGain;
      delete thisCamera.motionDetector;

      // Store camera information
      thisCamera.name = info.devName.toString();
      thisCamera.model = info.productName.toString();
      thisCamera.serial = info.serialNo.toString();
      thisCamera.fw = info.firmwareVer.toString();
      thisCamera.hw = info.hardwareVer.toString();

      // Initialize global cache
      thisCamera.currentState = Characteristic.SecuritySystemCurrentState.DISARMED;
      thisCamera.motionAlarm = false;
      thisCamera.statusActive = false;
      thisCamera.polling = null;

      // Workaround for empty serial number
      if (thisCamera.serial === "") thisCamera.serial = "Default-SerialNumber";

      // Store information to global
      self.foscamAPI[info.mac] = thisFoscamAPI;
      self.cameraInfo[info.mac] = thisCamera;
      callback(info.mac);
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

  accessory.getService(Service.MotionSensor)
    .getCharacteristic(Characteristic.MotionDetected)
    .getValue();
}

// Method to get the security system current state
FoscamPlatform.prototype.getCurrentState = function (mac, callback) {
  var self = this;
  var thisFoscamAPI = this.foscamAPI[mac];
  var thisCamera = this.cameraInfo[mac];
  var thisAccessory = this.accessories[mac];

  if (thisCamera.version === 0) {
    var getConfig = thisFoscamAPI.getMotionDetectConfig();
  } else if (thisCamera.version === 1) {
    var getConfig = thisFoscamAPI.getMotionDetectConfig1();
  }

  getConfig.then(function (config) {
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

      // Configre motion polling
      self.startMotionPolling(mac, thisCamera.currentState);

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
  var self = this;

  setTimeout(function () {
    callback(null, self.cameraInfo[mac].currentState);
  }, 1000);
}

// Method to set the security system target state
FoscamPlatform.prototype.setTargetState = function (mac, state, callback) {
  var self = this;
  var thisFoscamAPI = this.foscamAPI[mac];
  var thisCamera = this.cameraInfo[mac];
  var thisAccessory = this.accessories[mac];

  // Convert target state to isEnable
  var enable = state < 3 ? 1 : 0;

  if (thisCamera.version === 0) {
    var getConfig = thisFoscamAPI.getMotionDetectConfig();
    var setConfig = function (config) {thisFoscamAPI.setMotionDetectConfig(config);};
  } else if (thisCamera.version === 1) {
    var getConfig = thisFoscamAPI.getMotionDetectConfig1();
    var setConfig = function (config) {thisFoscamAPI.setMotionDetectConfig1(config);};
  }

  // Get current config
  getConfig.then(function (config) {
    if (config.result === 0) {
      // Change isEnable, linkage, sensitivity, triggerInterval to requested state
      config.isEnable = enable;
      if (enable) config.linkage = thisCamera.linkage[state];
      config.sensitivity = self.sensitivity[thisCamera.sensitivity];
      config.triggerInterval = thisCamera.triggerInterval - 5;

      // Update config with requested state
      setConfig(config);

      // Set motion sensor status
      thisAccessory.getService(Service.MotionSensor)
        .setCharacteristic(Characteristic.StatusActive, enable ? true : false);

      // Set security system current state
      thisCamera.currentState = state;
      thisAccessory.getService(Service.SecuritySystem)
        .setCharacteristic(Characteristic.SecuritySystemCurrentState, state);

      // Configure motion polling
      self.startMotionPolling(mac);

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
FoscamPlatform.prototype.startMotionPolling = function (mac) {
  var self = this;
  var thisFoscamAPI = this.foscamAPI[mac];
  var thisCamera = this.cameraInfo[mac];

  // Clear polling
  if (thisCamera.polling) clearTimeout(thisCamera.polling);

  if (thisCamera.currentState !== 3) {
    // Start polling if armed
    thisCamera.polling = setTimeout(function () {
      thisCamera.polling = null;
      thisFoscamAPI.getDevState().then(function (state) {
        if (state.motionDetectAlarm === 2) self.motionDetected(mac);

        // Setup next polling
        self.startMotionPolling(mac);
      });
    }, 1000);
  } else {
    // Stop polling if disarmed
    thisCamera.polling = null;
  }
}

// Method to configure motion sensor when motion is detected
FoscamPlatform.prototype.motionDetected = function (mac) {
  var thisCamera = this.cameraInfo[mac];
  var thisAccessory = this.accessories[mac];

  // Clear motion reset
  if (thisCamera.resetMotion) clearTimeout(thisCamera.resetMotion);

  // Set motion detected
  if (thisCamera.motionAlarm === false) thisCamera.log("Motion Detected!");
  thisCamera.motionAlarm = true;
  thisAccessory.getService(Service.MotionSensor)
    .setCharacteristic(Characteristic.MotionDetected, thisCamera.motionAlarm);

  // Reset motion detected after trigger interval
  thisCamera.resetMotion = setTimeout(function (thisCamera, thisAccessory) {
    thisCamera.resetMotion = null;
    thisCamera.motionAlarm = false;
    thisAccessory.getService(Service.MotionSensor)
      .setCharacteristic(Characteristic.MotionDetected, thisCamera.motionAlarm);
  }, (thisCamera.triggerInterval - 1) * 1000);
}

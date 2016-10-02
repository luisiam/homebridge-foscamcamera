var FoscamAccessory = require("homebridge-foscam-stream").FoscamAccessory;
var FoscamStreamLayer = require('foscam-binary-client').FoscamStreamLayer;
var Foscam = require("foscam-client");
var chalk = require("chalk");
var util = require("util");
var Accessory, Service, Characteristic, UUIDGen, hap;

module.exports = function(homebridge) {
  Accessory = homebridge.platformAccessory;
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  UUIDGen = homebridge.hap.uuid;
  hap = homebridge.hap;

  homebridge.registerPlatform("homebridge-foscamcamera", "FoscamCamera", FoscamPlatform, true);
}

function FoscamPlatform(log, config, api) {
  this.log = log;
  this.platformLog = function(msg) {log(chalk.cyan("[FoscamCamera]") + " " + msg);};
  this.config = config || {"platform": "FoscamCamera"};
  this.cameras = this.config.cameras || [];

  // HomeKit Current State: 0 (STAY_ARM), 1 (AWAY_ARM), 2 (NIGHT_ARM), 3 (DISARMED), 4 (ALARM_TRIGGERED)
  this.armState = ["Armed (Stay).", "Armed (Away).", "Armed (Night).", "Disarmed.", "Alarm Triggered."];

  // Global cache
  this.accessories = {};
  this.foscamAPI = {};
  this.foscamBinary = {};
  this.cameraInfo = {};

  if (api) {
    this.api = api;
    if (api.version < 2.1) throw new Error("Unexpected API version.");
    this.api.on('didFinishLaunching', this.didFinishLaunching.bind(this));
  }
}

FoscamPlatform.prototype.configureAccessory = function(accessory) {
  // Won't be invoked
}

// Method to setup accessories from config.json
FoscamPlatform.prototype.didFinishLaunching = function() {
  var self = this;

  if (this.cameras) {
    this.cameras.forEach(function(cameraConfig) {
      if (cameraConfig.password && cameraConfig.host) {

        // Initialize default config
        cameraConfig.username = cameraConfig.username || "admin";
        cameraConfig.port = cameraConfig.port || 88;
        cameraConfig.stay = cameraConfig.stay || 0;
        cameraConfig.away = cameraConfig.away || 0;
        cameraConfig.night = cameraConfig.night || 0;
        cameraConfig.speaker = {
          "enabled": cameraConfig.spkrEnable == undefined ? true : cameraConfig.spkrEnable,
          "compression": cameraConfig.spkrCompression == undefined ? true : cameraConfig.spkrCompression,
          "gain": cameraConfig.spkrGain || 0
        };
        delete cameraConfig.spkrEnable;
        delete cameraConfig.spkrCompression;
        delete cameraConfig.sprkGain;
        delete cameraConfig.motionDetector;

        self.getInfo(cameraConfig, function(cameraConfig, mac, error) {
          if (!error) {
            self.configureCamera(cameraConfig, mac);
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
FoscamPlatform.prototype.getInfo = function(cameraConfig, callback) {
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
  thisFoscamAPI.getDevInfo().then(function(info) {
    if (info.result == 0) {
      var thisCamera = {
        "name": info.devName.toString(),
        "model": info.productName.toString(),
        "serial": info.serialNo.toString(),
        "fw": info.firmwareVer.toString(),
        "hw": info.hardwareVer.toString(),
        "log": function() {
          var msg = util.format.apply(util, Array.prototype.slice.call(arguments));
          self.log(chalk.cyan("[Foscam " + info.devName + "]") + " " + msg);
        }
      };

      // Detect API
      thisFoscamAPI.getMotionDetectConfig().then(function(config) {
        if (config.result == 0) {
          thisCamera.ver = 0;
        } else {
          thisCamera.ver = 1;
        }

        // Store camera information
        self.cameraInfo[info.mac] = thisCamera;
        self.foscamAPI[info.mac] = thisFoscamAPI;
        self.foscamBinary[info.mac] = null;
        callback(cameraConfig, info.mac);
      });
    } else {
      callback(null, null, "Failed to retrieve camera information!");
    }
  });
}

// Method to configure camera info for HomeKit
FoscamPlatform.prototype.configureCamera = function(cameraConfig, mac) {
  var thisCamera = this.cameraInfo[mac];
  var name = "Foscam " + thisCamera.name;
  var uuid = UUIDGen.generate(mac);

  // Initialize global cache
  thisCamera.username = cameraConfig.username;
  thisCamera.password = cameraConfig.password;
  thisCamera.host = cameraConfig.host;
  thisCamera.port = cameraConfig.port;
  thisCamera.currentState = Characteristic.SecuritySystemCurrentState.DISARMED;
  thisCamera.motionAlarm = 0;
  thisCamera.statusActive = 0;
  thisCamera.triggerInterval = 5;
  thisCamera.conversion = [cameraConfig.stay, cameraConfig.away, cameraConfig.night];

  if (thisCamera.ver == 0) {
    // Older models only support 4-bit linkage
    thisCamera.conversion = thisCamera.conversion.map(function(k) {return (k & 0x0f)});
  } else {
    // Newer models support push notification bit
    thisCamera.conversion = thisCamera.conversion.map(function(k) {return (k & 0x8f)});
  }

  // Setup for FoscamAccessory
  var cameraSource = new FoscamAccessory(hap, cameraConfig, thisCamera.log);

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
    .on('get', this.getCurrentState.bind(this, mac));

  newAccessory.getService(Service.SecuritySystem)
    .getCharacteristic(Characteristic.SecuritySystemTargetState)
    .on('get', this.getTargetState.bind(this, mac))
    .on('set', this.setTargetState.bind(this, mac));

  newAccessory.getService(Service.SecuritySystem)
    .getCharacteristic(Characteristic.StatusFault);

  newAccessory.getService(Service.MotionSensor)
    .getCharacteristic(Characteristic.MotionDetected)
    .on('get', this.getMotionDetected.bind(this, mac));

  newAccessory.getService(Service.MotionSensor)
    .getCharacteristic(Characteristic.StatusActive);

  newAccessory.getService(Service.MotionSensor)
    .getCharacteristic(Characteristic.StatusFault);

  newAccessory.on('identify', this.identify.bind(this, mac));

  // Publish accessories to HomeKit
  this.api.publishCameraAccessories("FoscamCamera", [newAccessory]);
  this.accessories[mac] = newAccessory;

  // Retrieve initial state
  this.getInitState(newAccessory);

  // Start listening to motion notification
  this.startMotionPolling(mac);
}

// Method to retrieve initial state
FoscamPlatform.prototype.getInitState = function(accessory) {
  accessory.getService(Service.SecuritySystem)
    .getCharacteristic(Characteristic.SecuritySystemCurrentState)
    .getValue();

  accessory.getService(Service.SecuritySystem)
    .getCharacteristic(Characteristic.SecuritySystemTargetState)
    .getValue();
}

// Method to get the security system current state
FoscamPlatform.prototype.getCurrentState = function(mac, callback) {
  var self = this;
  var thisCamera = this.cameraInfo[mac];
  var thisAccessory = this.accessories[mac];

  // Setup the correct promise to use
  if (thisCamera.ver == 0) {
    var getConfig = this.foscamAPI[mac].getMotionDetectConfig();
  } else {
    var getConfig = this.foscamAPI[mac].getMotionDetectConfig1();
  }

  getConfig.then(function(config) {
    if (config.result == 0) {
      // Save trigger interval for motion sensor
      thisCamera.triggerInterval = config.triggerInterval + 5;

      // Compute current state and target state
      if (config.isEnable == 0) {
        thisCamera.currentState = Characteristic.SecuritySystemCurrentState.DISARMED;
      } else {
        if (thisCamera.conversion.indexOf(config.linkage) >= 0) {
          thisCamera.currentState = thisCamera.conversion.indexOf(config.linkage);
        } else {
          thisCamera.currentState = Characteristic.SecuritySystemCurrentState.STAY_ARM;
        }
      }

      // Set motion sensor status active
      thisAccessory.getService(Service.MotionSensor)
        .setCharacteristic(Characteristic.StatusActive, config.isEnable);

      // Set security system status fault
      thisAccessory.getService(Service.SecuritySystem)
        .setCharacteristic(Characteristic.StatusFault, 0);

      thisCamera.log("Current state: " + self.armState[thisCamera.currentState]);
      callback(null, thisCamera.currentState);
    } else {
      var error = "Failed to retrieve current state!";

      // Set security system status fault to 1 in case of error
      thisAccessory.getService(Service.SecuritySystem)
        .setCharacteristic(Characteristic.StatusFault, 1);

      thisCamera.log(error);
      callback(new Error(error));
    }
  });
}

// Method to get the security system target state
FoscamPlatform.prototype.getTargetState = function(mac, callback) {
  var self = this;
  setTimeout(function() {
    callback(null, self.cameraInfo[mac].currentState);
  }, 500);
}

// Method to set the security system target state
FoscamPlatform.prototype.setTargetState = function(mac, state, callback) {
  var self = this;
  var thisCamera = this.cameraInfo[mac];
  var thisAccessory = this.accessories[mac];

  // Setup the correct promise and function to use
  if (thisCamera.ver == 0) {
    var getConfig = this.foscamAPI[mac].getMotionDetectConfig();
    var setConfig = function(config) {self.foscamAPI[mac].setMotionDetectConfig(config);};
  } else {
    var getConfig = this.foscamAPI[mac].getMotionDetectConfig1();
    var setConfig = function(config) {self.foscamAPI[mac].setMotionDetectConfig1(config);};
  }

  // Convert target state to isEnable
  var enable = state < 3 ? 1 : 0;

  // Get current config
  getConfig.then(function(config) {
    if (config.result == 0) {
      // Change isEnable and linkage to requested state
      config.isEnable = enable;
      if (enable) config.linkage = thisCamera.conversion[state];

      // Update config with requested state
      setConfig(config);

      // Set motion sensor status
      thisAccessory.getService(Service.MotionSensor)
        .setCharacteristic(Characteristic.StatusActive, enable);

      // Set security system current state
      thisAccessory.getService(Service.SecuritySystem)
        .setCharacteristic(Characteristic.SecuritySystemCurrentState, state);

      // Set status fault
      thisAccessory.getService(Service.SecuritySystem)
        .setCharacteristic(Characteristic.StatusFault, 0);

      thisCamera.log(self.armState[state]);
      callback(null);
    } else {
      var error = "Failed to set target state!";

      // Set status fault to 1 in case of error
      thisAccessory.getService(Service.SecuritySystem)
        .setCharacteristic(Characteristic.StatusFault, 1);

      thisCamera.log(error);
      callback(new Error(error));
    }
  });
}

// Method to get the motion sensor motion detected
FoscamPlatform.prototype.getMotionDetected = function(mac, callback) {
  callback(null, this.cameraInfo[mac].motionAlarm);
}

// Method to handle identify request
FoscamPlatform.prototype.identify = function(mac, paired, callback) {
  var thisCamera = this.cameraInfo[mac];
  thisCamera.log("Identify requested!");
  callback();
}

// Method to start polling for motion
FoscamPlatform.prototype.startMotionPolling = function(mac, error) {
  var thisCamera = this.cameraInfo[mac];
  var thisFoscamBinary = this.foscamBinary[mac];
  if (error) thisCamera.log("Motion sensing connection error: " + error);

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
FoscamPlatform.prototype.motionDetected = function(mac) {
  var thisCamera = this.cameraInfo[mac];
  var thisAccessory = this.accessories[mac];

  if (thisCamera.tout) clearTimeout(thisCamera.tout);

  // Set motion detected
  thisCamera.motionAlarm = 1;
  thisAccessory.getService(Service.MotionSensor)
    .setCharacteristic(Characteristic.MotionDetected, thisCamera.motionAlarm);
  thisCamera.log("Motion Detected!");

  // Reset motion detected after trigger interval
  thisCamera.tout = setTimeout(function(thisCamera, thisAccessory) {
    thisCamera.tout = null;
    thisCamera.motionAlarm = 0;
    thisAccessory.getService(Service.MotionSensor)
      .setCharacteristic(Characteristic.MotionDetected, thisCamera.motionAlarm);
  }.bind(this, thisCamera, thisAccessory), thisCamera.triggerInterval * 1000);
}
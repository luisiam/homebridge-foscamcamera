var FFMPEG = require("homebridge-foscam-stream").FFMPEG
var Foscam = require("foscam-client");
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
  this.config = config || {"platform": "FoscamCamera"};
  this.cameras = this.config.cameras || [];

  // HomeKit Current State: 0 (STAY_ARM), 1 (AWAY_ARM), 2 (NIGHT_ARM), 3 (DISARMED), 4 (ALARM_TRIGGERED)
  this.armState = ["armed (stay).", "armed (away).", "armed (night).", "disarmed.", "alarm triggered."];

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
            self.log(error);
          }
        });
      } else {
        self.log("Missing Required Information!");
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
    protocol: cameraConfig.protocol || 'http',
    rejectUnauthorizedCerts: true
  });

  // Retrieve camera info
  Promise.all([thisFoscamAPI.getDevInfo(), thisFoscamAPI.getMotionDetectConfig(), thisFoscamAPI.getMotionDetectConfig1()]).then(function (output) {
    var info = output[0];

    if (info.result === 0) {
      // Create a copy of config
      var thisCamera = JSON.parse(JSON.stringify(cameraConfig));
      var config, linkageMask;

      if (output[1].result === 0) {
        // Older API
        config = output[1];
        linkageMask = 0x0f;
        thisCamera.version = 0;
      } else if (output[2].result === 0) {
        // Newer API
        config = output[2];
        linkageMask = 0xff;
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
        "enabled": cameraConfig.spkrEnable !== false,
        "compression": cameraConfig.spkrCompression !== false,
        "gain": cameraConfig.spkrGain || 0
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
      thisCamera.statusActive = 0;

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

  this.log("Initializing platform accessory '" + name + "'...");

  // Setup for FoscamAccessory
  var videoProcessor = self.config.videoProcessor || 'ffmpeg';
  var cameraSource = new FFMPEG(hap, thisCamera, self.log, videoProcessor);
  var newAccessory = new Accessory(name, uuid, hap.Accessory.Categories.CAMERA);
  newAccessory.configureCameraSource(cameraSource);

  // Add HomeKit Security System Service
  newAccessory.addService(Service.SecuritySystem, name + " Motion Detection");

  // Add HomeKit Motion Sensor Service
  newAccessory.addService(Service.MotionSensor, name + " Motion Sensor");

  // Setup listeners for different events
  self.setService(newAccessory, mac);

  // Publish accessories to HomeKit
  self.api.publishCameraAccessories("FoscamCamera", [newAccessory]);

  // Store accessory in cache
  self.accessories[mac] = newAccessory;

  // Retrieve initial state
  self.getInitState(newAccessory, thisCamera);
}

// Method to setup listeners for different events
FoscamPlatform.prototype.setService = function (accessory, mac) {
  // Setup listeners for Security System events
  accessory.getService(Service.SecuritySystem)
    .getCharacteristic(Characteristic.SecuritySystemCurrentState)
    .on('get', this.getCurrentState.bind(this, mac));

  accessory.getService(Service.SecuritySystem)
    .getCharacteristic(Characteristic.SecuritySystemTargetState)
    .on('get', this.getTargetState.bind(this, mac))
    .on('set', this.setTargetState.bind(this, mac));

  accessory.getService(Service.SecuritySystem)
    .getCharacteristic(Characteristic.StatusFault);

  // Setup listeners for Motion Sensor events
  accessory.getService(Service.MotionSensor)
    .getCharacteristic(Characteristic.MotionDetected)
    .on('get', this.getMotionDetected.bind(this, mac));

  accessory.getService(Service.MotionSensor)
    .getCharacteristic(Characteristic.StatusActive);

  accessory.getService(Service.MotionSensor)
    .getCharacteristic(Characteristic.StatusFault);

  // Setup additional Accessory Information
  accessory.getService(Service.AccessoryInformation)
    .getCharacteristic(Characteristic.FirmwareRevision);

  accessory.getService(Service.AccessoryInformation)
    .getCharacteristic(Characteristic.HardwareRevision);

  accessory.on('identify', this.identify.bind(this, mac));
}

// Method to retrieve initial state
FoscamPlatform.prototype.getInitState = function (accessory, info) {
  // Update HomeKit accessory information
  accessory.getService(Service.AccessoryInformation)
    .setCharacteristic(Characteristic.Manufacturer, "Foscam Digital Technologies LLC")
    .setCharacteristic(Characteristic.Model, info.model)
    .setCharacteristic(Characteristic.SerialNumber, info.serial)
    .setCharacteristic(Characteristic.FirmwareRevision, info.fw)
    .setCharacteristic(Characteristic.HardwareRevision, info.hw);

  // Retrieve initial state
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
      self.startMotionPolling(mac);

      // Set motion sensor status active
      thisAccessory.getService(Service.MotionSensor)
        .setCharacteristic(Characteristic.StatusActive, config.isEnable ? true : false);

      // Set security system status fault
      thisAccessory.getService(Service.SecuritySystem)
        .setCharacteristic(Characteristic.StatusFault, 0);

      self.log(thisCamera.name + " is " + self.armState[thisCamera.currentState]);
      callback(null, thisCamera.currentState);
    } else {
      var error = "Failed to retrieve " + thisCamera.name + " state!";

      // Set security system status fault to 1 in case of error
      thisAccessory.getService(Service.SecuritySystem)
        .setCharacteristic(Characteristic.StatusFault, 1);

      self.log(error);
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
        .setCharacteristic(Characteristic.StatusFault, 0);

      self.log(thisCamera.name + " is set to " + self.armState[state]);
      callback(null);
    } else {
      var error = "Failed to set " + thisCamera.name + " state!";

      // Set status fault to 1 in case of error
      thisAccessory.getService(Service.SecuritySystem)
        .setCharacteristic(Characteristic.StatusFault, 1);

      self.log(error);
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
  this.log(this.cameraInfo[mac].name + " identify requested!");
  callback();
}

// Method to start polling for motion
FoscamPlatform.prototype.startMotionPolling = function (mac) {
  var self = this;
  var thisFoscamAPI = this.foscamAPI[mac];
  var thisCamera = this.cameraInfo[mac];

  // Clear polling
  clearTimeout(thisCamera.polling);

  // Start polling if armed
  if (thisCamera.currentState !== 3) {
    thisFoscamAPI.getDevState().then(function (state) {
      if (state.motionDetectAlarm === 2) self.motionDetected(mac);
    });

    // Setup next polling
    thisCamera.polling = setTimeout(this.startMotionPolling.bind(this, mac), 1000);
  }
}

// Method to configure motion sensor when motion is detected
FoscamPlatform.prototype.motionDetected = function (mac) {
  var thisCamera = this.cameraInfo[mac];
  var thisAccessory = this.accessories[mac];

  // Clear motion reset
  clearTimeout(thisCamera.resetMotion);

  // Set motion detected
  if (thisCamera.motionAlarm === false) {
    this.log(thisCamera.name + " Motion Detected!");
    thisCamera.motionAlarm = true;
    thisAccessory.getService(Service.MotionSensor)
      .setCharacteristic(Characteristic.MotionDetected, thisCamera.motionAlarm);
  }

  // Reset motion detected after trigger interval
  thisCamera.resetMotion = setTimeout(function () {
    thisCamera.motionAlarm = false;
    thisAccessory.getService(Service.MotionSensor)
      .setCharacteristic(Characteristic.MotionDetected, thisCamera.motionAlarm);
  }, (thisCamera.triggerInterval - 1) * 1000);
}

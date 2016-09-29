var FoscamAccessory = require("homebridge-foscam-stream").FoscamAccessory;
var Foscam = require("foscam-client");
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
  this.config = config || {"platform": "FoscamCamera"};
  this.cameras = this.config.cameras || [];

  // HomeKit Current State: 0 (STAY_ARM), 1 (AWAY_ARM), 2 (NIGHT_ARM), 3 (DISARMED), 4 (ALARM_TRIGGERED)
  this.armState = ["Armed (Stay).", "Armed (Away).", "Armed (Night).", "Disarmed.", "Alarm Triggered."];
  this.accessories = {};
  this.foscamAPI = {};
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
        cameraConfig.gain = cameraConfig.gain || 0;
        cameraConfig.stay = cameraConfig.stay || 0;
        cameraConfig.away = cameraConfig.away || 0;
        cameraConfig.night = cameraConfig.night || 0;

        self.getInfo(cameraConfig, function(cameraConfig, mac, error) {
          if (!error) {
            self.configureCamera(cameraConfig, mac);
          } else {
            self.log(error);
          }
        });
      } else {
        self.log("[FoscamCamera] Missing Required Information!");
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
      var thisCamera = {};

      thisCamera.name = info.devName;
      thisCamera.model = info.productName.toString();
      thisCamera.serial = info.serialNo.toString();
      thisCamera.fw = info.firmwareVer.toString();
      thisCamera.hw = info.hardwareVer.toString();

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
        callback(cameraConfig, info.mac);
      });
    } else {
      callback(null, null, "[FoscamCamera] Failed to retrieve camera information!");
    }
  });
}

// Method to configure camera info for HomeKit
FoscamPlatform.prototype.configureCamera = function(cameraConfig, mac) {
  var thisCamera = this.cameraInfo[mac];
  var name = "Foscam " + thisCamera.name;
  var uuid = UUIDGen.generate(name + mac);

  // Initialize global cache
  thisCamera.currentState = Characteristic.SecuritySystemCurrentState.DISARMED;
  thisCamera.motionAlarm = 0;
  thisCamera.conversion = [cameraConfig.stay, cameraConfig.away, cameraConfig.night];

  if (thisCamera.ver == 0) {
    // Older models only support 4-bit linkage
    thisCamera.conversion = thisCamera.conversion.map(function(k) {return (k & 0x0f)});
  } else {
    // Newer models support push notification bit
    thisCamera.conversion = thisCamera.conversion.map(function(k) {return (k & 0x8f)});
  }

  // Setup for FoscamAccessory
  var cameraSource = new FoscamAccessory(hap, cameraConfig, this.log);

  // Setup accessory as CAMERA (17) category
  var newAccessory = new Accessory(name, uuid, 17);
  newAccessory.configureCameraSource(cameraSource);

  // Add HomeKit Security System Service
  newAccessory.addService(Service.SecuritySystem, name + " Motion Detection");

  // Add HomeKit Motion Sensor Service
  newAccessory.addService(Service.MotionSensor, name + " Motion Sensor");

  // Setup HomeKit accessory information
  newAccessory.getService(Service.AccessoryInformation)
    .setCharacteristic(Characteristic.Manufacturer, "Foscam Digital Technology LLC")
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

  this.api.publishCameraAccessories("FoscamCamera", [newAccessory]);
  this.accessories[mac] = newAccessory;

  // Retrieve initial state
  this.getInitState(newAccessory);
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
  var name = "Foscam " + thisCamera.name;

  // Setup the correct promise to use
  if (thisCamera.ver == 0) {
    var getConfig = this.foscamAPI[mac].getMotionDetectConfig();
  } else {
    var getConfig = this.foscamAPI[mac].getMotionDetectConfig1();
  }

  getConfig.then(function(config) {
    if (config.result == 0) {
      // Stop polling
      if (thisCamera.polling) clearTimeout(thisCamera.polling);

      // Compute current state and target state
      if (config.isEnable == 0) {
        thisCamera.currentState = Characteristic.SecuritySystemCurrentState.DISARMED;

        // Set motion sensor motion detected
        thisCamera.motionAlarm = 0;
        thisAccessory.getService(Service.MotionSensor)
          .setCharacteristic(Characteristic.MotionDetected, 0);
      } else {
        if (thisCamera.conversion.indexOf(config.linkage) >= 0) {
          thisCamera.currentState = thisCamera.conversion.indexOf(config.linkage);
        } else {
          thisCamera.currentState = Characteristic.SecuritySystemCurrentState.STAY_ARM;
        }

        // Start polling
        self.periodicUpdate(mac);
      }

      // Set motion sensor status active
      thisAccessory.getService(Service.MotionSensor)
        .setCharacteristic(Characteristic.StatusActive, config.isEnable);

      // Set status fault
      thisAccessory.getService(Service.SecuritySystem)
        .setCharacteristic(Characteristic.StatusFault, 0);

      self.log("[" + name + "] Current state: " + self.armState[thisCamera.currentState]);
      callback(null, thisCamera.currentState);
    } else {
      // Set status fault to 1 in case of error
      thisAccessory.getService(Service.SecuritySystem)
        .setCharacteristic(Characteristic.StatusFault, 1);

      callback(new Error("[" + name + "] Failed to retrieve current state!"));
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
  var name = "Foscam " + thisCamera.name;

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
      // Stop polling
      if (thisCamera.polling) clearTimeout(thisCamera.polling);

      // Change isEnable and linkage to requested state
      config.isEnable = enable;
      if (enable) {
        config.linkage = thisCamera.conversion[state];

        // Start polling
        self.periodicUpdate(mac);
      } else {
        // Set motion sensor motion detected
        thisCamera.motionAlarm = 0;
        thisAccessory.getService(Service.MotionSensor)
          .setCharacteristic(Characteristic.MotionDetected, 0);
      }

      // Update config with requested state
      setConfig(config);

      // Set motion sensor status active
      thisAccessory.getService(Service.MotionSensor)
        .setCharacteristic(Characteristic.StatusActive, enable);

      // Set security system current state
      thisAccessory.getService(Service.SecuritySystem)
        .setCharacteristic(Characteristic.SecuritySystemCurrentState, state);

      // Set status fault
      thisAccessory.getService(Service.SecuritySystem)
        .setCharacteristic(Characteristic.StatusFault, 0);

      self.log("[" + name + "] " + self.armState[state]);
      callback(null);
    } else {
      // Set status fault to 1 in case of error
      thisAccessory.getService(Service.SecuritySystem)
        .setCharacteristic(Characteristic.StatusFault, 1);

      callback(new Error("[" + name + "] Failed to set target state!"));
    }
  });
}

// Method to get the motion sensor motion detected
FoscamPlatform.prototype.getMotionDetected = function(mac, callback) {
  callback(null, this.cameraInfo[mac].motionAlarm > 1);
}

// Method to handle identify request
FoscamPlatform.prototype.identify = function(mac, paired, callback) {
  var thisCamera = this.cameraInfo[mac];
  var name = "Foscam " + thisCamera.name;
  this.log("[" + name + "] Identify requested!");
  callback();
}

// Method to update motion sensor periodically
FoscamPlatform.prototype.periodicUpdate = function(mac) {
  this.cameraInfo[mac].polling = setTimeout(function() {
    var self = this;
    var thisCamera = this.cameraInfo[mac];
    var thisAccessory = this.accessories[mac];
    var name = "Foscam " + thisCamera.name;

    this.foscamAPI[mac].getDevState().then(function(state) {
      // Check for changes
      if (thisCamera.motionAlarm != state.motionDetectAlarm) {
        thisCamera.motionAlarm = state.motionDetectAlarm;

        if (thisCamera.motionAlarm == 2) self.log("[" + name + "] Motion Detected!");

        // Set motion detected
        thisAccessory.getService(Service.MotionSensor)
          .setCharacteristic(Characteristic.MotionDetected, thisCamera.motionAlarm > 1);

        // Set status active
        thisAccessory.getService(Service.MotionSensor)
          .setCharacteristic(Characteristic.StatusActive, thisCamera.motionAlarm > 0);
      }

      // Setup next polling
      if (thisCamera.motionAlarm != 0) self.periodicUpdate(mac);
    });
  }.bind(this, mac), 1000);
}
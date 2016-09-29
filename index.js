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
	this.armState = ["Armed (Stay).", "Armed (Away).", "Armed (Night).", "Disarmed.", "Alarm Triggered."]
	this.foscamAPI = {};
	this.cameraInfo = {};

	if (api) {
		this.api = api;
		if (api.version < 2.1) {
			throw new Error("Unexpected API version.");
		}
		this.api.on('didFinishLaunching', this.didFinishLaunching.bind(this));
	}
}

FoscamPlatform.prototype.configureAccessory = function(accessory) {
	// Won't be invoked
}

// Method to setup accesories from config.json
FoscamPlatform.prototype.didFinishLaunching = function() {
	var self = this;

	if (this.cameras) {
		this.cameras.forEach(function(cameraConfig) {
			if (cameraConfig.password && cameraConfig.host) {
				cameraConfig.username = cameraConfig.username || "admin";
				cameraConfig.port = cameraConfig.port || 88;
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
			self.foscamAPI[info.mac] = thisFoscamAPI;
			self.cameraInfo[info.mac] = {};
			self.cameraInfo[info.mac].name = info.devName;
			self.cameraInfo[info.mac].model = info.productName.toString();
			self.cameraInfo[info.mac].serial = info.serialNo.toString();
			self.cameraInfo[info.mac].fw = info.firmwareVer.toString();
			self.cameraInfo[info.mac].hw = info.hardwareVer.toString();

			// Detect API
			thisFoscamAPI.getMotionDetectConfig().then(function(config) {
				if (config.result == 0) {
					self.cameraInfo[info.mac].ver = 0;
				} else {
					self.cameraInfo[info.mac].ver = 1;
				}
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

	thisCamera.currentState = Characteristic.SecuritySystemCurrentState.DISARMED;
	thisCamera.statusFault = 0;
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

	// Setup HomeKit accessory information
	newAccessory
		.getService(Service.AccessoryInformation)
		.setCharacteristic(Characteristic.Manufacturer, "Foscam Digital Technology LLC")
		.setCharacteristic(Characteristic.Model, thisCamera.model)
		.setCharacteristic(Characteristic.SerialNumber, thisCamera.serial)
		.setCharacteristic(Characteristic.FirmwareRevision, thisCamera.fw)
		.setCharacteristic(Characteristic.HardwareRevision, thisCamera.hw);

	// Setup listeners for different security system events
	newAccessory
		.getService(Service.SecuritySystem)
		.getCharacteristic(Characteristic.SecuritySystemCurrentState)
		.on('get', this.getCurrentState.bind(this, mac));

	newAccessory
		.getService(Service.SecuritySystem)
		.getCharacteristic(Characteristic.SecuritySystemTargetState)
		.on('get', this.getTargetState.bind(this, mac))
		.on('set', this.setTargetState.bind(this, mac, newAccessory));

	newAccessory
		.getService(Service.SecuritySystem)
		.getCharacteristic(Characteristic.StatusFault)
		.on('get', this.getStatusFault.bind(this, mac));

	newAccessory
		.on('identify', this.identify.bind(this, mac));

	this.api.publishCameraAccessories("FoscamCamera", [newAccessory]);

	// Retrieve initial state
	this.getInitState(newAccessory);
}

// Method to retrieve initial state
FoscamPlatform.prototype.getInitState = function(accessory) {
	accessory
		.getService(Service.SecuritySystem)
		.getCharacteristic(Characteristic.SecuritySystemCurrentState)
		.getValue();

	accessory
		.getService(Service.SecuritySystem)
		.getCharacteristic(Characteristic.SecuritySystemTargetState)
		.getValue();
}

// Method to get the current state
FoscamPlatform.prototype.getCurrentState = function(mac, callback) {
	var self = this;
	var thisCamera = this.cameraInfo[mac];
	var name = "Foscam " + thisCamera.name;

	// Setup the correct promise to use
	if (thisCamera.ver == 0) {
		var getConfig = this.foscamAPI[mac].getMotionDetectConfig();
	} else {
		var getConfig = this.foscamAPI[mac].getMotionDetectConfig1();
	}

	getConfig.then(function(config) {
		if (config.result == 0) {
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

			// Set status fault
			thisCamera.statusFault = 0;

			self.log("[" + name + "] Current state: " + self.armState[thisCamera.currentState]);
			callback(null, thisCamera.currentState);
		} else {
			// Set status fault to 1 in case of error
			thisCamera.statusFault = 1;
			callback(new Error("Failed to retrieve current state!"));
		}
	})
	.catch(function(error) {
		// Set status fault to 1 in case of error
		thisCamera.statusFault = 1;

		callback(error);
	});
}

// Method to get the target state
FoscamPlatform.prototype.getTargetState = function(mac, callback) {
	var self = this
	setTimeout(function() {
		callback(null, self.cameraInfo[mac].currentState);
	}, 500);
}

// Method to set the target state
FoscamPlatform.prototype.setTargetState = function(mac, accessory, state, callback) {
	var self = this;
	var thisCamera = this.cameraInfo[mac];
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
			// Change isEnable and linkage to requested state
			config.isEnable = enable;
			if (enable) config.linkage = thisCamera.conversion[state];

			// Update config with requested state
			setConfig(config);

			// Set status fault
			thisCamera.statusFault = 0;

			// Set current state
			accessory
				.getService(Service.SecuritySystem)
				.setCharacteristic(Characteristic.SecuritySystemCurrentState, state);

			self.log("[" + name + "] " + self.armState[state]);
			callback(null);
		} else {
			// Set status fault to 1 in case of error
			thisCamera.statusFault = 1;
			callback(new Error("Failed to set target state!"));
		}
	})
	.catch(function(error) {
		// Set status fault to 1 in case of error
		thisCamera.statusFault = 1;
		callback(error);
	});
}

// Method to get the status fault
FoscamPlatform.prototype.getStatusFault = function(mac, callback) {
	var self = this;
	setTimeout(function() {
		callback(null, self.cameraInfo[mac].statusFault);
	}, 500);
}

// Method to handle identify request
FoscamPlatform.prototype.identify = function(mac, paired, callback) {
	var thisCamera = this.cameraInfo[mac];
	var name = "Foscam " + thisCamera.name;
	this.log("[" + name + "] Identify requested!");
	callback();
}
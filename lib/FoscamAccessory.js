var FoscamStream = require('./FoscamStream');

function FoscamAccessory(hap, log, foscamAPI, uri, gain, streamType) {
	this.hap = hap;
	this.log = log;
	this.streamType = streamType;
	this._foscamClient = foscamAPI;

	var mainURI = uri + 'videoMain';
	var subURI = uri + 'videoSub';

	var mainResolutions = [
		[1280, 960, 30],
		[1280, 960, 15],
		[1280, 720, 30],
		[1280, 720, 15],
		[640, 480, 30],
		[640, 480, 15],
		[640, 360, 30],
		[640, 360, 15],
		[320, 240, 30],
		[320, 240, 15],
		[320, 180, 30],
		[320, 180, 15]
	];

	var subResolutions = [
		[1280, 720, 10],
		[640, 480, 10],
		[640, 360, 10],
		[320, 240, 10],
		[320, 180, 10]
	];

	var audioSettings = {
		codecs: [
			{
				type: 'OPUS',
				samplerate: 16
			}
		]
	};

	var videoCodec = {
		profiles: [StreamController.VideoCodecParamProfileIDTypes.MAIN],
		levels: [StreamController.VideoCodecParamLevelTypes.TYPE3_1, StreamController.VideoCodecParamLevelTypes.TYPE3_2, StreamController.VideoCodecParamLevelTypes.TYPE4_0]
	}

	var mainOptions = {
		proxy: true,
		disable_audio_proxy: true,
		srtp: false,
		video: {
			resolutions: mainResolutions,
			codec: videoCodec
		},
		audio: audioSettings
	};

	var subOptions = {
		proxy: true,
		disable_audio_proxy: true,
		srtp: false,
		video: {
			resolutions: subResolutions,
			codec: videoCodec
		},
		audio: audioSettings
	};

	this.mainSupportedBitRates = [
		4 * 1024 * 1024,
		2 * 1024 * 1024,
		1 * 1024 * 1024,
		512 * 1024,
		256 * 1024,
		200 * 1024,
		128 * 1024,
		100 * 1024
	];

	this.subSupportedBitRates = [
		512 * 1024,
		256 * 1024,
		200 * 1024,
		128 * 1024,
		100 * 1024,
		50 * 1024,
		20 * 1024
	];

	this.services = [];
	this.streamControllers = [];
	this.streams = [];

	this._streamControllerIdx = 0;
	this._createStreamControllers(1, mainURI, gain, mainOptions, this.setMainOptions.bind(this));
	this._createStreamControllers(1, subURI, gain, subOptions, this.setSubOptions.bind(this));
}

FoscamAccessory.prototype.closestBitRate = function(list, bitRate) {
	var closest = null;
	var closestDiff;
	for(var rate of list) {
		var diff = Math.abs(bitRate - rate);
		if(closest === null || closestDiff > diff) {
			closest = rate;
			closestDiff = diff;
		}
	}

	return closest;
}

FoscamAccessory.prototype.setMainOptions = function(width, height, fps, bitRate) {
	var self = this;
	self.log('Requested main options:', width, height, fps, bitRate);
	return self._foscamClient.setVideoStreamParam({
		'streamType': self.streamType,
		'resolution': self.heightToFoscamResolution(height),
		'bitRate': self.closestBitRate(self.mainSupportedBitRates, bitRate),
		'frameRate': fps,
		'GOP': fps,
		'isVBR': true
	}).then(function() {
		self.log('Set main parameters, requesting set type.');
		return self._foscamClient.setMainVideoStreamType(self.streamType);
	});
}

FoscamAccessory.prototype.setSubOptions = function(width, height, fps, bitRate) {
	var self = this;
	self.log('Requested sub options:', width, height, fps, bitRate);
	return self._foscamClient.setSubVideoStreamParam({
		'streamType': self.streamType,
		'resolution': self.heightToFoscamResolution(height),
		'bitRate': self.closestBitRate(self.subSupportedBitRates, bitRate),
		'frameRate': fps,
		'GOP': fps,
		'isVBR': true
	}).then(function() {
		// Work-around for lack of setSubVideoStreamType in foscam-client.
		self.log('Set sub parameters, requesting set type.');
		return self._foscamClient.get('setSubVideoStreamType', {'streamType': self.streamType});
	});
}

FoscamAccessory.prototype.heightToFoscamResolution = function(height) {
	switch(height) {
		case 960:
			return 6;
		case 720:
			return 0;
		case 480:
			return 1;
		case 360:
			return 3;
		case 240:
			return 2;
		case 180:
			return 4;
	}
}

FoscamAccessory.prototype._createStreamControllers = function(numStreams, uri, gain, options, setOptions) {
	var self = this;
	var stream = new FoscamStream(uri, gain, setOptions, self.log);

	for(var i = 0; i < numStreams; i++) {
		var streamController = new self.hap.StreamController(self._streamControllerIdx++, options, stream);

		self.services.push(streamController.service);
		self.streamControllers.push(streamController);
	}

	self.streams.push(stream);
}

FoscamAccessory.prototype.handleSnapshotRequest = function(request, callback) {
	var self = this;
	self.log('Foscam-NG: Getting snapshot.');
	self._foscamClient.snapPicture2().then(function(data) {
		self.log('Foscam-NG: Got snapshot.');
		callback(null, data);
	});
}

module.exports = FoscamAccessory;

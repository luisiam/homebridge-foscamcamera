"use strict";

const EventEmitter = require('events').EventEmitter;
const ip = require('ip');
const crypto = require('crypto');
const RTPG711Transcoder = require('./RTPG711Transcoder');
const RTSPClient = require('./RTSPClient');

class FoscamStream extends EventEmitter {
    constructor(uri, gain, setOptions, log) {
        super();
        let self = this;

        self._ready = false;
        self.log = log;

        self.uri = uri;
        self.gain = gain;
        self.setOptions = setOptions;

        self.rtspClient = new RTSPClient(uri);

        self._readyPromise = new Promise((resolve, reject) => {
            self.rtspClient.on('sdp', function() {
                if(self.rtspClient.audio.codec == 'PCMU') {
                    self.transcoderClass = RTPG711Transcoder;
                }

                self._ready = true;
                self.emit('ready');
                resolve();
            });

            self.rtspClient.on('error', (err) => {
                self.log(err);
                reject();
            });
        });
    }

    ready() {
        return self._readyPromise;
    }

    prepareStream(request, callback) {
        let self = this;
        let options = {
            'outgoing': {
                'address': request['audio']['targetAddress'],
                'port': request['audio']['port'],
                'ssrc': crypto.randomBytes(4).readUInt32LE(0)
            },
            'gain': self.gain
        };

        self.transcoder = new self.transcoderClass(options);

        self.transcoder.start().then(() => {
            return self.rtspClient.setup(self.rtspClient.video.uri, request['video']['proxy_rtp'], request['video']['proxy_rtcp']).then(function(video) {
                return self.rtspClient.setup(self.rtspClient.audio.uri, self.transcoder.incomingLocalRTPPort(), self.transcoder.incomingLocalRTCPPort()).then(function(audio) {
                    return [video, audio];
                });
            });
        }).then(function(settings) {
            let videoSettings = settings[0];
            let audioSettings = settings[1];

            self.transcoder.incomingAddress = audioSettings.source;
            self.transcoder.incomingRTPPort = audioSettings.rtpPort;
            self.transcoder.incomingRTCPPort = audioSettings.rtcpPort;

            let currentAddress = ip.address();
            let response = {
                'address': {
                    'address': currentAddress,
                    'type': ip.isV4Format(currentAddress) ? 'v4' : 'v6'
                },
                'video': {
                    'proxy_pt': self.rtspClient.video.payload,
                    'proxy_server_address': videoSettings.source,
                    'proxy_server_rtp': videoSettings.rtpPort,
                    'proxy_server_rtcp': videoSettings.rtcpPort
                },
                'audio': {
                    'address': currentAddress,
                    'port': self.transcoder.outgoingLocalPort(),
                    'ssrc': self.transcoder.outgoingSSRC
                }
            };

            self.log('Video: ' + self.rtspClient.video.uri + ' -> ' + currentAddress + ': RTP ' + videoSettings.rtpPort.toString() + ' -> ' + request['video']['proxy_rtp'].toString() + ' / RTCP ' + videoSettings.rtcpPort.toString() + ' -> ' + request['video']['proxy_rtcp'].toString());
            self.log('Audio: ' + self.rtspClient.audio.uri + ' -> ' + currentAddress + ': RTP ' + audioSettings.rtpPort.toString() + ' -> ' + self.transcoder.incomingLocalRTPPort().toString() + ' / RTCP ' + audioSettings.rtcpPort.toString() + ' -> ' + self.transcoder.incomingLocalRTCPPort().toString() + ' => ' + self.transcoder.outgoingLocalPort().toString() + ' -> ' + self.transcoder.outgoingPort.toString());
            callback(response);
        });
    }

    handleStreamRequest(request) {
        let self = this;
        let requestType = request['type'];
        if(requestType == 'start') {
            self.log('Play: ' + self.uri);

            self.transcoder.setOutgoingSampleRate(request['audio']['sample_rate'] * 1000);
            self.transcoder.outgoingPacketTime = request['audio']['packet_time'];
            self.transcoder.outgoingPayloadType = request['audio']['pt'];

            self.setOptions(request['video']['width'], request['video']['height'], request['video']['fps'], request['video']['max_bit_rate'] * 1000)
                .then(() => {
                    self.rtspClient.play();
                });

            return;
        } else if(requestType == 'reconfigure') {
            self.log('Reconfigure: ', request);
            self.setOptions(request['video']['width'], request['video']['height'], request['video']['fps'], request['video']['max_bit_rate'] * 1000);
        } else if(requestType == 'stop') {
            self.log('Stop: ' + self.uri);
            self.rtspClient.teardown();
        }

        return null;
    }
}

module.exports = FoscamStream;

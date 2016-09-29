"use strict";

const RTPAudioTranscoder = require('./RTPAudioTranscoder');
const opus = require('node-opus');

class RTPG711Transcoder extends RTPAudioTranscoder {
    constructor(options) {
        let incoming = options['incoming'] || {};

        incoming['sample_rate'] = 8000;
        incoming['payload_type'] = 0;

        options['incoming'] = incoming;

        super(options);
        let self = this;

        self.gainMultiplier = Math.pow(10, options['gain'] / 20);
        self.opusEncoder = new opus.OpusEncoder(self.outgoingSampleRate, 1);
        self.exp_lut = [0, 132, 396, 924, 1980, 4092, 8316, 16764];
    }

    setOutgoingSampleRate(sampleRate) {
        let self = this;
        super.setOutgoingSampleRate(sampleRate);
        self.opusEncoder = new opus.OpusEncoder(self.outgoingSampleRate, 1);
    }

    samplesInPayload(payload) {
        return payload.length;
    }

    transcode(payload, callback) {
        let self = this;
        let len = payload.length;
        let outgoingSamplesPerIncomingSample = self.outgoingSampleRate / self.incomingSampleRate;
        let outgoingBytesPerIncomingSample = 2 * outgoingSamplesPerIncomingSample;
        let samples = Buffer.alloc(len * outgoingBytesPerIncomingSample);

        // First convert from ulaw to linear.
        let writeOffset = 0;
        for(let readOffset = 0; readOffset < len; ++readOffset, writeOffset += outgoingBytesPerIncomingSample) {
            let b = ~payload.readUInt8(readOffset);
            let sign = b & 0x80;
            let exponent = (b >> 4) & 0x7;
            let mantissa = b & 0x0F;
            let sample = self.exp_lut[exponent] + (mantissa << (exponent + 3));

            sample *= self.gainMultiplier;

            if(sample > 0x7fff)
                sample = 0x7fff;

            if(sign != 0)
                sample = -sample;

            // Expand to 16 kHZ sample rate.
            for(let i = 0; i < outgoingSamplesPerIncomingSample; ++i) {
                samples.writeInt16LE(sample, writeOffset + (i * 2));
            }
        }

        let payloads = [];
        let bytesPerPacket = (self.outgoingSampleRate * self.outgoingPacketTime / 1000) * 2;
        for(let offset = 0; (offset + bytesPerPacket) <= samples.length; offset += bytesPerPacket) {
            let encoded = self.opusEncoder.encode(samples.slice(offset, offset + bytesPerPacket));
            payloads.push(encoded);
        }

        callback(payloads);
    }
}

module.exports = RTPG711Transcoder;

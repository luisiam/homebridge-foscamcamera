"use strict";

const dgram = require('dgram');
const ip = require('ip');

class RTPAudioTranscoder {
    constructor(options) {
        let self = this;

        self.incomingSampleRate = options['incoming']['sample_rate'];
        self.incomingPacketTime = null;
        self.incomingPayloadType = options['incoming']['payload_type'];
        self.incomingAddress = options['incoming']['address'];

        self.outgoingAddress = options['outgoing']['address'];
        self.outgoingPort = options['outgoing']['port'];
        self.outgoingSSRC = options['outgoing']['ssrc'];

        self.initialSequenceNumber = null;
        self.timestampIncrement = null;
        self.packetMultiplier = 1;

        self.senderPacketCount = 0;
        self.senderOctetCount = 0;

        self.incomingSSRC = null;
    }

    samplesInPayload(payload) {
        throw {message: 'samplesInPayload unimplemented'};
    }

    transcode(payload) {
        throw {message: 'transcode unimplemented'};
    }

    incomingLocalRTPPort() {
        let self = this;
        return self.incomingRTPSocket.address().port;
    }

    incomingLocalRTCPPort() {
        let self = this;
        return self.incomingRTCPSocket.address().port;
    }

    outgoingLocalPort() {
        let self = this;
        return self.outgoingSocket.address().port;
    }

    setOutgoingSampleRate(sampleRate) {
        let self = this;
        self.outgoingSampleRate = sampleRate;
    }

    start() {
        let self = this;
        return new Promise((resolve, reject) => {
            let incomingSocketType = self.incomingAddress ? (ip.isV4Format(self.incomingAddress) ? 'udp4' : 'udp6') : 'udp4';
            let outgoingSocketType = self.outgoingAddress ? (ip.isV4Format(self.outgoingAddress) ? 'udp4' : 'udp6') : 'udp4';

            self.createSocketPair(incomingSocketType).then(sockets => {
                self.createSocketAnyPort(outgoingSocketType).then(outgoingSocket => {
                    self.incomingRTPSocket = sockets[0];
                    self.incomingRTCPSocket = sockets[1];
                    self.outgoingSocket = outgoingSocket;
                    self.bound();
                    resolve();
                });
            });
        });
    }

    sendOut(msg) {
        let self = this;
        self.outgoingSocket.send(msg, self.outgoingPort, self.outgoingAddress);
    }

    processSenderReport(packet) {
        let self = this;
        let ssrc = packet.readUInt32BE(4);
        let rtpTimestamp = packet.readUInt32BE(16);
        let senderPacketCount = packet.readUInt32BE(20);
        let senderOctetCount = packet.readUInt32BE(24);

        if(self.incomingSSRC === null)
            self.incomingSSRC = ssrc;
        else if(self.incomingSSRC != ssrc)
            return null;

        rtpTimestamp = ((rtpTimestamp * self.timestampMultiplier) & 0xFFFFFFFF) >>> 0;
        senderPacketCount = self.senderPacketCount;
        senderOctetCount = self.senderOctetCount;

        packet.writeUInt32BE(self.outgoingSSRC, 4);
        packet.writeUInt32BE(rtpTimestamp, 16);
        packet.writeUInt32BE(senderPacketCount, 20);
        packet.writeUInt32BE(senderOctetCount, 24);

        return packet;
    }

    rtcpMessage(msg) {
        let self = this;

        let rtcpPackets = [];
        let offset = 0;
        while((offset + 4) <= msg.length) {
            let pt = msg.readUInt8(offset + 1);
            let len = msg.readUInt16BE(offset + 2) * 4;
            let packet = msg.slice(offset, offset + 4 + len);

            if(pt == 200) {
                packet = self.processSenderReport(packet);
            }

            if(packet)
                rtcpPackets.push(packet);

            offset += 4 + len;
        }

        self.sendOut(Buffer.concat(rtcpPackets));
    }

    rtcpReply(msg) {
        let self = this;
        // Ignore for now.
    }

    rtpMessage(msg) {
        let self = this;

        let byte0 = msg.readUInt8(0);
        let extension = (byte0 >> 4) & 1;
        let cc = byte0 & 0xf;
        let mpt = msg.readUInt8(1);
        let pt = mpt & 0x7F;
        let sequenceNumber = msg.readUInt16BE(2);
        let timestamp = msg.readUInt32BE(4);
        let ssrc = msg.readUInt32BE(8);

        let offset = 12 + 4 * cc;
        if(extension) {
            let extensionLength = (msg.readUInt16BE(offset + 2) * 4) + 4;
            offset += extensionLength;
        }

        if(self.incomingSSRC === null)
            self.incomingSSRC = ssrc;
        else if(self.incomingSSRC != ssrc)
            return;

        if(self.initialSequenceNumber === null)
            self.initialSequenceNumber = sequenceNumber;

        if(pt != self.incomingPayloadType)
            return;

        mpt = (mpt & 0x80) | self.outgoingPayloadType;
        msg.writeUInt8(mpt, 1);
        msg.writeUInt32BE(self.outgoingSSRC, 8);

        let payload = msg.slice(offset);

        if(self.incomingPacketTime === null) {
            self.incomingPacketTime = self.samplesInPayload(payload) / self.incomingSampleRate * 1000;
            self.packetMultiplier = self.incomingPacketTime / self.outgoingPacketTime;
            self.timestampIncrement = self.outgoingSampleRate * (self.outgoingPacketTime / 1000);
            self.timestampMultiplier = self.outgoingSampleRate / self.incomingSampleRate;
        }

        sequenceNumber = ((((sequenceNumber - self.initialSequenceNumber) * self.packetMultiplier) + self.initialSequenceNumber) & 0xFFFF) >>> 0;
        timestamp = ((timestamp * self.timestampMultiplier) & 0xFFFFFFFF) >>> 0;

        self.transcode(payload, payloads => {
            for(let i = 0; i < self.packetMultiplier; ++i) {
                if(payloads[i]) {
                    let packet = Buffer.concat([msg.slice(0, offset), payloads[i]]);
                    packet.writeUInt16BE(sequenceNumber, 2);
                    packet.writeUInt32BE(timestamp, 4);
                    ++self.senderPacketCount;
                    self.senderOctetCount += packet.length;
                    self.sendOut(packet);
                }

                timestamp = ((timestamp + self.timestampIncrement) & 0xFFFFFFFF) >>> 0;
                sequenceNumber = ((sequenceNumber + 1) & 0xFFFF) >>> 0;
            }
        });
    }

    bound() {
        let self = this;
        self.incomingRTPSocket.on('message', function(msg, rinfo) {
            self.rtpMessage(msg);
        });

        self.incomingRTCPSocket.on('message', function(msg, rinfo) {
            self.rtcpMessage(msg);
        });

        self.outgoingSocket.on('message', function(msg, rinfo) {
            self.rtcpReply(msg);
        });
    }

    createSocketPair(type) {
        let self = this;
        return new Promise((resolve, reject) => {
            let tryAgain = (port, resolve, reject) => {
                let promises = [self.createSocket(type, port), self.createSocket(type, port + 1)];
                Promise.all(promises)
                    .then(sockets => {
                        if(sockets[0] && sockets[1]) {
                            resolve(sockets);
                            return;
                        }

                        if(sockets[0])
                            sockets[0].close()

                        if(sockets[1])
                            sockets[1].close()

                        if(port >= 0xfffe)
                            port = 10000;
                        else
                            port++;

                        tryAgain(port, resolve, reject);
                    });
            };

            tryAgain(10000, resolve, reject);
        });
    }

    createSocketAnyPort(type) {
        let self = this;
        return new Promise((resolve, reject) => {
            let tryAgain = (port, resolve, reject) => {
                self.createSocket(type, port)
                    .then((socket) => {
                        if(socket) {
                            resolve(socket);
                            return;
                        }

                        if(port == 0xffff)
                            port = 10000;
                        else
                            port++;

                        tryAgain(port, resolve, reject);
                    })
            };

            tryAgain(10000, resolve, reject);
        });
    }

    createSocket(type, port) {
        let self = this;
        return new Promise((resolve, reject) => {
            let socket = dgram.createSocket(type);

            let errorHandler = () => {
                socket.close();
                resolve(null);
            };

            let listenHandler = () => {
                socket.removeListener('error', errorHandler);
                socket.removeListener('listening', listenHandler);
                resolve(socket);
            };

            socket.on('error', errorHandler);
            socket.on('listening', listenHandler);

            socket.bind(port);
        });
    }
}

module.exports = RTPAudioTranscoder;

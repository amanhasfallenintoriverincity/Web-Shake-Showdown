import { createOrientationPacketReceiver } from './orientationTransport.js';

const PEER_CONFIGURATION = {
  iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
};
const MAX_ICE_CANDIDATES_PER_PEER = 64;

export function shouldAcceptRelayedOrientation(peerSession) {
  return peerSession?.channel?.readyState !== 'open';
}

export function shouldResetHostRoomState(currentRoomId) {
  return Boolean(currentRoomId);
}

export function bindControllerOrientationReconnect({ socket, roomId, recreatePeer }) {
  const handleConnect = () => {
    recreatePeer();
    socket.emit('join_room', { roomId });
  };
  socket.on('connect', handleConnect);
  return () => socket.off('connect', handleConnect);
}

export function createHostOrientationPeer({
  RTCPeerConnectionClass = globalThis.RTCPeerConnection,
  socket,
  roomId,
  playerId,
  onOrientation,
}) {
  const peer = new RTCPeerConnectionClass(PEER_CONFIGURATION);
  const channel = peer.createDataChannel('orientation', {
    ordered: false,
    maxRetransmits: 0,
  });
  channel.binaryType = 'arraybuffer';
  const receiveOrientation = createOrientationPacketReceiver(onOrientation);
  let closed = false;
  channel.onmessage = event => {
    if (closed) return;
    receiveOrientation(event.data);
  };
  const pendingCandidates = [];
  let acceptedCandidateCount = 0;
  peer.onicecandidate = ({ candidate }) => {
    if (closed || !candidate) return;
    socket.emit('webrtc_host_candidate', {
      roomId,
      playerId,
      candidate: candidate.toJSON?.() ?? candidate,
    });
  };

  return {
    peer,
    channel,
    async start() {
      if (closed) return;
      const offer = await peer.createOffer();
      if (closed) return;
      await peer.setLocalDescription(offer);
      if (closed) return;
      socket.emit('webrtc_offer', {
        roomId,
        playerId,
        offer: peer.localDescription,
      });
    },
    async acceptAnswer(answer) {
      if (closed) return;
      await peer.setRemoteDescription(answer);
      if (closed) return;
      for (const candidate of pendingCandidates.splice(0)) {
        if (closed) return;
        await peer.addIceCandidate(candidate);
        if (closed) return;
      }
    },
    async addCandidate(candidate) {
      if (closed || acceptedCandidateCount >= MAX_ICE_CANDIDATES_PER_PEER) return;
      acceptedCandidateCount += 1;
      if (peer.remoteDescription) {
        await peer.addIceCandidate(candidate);
        if (closed) return;
      } else {
        pendingCandidates.push(candidate);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      pendingCandidates.length = 0;
      peer.onicecandidate = null;
      channel.onmessage = null;
      channel.close();
      peer.close();
    },
  };
}

export function createControllerOrientationPeer({
  RTCPeerConnectionClass = globalThis.RTCPeerConnection,
  socket,
  roomId,
  onChannel,
}) {
  const peer = new RTCPeerConnectionClass(PEER_CONFIGURATION);
  let channel = null;
  let closed = false;
  const pendingCandidates = [];
  let acceptedCandidateCount = 0;

  peer.ondatachannel = event => {
    if (closed) {
      event.channel.onmessage = null;
      event.channel.close();
      return;
    }
    if (event.channel.label !== 'orientation') {
      event.channel.close();
      return;
    }
    channel = event.channel;
    channel.binaryType = 'arraybuffer';
    onChannel(channel);
  };
  peer.onicecandidate = ({ candidate }) => {
    if (closed || !candidate) return;
    socket.emit('webrtc_controller_candidate', {
      roomId,
      candidate: candidate.toJSON?.() ?? candidate,
    });
  };

  return {
    peer,
    get channel() {
      return channel;
    },
    async acceptOffer(offer) {
      if (closed) return;
      await peer.setRemoteDescription(offer);
      if (closed) return;
      for (const candidate of pendingCandidates.splice(0)) {
        if (closed) return;
        await peer.addIceCandidate(candidate);
        if (closed) return;
      }
      const answer = await peer.createAnswer();
      if (closed) return;
      await peer.setLocalDescription(answer);
      if (closed) return;
      socket.emit('webrtc_answer', {
        roomId,
        answer: peer.localDescription,
      });
    },
    async addCandidate(candidate) {
      if (closed || acceptedCandidateCount >= MAX_ICE_CANDIDATES_PER_PEER) return;
      acceptedCandidateCount += 1;
      if (peer.remoteDescription) {
        await peer.addIceCandidate(candidate);
        if (closed) return;
      } else {
        pendingCandidates.push(candidate);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      pendingCandidates.length = 0;
      peer.onicecandidate = null;
      peer.ondatachannel = null;
      if (channel) channel.onmessage = null;
      channel?.close();
      peer.close();
    },
  };
}

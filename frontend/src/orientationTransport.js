const ORIENTATION_INTERVAL_MS = 1000 / 60;
const ORIENTATION_PACKET_BYTES = 16;
const MAX_ORIENTATION_SEQUENCE = 0xffffffff;
const ORIENTATION_RECEPTION_STALE_MS = 1000;
export const ORIENTATION_TRANSPORT_DIRECT = 'DIRECT';
export const ORIENTATION_TRANSPORT_FALLBACK = 'FALLBACK';

export function isValidOrientation(data) {
  return data !== null
    && typeof data === 'object'
    && Number.isFinite(data.alpha)
    && Number.isFinite(data.beta)
    && Number.isFinite(data.gamma);
}

function isValidOrientationSequence(sequence) {
  return Number.isInteger(sequence)
    && sequence >= 0
    && sequence <= MAX_ORIENTATION_SEQUENCE;
}

function isNewerOrientationSequence(sequence, lastSequence) {
  if (!isValidOrientationSequence(sequence)) return false;
  if (lastSequence === undefined || lastSequence === null) return true;
  const distance = (sequence - lastSequence) >>> 0;
  return distance > 0 && distance < 0x80000000;
}

function isValidOrientationReception(playerId, transport, receivedAt) {
  return typeof playerId === 'string'
    && Boolean(playerId)
    && Number.isFinite(receivedAt)
    && (transport === ORIENTATION_TRANSPORT_DIRECT
      || transport === ORIENTATION_TRANSPORT_FALLBACK);
}

export function recordOrientationReception(receptions, playerId, transport, receivedAt) {
  if (receptions === null || typeof receptions !== 'object') return false;
  if (!isValidOrientationReception(playerId, transport, receivedAt)) return false;
  receptions[playerId] = { transport, lastReceivedAt: receivedAt };
  return true;
}

export function getOrientationReceptionDiagnostic(receptions, playerId, now) {
  const reception = receptions[playerId];
  if (!reception) {
    return {
      transport: ORIENTATION_TRANSPORT_FALLBACK,
      lastReceivedAt: null,
      ageMs: null,
      ageLabel: '수신 대기',
      isStale: true,
    };
  }
  const ageMs = Math.max(0, Math.round(now - reception.lastReceivedAt));
  return {
    ...reception,
    ageMs,
    ageLabel: ageMs < ORIENTATION_RECEPTION_STALE_MS
      ? `${ageMs}ms 전`
      : `${(ageMs / 1000).toFixed(1)}초 전`,
    isStale: ageMs >= ORIENTATION_RECEPTION_STALE_MS,
  };
}

export function applyTrackedOrientation(orientations, sequences, playerId, data, sequence) {
  if (!Object.prototype.hasOwnProperty.call(orientations, playerId)) return false;
  if (!isValidOrientation(data)) return false;
  if (!isNewerOrientationSequence(sequence, sequences[playerId])) return false;

  orientations[playerId] = data;
  sequences[playerId] = sequence;
  return true;
}

export function applyTrackedOrientationReception({
  orientations,
  sequences,
  receptions,
  playerId,
  data,
  sequence,
  transport,
  receivedAt,
}) {
  if (receptions === null || typeof receptions !== 'object') return false;
  if (!isValidOrientationReception(playerId, transport, receivedAt)) return false;
  if (!applyTrackedOrientation(orientations, sequences, playerId, data, sequence)) return false;
  receptions[playerId] = { transport, lastReceivedAt: receivedAt };
  return true;
}

export function initializeTrackedOrientation(orientations, sequences, playerId, initialData) {
  if (Object.prototype.hasOwnProperty.call(orientations, playerId)) return false;
  orientations[playerId] = initialData;
  delete sequences[playerId];
  return true;
}

export function createDeviceOrientationListener(target, handler) {
  let active = false;
  return {
    start() {
      if (active) return;
      target.addEventListener('deviceorientation', handler);
      active = true;
    },
    stop() {
      if (!active) return;
      target.removeEventListener('deviceorientation', handler);
      active = false;
    },
  };
}

export function createDeviceOrientationPermissionFlow() {
  let generation = 0;
  return {
    invalidate() {
      generation += 1;
    },
    async start({
      roomId,
      requestPermission,
      onInvalidRoom = () => {},
      onGranted = () => {},
      onDenied = () => {},
      onError = () => {},
    }) {
      const attempt = ++generation;
      if (typeof roomId !== 'string' || !roomId.trim()) {
        onInvalidRoom();
        return false;
      }

      try {
        const permissionState = await requestPermission();
        if (attempt !== generation) return false;
        if (permissionState !== 'granted') {
          onDenied();
          return false;
        }
        onGranted();
        return true;
      } catch (error) {
        if (attempt !== generation) return false;
        onError(error);
        return false;
      }
    },
  };
}

function encodeOrientationPacket(sequence, data) {
  const buffer = new ArrayBuffer(ORIENTATION_PACKET_BYTES);
  const packet = new DataView(buffer);
  packet.setUint32(0, sequence, true);
  packet.setFloat32(4, Number.isFinite(data.alpha) ? data.alpha : 0, true);
  packet.setFloat32(8, Number.isFinite(data.beta) ? data.beta : 0, true);
  packet.setFloat32(12, Number.isFinite(data.gamma) ? data.gamma : 0, true);
  return buffer;
}

export function createOrientationPacketReceiver(onOrientation) {
  let lastSequence = null;

  return buffer => {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== ORIENTATION_PACKET_BYTES) {
      return false;
    }

    const packet = new DataView(buffer);
    const sequence = packet.getUint32(0, true);
    const data = {
      alpha: packet.getFloat32(4, true),
      beta: packet.getFloat32(8, true),
      gamma: packet.getFloat32(12, true),
    };
    if (!isValidOrientation(data)) return false;
    if (!isNewerOrientationSequence(sequence, lastSequence)) return false;

    lastSequence = sequence;
    onOrientation(data, sequence);
    return true;
  };
}

export function createOrientationPublisher({
  now = () => performance.now(),
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = timerId => clearTimeout(timerId),
} = {}) {
  let lastSentAt = -Infinity;
  let timerId = null;
  let pendingSample = null;
  let sequence = 0;

  const send = ({ socket, roomId, data, dataChannel }, sentAt) => {
    if (dataChannel?.readyState === 'open') {
      lastSentAt = sentAt;
      if (dataChannel.bufferedAmount > 0) return false;

      const packet = encodeOrientationPacket(sequence, data);
      try {
        dataChannel.send(packet);
        sequence = (sequence + 1) >>> 0;
        return true;
      } catch {
        // The channel was observed open, so relaying the same pose could arrive out of order.
        return false;
      }
    }

    if (!socket?.connected) return false;

    socket.volatile.emit('orientation', { roomId, data, sequence });
    sequence = (sequence + 1) >>> 0;
    lastSentAt = sentAt;
    return true;
  };

  const flush = () => {
    timerId = null;
    const sample = pendingSample;
    pendingSample = null;
    if (sample) send(sample, now());
  };

  const publish = (socket, roomId, data, dataChannel) => {
    if (!socket?.connected && dataChannel?.readyState !== 'open') return false;

    const sentAt = now();
    const elapsed = sentAt - lastSentAt;
    const sample = { socket, roomId, data, dataChannel };

    if (elapsed >= ORIENTATION_INTERVAL_MS) {
      if (timerId !== null) {
        clearTimer(timerId);
        timerId = null;
        pendingSample = null;
      }
      return send(sample, sentAt);
    }

    // Keep only the newest sensor pose while waiting for the next 60Hz slot.
    pendingSample = sample;
    if (timerId === null) {
      timerId = setTimer(flush, ORIENTATION_INTERVAL_MS - elapsed);
    }
    return false;
  };

  publish.reset = () => {
    if (timerId !== null) clearTimer(timerId);
    timerId = null;
    pendingSample = null;
    lastSentAt = -Infinity;
  };

  return publish;
}

const ORIENTATION_INTERVAL_MS = 1000 / 60;

export function createOrientationPublisher({
  now = () => performance.now(),
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = timerId => clearTimeout(timerId),
} = {}) {
  let lastSentAt = -Infinity;
  let timerId = null;
  let pendingSample = null;

  const send = ({ socket, roomId, data }, sentAt) => {
    if (!socket?.connected) return false;

    socket.volatile.emit('orientation', { roomId, data });
    lastSentAt = sentAt;
    return true;
  };

  const flush = () => {
    timerId = null;
    const sample = pendingSample;
    pendingSample = null;
    if (sample) send(sample, now());
  };

  return (socket, roomId, data) => {
    if (!socket?.connected) return false;

    const sentAt = now();
    const elapsed = sentAt - lastSentAt;
    const sample = { socket, roomId, data };

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
}

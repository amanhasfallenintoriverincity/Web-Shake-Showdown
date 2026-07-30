export function createOrientationPublisher() {
  return (socket, roomId, data) => {
    if (!socket?.connected) return false;

    // DeviceOrientation already supplies the browser's sensor cadence. Forward each
    // fresh sample; volatile transport discards it instead of queueing if WebSocket
    // cannot write immediately.
    socket.volatile.emit('orientation', { roomId, data });
    return true;
  };
}

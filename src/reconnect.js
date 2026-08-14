const RECONNECT_DELAY = 2000;
const MAX_RECONNECT_ATTEMPTS = 5;
const ICE_RESTART_DELAY = 3000;

let reconnectAttempts = new Map();
let reconnectTimers = new Map();

export function isPolitePeer(localPeerId, remotePeerId) {
  return localPeerId < remotePeerId;
}

export function scheduleReconnect(peerId, callback) {
  const attempts = reconnectAttempts.get(peerId) || 0;
  if (attempts >= MAX_RECONNECT_ATTEMPTS) {
    console.warn(`Max reconnect attempts reached for ${peerId}`);
    return false;
  }

  const delay = RECONNECT_DELAY * Math.pow(1.5, attempts);
  reconnectAttempts.set(peerId, attempts + 1);

  const timer = setTimeout(() => {
    reconnectTimers.delete(peerId);
    callback(peerId);
  }, delay);

  reconnectTimers.set(peerId, timer);
  return true;
}

export function clearReconnect(peerId) {
  reconnectAttempts.delete(peerId);
  const timer = reconnectTimers.get(peerId);
  if (timer) {
    clearTimeout(timer);
    reconnectTimers.delete(peerId);
  }
}

export function resetReconnectAttempts(peerId) {
  reconnectAttempts.set(peerId, 0);
}

export async function restartIce(pc) {
  if (!pc || pc.signalingState === 'closed') return;
  try {
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    return offer;
  } catch (e) {
    console.warn('ICE restart failed:', e);
    return null;
  }
}

export function setupConnectionMonitor(pc, peerId, onFailed) {
  if (!pc) return;

  pc.oniceconnectionstatechange = () => {
    const state = pc.iceConnectionState;
    if (state === 'failed') {
      console.warn(`ICE failed for ${peerId}, attempting restart`);
      restartIce(pc).then(offer => {
        if (!offer) onFailed(peerId);
      });
    } else if (state === 'disconnected') {
      console.warn(`ICE disconnected for ${peerId}`);
      setTimeout(() => {
        if (pc.iceConnectionState === 'disconnected') {
          restartIce(pc);
        }
      }, ICE_RESTART_DELAY);
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') {
      onFailed(peerId);
    }
  };
}

export function clearAllReconnects() {
  reconnectTimers.forEach(timer => clearTimeout(timer));
  reconnectTimers.clear();
  reconnectAttempts.clear();
}

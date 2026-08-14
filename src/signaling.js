import { Peer } from 'peerjs';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  {
    urls: 'turn:turn.cloudflare.com:3478',
    username: 'free',
    credential: 'free'
  }
];

const PEERJS_OPTIONS = {
  debug: 0,
  config: {
    iceServers: ICE_SERVERS,
    iceTransportPolicy: 'all',
    sdpSemantics: 'unified-plan'
  }
};

export function createPeer(peerId) {
  const opts = { ...PEERJS_OPTIONS };
  if (peerId) {
    return new Peer(peerId, opts);
  }
  return new Peer(undefined, opts);
}

export function connectToPeer(localPeer, remotePeerId, metadata) {
  return localPeer.connect(remotePeerId, {
    metadata,
    serialization: 'binary',
    reliable: true
  });
}

export function callPeer(localPeer, remotePeerId, stream, metadata) {
  return localPeer.call(remotePeerId, stream, { metadata });
}

export { ICE_SERVERS };

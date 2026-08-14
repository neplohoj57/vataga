const ROOM_PREFIX = 'vataga-';
const MAX_MEMBERS = 8;

let currentRoomId = null;
let localPeerId = null;
let localName = 'Аноним';
let members = new Map();
let eventLog = [];

export function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

export function getFullRoomId(code) {
  return ROOM_PREFIX + code.toLowerCase();
}

export function setCurrentRoom(code) {
  currentRoomId = code;
}

export function getCurrentRoom() {
  return currentRoomId;
}

export function setLocalPeerId(id) {
  localPeerId = id;
}

export function getLocalPeerId() {
  return localPeerId;
}

export function setLocalName(name) {
  localName = name || 'Аноним';
}

export function getLocalName() {
  return localName;
}

export function addMember(peerId, name) {
  if (members.size >= MAX_MEMBERS && !members.has(peerId)) return false;
  members.set(peerId, {
    name: name || 'Аноним',
    muted: false,
    deafened: false,
    speaking: false,
    volume: 0,
    audioElement: null,
    stream: null,
    conn: null,
    dataConn: null,
    screenStream: null
  });
  return true;
}

export function removeMember(peerId) {
  const m = members.get(peerId);
  if (m) {
    if (m.audioElement) {
      m.audioElement.srcObject = null;
      m.audioElement.remove();
    }
    members.delete(peerId);
  }
}

export function getMember(peerId) {
  return members.get(peerId);
}

export function getAllMembers() {
  return members;
}

export function getMemberCount() {
  return members.size;
}

export function isRoomFull() {
  return members.size >= MAX_MEMBERS;
}

export function updateMember(peerId, data) {
  const m = members.get(peerId);
  if (m) Object.assign(m, data);
}

export function logEvent(type, message) {
  const entry = {
    type,
    message,
    time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  };
  eventLog.push(entry);
  if (eventLog.length > 500) eventLog.shift();
  return entry;
}

export function getEventLog() {
  return eventLog;
}

export function clearRoom() {
  members.forEach((m, id) => {
    if (m.audioElement) {
      m.audioElement.srcObject = null;
      m.audioElement.remove();
    }
  });
  members.clear();
  eventLog = [];
  currentRoomId = null;
}

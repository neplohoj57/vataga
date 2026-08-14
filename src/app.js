import { createPeer, connectToPeer, callPeer } from './signaling.js';
import {
  captureMicrophone, getVolume, muteMic, unmuteMic, isMicMuted,
  getLocalStream, applyAudioConstraints, stopMicrophone,
  createAudioElement, removeAudioElement
} from './audio.js';
import {
  startScreenShare, getScreenStream, stopScreenShare, isScreenSharing
} from './screen.js';
import {
  generateRoomCode, getFullRoomId, setCurrentRoom, getCurrentRoom,
  setLocalPeerId, getLocalPeerId, setLocalName, getLocalName,
  addMember, removeMember, getMember, getAllMembers, getMemberCount,
  isRoomFull, updateMember, logEvent, getEventLog, clearRoom
} from './rooms.js';
import {
  createOutgoingTransfer, createIncomingTransfer, getTransfer, getAllTransfers,
  removeTransfer, getTransferProgress, getTransferSpeed, getTransferETA,
  formatBytes, formatSpeed, formatETA, handleIncomingChunk,
  assembleFile, clearAllTransfers, CHUNK_SIZE
} from './files.js';
import {
  isPolitePeer, scheduleReconnect, clearReconnect, resetReconnectAttempts,
  restartIce, setupConnectionMonitor, clearAllReconnects
} from './reconnect.js';

let peer = null;
let isHost = false;
let isMuted = false;
let isDeafened = false;
let isPTTActive = false;
let isPTTMode = false;
let isVAMode = false;
let vaThreshold = 30;
let vuInterval = null;
let fileInput = null;
let joined = false;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

async function init() {
  fileInput = $('#file-input');
  bindUI();
  checkUrlRoom();
}

function bindUI() {
  $('#btn-create').addEventListener('click', () => joinRoom(true));
  $('#btn-join').addEventListener('click', () => joinRoom(false));
  $('#input-name').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(false); });
  $('#input-room').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(false); });
  $('#btn-leave').addEventListener('click', leaveRoom);
  $('#btn-copy-link').addEventListener('click', copyInviteLink);
  $('#btn-mic').addEventListener('click', toggleMute);
  $('#btn-deaf').addEventListener('click', toggleDeafen);
  $('#btn-ptt').addEventListener('click', togglePTT);
  $('#btn-screen').addEventListener('click', toggleScreenShare);
  $('#btn-stop-screen').addEventListener('click', stopScreenShareAction);
  $('#btn-file').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', handleFileSelect);
  $('#toggle-ns').addEventListener('change', updateAudioSettings);
  $('#toggle-ec').addEventListener('change', updateAudioSettings);
  $('#toggle-agc').addEventListener('change', updateAudioSettings);
  $('#toggle-va').addEventListener('change', (e) => {
    isVAMode = e.target.checked;
    if (isVAMode) { isPTTMode = false; $('#btn-ptt').classList.remove('active'); }
  });
  $('#va-threshold').addEventListener('input', (e) => {
    vaThreshold = parseInt(e.target.value);
  });
  $('#btn-close-overlay').addEventListener('click', closeOverlay);

  document.addEventListener('keydown', (e) => {
    if (document.activeElement.tagName === 'INPUT') return;
    if (e.code === 'KeyM' && !e.repeat) toggleMute();
    if (e.code === 'KeyD' && !e.repeat) toggleDeafen();
    if (e.code === 'Space' && isPTTMode) {
      e.preventDefault();
      if (!isPTTActive) pttDown();
    }
  });
  document.addEventListener('keyup', (e) => {
    if (e.code === 'Space' && isPTTMode && isPTTActive) {
      pttUp();
    }
  });

  window.addEventListener('screen-share-stopped', () => {
    updateScreenShareUI(false);
    broadcastToAll({ type: 'screen-stopped' });
  });
}

function checkUrlRoom() {
  const params = new URLSearchParams(window.location.search);
  const room = params.get('room');
  if (room) {
    $('#input-room').value = room.toUpperCase();
  }
}

async function joinRoom(create) {
  if (joined) return;
  joined = true;

  const name = $('#input-name').value.trim() || 'Аноним';
  let roomCode = $('#input-room').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

  if (!roomCode || roomCode.length < 2) {
    roomCode = generateRoomCode();
  }

  setLocalName(name);
  setCurrentRoom(roomCode);
  isHost = create;

  showScreen('room');
  $('#room-code-display').textContent = roomCode;
  addMember('local', name);
  logEvent('join', `${name} зашёл в комнату`);
  renderMembers();
  renderEventLog();

  try {
    await captureMicrophone();
    const myPeerId = 'vataga-' + Date.now().toString(36) + '-' + Math.random().toString(36).substr(2, 6);
    setLocalPeerId(myPeerId);

    const roomPeerId = getFullRoomId(roomCode);

    if (create) {
      await createRoom(roomPeerId, myPeerId, name);
    } else {
      await joinExistingRoom(roomPeerId, myPeerId, name);
    }

    startVuMeter();
    updateUrl(roomCode);
  } catch (e) {
    console.error('Failed to join room:', e);
    logEvent('leave', 'Ошибка: ' + e.message);
    renderEventLog();
    joined = false;
  }
}

async function createRoom(roomPeerId, myPeerId, name) {
  return new Promise((resolve, reject) => {
    peer = createPeer(roomPeerId);

    peer.on('open', (id) => {
      logEvent('join', `Комната создана: ${getCurrentRoom()}`);
      renderEventLog();
      resolve();
    });

    peer.on('connection', (conn) => {
      handleNewPeerConnection(conn);
    });

    peer.on('call', (call) => {
      handleIncomingCall(call);
    });

    peer.on('disconnected', () => {
      if (peer && !peer.destroyed) {
        setTimeout(() => { try { peer.reconnect(); } catch(e) {} }, 2000);
      }
    });

    peer.on('error', (err) => {
      console.error('Peer error:', err.type);
      if (err.type === 'unavailable-id') {
        reject(new Error('Комната уже существует. Попробуйте другой код или присоединитесь.'));
      } else {
        reject(err);
      }
    });
  });
}

async function joinExistingRoom(roomPeerId, myPeerId, name) {
  return new Promise((resolve, reject) => {
    peer = createPeer(myPeerId);

    peer.on('open', (id) => {
      const conn = peer.connect(roomPeerId, {
        metadata: { name, peerId: id },
        serialization: 'json',
        reliable: true
      });

      conn.on('open', () => {
        conn.send({ type: 'join', name, peerId: id });
      });

      conn.on('data', (data) => handleHostData(conn, data));
      conn.on('close', () => {
        logEvent('leave', 'Соединение с хостом потеряно');
        renderEventLog();
      });
      conn.on('error', (e) => console.warn('Host conn error:', e));

      updateMember('host', { conn, name: 'Хост' });
      resolve();
    });

    peer.on('connection', (conn) => {
      handleNewPeerConnection(conn);
    });

    peer.on('call', (call) => {
      handleIncomingCall(call);
    });

    peer.on('disconnected', () => {
      if (peer && !peer.destroyed) {
        setTimeout(() => { try { peer.reconnect(); } catch(e) {} }, 2000);
      }
    });

    peer.on('error', (err) => {
      console.error('Peer error:', err.type);
      reject(err);
    });
  });
}

function handleNewPeerConnection(conn) {
  conn.on('open', () => {
    const remotePeerId = conn.peer;
    const meta = conn.metadata || {};
    const remoteName = meta.name || 'Аноним';

    if (!getMember(remotePeerId)) {
      addMember(remotePeerId, remoteName);
      logEvent('join', `${remoteName} зашёл в комнату`);
      renderMembers();
      renderEventLog();

      if (isHost) {
        const members = [];
        getAllMembers().forEach((m, pid) => {
          if (pid !== 'local' && pid !== remotePeerId) {
            members.push({ peerId: pid, name: m.name });
          }
        });
        conn.send({ type: 'room-members', members });

        broadcastToAll({ type: 'peer-joined', peerId: remotePeerId, name: remoteName }, remotePeerId);
      }

      const localStream = getLocalStream();
      if (localStream) {
        callPeer(peer, remotePeerId, localStream, { name: getLocalName() });
      }
    }

    updateMember(remotePeerId, { conn });

    conn.on('data', (data) => handlePeerData(remotePeerId, data));
    conn.on('close', () => handlePeerDisconnect(remotePeerId));
    conn.on('error', () => handlePeerDisconnect(remotePeerId));
  });
}

function handleHostData(conn, data) {
  if (!data || typeof data !== 'object') return;

  if (data.type === 'room-members' && Array.isArray(data.members)) {
    data.members.forEach(m => {
      if (m.peerId !== getLocalPeerId() && !getMember(m.peerId)) {
        addMember(m.peerId, m.name);
        logEvent('join', `${m.name} уже в комнате`);
        renderMembers();
        renderEventLog();

        const localStream = getLocalStream();
        if (localStream) {
          callPeer(peer, m.peerId, localStream, { name: getLocalName() });
        }

        const dc = connectToPeer(peer, m.peerId, { name: getLocalName() });
        setupDirectConnection(m.peerId, dc);
      }
    });
  }

  if (data.type === 'peer-joined') {
    const { peerId, name } = data;
    if (peerId !== getLocalPeerId() && !getMember(peerId)) {
      addMember(peerId, name);
      logEvent('join', `${name} зашёл в комнату`);
      renderMembers();
      renderEventLog();
    }
  }

  if (data.type === 'peer-left') {
    handlePeerDisconnect(data.peerId);
  }
}

function setupDirectConnection(peerId, dc) {
  dc.on('open', () => {
    updateMember(peerId, { dataConn: dc });
  });
  dc.on('data', (data) => handlePeerData(peerId, data));
  dc.on('close', () => handlePeerDisconnect(peerId));
  dc.on('error', (e) => console.warn('Direct conn error:', e));
}

function handleIncomingCall(call) {
  const peerId = call.peer;
  const meta = call.metadata || {};

  if (meta.type === 'screen') {
    call.answer();
    call.on('stream', (stream) => {
      showRemoteScreenShare(peerId, stream, meta.name);
    });
    call.on('close', () => {
      hideRemoteScreenShare(peerId);
    });
    return;
  }

  const localStream = getLocalStream();
  call.answer(localStream);

  call.on('stream', (stream) => {
    handleRemoteStream(peerId, stream);
  });

  call.on('close', () => {
    console.log('Call closed with', peerId);
  });

  if (call.peerConnection) {
    setupConnectionMonitor(
      call.peerConnection,
      peerId,
      (failedPeerId) => {
        scheduleReconnect(failedPeerId, (rpId) => {
          const m = getMember(rpId);
          if (m && peer && !peer.destroyed) {
            const ls = getLocalStream();
            if (ls) callPeer(peer, rpId, ls, { name: getLocalName() });
          }
        });
      }
    );
  }
}

function handleRemoteStream(peerId, stream) {
  let member = getMember(peerId);
  if (!member) {
    addMember(peerId, 'Аноним');
    member = getMember(peerId);
  }

  if (member.audioElement) {
    removeAudioElement(member.audioElement);
  }

  const audio = createAudioElement(stream);
  audio.muted = isDeafened;
  updateMember(peerId, { stream, audioElement: audio });
  resetReconnectAttempts(peerId);
}

function handlePeerData(peerId, data) {
  if (!data || typeof data !== 'object') return;

  switch (data.type) {
    case 'file-meta': {
      createIncomingTransfer(peerId, data);
      renderFileTransfers();
      break;
    }
    case 'file-chunk': {
      const transfer = getTransfer(data.transferId);
      if (!transfer) return;
      const done = handleIncomingChunk(transfer, data.chunk);
      renderFileTransfers();
      if (done) {
        const blob = assembleFile(transfer);
        downloadBlob(blob, transfer.fileName);
        logEvent('file', `Файл получен: ${transfer.fileName} (${formatBytes(transfer.fileSize)})`);
        renderEventLog();
        removeTransfer(transfer.id);
        renderFileTransfers();
      }
      break;
    }
    case 'file-cancel': {
      const t = getTransfer(data.transferId);
      if (t) { removeTransfer(t.id); renderFileTransfers(); }
      break;
    }
    case 'file-pause': {
      const t = getTransfer(data.transferId);
      if (t) { t.paused = !t.paused; renderFileTransfers(); }
      break;
    }
    case 'mute-status': {
      updateMember(peerId, { muted: data.muted });
      renderMembers();
      const m = getMember(peerId);
      logEvent('mute', `${m?.name || 'Участник'} ${data.muted ? 'замутился' : 'размутился'}`);
      renderEventLog();
      break;
    }
    case 'screen-stopped': {
      hideRemoteScreenShare(peerId);
      break;
    }
  }
}

function handlePeerDisconnect(peerId) {
  const member = getMember(peerId);
  if (member) {
    const name = member.name;
    if (member.audioElement) removeAudioElement(member.audioElement);
    removeMember(peerId);
    clearReconnect(peerId);
    logEvent('leave', `${name} вышел из комнаты`);
    renderMembers();
    renderEventLog();
  }

  if (isHost) {
    broadcastToAll({ type: 'peer-left', peerId });
  }
}

function broadcastToAll(msg, excludePeerId) {
  getAllMembers().forEach((m, peerId) => {
    if (peerId === 'local' || peerId === excludePeerId) return;
    const conn = m.dataConn || m.conn;
    if (conn && conn.open) {
      try { conn.send(msg); } catch(e) {}
    }
  });
}

function toggleMute() {
  isMuted = !isMuted;
  if (isMuted) muteMic(); else unmuteMic();
  updateMember('local', { muted: isMuted });
  broadcastToAll({ type: 'mute-status', muted: isMuted });
  renderMembers();
  logEvent('mute', `${getLocalName()} ${isMuted ? 'замутился' : 'размутился'}`);
  renderEventLog();
  updateCtrlButtons();
}

function toggleDeafen() {
  isDeafened = !isDeafened;
  updateMember('local', { deafened: isDeafened });
  getAllMembers().forEach((m, peerId) => {
    if (peerId === 'local') return;
    if (m.audioElement) m.audioElement.muted = isDeafened;
  });
  if (isDeafened && !isMuted) toggleMute();
  updateCtrlButtons();
}

function togglePTT() {
  isPTTMode = !isPTTMode;
  if (isPTTMode) {
    isVAMode = false;
    $('#toggle-va').checked = false;
    if (!isMuted) toggleMute();
  } else {
    if (isMuted) toggleMute();
  }
  updateCtrlButtons();
}

function pttDown() {
  if (isMuted) toggleMute();
  isPTTActive = true;
  updateCtrlButtons();
}

function pttUp() {
  if (!isMuted) toggleMute();
  isPTTActive = false;
  updateCtrlButtons();
}

function updateAudioSettings() {
  applyAudioConstraints({
    noiseSuppression: $('#toggle-ns').checked,
    echoCancellation: $('#toggle-ec').checked,
    autoGainControl: $('#toggle-agc').checked
  });
}

function toggleScreenShare() {
  if (isScreenSharing()) {
    stopScreenShareAction();
  } else {
    startScreenShareAction();
  }
}

async function startScreenShareAction() {
  const stream = await startScreenShare();
  if (!stream) return;

  updateScreenShareUI(true);

  getAllMembers().forEach((m, peerId) => {
    if (peerId === 'local') return;
    try {
      peer.call(peerId, stream, { metadata: { type: 'screen', name: getLocalName() } });
    } catch(e) {}
  });

  const video = $('#screen-share-video');
  video.srcObject = stream;

  logEvent('file', `${getLocalName()} начал демонстрацию экрана`);
  renderEventLog();
}

function stopScreenShareAction() {
  stopScreenShare();
  updateScreenShareUI(false);
  broadcastToAll({ type: 'screen-stopped' });
  logEvent('file', `${getLocalName()} остановил демонстрацию экрана`);
  renderEventLog();
}

function updateScreenShareUI(active) {
  $('#screen-share-panel').style.display = active ? 'flex' : 'none';
  $('#btn-screen').classList.toggle('active', active);
}

function showRemoteScreenShare(peerId, stream, name) {
  updateScreenShareUI(true);
  const video = $('#screen-share-video');
  video.srcObject = stream;
  logEvent('file', `${name || 'Участник'} показывает экран`);
  renderEventLog();
}

function hideRemoteScreenShare(peerId) {
  const video = $('#screen-share-video');
  if (video.srcObject) {
    video.srcObject.getTracks().forEach(t => t.stop());
    video.srcObject = null;
  }
  updateScreenShareUI(false);
}

function closeOverlay() {
  $('#screen-overlay').style.display = 'none';
  const video = $('#screen-overlay-video');
  if (video.srcObject) {
    video.srcObject.getTracks().forEach(t => t.stop());
    video.srcObject = null;
  }
}

function handleFileSelect(e) {
  const files = Array.from(e.target.files);
  files.forEach(f => sendFile(f));
  fileInput.value = '';
}

async function sendFile(file) {
  const transfer = createOutgoingTransfer('all', file);

  broadcastToAll({
    type: 'file-meta',
    transferId: transfer.id,
    fileName: file.name,
    fileSize: file.size
  });

  logEvent('file', `Отправка: ${file.name} (${formatBytes(file.size)})`);
  renderEventLog();
  renderFileTransfers();

  const peers = [];
  getAllMembers().forEach((m, peerId) => {
    if (peerId === 'local') return;
    const dc = m.dataConn || m.conn;
    if (dc && dc.open) peers.push({ peerId, dc });
  });

  if (peers.length === 0) {
    logEvent('file', 'Нет участников для отправки');
    renderEventLog();
    removeTransfer(transfer.id);
    renderFileTransfers();
    return;
  }

  for (const { dc } of peers) {
    sendFileToChannel(transfer, file, dc);
  }
}

async function sendFileToChannel(transfer, file, dc) {
  let offset = 0;

  while (offset < file.size) {
    if (transfer.cancelled) {
      try { dc.send({ type: 'file-cancel', transferId: transfer.id }); } catch(e) {}
      return;
    }

    while (transfer.paused) {
      await sleep(200);
    }

    const end = Math.min(offset + CHUNK_SIZE, file.size);
    const chunk = file.slice(offset, end);

    try {
      const buffer = await chunk.arrayBuffer();
      dc.send({ type: 'file-chunk', transferId: transfer.id, chunk: buffer });
    } catch(e) {
      await sleep(100);
      continue;
    }

    offset = end;
    transfer.offset = offset;
    renderFileTransfers();

    await sleep(5);
  }

  logEvent('file', `Отправлено: ${file.name}`);
  renderEventLog();
  removeTransfer(transfer.id);
  renderFileTransfers();
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function startVuMeter() {
  vuInterval = setInterval(() => {
    if (!joined) return;

    const vol = getVolume();
    updateMember('local', { volume: vol, speaking: vol > 0.05 });

    if (isVAMode && !isPTTMode) {
      const threshold = vaThreshold / 100;
      if (vol > threshold && isMuted) {
        toggleMute();
      } else if (vol < threshold * 0.3 && !isMuted) {
        setTimeout(() => {
          if (getVolume() < threshold * 0.3 && !isMuted) toggleMute();
        }, 500);
      }
    }

    let needRender = false;
    getAllMembers().forEach((m, peerId) => {
      if (peerId === 'local') return;
      const el = m.audioElement;
      if (el) {
        const speaking = !el.paused && el.currentTime > 0;
        if (m.speaking !== speaking) {
          updateMember(peerId, { speaking });
          needRender = true;
        }
      }
    });

    renderMembers();
  }, 150);
}

function showScreen(name) {
  $$('.screen').forEach(s => s.classList.remove('active'));
  $(`#screen-${name}`).classList.add('active');
}

function updateCtrlButtons() {
  $('#btn-mic').classList.toggle('muted', isMuted);
  $('#btn-mic').textContent = isMuted ? '🔇' : '🎤';
  $('#btn-deaf').classList.toggle('muted', isDeafened);
  $('#btn-deaf').textContent = isDeafened ? '🔈' : '🔊';
  $('#btn-ptt').classList.toggle('active', isPTTMode);
}

function updateUrl(roomCode) {
  const url = new URL(window.location);
  url.searchParams.set('room', roomCode);
  window.history.replaceState({}, '', url);
}

function copyInviteLink() {
  const roomCode = getCurrentRoom();
  const url = new URL(window.location.origin + window.location.pathname);
  url.searchParams.set('room', roomCode);
  navigator.clipboard.writeText(url.toString()).then(() => {
    const btn = $('#btn-copy-link');
    btn.textContent = '✅';
    setTimeout(() => { btn.textContent = '📋'; }, 1500);
  }).catch(() => {});
}

let lastMembersHtml = '';
function renderMembers() {
  const list = $('#members-list');
  const members = getAllMembers();
  $('#members-count').textContent = members.size;

  let html = '';
  members.forEach((m, peerId) => {
    const initials = m.name.substring(0, 2).toUpperCase();
    const vuPercent = Math.min(100, Math.round((m.volume || 0) * 200));
    const speaking = m.speaking ? ' speaking' : '';

    html += `<li class="member${speaking}">
      <div class="member-avatar${speaking}">${initials}
        <div class="vu-bar"><div class="vu-fill" style="width:${peerId === 'local' ? vuPercent : (m.speaking ? 60 : 0)}%"></div></div>
      </div>
      <span class="member-name">${m.name}${peerId === 'local' ? ' (ты)' : ''}</span>
      ${m.muted ? '<span class="member-muted">🔇</span>' : ''}
    </li>`;
  });

  if (html !== lastMembersHtml) {
    list.innerHTML = html;
    lastMembersHtml = html;
  }
}

let lastLogCount = 0;
function renderEventLog() {
  const log = $('#event-log');
  const entries = getEventLog();

  if (entries.length === lastLogCount) return;

  while (lastLogCount < entries.length) {
    const e = entries[lastLogCount];
    const div = document.createElement('div');
    div.className = 'log-entry ' + e.type;
    div.innerHTML = `<span class="time">${e.time}</span>${e.message}`;
    log.appendChild(div);
    lastLogCount++;
  }

  log.scrollTop = log.scrollHeight;
}

function renderFileTransfers() {
  const container = $('#file-transfers');
  const transfers = getAllTransfers();
  let html = '';

  transfers.forEach((t) => {
    const progress = getTransferProgress(t);
    const speed = getTransferSpeed(t);
    const eta = getTransferETA(t);
    const percent = Math.round(progress * 100);

    html += `<div class="file-transfer">
      <div class="ft-header">
        <span class="ft-name">${t.direction === 'out' ? '📤' : '📥'} ${t.fileName}</span>
        <span class="ft-info">${formatBytes(t.direction === 'out' ? t.offset : t.receivedSize)} / ${formatBytes(t.fileSize)}</span>
      </div>
      <div class="ft-bar"><div class="ft-fill" style="width:${percent}%"></div></div>
      <div class="ft-header">
        <span class="ft-info">${formatSpeed(speed)} · ${formatETA(eta)}</span>
        <div class="ft-actions">
          <button data-action="pause" data-id="${t.id}">${t.paused ? '▶️' : '⏸'}</button>
          <button data-action="cancel" data-id="${t.id}">✕</button>
        </div>
      </div>
    </div>`;
  });

  container.innerHTML = html;

  container.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const action = e.target.dataset.action;
      const id = e.target.dataset.id;
      const transfer = getTransfer(id);
      if (!transfer) return;
      if (action === 'pause') {
        transfer.paused = !transfer.paused;
        broadcastToAll({ type: 'file-pause', transferId: id });
      } else if (action === 'cancel') {
        transfer.cancelled = true;
        broadcastToAll({ type: 'file-cancel', transferId: id });
        removeTransfer(id);
      }
      renderFileTransfers();
    });
  });
}

async function leaveRoom() {
  broadcastToAll({ type: 'leave', name: getLocalName() });

  getAllMembers().forEach((m, peerId) => {
    if (peerId === 'local') return;
    if (m.conn) try { m.conn.close(); } catch(e) {}
    if (m.dataConn) try { m.dataConn.close(); } catch(e) {}
    if (m.audioElement) removeAudioElement(m.audioElement);
  });

  stopMicrophone();
  stopScreenShare();
  clearAllReconnects();
  clearAllTransfers();

  if (vuInterval) { clearInterval(vuInterval); vuInterval = null; }

  if (peer) { try { peer.destroy(); } catch(e) {} peer = null; }

  clearRoom();
  isMuted = false;
  isDeafened = false;
  isPTTActive = false;
  isPTTMode = false;
  isHost = false;
  joined = false;
  lastMembersHtml = '';
  lastLogCount = 0;

  window.history.replaceState({}, '', window.location.pathname);
  showScreen('join');
}

init();

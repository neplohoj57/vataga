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
  formatBytes, formatSpeed, formatETA, prepareChunk, handleIncomingChunk,
  assembleFile, clearAllTransfers, CHUNK_SIZE
} from './files.js';
import {
  isPolitePeer, scheduleReconnect, clearReconnect, resetReconnectAttempts,
  restartIce, setupConnectionMonitor, clearAllReconnects
} from './reconnect.js';

let peer = null;
let isMuted = false;
let isDeafened = false;
let isPTTActive = false;
let isPTTMode = false;
let isVAMode = false;
let vaThreshold = 30;
let vuInterval = null;
let fileInput = null;

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
    if (isVAMode) isPTTMode = false;
    updateCtrlButtons();
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
    broadcastMessage({ type: 'screen-stopped' });
  });
}

function checkUrlRoom() {
  const params = new URLSearchParams(window.location.search);
  const room = params.get('room');
  if (room) {
    $('#input-room').value = room;
  }
}

async function joinRoom(isCreate) {
  const name = $('#input-name').value.trim() || 'Аноним';
  let roomCode = $('#input-room').value.trim();

  if (!roomCode && isCreate) {
    roomCode = generateRoomCode();
  }
  if (!roomCode) {
    roomCode = generateRoomCode();
  }

  roomCode = roomCode.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (roomCode.length < 2) roomCode = generateRoomCode();

  setLocalName(name);
  setCurrentRoom(roomCode);

  showScreen('room');
  $('#room-code-display').textContent = roomCode;
  addLocalMember();
  logEvent('join', `${name} зашёл в комнату`);
  renderMembers();
  renderEventLog();

  try {
    const stream = await captureMicrophone();
    const peerId = 'vataga-' + roomCode + '-' + generateRoomCode().toLowerCase();
    setLocalPeerId(peerId);

    peer = createPeer(peerId);

    peer.on('open', (id) => {
      setLocalPeerId(id);
      const fullId = getFullRoomId(roomCode);
      const conn = peer.connect(fullId, {
        metadata: { name, type: 'room-join' },
        serialization: 'json',
        reliable: true
      });
      conn.on('open', () => {
        conn.send({ type: 'join', name, peerId: id });
      });
      conn.on('data', (data) => handleControlData(conn, data));
      conn.on('close', () => {});
      conn.on('error', (e) => console.warn('Control conn error:', e));
    });

    peer.on('connection', (conn) => {
      handleIncomingConnection(conn);
    });

    peer.on('call', (call) => {
      handleIncomingCall(call);
    });

    peer.on('disconnected', () => {
      console.warn('PeerJS disconnected, attempting reconnect...');
      setTimeout(() => {
        if (peer && !peer.destroyed) {
          try { peer.reconnect(); } catch(e) {}
        }
      }, 2000);
    });

    peer.on('error', (err) => {
      console.error('PeerJS error:', err.type, err);
      if (err.type === 'unavailable-id') {
        const newId = 'vataga-' + roomCode + '-' + generateRoomCode().toLowerCase();
        setLocalPeerId(newId);
        peer = createPeer(newId);
      }
    });

    startVuMeter();
    updateUrl(roomCode);
  } catch (e) {
    console.error('Failed to join room:', e);
    logEvent('leave', 'Ошибка подключения: ' + e.message);
    renderEventLog();
  }
}

function handleIncomingConnection(conn) {
  conn.on('open', () => {
    const peerId = conn.peer;
    const meta = conn.metadata || {};
    const name = meta.name || 'Аноним';

    if (!getMember(peerId)) {
      addMember(peerId, name);
      logEvent('join', `${name} зашёл в комнату`);
      renderMembers();
      renderEventLog();

      const localStream = getLocalStream();
      if (localStream) {
        callPeer(peer, peerId, localStream, { name: getLocalName() });
      }
    }

    updateMember(peerId, { conn });

    if (isScreenSharing()) {
      const screenStream = getScreenStream();
      if (screenStream) {
        try {
          peer.call(peerId, screenStream, { metadata: { type: 'screen', name: getLocalName() } });
        } catch(e) {}
      }
    }

    conn.on('data', (data) => handlePeerData(peerId, data));
    conn.on('close', () => handlePeerDisconnect(peerId));
    conn.on('error', () => handlePeerDisconnect(peerId));
  });
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
  if (localStream) {
    call.answer(localStream);
  } else {
    call.answer();
  }

  call.on('stream', (stream) => {
    handleRemoteStream(peerId, stream);
  });

  call.on('close', () => {
    console.log('Call closed with', peerId);
  });

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

function handleControlData(conn, data) {
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

        const dc = connectToPeer(peer, m.peerId, { name: getLocalName(), type: 'data' });
        setupDataConnection(m.peerId, dc);
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
    const { peerId, name } = data;
    removeMember(peerId);
    logEvent('leave', `${name} вышел из комнаты`);
    renderMembers();
    renderEventLog();
  }
}

function handlePeerData(peerId, data) {
  if (!data || typeof data !== 'object') return;

  if (data.type === 'file-meta') {
    const transfer = createIncomingTransfer(peerId, data);
    renderFileTransfers();
    return;
  }

  if (data.type === 'file-chunk') {
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
    return;
  }

  if (data.type === 'file-cancel') {
    const transfer = getTransfer(data.transferId);
    if (transfer) {
      transfer.cancelled = true;
      removeTransfer(transfer.id);
      renderFileTransfers();
    }
    return;
  }

  if (data.type === 'file-pause') {
    const transfer = getTransfer(data.transferId);
    if (transfer) {
      transfer.paused = !transfer.paused;
      renderFileTransfers();
    }
    return;
  }

  if (data.type === 'mute-status') {
    updateMember(peerId, { muted: data.muted });
    renderMembers();
    logEvent('mute', `${getMember(peerId)?.name || 'Аноним'} ${data.muted ? 'замутился' : 'размутился'}`);
    renderEventLog();
  }

  if (data.type === 'screen-stopped') {
    hideRemoteScreenShare(peerId);
  }
}

function handlePeerDisconnect(peerId) {
  const member = getMember(peerId);
  if (member) {
    const name = member.name;
    removeMember(peerId);
    logEvent('leave', `${name} вышел из комнаты`);
    renderMembers();
    renderEventLog();
  }
}

function setupDataConnection(peerId, dc) {
  dc.on('open', () => {
    updateMember(peerId, { dataConn: dc });
  });

  dc.on('data', (data) => {
    handlePeerData(peerId, data);
  });

  dc.on('close', () => {
    handlePeerDisconnect(peerId);
  });

  dc.on('error', (e) => {
    console.warn('Data channel error:', e);
  });
}

function addLocalMember() {
  const name = getLocalName();
  addMember('local', name);
}

function broadcastMessage(msg) {
  getAllMembers().forEach((m, peerId) => {
    if (peerId === 'local') return;
    if (m.conn && m.conn.open) {
      try { m.conn.send(msg); } catch(e) {}
    }
    if (m.dataConn && m.dataConn.open) {
      try { m.dataConn.send(msg); } catch(e) {}
    }
  });
}

function broadcastData(msg) {
  getAllMembers().forEach((m, peerId) => {
    if (peerId === 'local') return;
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
  broadcastData({ type: 'mute-status', muted: isMuted });
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
  broadcastMessage({ type: 'screen-stopped' });
  logEvent('file', `${getLocalName()} остановил демонстрацию экрана`);
  renderEventLog();
}

function updateScreenShareUI(active) {
  const panel = $('#screen-share-panel');
  const btn = $('#btn-screen');
  panel.style.display = active ? 'flex' : 'none';
  btn.classList.toggle('active', active);
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
    const tracks = video.srcObject.getTracks();
    tracks.forEach(t => t.stop());
    video.srcObject = null;
  }
  updateScreenShareUI(false);
}

function closeOverlay() {
  const overlay = $('#screen-overlay');
  overlay.style.display = 'none';
  const video = $('#screen-overlay-video');
  if (video.srcObject) {
    video.srcObject.getTracks().forEach(t => t.stop());
    video.srcObject = null;
  }
}

async function handleFileSelect(e) {
  const files = Array.from(e.target.files);
  if (!files.length) return;

  for (const file of files) {
    sendFile(file);
  }
  fileInput.value = '';
}

async function sendFile(file) {
  const transfer = createOutgoingTransfer('all', file);

  broadcastData({
    type: 'file-meta',
    transferId: transfer.id,
    fileName: file.name,
    fileSize: file.size
  });

  logEvent('file', `Отправка файла: ${file.name} (${formatBytes(file.size)})`);
  renderEventLog();
  renderFileTransfers();

  const peers = [];
  getAllMembers().forEach((m, peerId) => {
    if (peerId === 'local') return;
    const dc = m.dataConn || m.conn;
    if (dc && dc.open) peers.push({ peerId, dc });
  });

  if (peers.length === 0) {
    logEvent('file', 'Нет подключённых участников для отправки');
    renderEventLog();
    removeTransfer(transfer.id);
    renderFileTransfers();
    return;
  }

  for (const { peerId, dc } of peers) {
    sendFileToPeer(transfer, file, dc, peerId);
  }
}

async function sendFileToPeer(transfer, file, dc, peerId) {
  const t = { ...transfer, offset: 0, peerId };

  while (t.offset < file.size) {
    if (t.cancelled) {
      dc.send({ type: 'file-cancel', transferId: t.id });
      return;
    }

    while (t.paused) {
      await sleep(200);
    }

    const end = Math.min(t.offset + CHUNK_SIZE, file.size);
    const chunk = file.slice(t.offset, end);
    const buffer = await chunk.arrayBuffer();

    try {
      dc.send({
        type: 'file-chunk',
        transferId: t.id,
        chunk: buffer
      });
    } catch(e) {
      console.warn('Send chunk error:', e);
      await sleep(500);
      continue;
    }

    t.offset = end;
    transfer.offset = end;
    renderFileTransfers();

    await sleep(10);
  }

  logEvent('file', `Файл отправлен: ${file.name}`);
  renderEventLog();
  removeTransfer(transfer.id);
  renderFileTransfers();
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 100);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function startVuMeter() {
  vuInterval = setInterval(() => {
    const vol = getVolume();
    updateMember('local', { volume: vol, speaking: vol > 0.05 });

    if (isVAMode && !isPTTMode) {
      const threshold = vaThreshold / 100;
      if (vol > threshold && isMuted) {
        toggleMute();
      } else if (vol < threshold * 0.5 && !isMuted && !isPTTMode) {
        setTimeout(() => {
          if (getVolume() < threshold * 0.5 && !isMuted) toggleMute();
        }, 300);
      }
    }

    getAllMembers().forEach((m, peerId) => {
      if (peerId === 'local') return;
      const el = m.audioElement;
      if (el) {
        const speaking = !el.paused && el.currentTime > 0;
        updateMember(peerId, { speaking });
      }
    });

    renderMembers();
  }, 100);
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

function renderMembers() {
  const list = $('#members-list');
  const members = getAllMembers();
  $('#members-count').textContent = members.size;

  list.innerHTML = '';
  members.forEach((m, peerId) => {
    const li = document.createElement('li');
    li.className = 'member';
    if (m.speaking) li.classList.add('speaking');

    const initials = m.name.substring(0, 2).toUpperCase();
    const vuPercent = Math.min(100, Math.round((m.volume || 0) * 200));

    li.innerHTML = `
      <div class="member-avatar ${m.speaking ? 'speaking' : ''}">${initials}
        <div class="vu-bar"><div class="vu-fill" style="width:${peerId === 'local' ? vuPercent : (m.speaking ? 60 : 0)}%"></div></div>
      </div>
      <span class="member-name">${m.name}${peerId === 'local' ? ' (ты)' : ''}</span>
      ${m.muted ? '<span class="member-muted">🔇</span>' : ''}
    `;
    list.appendChild(li);
  });
}

function renderEventLog() {
  const log = $('#event-log');
  const entries = getEventLog();
  log.innerHTML = '';
  entries.forEach(e => {
    const div = document.createElement('div');
    div.className = 'log-entry ' + e.type;
    div.innerHTML = `<span class="time">${e.time}</span>${e.message}`;
    log.appendChild(div);
  });
  log.scrollTop = log.scrollHeight;
}

function renderFileTransfers() {
  const container = $('#file-transfers');
  const transfers = getAllTransfers();
  container.innerHTML = '';

  transfers.forEach((t) => {
    const progress = getTransferProgress(t);
    const speed = getTransferSpeed(t);
    const eta = getTransferETA(t);
    const percent = Math.round(progress * 100);

    const div = document.createElement('div');
    div.className = 'file-transfer';
    div.innerHTML = `
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
    `;
    container.appendChild(div);
  });

  container.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const action = e.target.dataset.action;
      const id = e.target.dataset.id;
      const transfer = getTransfer(id);
      if (!transfer) return;

      if (action === 'pause') {
        transfer.paused = !transfer.paused;
        broadcastData({ type: 'file-pause', transferId: id });
      } else if (action === 'cancel') {
        transfer.cancelled = true;
        broadcastData({ type: 'file-cancel', transferId: id });
        removeTransfer(id);
      }
      renderFileTransfers();
    });
  });
}

async function leaveRoom() {
  broadcastMessage({ type: 'leave', name: getLocalName() });

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

  if (vuInterval) {
    clearInterval(vuInterval);
    vuInterval = null;
  }

  if (peer) {
    try { peer.destroy(); } catch(e) {}
    peer = null;
  }

  clearRoom();
  isMuted = false;
  isDeafened = false;
  isPTTActive = false;
  isPTTMode = false;

  window.history.replaceState({}, '', window.location.pathname);
  showScreen('join');
}

init();

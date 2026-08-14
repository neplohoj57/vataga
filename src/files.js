const CHUNK_SIZE = 32 * 1024; // 32 KB
const MAX_CONCURRENT = 3;

let transfers = new Map();
let transferIdCounter = 0;

export function generateTransferId() {
  return 'ft-' + (++transferIdCounter) + '-' + Date.now().toString(36);
}

export function createOutgoingTransfer(peerId, file) {
  const id = generateTransferId();
  const transfer = {
    id,
    direction: 'out',
    peerId,
    fileName: file.name,
    fileSize: file.size,
    file,
    offset: 0,
    paused: false,
    cancelled: false,
    startTime: Date.now(),
    speed: 0,
    chunkIndex: 0
  };
  transfers.set(id, transfer);
  return transfer;
}

export function createIncomingTransfer(peerId, meta) {
  const id = meta.transferId || generateTransferId();
  const transfer = {
    id,
    direction: 'in',
    peerId,
    fileName: meta.fileName,
    fileSize: meta.fileSize,
    receivedSize: 0,
    chunks: [],
    paused: false,
    cancelled: false,
    startTime: Date.now(),
    speed: 0,
    writePosition: 0
  };
  transfers.set(id, transfer);
  return transfer;
}

export function getTransfer(id) {
  return transfers.get(id);
}

export function getAllTransfers() {
  return transfers;
}

export function removeTransfer(id) {
  transfers.delete(id);
}

export function getTransferProgress(transfer) {
  if (transfer.direction === 'out') {
    return transfer.offset / transfer.fileSize;
  }
  return transfer.receivedSize / transfer.fileSize;
}

export function getTransferSpeed(transfer) {
  const elapsed = (Date.now() - transfer.startTime) / 1000;
  if (elapsed < 0.1) return 0;
  const bytes = transfer.direction === 'out' ? transfer.offset : transfer.receivedSize;
  return bytes / elapsed;
}

export function getTransferETA(transfer) {
  const speed = getTransferSpeed(transfer);
  if (speed < 1) return Infinity;
  const remaining = transfer.direction === 'out'
    ? transfer.fileSize - transfer.offset
    : transfer.fileSize - transfer.receivedSize;
  return remaining / speed;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' Б';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' КБ';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' МБ';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' ГБ';
}

export function formatSpeed(bytesPerSec) {
  return formatBytes(bytesPerSec) + '/с';
}

export function formatETA(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return Math.ceil(seconds) + 'с';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'м ' + Math.ceil(seconds % 60) + 'с';
  return Math.floor(seconds / 3600) + 'ч ' + Math.floor((seconds % 3600) / 60) + 'м';
}

export function prepareChunk(transfer) {
  if (transfer.paused || transfer.cancelled) return null;
  if (transfer.offset >= transfer.file.size) return null;

  const end = Math.min(transfer.offset + CHUNK_SIZE, transfer.file.size);
  const chunk = transfer.file.slice(transfer.offset, end);
  transfer.offset = end;
  transfer.chunkIndex++;
  return chunk;
}

export function handleIncomingChunk(transfer, chunk) {
  if (transfer.cancelled) return false;
  transfer.chunks.push(chunk);
  transfer.receivedSize += chunk.byteLength || chunk.size || 0;
  return transfer.receivedSize >= transfer.fileSize;
}

export function assembleFile(transfer) {
  return new Blob(transfer.chunks, { type: 'application/octet-stream' });
}

export function clearAllTransfers() {
  transfers.clear();
}

export { CHUNK_SIZE, MAX_CONCURRENT };

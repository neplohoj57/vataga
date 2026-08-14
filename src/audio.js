const AUDIO_CONSTRAINTS_DEFAULT = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  sampleRate: 48000,
  channelCount: 2
};

let localStream = null;
let audioContext = null;
let analyser = null;
let micSource = null;
let dataArray = null;

export async function captureMicrophone(constraints = {}) {
  const cons = { ...AUDIO_CONSTRAINTS_DEFAULT, ...constraints };
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: cons, video: false });
    setupAnalyser();
    return localStream;
  } catch (e) {
    console.error('captureMicrophone error:', e);
    throw e;
  }
}

function setupAnalyser() {
  if (!localStream) return;
  audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.5;
  micSource = audioContext.createMediaStreamSource(localStream);
  micSource.connect(analyser);
  dataArray = new Uint8Array(analyser.frequencyBinCount);
}

export function getVolume() {
  if (!analyser || !dataArray) return 0;
  analyser.getByteFrequencyData(dataArray);
  let sum = 0;
  for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
  return sum / dataArray.length / 255;
}

export function muteMic() {
  if (localStream) {
    localStream.getAudioTracks().forEach(t => { t.enabled = false; });
  }
}

export function unmuteMic() {
  if (localStream) {
    localStream.getAudioTracks().forEach(t => { t.enabled = true; });
  }
}

export function isMicMuted() {
  if (!localStream) return true;
  const track = localStream.getAudioTracks()[0];
  return track ? !track.enabled : true;
}

export function getLocalStream() {
  return localStream;
}

export async function applyAudioConstraints(opts) {
  if (!localStream) return;
  const track = localStream.getAudioTracks()[0];
  if (!track) return;
  try {
    await track.applyConstraints({
      echoCancellation: opts.echoCancellation,
      noiseSuppression: opts.noiseSuppression,
      autoGainControl: opts.autoGainControl
    });
  } catch (e) {
    console.warn('applyConstraints failed:', e);
  }
}

export function stopMicrophone() {
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (micSource) {
    micSource.disconnect();
    micSource = null;
  }
  if (audioContext && audioContext.state !== 'closed') {
    audioContext.close();
    audioContext = null;
  }
  analyser = null;
  dataArray = null;
}

export function createAudioElement(stream) {
  const audio = document.createElement('audio');
  audio.srcObject = stream;
  audio.autoplay = true;
  audio.playsInline = true;
  document.body.appendChild(audio);
  return audio;
}

export function removeAudioElement(audio) {
  if (audio) {
    audio.srcObject = null;
    audio.remove();
  }
}

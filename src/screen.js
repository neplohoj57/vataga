let screenStream = null;
let screenTrack = null;

export async function startScreenShare() {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        cursor: 'always',
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30, max: 30 }
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: 48000
      },
      preferCurrentTab: false,
      selfBrowserSurface: 'include',
      systemAudio: 'include'
    });

    screenTrack = screenStream.getVideoTracks()[0];
    screenTrack.onended = () => {
      stopScreenShare();
      window.dispatchEvent(new CustomEvent('screen-share-stopped'));
    };

    return screenStream;
  } catch (e) {
    if (e.name === 'NotAllowedError') {
      console.log('Screen share cancelled by user');
      return null;
    }
    console.error('startScreenShare error:', e);
    throw e;
  }
}

export function getScreenStream() {
  return screenStream;
}

export function getScreenTrack() {
  return screenTrack;
}

export function stopScreenShare() {
  if (screenStream) {
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
    screenTrack = null;
  }
}

export function isScreenSharing() {
  return screenStream !== null;
}

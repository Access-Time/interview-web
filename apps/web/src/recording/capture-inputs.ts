export type RecordingCaptureSource = "camera" | "screen";

export function stopMediaStream(stream: MediaStream | null | undefined): void {
  if (!stream) {
    return;
  }
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

export async function acquireCameraStream(): Promise<MediaStream> {
  return await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: { facingMode: "user" },
  });
}

function attachMicrophone(screen: MediaStream, microphone: MediaStream): void {
  for (const track of microphone.getTracks()) {
    const canAddAudio =
      track.kind === "audio" && typeof screen.addTrack === "function";
    if (canAddAudio) {
      screen.addTrack(track);
    } else {
      track.stop();
    }
  }
}

export async function acquireScreenStream(): Promise<MediaStream> {
  const screen = await navigator.mediaDevices.getDisplayMedia({
    audio: true,
    video: true,
  });
  try {
    const microphone = await navigator.mediaDevices.getUserMedia({
      audio: true,
    });
    attachMicrophone(screen, microphone);
  } catch {
    // Screen recording can continue without a microphone.
  }
  return screen;
}

export function listenForTrackEnded(
  stream: MediaStream,
  onEnded: () => void
): () => void {
  const tracks = stream.getTracks?.() ?? [];
  for (const track of tracks) {
    track.addEventListener?.("ended", onEnded);
  }
  return () => {
    for (const track of tracks) {
      track.removeEventListener?.("ended", onEnded);
    }
  };
}

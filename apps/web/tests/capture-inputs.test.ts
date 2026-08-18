import { afterEach, expect, it, vi } from "vitest";
import {
  acquireCameraStream,
  acquireScreenStream,
  listenForTrackEnded,
  stopMediaStream,
} from "../src/recording/capture-inputs";

function fakeTrack(kind: MediaStreamTrack["kind"]) {
  return {
    addEventListener: vi.fn(),
    kind,
    removeEventListener: vi.fn(),
    stop: vi.fn(),
  } as unknown as MediaStreamTrack;
}

function fakeStream(tracks: MediaStreamTrack[]): MediaStream {
  const stream = {
    addTrack: vi.fn(),
    getAudioTracks: () => tracks.filter((track) => track.kind === "audio"),
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((track) => track.kind === "video"),
  };
  return stream as unknown as MediaStream;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it("requests the user-facing camera and microphone", async () => {
  const camera = fakeStream([fakeTrack("video"), fakeTrack("audio")]);
  const getUserMedia = vi.fn().mockResolvedValue(camera);
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia },
  });
  await expect(acquireCameraStream()).resolves.toBe(camera);
  expect(getUserMedia).toHaveBeenCalledWith({
    audio: true,
    video: { facingMode: "user" },
  });
});

it("requests a display stream and attaches microphone audio", async () => {
  const screenVideo = fakeTrack("video");
  const micAudio = fakeTrack("audio");
  const micVideo = fakeTrack("video");
  const screen = fakeStream([screenVideo]);
  const microphone = fakeStream([micAudio, micVideo]);
  const getDisplayMedia = vi.fn().mockResolvedValue(screen);
  const getUserMedia = vi.fn().mockResolvedValue(microphone);
  vi.stubGlobal("navigator", {
    mediaDevices: { getDisplayMedia, getUserMedia },
  });
  await expect(acquireScreenStream()).resolves.toBe(screen);
  expect(getDisplayMedia).toHaveBeenCalledWith({
    audio: false,
    video: true,
  });
  expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
  expect(screen.addTrack).toHaveBeenCalledWith(micAudio);
  expect(micVideo.stop).toHaveBeenCalledOnce();
});

it("keeps the screen stream when the microphone is unavailable", async () => {
  const screen = fakeStream([fakeTrack("video")]);
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getDisplayMedia: vi.fn().mockResolvedValue(screen),
      getUserMedia: vi.fn().mockRejectedValue(new Error("mic denied")),
    },
  });
  await expect(acquireScreenStream()).resolves.toBe(screen);
});

it("stops every track on a capture stream", () => {
  const video = fakeTrack("video");
  const audio = fakeTrack("audio");
  stopMediaStream(fakeStream([video, audio]));
  expect(video.stop).toHaveBeenCalledOnce();
  expect(audio.stop).toHaveBeenCalledOnce();
});

it("notifies when a screen video track ends", () => {
  const video = fakeTrack("video");
  const audio = fakeTrack("audio");
  const onEnded = vi.fn();
  const stopListening = listenForTrackEnded(
    fakeStream([video, audio]),
    onEnded
  );
  expect(video.addEventListener).toHaveBeenCalledWith("ended", onEnded);
  expect(audio.addEventListener).not.toHaveBeenCalled();
  stopListening();
  expect(video.removeEventListener).toHaveBeenCalledWith("ended", onEnded);
  expect(audio.removeEventListener).not.toHaveBeenCalled();
});

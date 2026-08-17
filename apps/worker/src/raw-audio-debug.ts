import { AudioStream, RemoteAudioTrack, type Room } from "@livekit/rtc-node";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

import {
  createTelephoneBoundaryRuntime,
} from "@voice-agent/runtime";

type BoundaryRuntime = ReturnType<typeof createTelephoneBoundaryRuntime>;

/**
 * Polls for the owner-authorized, session-scoped debug grant and records only
 * the remote caller track. The ordinary path never opens a file.
 */
export async function recordAuthorizedCallerAudio(options: {
  readonly boundaries: Pick<BoundaryRuntime, "claimRawAudioCapture">;
  readonly pollIntervalMs?: number;
  readonly room: Room;
  readonly sessionId: string;
  readonly stop: Promise<void>;
}): Promise<"captured" | "not-authorized" | "stopped"> {
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  let grant:
    | { readonly artifactPath: string; readonly expiresAt: string }
    | undefined;

  while (grant === undefined) {
    const claimed = await options.boundaries.claimRawAudioCapture({
      actor: "voice-agent",
      sessionId: options.sessionId,
    });
    if (claimed.decision === "accepted") {
      grant = claimed;
      break;
    }
    if ((await waitForPollOrStop(options.stop, pollIntervalMs)) === "stopped") {
      return "not-authorized";
    }
  }

  const expiresAt = new Date(grant.expiresAt).getTime();
  let track = findRemoteCallerTrack(options.room);
  while (track === undefined && Date.now() < expiresAt) {
    if ((await waitForPollOrStop(options.stop, pollIntervalMs)) === "stopped") {
      return "stopped";
    }
    track = findRemoteCallerTrack(options.room);
  }
  if (track === undefined) return "stopped";

  await mkdir(dirname(grant.artifactPath), { mode: 0o700, recursive: true });
  const artifact = await open(grant.artifactPath, "wx", 0o600);
  const stream = new AudioStream(track, { numChannels: 1, sampleRate: 48_000 });
  const reader = stream.getReader();
  const expirationTimer = setTimeout(
    () => void reader.cancel("raw-audio-debug-expired"),
    Math.max(0, expiresAt - Date.now()),
  );
  void options.stop
    .then(() => reader.cancel("telephone-session-ended"))
    .catch(() => undefined);
  try {
    while (Date.now() < expiresAt) {
      const next = await reader.read();
      if (next.done) break;
      const samples = next.value.data;
      await artifact.write(
        Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength),
      );
    }
    return "captured";
  } finally {
    clearTimeout(expirationTimer);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    await artifact.close();
  }
}

function findRemoteCallerTrack(room: Room): RemoteAudioTrack | undefined {
  for (const participant of room.remoteParticipants.values()) {
    for (const publication of participant.trackPublications.values()) {
      if (publication.track instanceof RemoteAudioTrack) {
        return publication.track;
      }
    }
  }
  return undefined;
}

async function waitForPollOrStop(
  stop: Promise<void>,
  pollIntervalMs: number,
): Promise<"poll" | "stopped"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      stop.then(() => "stopped" as const),
      new Promise<"poll">((resolve) => {
        timer = setTimeout(() => resolve("poll"), pollIntervalMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

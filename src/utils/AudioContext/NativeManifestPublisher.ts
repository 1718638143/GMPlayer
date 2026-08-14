/**
 * NativeManifestPublisher — publishes the full playback manifest to the Rust
 * backend so it can plan and resolve track advances entirely on its own.
 *
 * This replaces the bounded-window approach of `NativeQueuePrefill`. The old
 * design pre-resolved N upcoming CDN URLs in JS; that could not survive a
 * frozen Android WebView for longer than the window (and, for random mode, was
 * hard-capped at depth 1 because duplicate `origOrder` entries broke the
 * backend's identity matching). The manifest carries stable *identities* only —
 * no temporary URLs — and the backend resolves each track when it needs it.
 *
 * Division of responsibility:
 * - JS owns policy: list contents, traversal order, play mode, credentials.
 * - Rust owns execution: when to resolve, what to play next, retry on failure.
 *
 * Tauri-only. The web backend accepts and ignores these messages (playback is
 * owned by the browser media host and JS is never frozen), so callers do not
 * need to branch — but we still gate here to avoid pointless IPC.
 */

import { isTauri } from "@/utils/tauri/core/runtime";
import type {
  NativeManifestEntry,
  NativePlaybackManifest,
  TrackIdentity,
} from "@/utils/tauri/audio/protocol";
import { NativeRustSound, setPlannerRevisionObserver } from "@/utils/tauri/audio/nativeRustSound";
// Import stores directly to avoid circular dependency through barrel exports
import useMusicDataStore from "@/store/musicData";
import useListenTogetherStore from "@/store/listenTogether";
import type { SongData } from "@/store/musicTypes";

const IS_DEV = import.meta.env?.DEV ?? false;

const REVISION_STORAGE_KEY = "gmplayer:nativeManifestRevision";

/**
 * Monotonic manifest revision. The backend rejects anything not strictly newer.
 *
 * This MUST survive a WebView reload: the Rust `Player` lives for the whole
 * process, so a module-scoped counter restarting at 1 while the backend holds
 * (say) 12 would make it reject every publish — and every clear — for the rest
 * of the session, with the planner still advancing the pre-reload list.
 * Persisting it keeps the sequence monotonic across reloads and restarts.
 */
let revision = (() => {
  try {
    const stored = Number(localStorage.getItem(REVISION_STORAGE_KEY));
    return Number.isFinite(stored) && stored > 0 ? stored : 0;
  } catch {
    return 0;
  }
})();

const nextRevision = (): number => {
  revision += 1;
  try {
    localStorage.setItem(REVISION_STORAGE_KEY, String(revision));
  } catch {
    /* quota/unavailable — in-memory monotonicity still holds this session */
  }
  return revision;
};

/** Last published fingerprint, to skip redundant IPC on unrelated store churn. */
let lastFingerprint = "";
let publishScheduled = false;
let pendingForce = false;

/**
 * Adopt a revision the backend reports. Covers the case where our persisted
 * counter is behind the live backend (cleared storage, a different profile):
 * without this the backend would reject everything we publish.
 */
export const reconcileNativeManifestRevision = (backendRevision: number): void => {
  if (!Number.isFinite(backendRevision) || backendRevision <= revision) return;
  revision = backendRevision;
  try {
    localStorage.setItem(REVISION_STORAGE_KEY, String(revision));
  } catch {
    /* best effort */
  }
  // Our last-published state no longer describes what the backend holds.
  lastFingerprint = "";
};

// Adopt the backend's revision as soon as it reports one, so a reload can never
// leave us publishing manifests the backend rejects as stale.
setPlannerRevisionObserver(reconcileNativeManifestRevision);

/**
 * Stable seed for random traversal. Regenerated whenever a *new* shuffle is
 * wanted (mode switch, list replace) rather than per publish, so re-publishing
 * the same list does not reshuffle under the user.
 */
let randomSeed = Math.floor(Math.random() * 0xffffffff);

export const reseedRandomTraversal = (): void => {
  randomSeed = Math.floor(Math.random() * 0xffffffff);
  lastFingerprint = "";
};

/**
 * Derive a backend identity from a store song.
 *
 * Every song in this app is Netease-sourced, so identity is the numeric id.
 * (`TrackIdentity` also has a `local` variant for on-disk files; nothing in the
 * current store produces one.) Returning `null` means "not plannable" — the
 * manifest omits it rather than shipping an entry the resolver would always
 * fail on.
 */
const toIdentity = (song: SongData): TrackIdentity | null => {
  if (!song) return null;
  const id = Number(song.id);
  if (!Number.isFinite(id) || id <= 0) return null;
  return { provider: "netease", id: String(id) };
};

/**
 * Build the traversal order for the current mode.
 *
 * - normal/single: natural list order.
 * - random: a full shuffled permutation with the *current* track pinned to slot
 *   0, so the backend can walk an entire pass without JS and without repeats.
 *   The backend reshuffles subsequent passes itself from `randomSeed`.
 */
const buildOrder = (length: number, cursorPosition: number, mode: string): number[] => {
  const order = Array.from({ length }, (_, i) => i);
  if (mode !== "random" || length <= 1) return order;

  // Fisher-Yates seeded off randomSeed so a re-publish of the same list is
  // stable. Math.random() here would reshuffle on every unrelated store write.
  let state = randomSeed | 1;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
  for (let i = length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  if (cursorPosition >= 0) {
    const at = order.indexOf(cursorPosition);
    if (at > 0) [order[0], order[at]] = [order[at], order[0]];
  }
  return order;
};

/**
 * Publish the current playlist as a manifest.
 *
 * Coalesced: callers fire this from many independent store mutations (adding a
 * song, moving the cursor, changing mode), and a single user action commonly
 * triggers several in one tick. Only the last one in a tick does any work, and
 * `force` is sticky across the batch so a forced publish is never swallowed by
 * a plain one scheduled after it.
 */
export const publishNativeManifest = (options: { force?: boolean } = {}): void => {
  if (!isTauri()) return;
  pendingForce ||= options.force === true;
  if (publishScheduled) return;
  publishScheduled = true;
  // Microtask, not a timer: the manifest still lands within the same task that
  // mutated the store, so nothing can observe a stale backend cursor.
  queueMicrotask(flushNativeManifest);
};

/**
 * Cheap change probe.
 *
 * Runs over the playlist *without allocating* the entry objects, so the common
 * "nothing material moved" case costs one pass and no garbage. Previously the
 * dedup happened only after building every entry (plus a 3-allocation artist
 * join per song) and an N-element fingerprint string — i.e. the expensive part
 * ran even when the result was discarded.
 *
 * Two independent 32-bit hashes are combined rather than one: a collision here
 * means a skipped publish, which would leave the backend planning on a stale
 * list, so ~2^-64 is the right risk level, whereas a single 32-bit hash is not.
 */
const playlistSignature = (
  playlists: SongData[],
  mode: string,
  cursorSongId: number | null | undefined,
): string => {
  let h1 = 0x811c9dc5;
  let h2 = 5381;
  let counted = 0;
  for (let index = 0; index < playlists.length; index++) {
    const id = Number(playlists[index]?.id);
    // Mirror `toIdentity`: unplannable songs are omitted from entries, so they
    // must not contribute to the signature either.
    if (!Number.isFinite(id) || id <= 0) continue;
    counted++;
    h1 = Math.imul(h1 ^ id, 0x01000193) >>> 0;
    h1 = Math.imul(h1 ^ index, 0x01000193) >>> 0;
    h2 = ((Math.imul(h2, 33) ^ id) >>> 0) + index;
    h2 >>>= 0;
  }
  const seed = mode === "random" ? randomSeed : 0;
  return `${mode}|${seed}|${cursorSongId ?? "?"}|${counted}|${h1.toString(36)}:${h2.toString(36)}`;
};

const flushNativeManifest = (): void => {
  publishScheduled = false;
  const force = pendingForce;
  pendingForce = false;

  const sound = window.$player;
  if (!(sound instanceof NativeRustSound) || sound.isDestroyed()) return;

  const music = useMusicDataStore();
  const listenTogether = useListenTogetherStore();

  // Personal FM and listen-together transitions need live JS (server picks the
  // next track), so the backend must not plan ahead. Clear any stale manifest.
  if (music.persistData.personalFmMode || listenTogether.isInRoom) {
    clearNativeManifest();
    return;
  }

  const playlists = music.persistData.playlists;
  if (!playlists?.length) {
    clearNativeManifest();
    return;
  }

  const entries: NativeManifestEntry[] = [];
  let cursorPosition = -1;
  const cursorSongId = music.playingSongId ?? music.getPlaySongData?.id;

  // Probe before building: bail on the no-op path without allocating entries.
  const signature = playlistSignature(playlists, music.persistData.playSongMode, cursorSongId);
  if (!force && signature === lastFingerprint) return;

  for (let index = 0; index < playlists.length; index++) {
    const song = playlists[index];
    const identity = toIdentity(song);
    if (!identity) continue;
    if (cursorSongId !== null && cursorSongId !== undefined && song.id === cursorSongId) {
      cursorPosition = entries.length;
    }
    entries.push({
      identity,
      playlistIndex: index,
      title: song.name ?? null,
      artist: Array.isArray(song.artist)
        ? song.artist
            .map((a: any) => a?.name)
            .filter(Boolean)
            .join(" / ") || null
        : null,
      durationMs: null,
      fee: Number.isFinite(song.fee) ? Number(song.fee) : null,
      hasPc: song.pc !== null && song.pc !== undefined,
    });
  }

  if (!entries.length) {
    clearNativeManifest();
    return;
  }

  const mode = music.persistData.playSongMode;
  const cursorIdentity = cursorPosition >= 0 ? entries[cursorPosition].identity : null;
  const cursorIndex = cursorPosition >= 0 ? entries[cursorPosition].playlistIndex : 0;

  lastFingerprint = signature;

  const manifest: NativePlaybackManifest = {
    schemaVersion: 1,
    revision: nextRevision(),
    entries,
    order: buildOrder(entries.length, cursorPosition, mode),
    cursorIdentity,
    cursorIndex,
    // `single` repeats one track; list repeat is the normal/random default.
    mode: mode === "single" ? "single" : mode === "random" ? "random" : "normal",
    repeatList: true,
    randomSeed,
  };

  sound.setNativeManifest(manifest);
  if (IS_DEV) {
    console.log(
      `[NativeManifest] published rev=${manifest.revision}, ${entries.length} entries, ` +
        `mode=${manifest.mode}, cursor=${cursorIndex}`,
    );
  }
};

/**
 * Drop the backend manifest, returning advancement to the JS-driven path.
 *
 * Unconditional: after a WebView reload `lastFingerprint` is empty even though
 * the backend still holds a manifest from the previous session, so guarding on
 * it would leave the planner advancing a stale list (e.g. through personal FM).
 */
export const clearNativeManifest = (): void => {
  if (!isTauri()) return;
  const sound = window.$player;
  if (!(sound instanceof NativeRustSound) || sound.isDestroyed()) return;
  lastFingerprint = "";
  const cleared = nextRevision();
  sound.clearNativeManifest(cleared);
  if (IS_DEV) console.log(`[NativeManifest] cleared at rev=${cleared}`);
};

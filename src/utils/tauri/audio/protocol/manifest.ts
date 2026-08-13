/**
 * Native manifest / planner protocol.
 *
 * The manifest is how the frontend hands the Rust planner an authoritative
 * view of the playlist; the planner then owns advancement and resolution.
 * See `src-tauri/crates/audio-backend/src/player/{manifest,planner}.rs`.
 */

/**
 * Stable track identity — deliberately independent of any resolved CDN URL,
 * which expires and gets re-resolved. All frontend/backend reconciliation
 * happens on this, never on `local:<url>`.
 */
export type TrackIdentity =
  | { provider: "netease"; id: string }
  | { provider: "local"; path: string };

export interface NativeManifestEntry {
  identity: TrackIdentity;
  /** UI-facing index. May be sparse; never used for advancement ordering. */
  playlistIndex: number;
  title?: string | null;
  artist?: string | null;
  durationMs?: number | null;
  /** Netease `fee`, so Rust can apply the same VIP pre-check as the frontend. */
  fee?: number | null;
  /** Cloud-uploaded (`pc`) tracks bypass the VIP pre-check. */
  hasPc?: boolean;
}

export interface NativePlaybackManifest {
  schemaVersion: 1;
  /** Monotonic. The backend rejects anything not strictly newer. */
  revision: number;
  entries: NativeManifestEntry[];
  /**
   * Explicit traversal order as indices into `entries`. Empty means natural
   * order. Random mode ships a full permutation so both sides agree without
   * duplicating a PRNG; the backend reshuffles later passes from `randomSeed`.
   */
  order: number[];
  cursorIdentity: TrackIdentity | null;
  cursorIndex: number;
  mode: "normal" | "single" | "random";
  repeatList: boolean;
  randomSeed?: number | null;
}

/**
 * Endpoints/credentials the Rust resolver needs to call the same deployed
 * NeteaseCloudMusicApi the frontend uses. Never persisted, never logged.
 */
export interface NativeResolverConfig {
  ncmBaseUrl?: string | null;
  unmBaseUrl?: string | null;
  unmEnabled: boolean;
  cookie?: string | null;
  level?: string | null;
}

export type NativePlannerPlaybackState = "stopped" | "loading" | "playing" | "paused" | "ended";

export interface NativePlannerStatus {
  manifestRevision: number;
  cursorIdentity: TrackIdentity | null;
  cursorIndex: number | null;
  playbackState: NativePlannerPlaybackState;
  preparedIdentity: TrackIdentity | null;
  failureCount: number;
  exhausted: boolean;
}

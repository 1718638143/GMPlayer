/**
 * NativeResolverConfigSync — hands the Rust backend the endpoints and
 * credentials it needs to resolve playback URLs itself.
 *
 * The backend does NOT reimplement the Netease API: all weapi/eapi crypto,
 * anonymous_token and cookie signing stay in the deployed
 * NeteaseCloudMusicApi service the frontend already talks to. From Rust it is
 * a plain HTTP GET against the same base URL. This module is the single place
 * that decides *which* base URL and *which* credentials that is, so the two
 * runtimes can never drift apart.
 *
 * What is duplicated in Rust is only the five-rule fallback policy from
 * `resolveSongUrl.ts` (level, VIP pre-check, trial detection, UNM fallback,
 * kuwo proxy) — see `player/source_resolver.rs`, which unit-tests the same
 * cases.
 *
 * Secrets: the cookie is sent over the local Tauri IPC only. The backend never
 * logs or persists it.
 */

import { isTauri } from "@/utils/tauri/core/runtime";
import type { NativeResolverConfig } from "@/utils/tauri/audio/protocol";
import { NativeRustSound } from "@/utils/tauri/audio/nativeRustSound";
import useSettingDataStore from "@/store/settingData";
import { userStore } from "@/store";

const IS_DEV = import.meta.env?.DEV ?? false;

let lastSerialized = "";

/**
 * Resolve the NCM API base the same way `utils/request.ts` does.
 *
 * In dev the frontend talks to Vite's same-origin proxy (`/api/ncm`), which
 * Rust cannot use — it has no dev server. Fall back to the configured upstream
 * so native resolution works in `pnpm dev` too.
 */
const resolveNcmBase = (): string | null => {
  const configured = import.meta.env.VITE_MUSIC_API as string | undefined;
  return configured?.trim() || null;
};

const resolveUnmBase = (): string | null => {
  const configured = import.meta.env.VITE_UNM_API as string | undefined;
  return configured?.trim() || null;
};

/**
 * Push the current resolver config to the backend. Idempotent — skips IPC when
 * nothing changed. Call on startup, login/logout and quality-setting changes.
 */
export const syncNativeResolverConfig = (options: { force?: boolean } = {}): void => {
  if (!isTauri()) return;
  const sound = window.$player;
  if (!(sound instanceof NativeRustSound) || sound.isDestroyed()) return;

  const setting = useSettingDataStore();
  const user = userStore();

  const unmBaseUrl = resolveUnmBase();
  const config: NativeResolverConfig = {
    ncmBaseUrl: resolveNcmBase(),
    unmBaseUrl,
    unmEnabled: Boolean(unmBaseUrl) && Boolean(setting.useUnmServer),
    cookie: user.cookie ?? null,
    level: setting.songLevel || "exhigh",
  };

  const serialized = JSON.stringify(config);
  if (!options.force && serialized === lastSerialized) return;
  lastSerialized = serialized;

  sound.setNativeResolverConfig(config);
  if (IS_DEV) {
    // Never log the cookie itself — only whether one is present.
    console.log(
      `[NativeResolver] config synced: ncm=${Boolean(config.ncmBaseUrl)}, ` +
        `unm=${config.unmEnabled}, level=${config.level}, auth=${Boolean(config.cookie)}`,
    );
  }
};

/** Force a re-push on the next call (e.g. after the player is recreated). */
export const invalidateNativeResolverConfig = (): void => {
  lastSerialized = "";
};

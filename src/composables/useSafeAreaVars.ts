const SAFE_AREA_VARS: Record<string, string> = {
  "--app-safe-area-top": "env(safe-area-inset-top, 0px)",
  "--app-safe-area-bottom": "env(safe-area-inset-bottom, 0px)",
  "--app-safe-area-left": "env(safe-area-inset-left, 0px)",
  "--app-safe-area-right": "env(safe-area-inset-right, 0px)",
};

/**
 * Expose CSS safe-area insets on every runtime.
 *
 * `env(safe-area-inset-*)` resolves to zero on ordinary desktop browsers,
 * while covering installed PWAs, mobile browsers and Tauri mobile webviews.
 */
export function useSafeAreaVars(): void {
  if (typeof document === "undefined") return;

  for (const [key, value] of Object.entries(SAFE_AREA_VARS)) {
    document.documentElement.style.setProperty(key, value);
  }
}

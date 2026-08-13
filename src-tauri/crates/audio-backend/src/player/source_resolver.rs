//! Just-in-time playback source resolution.
//!
//! This is a deliberate *port of the frontend policy*, not a reimplementation
//! of the Netease API. All crypto (weapi/eapi, anonymous_token, cookie signing)
//! stays in the deployed NeteaseCloudMusicApi service that the frontend already
//! talks to — from here it is a plain HTTP GET. The only thing duplicated is the
//! five-rule fallback policy in `src/utils/AudioContext/resolveSongUrl.ts`:
//!
//! 1. quality level selection
//! 2. VIP pre-check (`fee == 1 || fee == 4`, and not cloud-uploaded) → UNM first
//! 3. trial-clip detection (`jd-musicrep-ts` in the URL) → treat as no URL
//! 4. UNM fallback when NCM yields nothing
//! 5. kuwo.cn → prefer `proxyUrl`
//!
//! The policy half (`plan_resolution`, `classify_ncm_url`, `pick_unm_url`) is
//! pure and unit-tested against the same cases as the TS implementation. Only
//! `resolve_blocking` performs I/O, and it runs on a blocking worker — never on
//! the player loop and never anywhere near an audio callback.
//!
//! Secrets discipline: the cookie is sent as a header, is never logged, and
//! never enters a persisted snapshot or an emitted event.

use std::time::{Duration, Instant};

use crate::types::{NativeManifestEntry, NativeResolverConfig, TrackIdentity};

/// Assumed lifetime of a resolved Netease CDN URL. Their links are typically
/// valid for ~20 minutes; we treat them as good for 10 with a safety margin so
/// a one-ahead source prepared now is still playable when the current track
/// ends. Expiry is advisory — a 403 at play time re-resolves regardless.
const ASSUMED_URL_TTL: Duration = Duration::from_secs(600);

/// Network budget per attempt. Kept tight: a hung resolve must not stall the
/// hand-off to the next track past the point where the current one ends.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const READ_TIMEOUT: Duration = Duration::from_secs(15);

/// Where a resolved URL came from. Mirrors the TS `source` field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceOrigin {
    Ncm,
    Unm,
    LocalFile,
}

#[derive(Debug, Clone)]
pub struct ResolvedSource {
    pub identity: TrackIdentity,
    pub uri: String,
    pub origin: SourceOrigin,
    resolved_at: Instant,
    ttl: Option<Duration>,
}

impl ResolvedSource {
    pub fn local(identity: TrackIdentity, path: String) -> Self {
        Self {
            identity,
            uri: path,
            origin: SourceOrigin::LocalFile,
            resolved_at: Instant::now(),
            // A path on disk does not expire.
            ttl: None,
        }
    }

    pub fn remote(identity: TrackIdentity, uri: String, origin: SourceOrigin) -> Self {
        Self {
            identity,
            uri,
            origin,
            resolved_at: Instant::now(),
            ttl: Some(ASSUMED_URL_TTL),
        }
    }

    /// Whether this source is past its assumed lifetime and should be
    /// re-resolved before use.
    pub fn is_stale(&self) -> bool {
        match self.ttl {
            Some(ttl) => self.resolved_at.elapsed() >= ttl,
            None => false,
        }
    }
}

/// Classification of a resolve failure, used by the planner's bounded
/// skip/retry policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolveErrorKind {
    /// Network/5xx/timeout — worth one retry.
    Transient,
    /// 401/403 — credentials rejected.
    Auth,
    /// Resolved to nothing playable (region-locked, taken down, trial only).
    Unavailable,
    /// Local file is gone.
    LocalMissing,
    /// Resolver is not configured (no API base URL).
    NotConfigured,
}

#[derive(Debug, Clone)]
pub struct ResolveError {
    pub kind: ResolveErrorKind,
    /// Already redacted — safe to log and to send to the frontend.
    pub message: String,
}

impl ResolveError {
    fn new(kind: ResolveErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn is_retryable(&self) -> bool {
        self.kind == ResolveErrorKind::Transient
    }
}

impl std::fmt::Display for ResolveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.kind, self.message)
    }
}

// ── Pure policy ──────────────────────────────────────────────────

/// What the resolver should try, in order. Mirrors the branch structure of
/// `resolveSongUrl` so the two stay comparable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolutionPlan {
    /// Local path: nothing to fetch.
    LocalPath,
    /// Normal path — NCM first, UNM as fallback when enabled.
    NcmThenUnm { unm_enabled: bool },
    /// VIP/paid pre-check hit: skip NCM entirely and go straight to UNM.
    UnmOnly,
}

/// Decide the resolution strategy for `entry`. Pure — no I/O, no allocation
/// beyond the returned enum.
pub fn plan_resolution(
    entry: &NativeManifestEntry,
    config: &NativeResolverConfig,
) -> ResolutionPlan {
    if matches!(entry.identity, TrackIdentity::Local { .. }) {
        return ResolutionPlan::LocalPath;
    }

    let unm_enabled = config.unm_enabled
        && config
            .unm_base_url
            .as_deref()
            .is_some_and(|base| !base.trim().is_empty());

    // VIP pre-check: fee=1 (VIP) or fee=4 (paid album), and not a
    // cloud-uploaded track (`pc` present bypasses the check).
    let vip_locked = matches!(entry.fee, Some(1) | Some(4)) && !entry.has_pc;
    if unm_enabled && vip_locked {
        return ResolutionPlan::UnmOnly;
    }

    ResolutionPlan::NcmThenUnm { unm_enabled }
}

/// Normalize and validate a URL returned by `/song/url/v1`. Returns `None`
/// when the response carries nothing playable — including the trial-clip case,
/// which reports a real URL that is only a preview.
pub fn classify_ncm_url(raw: Option<&str>) -> Option<String> {
    let raw = raw?.trim();
    if raw.is_empty() {
        return None;
    }
    let upgraded = upgrade_to_https(raw);
    // Trial/preview clip — the frontend nullifies these so UNM can take over.
    if upgraded.contains("jd-musicrep-ts") {
        return None;
    }
    Some(upgraded)
}

/// Apply the kuwo proxy rule to a UNM response.
pub fn pick_unm_url(url: Option<&str>, proxy_url: Option<&str>) -> Option<String> {
    let url = url?.trim();
    if url.is_empty() {
        return None;
    }
    let upgraded = upgrade_to_https(url);
    if upgraded.to_ascii_lowercase().contains("kuwo.cn") {
        if let Some(proxy) = proxy_url.map(str::trim).filter(|p| !p.is_empty()) {
            return Some(proxy.to_string());
        }
    }
    Some(upgraded)
}

fn upgrade_to_https(url: &str) -> String {
    match url.strip_prefix("http://") {
        Some(rest) => format!("https://{rest}"),
        None => url.to_string(),
    }
}

/// Join an API base with a path, tolerating a trailing slash on the base
/// (`VITE_MUSIC_API` carries one).
pub fn join_url(base: &str, path: &str) -> String {
    let base = base.trim().trim_end_matches('/');
    let path = path.trim_start_matches('/');
    format!("{base}/{path}")
}

/// Strip anything credential-shaped out of a string before it is logged or
/// emitted. Defence in depth: callers should not be putting cookies in error
/// text in the first place.
pub fn redact(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for part in text.split_whitespace() {
        let lower = part.to_ascii_lowercase();
        if lower.contains("music_u")
            || lower.contains("cookie")
            || lower.contains("csrf")
            || lower.contains("token")
        {
            out.push_str("[redacted]");
        } else {
            out.push_str(part);
        }
        out.push(' ');
    }
    out.trim_end().to_string()
}

// ── I/O ──────────────────────────────────────────────────────────

/// Resolve `entry` to a playable source. Blocking; call from
/// `spawn_blocking`, never from the player loop.
pub fn resolve_blocking(
    entry: &NativeManifestEntry,
    config: &NativeResolverConfig,
) -> Result<ResolvedSource, ResolveError> {
    match plan_resolution(entry, config) {
        ResolutionPlan::LocalPath => {
            let TrackIdentity::Local { path } = &entry.identity else {
                return Err(ResolveError::new(
                    ResolveErrorKind::Unavailable,
                    "local plan for a non-local identity",
                ));
            };
            if !std::path::Path::new(path).exists() {
                return Err(ResolveError::new(
                    ResolveErrorKind::LocalMissing,
                    "local file no longer exists",
                ));
            }
            Ok(ResolvedSource::local(entry.identity.clone(), path.clone()))
        }
        ResolutionPlan::UnmOnly => resolve_via_unm(entry, config),
        ResolutionPlan::NcmThenUnm { unm_enabled } => {
            let ncm_result = resolve_via_ncm(entry, config);
            match ncm_result {
                Ok(source) => Ok(source),
                Err(err) => {
                    // Auth failures are not something UNM can fix, but an
                    // unavailable/trial track is exactly what it is for.
                    if unm_enabled && err.kind != ResolveErrorKind::NotConfigured {
                        resolve_via_unm(entry, config).map_err(|unm_err| {
                            // Report the more actionable of the two.
                            if err.kind == ResolveErrorKind::Auth {
                                err
                            } else {
                                unm_err
                            }
                        })
                    } else {
                        Err(err)
                    }
                }
            }
        }
    }
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(CONNECT_TIMEOUT)
        .timeout_read(READ_TIMEOUT)
        .build()
}

fn resolve_via_ncm(
    entry: &NativeManifestEntry,
    config: &NativeResolverConfig,
) -> Result<ResolvedSource, ResolveError> {
    let Some(base) = config
        .ncm_base_url
        .as_deref()
        .map(str::trim)
        .filter(|base| !base.is_empty())
    else {
        return Err(ResolveError::new(
            ResolveErrorKind::NotConfigured,
            "no NCM API base URL configured",
        ));
    };
    let Some(song_id) = entry.identity.netease_id() else {
        return Err(ResolveError::new(
            ResolveErrorKind::Unavailable,
            "identity is not a netease track",
        ));
    };
    let level = config.level.as_deref().unwrap_or("exhigh");

    let url = join_url(base, "song/url/v1");
    let mut request = agent()
        .get(&url)
        .query("id", song_id)
        .query("level", level)
        // The deployed API accepts `realIP`-style params and cookies; we only
        // need the cookie for VIP-quality entitlement.
        .set("X-Requested-With", "XMLHttpRequest");
    if let Some(cookie) = config
        .cookie
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty())
    {
        request = request.set("Cookie", cookie);
    }

    let body = send_and_read(request)?;
    let parsed: serde_json::Value = serde_json::from_str(&body)
        .map_err(|_| ResolveError::new(ResolveErrorKind::Transient, "malformed NCM JSON"))?;

    let raw_url = parsed
        .get("data")
        .and_then(|data| data.get(0))
        .and_then(|first| first.get("url"))
        .and_then(|url| url.as_str());

    match classify_ncm_url(raw_url) {
        Some(url) => Ok(ResolvedSource::remote(
            entry.identity.clone(),
            url,
            SourceOrigin::Ncm,
        )),
        None => Err(ResolveError::new(
            ResolveErrorKind::Unavailable,
            "NCM returned no playable URL",
        )),
    }
}

fn resolve_via_unm(
    entry: &NativeManifestEntry,
    config: &NativeResolverConfig,
) -> Result<ResolvedSource, ResolveError> {
    if !config.unm_enabled {
        return Err(ResolveError::new(
            ResolveErrorKind::NotConfigured,
            "UNM fallback is disabled",
        ));
    }
    let Some(base) = config
        .unm_base_url
        .as_deref()
        .map(str::trim)
        .filter(|base| !base.is_empty())
    else {
        return Err(ResolveError::new(
            ResolveErrorKind::NotConfigured,
            "no UNM base URL configured",
        ));
    };
    let Some(song_id) = entry.identity.netease_id() else {
        return Err(ResolveError::new(
            ResolveErrorKind::Unavailable,
            "identity is not a netease track",
        ));
    };

    let url = join_url(base, "match");
    let request = agent()
        .get(&url)
        .query("id", song_id)
        .query("server", "qq,pyncmd");

    let body = send_and_read(request)?;
    let parsed: serde_json::Value = serde_json::from_str(&body)
        .map_err(|_| ResolveError::new(ResolveErrorKind::Transient, "malformed UNM JSON"))?;

    let code_ok = parsed
        .get("code")
        .and_then(|code| code.as_i64())
        .is_some_and(|code| code == 200);
    if !code_ok {
        return Err(ResolveError::new(
            ResolveErrorKind::Unavailable,
            "UNM reported no match",
        ));
    }

    let data = parsed.get("data");
    let candidate = data.and_then(|d| d.get("url")).and_then(|u| u.as_str());
    let proxy = data
        .and_then(|d| d.get("proxyUrl"))
        .and_then(|u| u.as_str());

    match pick_unm_url(candidate, proxy) {
        Some(url) => Ok(ResolvedSource::remote(
            entry.identity.clone(),
            url,
            SourceOrigin::Unm,
        )),
        None => Err(ResolveError::new(
            ResolveErrorKind::Unavailable,
            "UNM returned no playable URL",
        )),
    }
}

fn send_and_read(request: ureq::Request) -> Result<String, ResolveError> {
    match request.call() {
        Ok(response) => response.into_string().map_err(|_| {
            ResolveError::new(ResolveErrorKind::Transient, "failed to read response body")
        }),
        Err(ureq::Error::Status(status, _)) => {
            let kind = match status {
                401 | 403 => ResolveErrorKind::Auth,
                404 | 410 => ResolveErrorKind::Unavailable,
                _ => ResolveErrorKind::Transient,
            };
            Err(ResolveError::new(kind, format!("HTTP {status}")))
        }
        // `ureq::Error::Transport` carries the URL, which for a signed CDN link
        // can embed a token — never surface it verbatim.
        Err(ureq::Error::Transport(_)) => Err(ResolveError::new(
            ResolveErrorKind::Transient,
            "transport error",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn netease_entry(fee: Option<i64>, has_pc: bool) -> NativeManifestEntry {
        NativeManifestEntry {
            identity: TrackIdentity::Netease { id: "123".into() },
            playlist_index: 0,
            title: None,
            artist: None,
            duration_ms: None,
            fee,
            has_pc,
        }
    }

    fn config(unm_enabled: bool) -> NativeResolverConfig {
        NativeResolverConfig {
            ncm_base_url: Some("https://ncm.example.com/".into()),
            unm_base_url: Some("https://unm.example.com/".into()),
            unm_enabled,
            cookie: Some("MUSIC_U=secret".into()),
            level: Some("exhigh".into()),
        }
    }

    // ── Rule 2: VIP pre-check ────────────────────────────────────

    #[test]
    fn vip_and_paid_album_go_straight_to_unm() {
        for fee in [1, 4] {
            assert_eq!(
                plan_resolution(&netease_entry(Some(fee), false), &config(true)),
                ResolutionPlan::UnmOnly,
                "fee={fee} must skip NCM"
            );
        }
    }

    #[test]
    fn cloud_uploaded_tracks_bypass_the_vip_precheck() {
        assert_eq!(
            plan_resolution(&netease_entry(Some(1), true), &config(true)),
            ResolutionPlan::NcmThenUnm { unm_enabled: true },
            "a `pc` track is playable through NCM even when fee=1"
        );
    }

    #[test]
    fn free_tracks_use_the_normal_path() {
        assert_eq!(
            plan_resolution(&netease_entry(Some(0), false), &config(true)),
            ResolutionPlan::NcmThenUnm { unm_enabled: true }
        );
        assert_eq!(
            plan_resolution(&netease_entry(None, false), &config(true)),
            ResolutionPlan::NcmThenUnm { unm_enabled: true }
        );
    }

    #[test]
    fn vip_precheck_is_skipped_when_unm_is_unavailable() {
        // Disabled by setting...
        assert_eq!(
            plan_resolution(&netease_entry(Some(1), false), &config(false)),
            ResolutionPlan::NcmThenUnm { unm_enabled: false },
            "without UNM there is nothing to pre-empt NCM with"
        );

        // ...and by having no endpoint at all.
        let mut cfg = config(true);
        cfg.unm_base_url = Some("   ".into());
        assert_eq!(
            plan_resolution(&netease_entry(Some(1), false), &cfg),
            ResolutionPlan::NcmThenUnm { unm_enabled: false }
        );
    }

    #[test]
    fn local_identities_never_hit_the_network() {
        let entry = NativeManifestEntry {
            identity: TrackIdentity::Local {
                path: "/music/a.flac".into(),
            },
            playlist_index: 3,
            title: None,
            artist: None,
            duration_ms: None,
            fee: Some(1),
            has_pc: false,
        };
        assert_eq!(
            plan_resolution(&entry, &config(true)),
            ResolutionPlan::LocalPath
        );
    }

    // ── Rule 3: trial-clip detection ─────────────────────────────

    #[test]
    fn trial_clips_are_treated_as_no_url() {
        assert_eq!(
            classify_ncm_url(Some("https://m8.music.126.net/jd-musicrep-ts/abc.mp3")),
            None,
            "a preview clip must fall through to UNM"
        );
    }

    #[test]
    fn ncm_urls_are_upgraded_to_https() {
        assert_eq!(
            classify_ncm_url(Some("http://m8.music.126.net/x/abc.mp3")).as_deref(),
            Some("https://m8.music.126.net/x/abc.mp3")
        );
    }

    #[test]
    fn empty_and_missing_ncm_urls_are_rejected() {
        assert_eq!(classify_ncm_url(None), None);
        assert_eq!(classify_ncm_url(Some("")), None);
        assert_eq!(classify_ncm_url(Some("   ")), None);
    }

    #[test]
    fn https_urls_are_left_alone() {
        assert_eq!(
            classify_ncm_url(Some("https://cdn.example.com/a.flac")).as_deref(),
            Some("https://cdn.example.com/a.flac")
        );
    }

    // ── Rule 5: kuwo proxy ───────────────────────────────────────

    #[test]
    fn kuwo_urls_prefer_the_proxy() {
        assert_eq!(
            pick_unm_url(
                Some("http://sycdn.kuwo.cn/song.mp3"),
                Some("https://proxy.example.com/song.mp3")
            )
            .as_deref(),
            Some("https://proxy.example.com/song.mp3")
        );
    }

    #[test]
    fn kuwo_without_a_proxy_still_returns_the_direct_url() {
        assert_eq!(
            pick_unm_url(Some("http://sycdn.kuwo.cn/song.mp3"), None).as_deref(),
            Some("https://sycdn.kuwo.cn/song.mp3")
        );
        assert_eq!(
            pick_unm_url(Some("http://sycdn.kuwo.cn/song.mp3"), Some("  ")).as_deref(),
            Some("https://sycdn.kuwo.cn/song.mp3"),
            "a blank proxy must not win over the real URL"
        );
    }

    #[test]
    fn non_kuwo_urls_ignore_the_proxy() {
        assert_eq!(
            pick_unm_url(
                Some("https://cdn.qq.com/song.mp3"),
                Some("https://proxy.example.com/song.mp3")
            )
            .as_deref(),
            Some("https://cdn.qq.com/song.mp3")
        );
    }

    #[test]
    fn unm_url_matching_is_case_insensitive() {
        assert_eq!(
            pick_unm_url(
                Some("https://SYCDN.KUWO.CN/song.mp3"),
                Some("https://proxy.example.com/song.mp3")
            )
            .as_deref(),
            Some("https://proxy.example.com/song.mp3")
        );
    }

    // ── URL joining ──────────────────────────────────────────────

    #[test]
    fn join_url_tolerates_trailing_and_leading_slashes() {
        for base in [
            "https://api.example.com",
            "https://api.example.com/",
            "  https://api.example.com/  ",
        ] {
            assert_eq!(
                join_url(base, "song/url/v1"),
                "https://api.example.com/song/url/v1",
                "base={base:?}"
            );
        }
        assert_eq!(
            join_url("https://api.example.com/", "/match"),
            "https://api.example.com/match"
        );
    }

    // ── Expiry ───────────────────────────────────────────────────

    #[test]
    fn local_sources_never_go_stale() {
        let source = ResolvedSource::local(
            TrackIdentity::Local {
                path: "/a.flac".into(),
            },
            "/a.flac".into(),
        );
        assert!(!source.is_stale());
    }

    #[test]
    fn fresh_remote_sources_are_not_stale() {
        let source = ResolvedSource::remote(
            TrackIdentity::Netease { id: "1".into() },
            "https://cdn/x".into(),
            SourceOrigin::Ncm,
        );
        assert!(!source.is_stale());
    }

    // ── Secrets ──────────────────────────────────────────────────

    #[test]
    fn redact_removes_credential_shaped_tokens() {
        let redacted = redact("failed for MUSIC_U=abc123 with csrf=zzz");
        assert!(!redacted.contains("abc123"), "cookie value leaked");
        assert!(!redacted.contains("zzz"), "csrf value leaked");
        assert!(redacted.contains("[redacted]"));
    }

    #[test]
    fn resolver_config_usability_requires_a_base_url() {
        assert!(config(true).is_usable());

        let mut cfg = config(true);
        cfg.ncm_base_url = None;
        assert!(!cfg.is_usable());

        cfg.ncm_base_url = Some("  ".into());
        assert!(!cfg.is_usable());
    }

    #[test]
    fn error_retryability_matches_classification() {
        assert!(ResolveError::new(ResolveErrorKind::Transient, "x").is_retryable());
        for kind in [
            ResolveErrorKind::Auth,
            ResolveErrorKind::Unavailable,
            ResolveErrorKind::LocalMissing,
            ResolveErrorKind::NotConfigured,
        ] {
            assert!(
                !ResolveError::new(kind, "x").is_retryable(),
                "{kind:?} must not be retried"
            );
        }
    }
}

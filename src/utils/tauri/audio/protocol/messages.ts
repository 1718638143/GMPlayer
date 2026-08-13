/**
 * Outbound protocol: the `AudioThreadMessage` union and its payload types.
 *
 * Mirrors the Rust `AudioThreadMessage` enum in
 * `src-tauri/crates/audio-backend/src/player/messages.rs`. A single
 * `audio_send_msg` command carries every one of these, AMLL-style, instead of
 * one Tauri command per playback action — keep both sides in lockstep.
 */
import type { NativePlaybackManifest, NativeResolverConfig } from "./manifest";

export interface SongData {
  type: "local" | "custom";
  filePath?: string;
  id?: string;
  songJsonData?: string;
  origOrder: number;
}

export interface AutoMixConfig {
  enabled: boolean;
  crossfadeDuration: number;
  bpmMatch: boolean;
  beatAlign: boolean;
  volumeNorm: boolean;
  smartCurve: boolean;
  transitionStyle: "linear" | "equalPower" | "sCurve";
  transitionEffects: boolean;
  vocalGuard: boolean;
}

export interface EqualizerBand {
  enabled?: boolean;
  filterType: "peaking" | "lowShelf" | "highShelf";
  frequency: number;
  gainDb: number;
  q: number;
}

export interface EqualizerConfig {
  enabled: boolean;
  preampDb?: number;
  bands?: EqualizerBand[];
}

export interface LimiterConfig {
  enabled: boolean;
  thresholdDb?: number;
  ceilingDb?: number;
  releaseMs?: number;
}

export interface DspConfig {
  enabled: boolean;
  inputGainDb?: number;
  equalizer?: EqualizerConfig;
  outputGainDb?: number;
  limiter?: LimiterConfig;
}

export type AudioThreadMessage =
  | { type: "resumeAudio" }
  | { type: "pauseAudio" }
  | { type: "resumeOrPauseAudio" }
  | { type: "seekAudio"; position: number; requestId?: number; expectedMusicId?: string }
  | { type: "jumpToSong"; songIndex: number }
  | { type: "jumpToSongAt"; songIndex: number; position: number }
  | { type: "prevSong" }
  | { type: "nextSong" }
  | { type: "nextSongGapless" }
  | {
      type: "setPlaylist";
      songs: SongData[];
      windowed?: boolean;
      playIndex?: number;
      initialPosition?: number;
      loadRequestId?: number;
    }
  | { type: "setVolume"; volume: number }
  | { type: "setVolumeRelative"; volume: number }
  | { type: "setAudioOutput"; name: string }
  | { type: "setAnalysis"; enabled: boolean }
  | { type: "setFFT"; enabled: boolean }
  | { type: "setFFTRange"; fromFreq: number; toFreq: number }
  | { type: "setEqualizer"; config: EqualizerConfig }
  | { type: "setDsp"; config: DspConfig }
  | { type: "syncStatus" }
  | { type: "close" }
  | { type: "setMediaControlsEnabled"; enabled: boolean }
  | { type: "automixSetEnabled"; enabled: boolean }
  | { type: "automixConfigure"; config: AutoMixConfig }
  | {
      type: "automixPrepareNext";
      currentIndex: number;
      nextIndex: number;
      nextSong: SongData;
      transitionId?: number | null;
    }
  | { type: "automixCancel" }
  | { type: "automixForceStart"; generation?: number | null }
  | { type: "automixCompleteNative"; generation: number; currentIndex: number; position: number }
  | { type: "setNativeManifest"; manifest: NativePlaybackManifest }
  | { type: "clearNativeManifest"; revision: number }
  | { type: "setNativeResolverConfig"; config: NativeResolverConfig }
  | { type: "setNativePlannerEnabled"; enabled: boolean }
  | { type: "syncNativePlannerStatus" };

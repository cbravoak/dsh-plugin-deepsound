/**
 * Sound presets and playback engine for dsh-plugin-deepsound.
 *
 * Every preset is SYNTHESIZED with the Web Audio API — no audio files ship with
 * the plugin. That avoids CSP problems entirely (the GUI is served over
 * http://127.0.0.1 with a sandbox CSP) and keeps the package tiny.
 *
 * A preset is a list of "voices": each voice is one oscillator with an envelope
 * and an optional frequency sweep. Playing a preset schedules all its voices on
 * a shared AudioContext at a common start time.
 *
 * Contract used by the client bundle:
 *   createSoundEngine()  -> engine
 *   engine.unlock()      -> resumes the AudioContext (call on a user gesture)
 *   engine.play(id, opts)-> Promise<void>  (never rejects; safe to fire-and-forget)
 *   engine.dispose()     -> releases the AudioContext
 *   engine.state         -> 'uninitialized' | 'ready' | 'blocked'
 */

/** Tone: [frequencyHz, startOffsetSec, durationSec, gain, waveType?] */
const P = (freq, at, dur, gain, type = 'sine', sweepTo = null) => ({
  freq,
  at,
  dur,
  gain,
  type,
  sweepTo,
})

/**
 * The preset table. Keys are stable ids persisted in the settings document.
 * `none` means "play nothing" and is handled before reaching the engine.
 */
export const SOUND_PRESETS = {
  /** Two-note ascending bell — the default "turn finished" cue. */
  chime: [P(880, 0, 0.42, 0.55), P(1318.5, 0.13, 0.55, 0.42)],
  /** Warm single bell with a long decay. */
  bell: [P(1046.5, 0, 0.9, 0.5), P(2093, 0, 0.55, 0.16)],
  /** Short bright "ding". */
  ding: [P(1567.98, 0, 0.28, 0.45), P(3135.96, 0, 0.14, 0.12)],
  /** Soft rounded pop for background completions. */
  pop: [P(520, 0, 0.09, 0.5, 'sine', 900)],
  /** Tiny UI blip. */
  blip: [P(1200, 0, 0.06, 0.35, 'triangle')],
  /** Marimba-like three-note phrase. */
  marimba: [
    P(523.25, 0, 0.22, 0.45, 'triangle'),
    P(783.99, 0.1, 0.22, 0.4, 'triangle'),
    P(1046.5, 0.2, 0.42, 0.35, 'triangle'),
  ],
  /** Piano-ish major third. */
  piano: [P(659.25, 0, 0.6, 0.42, 'triangle'), P(830.61, 0.02, 0.55, 0.34, 'triangle')],
  /** Urgent two-beat alarm for approvals and errors. */
  alarm: [
    P(1000, 0, 0.14, 0.5, 'square'),
    P(1000, 0.2, 0.14, 0.5, 'square'),
  ],
  /** Rising major triad — a positive confirmation. */
  success: [
    P(523.25, 0, 0.16, 0.42),
    P(659.25, 0.09, 0.16, 0.42),
    P(783.99, 0.18, 0.34, 0.45),
  ],
  /** Falling minor third — a negative outcome. */
  error: [P(440, 0, 0.2, 0.45, 'triangle'), P(349.23, 0.13, 0.42, 0.45, 'triangle')],
  /** Neutral two-tone attention cue. */
  notify: [P(1174.66, 0, 0.13, 0.42), P(880, 0.12, 0.28, 0.4)],
}

/** Preset ids offered in the settings UI, in display order. */
export const SOUND_IDS = ['none', ...Object.keys(SOUND_PRESETS)]

const MASTER_GAIN = 0.5

/**
 * Create the shared audio engine. Lazily constructs the AudioContext so merely
 * loading the plugin allocates no audio resources.
 * @returns the engine described in this file's header.
 */
export function createSoundEngine() {
  /** @type {AudioContext | null} */
  let audio = null
  let disposed = false
  /** Last time a sound actually played, for de-duplication. */
  let lastPlayedAt = 0

  const engine = {
    /** Current engine state, for the settings UI. */
    get state() {
      if (disposed) return 'disposed'
      if (audio === null) return 'uninitialized'
      return audio.state === 'running' ? 'ready' : 'blocked'
    },

    /**
     * Create or resume the AudioContext. Browsers only allow this during a user
     * gesture, so the plugin calls it from the first pointer/key event.
     * @returns whether the context is running afterwards.
     */
    async unlock() {
      if (disposed) return false
      try {
        audio ??= new AudioContext()
        if (audio.state === 'suspended') await audio.resume()
        return audio.state === 'running'
      } catch {
        return false
      }
    },

    /**
     * Play one preset. Fire-and-forget: never throws and never rejects, so it is
     * safe to call from event listeners and waterfall interceptors.
     * @param id - preset id; `none`, unknown ids and empty values play nothing.
     * @param opts - `{ volume?: 0..100, minGapMs?: number }`
     */
    async play(id, opts = {}) {
      if (disposed || id === undefined || id === null || id === '' || id === 'none') return
      const preset = SOUND_PRESETS[id]
      if (preset === undefined) return

      const volume = opts.volume === undefined ? 70 : opts.volume
      if (volume <= 0) return

      // Collapse accidental bursts: two identical cues within the gap play once.
      const now = Date.now()
      const gap = opts.minGapMs ?? 250
      if (now - lastPlayedAt < gap) return

      try {
        const running = await engine.unlock()
        if (!running || audio === null) return
        lastPlayedAt = now
        const master = audio.createGain()
        master.gain.value = MASTER_GAIN * (volume / 100)
        master.connect(audio.destination)
        const start = audio.currentTime + 0.01
        for (const voice of preset) {
          const osc = audio.createOscillator()
          const env = audio.createGain()
          osc.type = voice.type
          const t0 = start + voice.at
          const t1 = t0 + voice.dur
          osc.frequency.setValueAtTime(voice.freq, t0)
          if (voice.sweepTo !== null) {
            osc.frequency.exponentialRampToValueAtTime(voice.sweepTo, t1)
          }
          // Short attack avoids clicks; exponential decay sounds natural.
          env.gain.setValueAtTime(0.0001, t0)
          env.gain.exponentialRampToValueAtTime(Math.max(voice.gain, 0.0002), t0 + 0.012)
          env.gain.exponentialRampToValueAtTime(0.0001, t1)
          osc.connect(env)
          env.connect(master)
          osc.start(t0)
          osc.stop(t1 + 0.02)
        }
        // Release the master node once the longest voice finishes.
        const longest = preset.reduce((acc, v) => Math.max(acc, v.at + v.dur), 0)
        setTimeout(() => {
          try {
            master.disconnect()
          } catch {
            /* already gone */
          }
        }, (longest + 0.3) * 1000)
      } catch {
        /* audio unavailable; stay silent */
      }
    },

    /** Release audio resources. Idempotent. */
    dispose() {
      if (disposed) return
      disposed = true
      const closing = audio?.close()
      audio = null
      closing?.catch?.(() => {})
    },
  }

  return engine
}

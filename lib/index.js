/**
 * dsh-plugin-deepsound — node half.
 *
 * Declares the plugin's user configuration. The web client's "Sounds" settings
 * page edits this document; the browser half reads it and plays sounds.
 *
 * Every field is `.volatile()` so the settings service projects a form for the
 * `deepsound` entry (non-volatile entries get no namespace and no form).
 *
 * The node half deliberately provides no service: all playback happens in the
 * browser. This half exists to own the persisted configuration document.
 * @module dsh-plugin-deepsound
 */

import z from '@deepseek-ai/schemastery'

/** Cordis entry id from cordis.patch.yml — also the settings namespace. */
export const name = 'deepsound'

/** Required host services. */
export const inject = []

/**
 * Sound ids the browser engine knows how to synthesize. Kept in sync with the
 * client half's SOUND_IDS table; the settings page offers these as choices.
 */
export const SOUND_IDS = [
  'none',
  'chime',
  'bell',
  'ding',
  'pop',
  'blip',
  'marimba',
  'piano',
  'alarm',
  'success',
  'error',
  'notify',
  'work',
  'workLoop',
]

/** Event ids the browser engine can fire. Kept in sync with the client half. */
export const EVENT_IDS = [
  'turnComplete',
  'turnError',
  'approvalRequest',
  'userQuestion',
  'subagentComplete',
  'jobComplete',
  'sessionStart',
  'goalChanged',
  'turnProgress',
]

/**
 * Ready-made sound profiles. Each names the sound every event plays, so a user
 * can pick a whole behaviour in one click; the per-event fields below stay
 * editable afterwards for fine tuning.
 *
 * `moderate` covers the cues most people want; `complete` adds the chattier
 * lifecycle events; `silent` turns everything off.
 */
export const PROFILES = {
  moderate: {
    turnComplete: 'chime',
    turnError: 'error',
    approvalRequest: 'notify',
    userQuestion: 'bell',
    subagentComplete: 'none',
    jobComplete: 'none',
    sessionStart: 'none',
    goalChanged: 'none',
    turnProgress: 'work',
  },
  complete: {
    turnComplete: 'chime',
    turnError: 'error',
    approvalRequest: 'notify',
    userQuestion: 'bell',
    subagentComplete: 'pop',
    jobComplete: 'ding',
    sessionStart: 'blip',
    goalChanged: 'marimba',
    turnProgress: 'work',
  },
  silent: {
    turnComplete: 'none',
    turnError: 'none',
    approvalRequest: 'none',
    userQuestion: 'none',
    subagentComplete: 'none',
    jobComplete: 'none',
    sessionStart: 'none',
    goalChanged: 'none',
    turnProgress: 'none',
  },
}

/** Profile ids offered in the settings UI, in display order. */
export const PROFILE_IDS = ['moderate', 'complete', 'silent', 'custom']

/**
 * A sound-id field.
 *
 * `.volatile()` is REQUIRED: the settings service projects a form only from
 * fields with a volatile ancestor (`volatileForm` in dsh-settings), and an entry
 * whose schema projects nothing gets no settings namespace at all — the page
 * would silently never appear.
 * @param fallback - the default sound id.
 * @returns the schema node for one sound field.
 */
const soundId = (fallback) =>
  z
    .union(SOUND_IDS.map((id) => z.const(id)))
    .default(fallback)
    .volatile()

/**
 * The plugin's user configuration.
 *
 * Every field is `.volatile()` so the settings service serves the `deepsound`
 * namespace and the web client can render and edit it.
 */
export const Config = z
  .object({
    /**
     * Selected sound profile. `custom` means the per-event fields below are
     * authoritative; the other ids mirror their PROFILES entry into them.
     */
    profile: z
      .union(PROFILE_IDS.map((id) => z.const(id)))
      .default('moderate')
      .volatile(),
    /** Master switch for all interface sounds. */
    enabled: z.boolean().default(true).volatile(),
    /** Master volume, 0–100. */
    volume: z.number().step(5).min(0).max(100).default(70).volatile(),
    /** Suppress sounds while the window is not focused. */
    muteWhenUnfocused: z.boolean().default(false).volatile(),
    /** Fire a sound when an agent turn finishes successfully. */
    turnComplete: soundId('chime'),
    /** Fire a sound when a turn ends in an error. */
    turnError: soundId('error'),
    /** Fire a sound when a tool asks for approval. */
    approvalRequest: soundId('notify'),
    /** Fire a sound when the agent asks the user a question. */
    userQuestion: soundId('bell'),
    /** Fire a sound when a subagent finishes. */
    subagentComplete: soundId('none'),
    /** Fire a sound when a background job finishes. */
    jobComplete: soundId('none'),
    /** Fire a sound when a new session starts. */
    sessionStart: soundId('none'),
    /** Fire a sound when a goal's activation changes. */
    goalChanged: soundId('none'),
    /** Soft periodic pulse while one or more models are thinking or working. */
    turnProgress: soundId('work'),
  })
  .description('Interface and notification sounds')

/**
 * Mount the plugin's node half.
 * @param ctx - host plugin context.
 * @param config - the resolved configuration for this entry.
 */
export function apply(ctx, config) {
  // The settings document is owned by the settings service; this half only
  // declares the schema and records the active configuration for diagnostics.
  ctx.logger?.debug?.('deepsound: configuration loaded %o', config)
}

// The Loader selects module.default before registering the plugin. Keep Config
// on that selected object: named exports alone are invisible to SettingsForms.
export default { name, inject, Config, apply }

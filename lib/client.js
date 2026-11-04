/**
 * dsh-plugin-deepsound — browser half.
 *
 * Plays configurable sounds for interface and notification events, and adds a
 * "Sounds" section to Settings.
 *
 * Observation channels (verified against the shipped client; see
 * _inspect/CONTRACTS.md):
 *   - `ctx.uiSession.sessionStatus` store  -> turn finished (running true -> false)
 *   - `ctx.remote.$on('<event>', fn)`      -> approval, question, error, goal, session
 *
 * IMPORTANT: `approval/request` and `user-questions/request` are Cordis
 * waterfalls. This plugin only observes them, so it plays the cue and then
 * delegates with `return next()`. Returning a value would make this plugin the
 * answerer and break the real prompts.
 *
 * Every write goes through the ONE staged SettingsFormModel, so the page has a
 * single source of truth and a single Save button.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-deepsound',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const react = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    // ---------------------------------------------------------------------
    // Sound engine — synthesized presets, no shipped audio assets
    // ---------------------------------------------------------------------

    /** One oscillator voice: {freq, at, dur, gain, type, sweepTo}. */
    const P = (freq, at, dur, gain, type = 'sine', sweepTo = null) => ({
      freq,
      at,
      dur,
      gain,
      type,
      sweepTo,
    })

    /** Preset table; keys are persisted in the settings document. */
    const SOUND_PRESETS = {
      chime: [P(880, 0, 0.42, 0.55), P(1318.5, 0.13, 0.55, 0.42)],
      bell: [P(1046.5, 0, 0.9, 0.5), P(2093, 0, 0.55, 0.16)],
      ding: [P(1567.98, 0, 0.28, 0.45), P(3135.96, 0, 0.14, 0.12)],
      pop: [P(520, 0, 0.09, 0.5, 'sine', 900)],
      blip: [P(1200, 0, 0.06, 0.35, 'triangle')],
      marimba: [
        P(523.25, 0, 0.22, 0.45, 'triangle'),
        P(783.99, 0.1, 0.22, 0.4, 'triangle'),
        P(1046.5, 0.2, 0.42, 0.35, 'triangle'),
      ],
      piano: [P(659.25, 0, 0.6, 0.42, 'triangle'), P(830.61, 0.02, 0.55, 0.34, 'triangle')],
      alarm: [P(1000, 0, 0.14, 0.5, 'square'), P(1000, 0.2, 0.14, 0.5, 'square')],
      success: [
        P(523.25, 0, 0.16, 0.42),
        P(659.25, 0.09, 0.16, 0.42),
        P(783.99, 0.18, 0.34, 0.45),
      ],
      error: [P(440, 0, 0.2, 0.45, 'triangle'), P(349.23, 0.13, 0.42, 0.45, 'triangle')],
      notify: [P(1174.66, 0, 0.13, 0.42), P(880, 0.12, 0.28, 0.4)],
      // A low, restrained pulse for background model activity. Its low gain and
      // triangle wave keep it warm and deliberately unobtrusive.
      work: [P(164.81, 0, 0.28, 0.12, 'triangle', 196), P(246.94, 0.12, 0.22, 0.07, 'sine', 220)],
    }

    /** Sound ids offered in the UI, in display order. */
    const SOUND_CHOICES = [
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

    /** Human labels for the sound ids. */
    const SOUND_LABELS = {
      none: 'None',
      chime: 'Chime',
      bell: 'Bell',
      ding: 'Ding',
      pop: 'Pop',
      blip: 'Blip',
      marimba: 'Marimba',
      piano: 'Piano',
      alarm: 'Alarm',
      success: 'Success',
      error: 'Error',
      notify: 'Notify',
      work: 'Soft work pulse',
      workLoop: 'Working loop (333)',
    }

    // Compact copy of the user-supplied working loop, embedded so the plugin
    // works after installation without depending on a filesystem URL.
    const WORK_LOOP_AUDIO = 'data:audio/mp4;base64,AAAAHGZ0eXBNNEEgAAAAAE00QSBtcDQyaXNvbQAABA5tb292AAAAbG12aGQAAAAA5xD2RucQ9kYAALuAAADIAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAACoHRyYWsAAABcdGtoZAAAAAfnEPZG5xD2RgAAAAEAAAAAAADIAAAAAAAAAAAAAAAAAAEAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAjxtZGlhAAAAIG1kaGQAAAAA5xD2RucQ9kYAALuAAADIAAAAAAAAAAAiaGRscgAAAAAAAAAAc291bgAAAAAAAAAAAAAAAAAAAAAB8m1pbmYAAAAQc21oZAAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAABtnN0YmwAAAB2c3RzZAAAAAAAAAABAAAAZm1wNGEAAAAAAAAAAQAAAAAAAAAAAAIAEAAAAAC7gAAAAAAAM2VzZHMAAAAAA4CAgCIAAAAEgICAFEAUABgAAACbCAAA+gAFgICAAhGQBoCAgAECAAAAD3NidGQAAAAASTI0AAAAGHN0dHMAAAAAAAAAAQAAADIAAAQAAAAAKHN0c2MAAAAAAAAAAgAAAAEAAAAYAAAAAQAAAAMAAAACAAAAAQAAANxzdHN6AAAAAAAAAAAAAAAyAAAABgAAAE0AAADnAAAAtQAAAJAAAAB/AAAAiAAAAJsAAADBAAAAygAAAKQAAACkAAAAiQAAAH8AAACkAAAAiQAAAOoAAACtAAAAgwAAAHAAAABnAAAAxwAAAIYAAAB+AAAA5QAAAOgAAACHAAAAiwAAAIoAAACcAAAA4wAAAJQAAACPAAAA6gAAAIkAAABkAAAAawAAAPwAAAB1AAAAiwAAAIgAAACDAAAAvQAAAGQAAAB+AAAAeAAAAIMAAAB4AAAAMQAAAB4AAAAcc3RjbwAAAAAAAAADAAAQAAAAHeUAACxLAAAA+nVkdGEAAADybWV0YQAAAAAAAAAiaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAAxGlsc3QAAAC8LS0tLQAAABxtZWFuAAAAAGNvbS5hcHBsZS5pVHVuZXMAAAAUbmFtZQAAAABpVHVuU01QQgAAAIRkYXRhAAAAAQAAAAAgMDAwMDAwMDAgMDAwMDA4NDAgMDAwMDAyRTAgMDAwMDAwMDAwMDAwQkNFMCAwMDAwMDAwMCAwMDAwMDAwMCAwMDAwMDAwMCAwMDAwMDAwMCAwMDAwMDAwMCAwMDAwMDAwMCAwMDAwMDAwMCAwMDAwMDAwMAAAC85mcmVlAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA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'

    const MASTER_GAIN = 0.5

    /**
     * Create the shared audio engine. The AudioContext is created lazily so
     * loading the plugin allocates nothing, and `play` never rejects.
     */
    function createSoundEngine() {
      let audio = null
      let disposed = false
      const mediaPlayers = new Set()

      return {
        get state() {
          if (disposed) return 'disposed'
          if (audio === null) return 'uninitialized'
          return audio.state === 'running' ? 'ready' : 'blocked'
        },

        /** Create or resume the AudioContext; browsers require a user gesture. */
        async unlock() {
          if (disposed) return false
          try {
            if (audio === null) audio = new AudioContext()
            if (audio.state === 'suspended') await audio.resume()
            return audio.state === 'running'
          } catch {
            return false
          }
        },

        /**
         * Play one preset. Fire-and-forget: never throws, never rejects, so it
         * is safe to call from event listeners and waterfall interceptors.
         * @param id - preset id; `none`/unknown/empty play nothing.
         * @param opts - `{ volume?: 0..100, minGapMs?: number }`
         */
        async play(id, opts) {
          const options = opts || {}
          if (disposed || !id || id === 'none') return
          const volume = options.volume === undefined ? 70 : options.volume
          if (!(volume > 0)) return
          if (id === 'workLoop') {
            try {
              const player = new Audio(WORK_LOOP_AUDIO)
              player.volume = Math.min(1, Math.max(0, volume / 100))
              mediaPlayers.add(player)
              player.addEventListener('ended', () => mediaPlayers.delete(player), { once: true })
              player.addEventListener('error', () => mediaPlayers.delete(player), { once: true })
              await player.play()
            } catch {
              /* stay silent when media playback is unavailable */
            }
            return
          }
          const preset = SOUND_PRESETS[id]
          if (preset === undefined) return
          try {
            const running = await this.unlock()
            if (!running || audio === null) return
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
              // Short attack avoids a click; exponential release sounds natural.
              env.gain.setValueAtTime(0.0001, t0)
              env.gain.exponentialRampToValueAtTime(Math.max(voice.gain, 0.0002), t0 + 0.012)
              env.gain.exponentialRampToValueAtTime(0.0001, t1)
              osc.connect(env)
              env.connect(master)
              osc.start(t0)
              osc.stop(t1 + 0.02)
            }
            const longest = preset.reduce((acc, v) => Math.max(acc, v.at + v.dur), 0)
            setTimeout(() => {
              try {
                master.disconnect()
              } catch {
                /* already released */
              }
            }, (longest + 0.3) * 1000)
          } catch {
            /* stay silent when audio is unavailable */
          }
        },

        /** Release audio resources. Idempotent. */
        dispose() {
          if (disposed) return
          disposed = true
          for (const player of mediaPlayers) {
            try {
              player.pause()
              player.src = ''
            } catch {
              /* already released */
            }
          }
          mediaPlayers.clear()
          const closing = audio === null ? null : audio.close()
          audio = null
          if (closing && typeof closing.catch === 'function') closing.catch(() => {})
        },
      }
    }

    // ---------------------------------------------------------------------
    // Configuration surface
    // ---------------------------------------------------------------------

    /** Settings namespace = the Cordis entry id in cordis.patch.yml. */
    const NAMESPACE = 'deepsound'

    /** Dictionary namespace owned by this plugin. */
    const NS = 'deepsound'

    /** Configurable events, in display order. `field` is the settings field. */
    const EVENTS = [
      { field: 'turnComplete', label: 'eventTurnComplete', hint: 'eventTurnCompleteHint' },
      { field: 'turnError', label: 'eventTurnError', hint: 'eventTurnErrorHint' },
      { field: 'approvalRequest', label: 'eventApprovalRequest', hint: 'eventApprovalRequestHint' },
      { field: 'userQuestion', label: 'eventUserQuestion', hint: 'eventUserQuestionHint' },
      { field: 'subagentComplete', label: 'eventSubagentComplete', hint: 'eventSubagentCompleteHint' },
      { field: 'jobComplete', label: 'eventJobComplete', hint: 'eventJobCompleteHint' },
      { field: 'sessionStart', label: 'eventSessionStart', hint: 'eventSessionStartHint' },
      { field: 'goalChanged', label: 'eventGoalChanged', hint: 'eventGoalChangedHint' },
      { field: 'turnProgress', label: 'eventTurnProgress', hint: 'eventTurnProgressHint' },
    ]

    /** Boolean config fields, rendered as switches through the same form. */
    const BOOLEANS = [
      { field: 'enabled', label: 'master', hint: 'masterHint' },
      { field: 'muteWhenUnfocused', label: 'muteUnfocused', hint: 'muteUnfocusedHint' },
    ]

    /**
     * Ready-made sound profiles, mirroring the node half's PROFILES table.
     * Choosing one writes every event field at once; `custom` leaves the
     * per-event selection alone.
     */
    const PROFILES = {
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
      custom: null,
    }

    /** Profile choices offered in the UI, in display order. */
    const PROFILE_CHOICES = ['moderate', 'complete', 'silent', 'custom']

    /** Labels for the profiles. */
    const PROFILE_LABELS = {
      moderate: 'profileModerate',
      complete: 'profileComplete',
      silent: 'profileSilent',
      custom: 'profileCustom',
    }

    /**
     * A field spec selecting one entry of `choices`.
     * `SettingsFormModel` only ships text/number factories, so enumerations are
     * expressed as a validated text field.
     * @param field - settings field name.
     * @param choices - accepted values.
     * @param fallback - value used when the stored value is absent.
     * @returns a field spec.
     */
    function choiceField(field, choices, fallback) {
      return {
        field,
        format: (value) => (choices.indexOf(value) >= 0 ? value : fallback),
        parse: (text) => {
          const value = String(text).trim()
          if (choices.indexOf(value) < 0) return undefined
          return { kind: 'set', value }
        },
      }
    }

    /** A boolean field staged as 'true'/'false' text. */
    function booleanField(field) {
      return {
        field,
        format: (value) => (value === true ? 'true' : 'false'),
        parse: (text) => {
          const value = String(text).trim()
          if (value !== 'true' && value !== 'false') return undefined
          return { kind: 'set', value: value === 'true' }
        },
      }
    }

    /** A 0–100 volume field. */
    function volumeField(field) {
      return {
        field,
        format: (value) => (typeof value === 'number' ? String(value) : ''),
        parse: (text) => {
          const raw = String(text).trim()
          if (raw === '') return { kind: 'clear' }
          const value = Number(raw)
          if (!Number.isFinite(value) || value < 0 || value > 100) return undefined
          return { kind: 'set', value }
        },
      }
    }

    // ---------------------------------------------------------------------
    // Locale
    // ---------------------------------------------------------------------

    const en = {
      nav: 'Sounds',
      description: 'Play a sound when the interface needs your attention.',
      master: 'Interface sounds',
      masterHint: 'Turn every sound on or off at once.',
      volume: 'Volume',
      volumeHint: 'Loudness of every sound, as a percentage (0–100).',
      muteUnfocused: 'Only when the window is focused',
      muteUnfocusedHint: 'Stay silent while DeepSeek Harness is in the background.',
      eventsTitle: 'When to play',
      eventsHint: 'Choose a sound for each event, or None to stay silent.',
      profileTitle: 'Sound profile',
      profileHint: 'Start from a ready-made set, then fine-tune each event below.',
      profileModerate: 'Moderate',
      profileModerateHint: 'Turn finished, approvals, questions and errors.',
      profileComplete: 'Complete',
      profileCompleteHint: 'Every event, including subagents, jobs, sessions and goals.',
      profileSilent: 'Silent',
      profileSilentHint: 'No sounds at all.',
      profileCustom: 'Custom',
      profileCustomHint: 'Your own per-event selection.',
      profileApplied: 'Profile applied to the event list below. Save to keep it.',
      preview: 'Preview',
      blocked: 'Click anywhere in the window once to allow audio playback.',
      overridden: 'Overridden',
      reset: 'Reset to default',
      readOnly: 'This deployment stores settings read-only.',
      unavailable: 'The Deepsound plugin is not loaded, so it cannot be configured right now.',
      save: 'Save',
      saving: 'Saving…',
      saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
      invalidNumber: 'Enter a number from 0 to 100.',
      eventTurnComplete: 'Turn finished',
      eventTurnCompleteHint: 'The agent finished answering and is waiting for you.',
      eventTurnError: 'Turn failed',
      eventTurnErrorHint: 'The agent stopped because of an error.',
      eventApprovalRequest: 'Approval requested',
      eventApprovalRequestHint: 'A tool is waiting for your approval.',
      eventUserQuestion: 'Question asked',
      eventUserQuestionHint: 'The agent is asking you a question.',
      eventSubagentComplete: 'Subagent finished',
      eventSubagentCompleteHint: 'A subagent completed its work.',
      eventJobComplete: 'Job finished',
      eventJobCompleteHint: 'A background job completed.',
      eventSessionStart: 'Session started',
      eventSessionStartHint: 'A new session was created.',
      eventGoalChanged: 'Goal updated',
      eventGoalChangedHint: "A goal's status changed.",
      eventTurnProgress: 'Model working',
      eventTurnProgressHint: 'A soft, low pulse repeats while the model is thinking or working.',
    }

    const zh = {
      nav: '音效',
      description: '当界面需要你注意时播放提示音。',
      master: '界面音效',
      masterHint: '一次性开启或关闭所有音效。',
      volume: '音量',
      volumeHint: '所有音效的音量百分比（0–100）。',
      muteUnfocused: '仅在窗口聚焦时',
      muteUnfocusedHint: '当 DeepSeek Harness 在后台时保持静音。',
      eventsTitle: '播放时机',
      eventsHint: '为每个事件选择音效，选择「无」则不播放。',
      profileTitle: '音效方案',
      profileHint: '从预设方案开始，再在下方逐项微调。',
      profileModerate: '适度',
      profileModerateHint: '回合结束、请求批准、提问与错误。',
      profileComplete: '完整',
      profileCompleteHint: '包括子智能体、任务、会话与目标在内的全部事件。',
      profileSilent: '静音',
      profileSilentHint: '完全不播放声音。',
      profileCustom: '自定义',
      profileCustomHint: '你自行选择每个事件的音效。',
      profileApplied: '方案已应用到下方事件列表，保存后生效。',
      preview: '试听',
      blocked: '请在窗口内点击一次以允许播放音频。',
      overridden: '已覆盖',
      reset: '恢复默认',
      readOnly: '本部署的设置为只读。',
      unavailable: 'Deepsound 插件未加载，暂时无法配置。',
      save: '保存',
      saving: '保存中…',
      saveFailed: '本部署没有接受这些值，已保留供你修改。',
      invalidNumber: '请输入 0 到 100 的数字。',
      eventTurnComplete: '回合结束',
      eventTurnCompleteHint: '智能体已回复完毕，正在等待你。',
      eventTurnError: '回合失败',
      eventTurnErrorHint: '智能体因错误而停止。',
      eventApprovalRequest: '请求批准',
      eventApprovalRequestHint: '有工具正在等待你的批准。',
      eventUserQuestion: '提问',
      eventUserQuestionHint: '智能体正在向你提问。',
      eventSubagentComplete: '子智能体完成',
      eventSubagentCompleteHint: '子智能体已完成工作。',
      eventJobComplete: '任务完成',
      eventJobCompleteHint: '后台任务已完成。',
      eventSessionStart: '会话开始',
      eventSessionStartHint: '已创建新会话。',
      eventGoalChanged: '目标更新',
      eventGoalChangedHint: '目标状态发生了变化。',
      eventTurnProgress: '模型工作中',
      eventTurnProgressHint: '模型思考或工作时，重复播放柔和的低音脉冲。',
    }

    // ---------------------------------------------------------------------
    // Settings page
    // ---------------------------------------------------------------------

    /** Labels for the shared SettingsForm chrome. */
    function formLabels(t) {
      return {
        unavailable: t('unavailable'),
        readOnly: t('readOnly'),
        saveFailed: t('saveFailed'),
        save: t('save'),
        saving: t('saving'),
      }
    }

    /**
     * The Sounds settings page. Props come from the slot registration's
     * `inject()`: the form actions, `t`, and the `useDeepsoundForm` selector.
     */
    function DeepsoundSettings(props) {
      const t = props.t
      const h = react.createElement
      const state = props.useDeepsoundForm((snapshot) => snapshot)
      const { SettingsForm, SettingsValueField, Switch } = primitives

      if (props.view === 'summary') return t('description')

      const disabled = !state.writable || state.saving
      const groups = []

      // Profile picker: one click sets every event field.
      const profileChoices = PROFILE_CHOICES.map((id) =>
        h('option', { key: id, value: id }, t(PROFILE_LABELS[id])),
      )
      groups.push(
        h(
          'div',
          { key: 'profile', className: 'deepsound-profile' },
          h('label', { className: 'deepsound-row-label', htmlFor: 'deepsound-profile' }, t('profileTitle')),
          h(
            'select',
            {
              id: 'deepsound-profile',
              className: 'deepsound-select',
              disabled: disabled,
              value: state.profile.value,
              'aria-describedby': 'deepsound-profile-hint',
              onChange: (e) => props.applyProfile(e.currentTarget.value),
            },
            profileChoices,
          ),
          h('p', { id: 'deepsound-profile-hint', className: 'deepsound-hint' }, t('profileHint')),
        ),
      )

      // Master switch and focus gate — the same form, so Save covers them too.
      const toggles = BOOLEANS.map((entry) => {
        const field = state[entry.field]
        return h(
          'div',
          { key: entry.field, className: 'deepsound-row' },
          h(Switch, {
            checked: field.value === true,
            disabled: disabled,
            label: t(entry.label),
            onChange: () => props.edit(entry.field, field.value === true ? 'false' : 'true'),
          }),
          h(
            'div',
            { className: 'deepsound-row-text' },
            h('span', { className: 'deepsound-row-label' }, t(entry.label)),
            h('span', { className: 'deepsound-row-hint' }, t(entry.hint)),
          ),
        )
      })

      groups.push(h('div', { key: 'toggles' }, toggles))

      groups.push(
        h(SettingsValueField, {
          key: 'volume',
          id: 'deepsound-volume',
          label: t('volume'),
          hint: t('volumeHint'),
          overriddenLabel: t('overridden'),
          resetLabel: t('reset'),
          invalidLabel: t('invalidNumber'),
          numeric: true,
          disabled: disabled,
          text: state.volume.text,
          overridden: state.volume.overridden,
          invalid: state.volume.invalid,
          onEdit: (text) => props.edit('volume', text),
          onReset: () => props.resetField('volume'),
        }),
      )

      const rows = [
        h('h3', { key: 'events-title', className: 'deepsound-heading' }, t('eventsTitle')),
        h('p', { key: 'events-hint', className: 'deepsound-hint' }, t('eventsHint')),
      ]

      for (const event of EVENTS) {
        const field = state[event.field]
        rows.push(
          h(
            'div',
            { key: event.field, className: 'deepsound-event-row' },
            h(
              'div',
              { className: 'deepsound-event-text' },
              h('span', { className: 'deepsound-event-label' }, t(event.label)),
              h('span', { className: 'deepsound-event-hint' }, t(event.hint)),
            ),
            h(
              'select',
              {
                className: 'deepsound-select',
                disabled: disabled,
                value: field.value,
                'aria-label': t(event.label),
                onChange: (e) => props.edit(event.field, e.currentTarget.value),
              },
              SOUND_CHOICES.map((id) => h('option', { key: id, value: id }, SOUND_LABELS[id])),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'deepsound-preview',
                disabled: field.value === 'none',
                onClick: () => props.preview(field.value),
              },
              t('preview'),
            ),
          ),
        )
      }

      groups.push(h('div', { key: 'events', className: 'deepsound-events' }, rows))

      if (state.audioBlocked) {
        groups.push(
          h('p', { key: 'blocked', className: 'deepsound-hint', role: 'status' }, t('blocked')),
        )
      }

      return h(
        SettingsForm,
        {
          labels: formLabels(t),
          state: state,
          onSave: props.save,
          onDiscard: props.discard,
        },
        groups,
      )
    }

    /** Styles for the rows the shared primitives do not cover. */
    const STYLES = [
      '.deepsound-heading{margin:4px 0 2px;font-size:13px;font-weight:600;}',
      '.deepsound-hint{margin:0 0 10px;font-size:12px;opacity:.7;}',
      '.deepsound-row{display:flex;align-items:center;gap:10px;margin:12px 0;}',
      '.deepsound-row-text{display:flex;flex-direction:column;}',
      '.deepsound-row-label{font-size:13px;font-weight:500;}',
      '.deepsound-row-hint{font-size:12px;opacity:.7;}',
      '.deepsound-events{margin-top:18px;}',
      '.deepsound-profile{display:flex;flex-direction:column;gap:4px;margin:8px 0 16px;}',
      '.deepsound-profile .deepsound-select{align-self:flex-start;}',
      '.deepsound-event-row{display:flex;align-items:center;gap:10px;padding:6px 0;}',
      '.deepsound-event-text{display:flex;flex-direction:column;flex:1 1 auto;min-width:160px;}',
      '.deepsound-event-label{font-size:13px;}',
      '.deepsound-event-hint{font-size:12px;opacity:.7;}',
      '.deepsound-select{min-width:104px;padding:4px 6px;border-radius:6px;background:transparent;color:inherit;}',
      // Windows native option popups do not reliably inherit the dark surface.
      // Set BOTH colors so inherited light text cannot land on a white popup.
      '.deepsound-select option,.deepsound-select optgroup{background-color:#ffffff;color:#171717;}',
      '.deepsound-preview{padding:4px 10px;border-radius:6px;cursor:pointer;background:transparent;color:inherit;}',
      '.deepsound-preview:disabled{opacity:.45;cursor:default;}',
    ].join('')

    // ---------------------------------------------------------------------
    // Plugin
    // ---------------------------------------------------------------------

    /**
     * Runtime SERVICE names. Package names for load ordering live in
     * package.json's `dsh.client.inject` — the two lists are different.
     */
    const inject = ['remote', 'uiSession', 'sessions', 'slots', 'locale', 'configForms']

    /**
     * Mount the browser half.
     * @param ctx - client plugin context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'deepsound: dictionaries')

      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'dsh-plugin-deepsound')
        style.textContent = STYLES
        document.head.appendChild(style)
        return () => style.remove()
      }, 'deepsound: styles')

      const engine = createSoundEngine()
      ctx.effect(() => () => engine.dispose(), 'deepsound: audio engine')

      // ---- configuration -------------------------------------------------
      // One staged form for every field, so the page has a single Save and a
      // single source of truth.
      const scope = ctx.configForms.get(NAMESPACE)
      const form = new primitives.SettingsFormModel(scope, [
        volumeField('volume'),
        booleanField('enabled'),
        booleanField('muteWhenUnfocused'),
        choiceField('profile', PROFILE_CHOICES, 'moderate'),
        ...EVENTS.map((event) => choiceField(event.field, SOUND_CHOICES, 'none')),
      ])
      ctx.effect(() => () => form.dispose(), 'deepsound: form subscription')

      /** Accepted settings value, used by the event wiring (not the form draft). */
      const accepted = () => {
        const snapshot = scope.getSnapshot()
        return snapshot && snapshot.value ? snapshot.value : {}
      }

      // Audio only starts after a user gesture; track that for the hint.
      let audioBlocked = true
      ctx.effect(() => {
        const unlock = () => {
          engine.unlock().then((ok) => {
            if (ok) {
              audioBlocked = false
              publish()
            }
          })
        }
        document.addEventListener('pointerdown', unlock, { once: true, capture: true })
        document.addEventListener('keydown', unlock, { once: true, capture: true })
        return () => {
          document.removeEventListener('pointerdown', unlock, true)
          document.removeEventListener('keydown', unlock, true)
        }
      }, 'deepsound: audio unlock')

      /**
       * Play one configured event's sound, honouring the master switch, the
       * volume, and the focus gate. Never awaits inside a waterfall.
       * @param field - settings field naming the sound to play.
       */
      const fire = (field) => {
        const value = accepted()
        if (value.enabled === false) return
        if (
          value.muteWhenUnfocused === true &&
          typeof document.hasFocus === 'function' &&
          !document.hasFocus()
        ) {
          return
        }
        const id = value[field]
        if (!id || id === 'none') return
        void engine.play(id, { volume: value.volume })
      }

      // ---- turn completion ------------------------------------------------
      // No turn/end event exists; the running flag is the signal. A finished
      // turn is the true -> false edge. See CONTRACTS.md §2.3.
      const status = ctx.uiSession.sessionStatus
      const previousRunning = new Map()
      const workingSessions = new Set()
      let workTimer = null
      const WORK_PULSE_MS = 5000

      // Play one gentle cue now and then while at least one model is active.
      // One shared timer prevents overlapping sessions from becoming louder.
      const updateWorkPulse = () => {
        if (workingSessions.size > 0 && workTimer === null) {
          fire('turnProgress')
          workTimer = setInterval(() => fire('turnProgress'), WORK_PULSE_MS)
        } else if (workingSessions.size === 0 && workTimer !== null) {
          clearInterval(workTimer)
          workTimer = null
        }
      }

      ctx.effect(
        () => {
          const unsubscribe = status.subscribe(() => {
            const snapshot = status.getSnapshot()
            if (!snapshot || typeof snapshot.forEach !== 'function') return
            const seen = new Set()
            snapshot.forEach((entry, sessionId) => {
              seen.add(sessionId)
              const was = previousRunning.get(sessionId)
              const now = entry ? entry.running === true : false
              if (was === true && !now) {
                workingSessions.delete(sessionId)
                fire(subagentOf(ctx, sessionId) ? 'subagentComplete' : 'turnComplete')
              } else if (now) {
                // Include active sessions found on the first snapshot as well.
                workingSessions.add(sessionId)
              }
              previousRunning.set(sessionId, now)
            })
            for (const id of Array.from(previousRunning.keys())) {
              if (!seen.has(id)) {
                previousRunning.delete(id)
                workingSessions.delete(id)
              }
            }
            updateWorkPulse()
          })
          return () => {
            if (typeof unsubscribe === 'function') unsubscribe()
            if (workTimer !== null) clearInterval(workTimer)
            workTimer = null
            workingSessions.clear()
          }
        },
        'deepsound: session status',
      )

      // ---- forwarded events -----------------------------------------------
      ctx.effect(() => {
        const disposers = []

        // Waterfalls: observe, then delegate. Never return a value here.
        disposers.push(
          ctx.remote.$on('approval/request', function (request, next) {
            fire('approvalRequest')
            return next()
          }),
        )
        disposers.push(
          ctx.remote.$on('user-questions/request', function (request, next) {
            fire('userQuestion')
            return next()
          }),
        )

        disposers.push(ctx.remote.$on('api-session/error', () => fire('turnError')))
        disposers.push(ctx.remote.$on('api-session/added', () => fire('sessionStart')))
        disposers.push(ctx.remote.$on('goal/activation-changed', () => fire('goalChanged')))

        return () => {
          for (const dispose of disposers) {
            try {
              dispose()
            } catch {
              /* already released */
            }
          }
        }
      }, 'deepsound: forwarded events')

      // ---- the page's store ------------------------------------------------
      /** Whether a session is a subagent's own session. */
      function subagentOf(context, sessionId) {
        try {
          const binding = context.sessions.binding(sessionId)
          if (!binding) return false
          const snapshot = binding.session.getSnapshot()
          return Boolean(snapshot && snapshot.subagent)
        } catch {
          return false
        }
      }

      /** Project the form into the snapshot the page renders. */
      function project() {
        const shell = form.shell()
        const values = {}
        for (const event of EVENTS) {
          const field = form.field(event.field)
          values[event.field] = { value: field.text || 'none', overridden: field.overridden }
        }
        const booleans = {}
        for (const entry of BOOLEANS) {
          const field = form.field(entry.field)
          booleans[entry.field] = {
            value: field.text === 'true',
            overridden: field.overridden,
          }
        }
        const profile = form.field('profile')
        return Object.assign({}, shell, booleans, values, {
          volume: form.field('volume'),
          profile: { value: profile.text || 'moderate', overridden: profile.overridden },
          audioBlocked: audioBlocked,
        })
      }

      const store = form.bind(project)

      /** Re-publish after an out-of-band change (audio unlock). */
      function publish() {
        store.set(project())
      }

      const actions = form.actions()

      /**
       * Edit one event's sound. Changing a single event moves the selection to
       * `custom`, so the profile label never lies about what is configured.
       * @param field - settings field name.
       * @param value - the new sound id.
       */
      const editEvent = (field, value) => {
        actions.edit(field, value)
        const isEvent = EVENTS.some((event) => event.field === field)
        if (isEvent && form.field('profile').text !== 'custom') actions.edit('profile', 'custom')
        publish()
      }

      /**
       * Edit any field through the staged form, keeping the store in sync so the
       * page reflects the change immediately.
       * @param field - settings field name.
       * @param value - the new value.
       */
      const editField = (field, value) => {
        if (EVENTS.some((event) => event.field === field)) {
          editEvent(field, value)
          return
        }
        actions.edit(field, value)
        publish()
      }

      /** Stage a field to its inherited default. */
      const resetField = (field) => {
        actions.resetField(field)
        publish()
      }

      /**
       * Apply a sound profile: stage the profile id plus every event field it
       * defines, so the page's single Save commits them together.
       * @param id - profile id; `custom` only records the choice.
       */
      const applyProfile = (id) => {
        actions.edit('profile', id)
        const preset = PROFILES[id]
        if (!preset) {
          publish()
          return
        }
        for (const event of EVENTS) {
          const sound = preset[event.field]
          if (sound !== undefined) actions.edit(event.field, sound)
        }
        publish()
      }

      const injected = () => ({
        hooks: { deepsoundForm: store },
        props: { t: t },
        edit: editField,
        resetField: resetField,
        save: actions.save,
        discard: () => {
          actions.discard()
          publish()
        },
        applyProfile: applyProfile,
        preview: (id) => {
          const value = accepted()
          const volume = typeof value.volume === 'number' ? value.volume : 70
          void engine.play(id, { volume: volume })
        },
      })

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'deepsound',
            order: 95,
            label: () => t('nav'),
            locale: NS,
            inject: injected,
          },
          DeepsoundSettings,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})

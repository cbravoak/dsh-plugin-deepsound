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
    }

    const MASTER_GAIN = 0.5

    /**
     * Create the shared audio engine. The AudioContext is created lazily so
     * loading the plugin allocates nothing, and `play` never rejects.
     */
    function createSoundEngine() {
      let audio = null
      let disposed = false

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
          const preset = SOUND_PRESETS[id]
          if (preset === undefined) return
          const volume = options.volume === undefined ? 70 : options.volume
          if (!(volume > 0)) return
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
      ctx.effect(
        () =>
          status.subscribe(() => {
            const snapshot = status.getSnapshot()
            if (!snapshot || typeof snapshot.forEach !== 'function') return
            const seen = new Set()
            snapshot.forEach((entry, sessionId) => {
              seen.add(sessionId)
              const was = previousRunning.get(sessionId)
              const now = entry ? entry.running : undefined
              // Require a real running -> idle transition so page load stays quiet.
              if (was === true && now === false) {
                fire(subagentOf(ctx, sessionId) ? 'subagentComplete' : 'turnComplete')
              }
              previousRunning.set(sessionId, now)
            })
            for (const id of Array.from(previousRunning.keys())) {
              if (!seen.has(id)) previousRunning.delete(id)
            }
          }),
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

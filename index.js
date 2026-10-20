/**
 * dsh-desktop-notify — Windows system notifications for the three moments a
 * Harness session needs you back at the keyboard:
 *
 *   1. something is waiting for you — an approval request or an
 *      `ask_user_question` prompt;
 *   2. you answered it — allowed / rejected / cancelled, or what you picked;
 *   3. the task ended — the turn closed, or it failed.
 *
 * Host-only bundle: no Client half, no network, no runtime dependencies. A
 * notification is one detached PowerShell process that shows a tray balloon
 * (rendered as a toast by Windows 10/11) and exits.
 *
 * The two prompts are ordinary waterfall events, so this plugin never claims a
 * decision: each listener awaits `next()` and returns its result unchanged. The
 * host can also answer a request without a human (an auto-answering policy, or
 * `unavailable`); such a request settles far faster than `interactionDelayMs`,
 * which is how "nobody was actually asked" is told apart from "the human took
 * their time".
 *
 * The task end is read from the durable `turn/end` log event rather than from
 * agent status: a turn is one task, it closes exactly once, and the notification
 * then still works for a turn that began before this plugin was loaded.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = path.join(PACKAGE_ROOT, 'notify.ps1')

/** Every tunable lives here so a `cordis.patch.yml` row can override it. */
const DEFAULTS = {
  enabled: true,
  // Which of the three moments notify.
  confirm: true,
  answered: true,
  taskEnd: true,
  taskError: true,
  // Presentation.
  sound: true,
  language: 'zh',
  showSessionTitle: true,
  // Rate control.
  taskEndMinSeconds: 8,
  interactionDelayMs: 1200,
  hideWhenSubagent: true,
  // Process.
  powershellPath: 'powershell.exe',
  maxConcurrent: 3,
  coalesceMs: 700,
  // Clicking the notification.
  clickAction: 'focus', // focus | url | none
  appProcessName: 'DeepSeek Harness',
  // How long the notification stays clickable (also how long its tray icon lives).
  dwellSeconds: 8,
}

const COPY = {
  zh: {
    approvalTitle: '需要你确认',
    approvalBody: (tool, reason) => (reason ? `${tool}：${reason}` : `${tool} 正在请求授权`),
    questionTitle: '需要你回答',
    questionBody: (question, count) => (count > 1 ? `${question}（共 ${count} 个问题）` : question),
    questionFallback: '有一道问题在等你回答',
    answeredTitle: '你已回答',
    answeredApproval: (tool, verdict) => `${tool} → ${verdict}`,
    answeredQuestion: (choice) => (choice ? `你选择了：${choice}` : '问题已回答'),
    outcome: { 'allowed-once': '允许', rejected: '拒绝', cancelled: '取消' },
    doneTitle: '任务完成',
    errorTitle: '任务出错',
    doneMeta: (title, duration) => [title, duration ? `用时 ${duration}` : ''].filter(Boolean).join(' · '),
    errorMeta: (title, message) => [title, message || '本轮未正常结束'].filter(Boolean).join(' · '),
  },
  en: {
    approvalTitle: 'Confirmation needed',
    approvalBody: (tool, reason) => (reason ? `${tool}: ${reason}` : `${tool} is asking for permission`),
    questionTitle: 'Your answer is needed',
    questionBody: (question, count) => (count > 1 ? `${question} (${count} questions)` : question),
    questionFallback: 'A question is waiting for your answer',
    answeredTitle: 'Answered',
    answeredApproval: (tool, verdict) => `${tool} → ${verdict}`,
    answeredQuestion: (choice) => (choice ? `You picked: ${choice}` : 'Question answered'),
    outcome: { 'allowed-once': 'allowed', rejected: 'rejected', cancelled: 'cancelled' },
    doneTitle: 'Task finished',
    errorTitle: 'Task failed',
    doneMeta: (title, duration) => [title, duration].filter(Boolean).join(' · '),
    errorMeta: (title, message) => [title, message || 'The turn did not finish cleanly'].filter(Boolean).join(' · '),
  },
}

function copyFor(language) {
  return COPY[String(language || '').toLowerCase() === 'en' ? 'en' : 'zh']
}

/** `3m 12s` / `1h 4m` — never more than two units, so it fits a balloon. */
function formatDuration(ms, language) {
  const total = Math.max(0, Math.round(Number(ms) / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const zh = String(language || '').toLowerCase() !== 'en'
  if (h > 0) return zh ? `${h} 小时 ${m} 分` : `${h}h ${m}m`
  if (m > 0) return zh ? `${m} 分 ${s} 秒` : `${m}m ${s}s`
  return zh ? `${s} 秒` : `${s}s`
}

function shorten(value, max) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** The one-line reason an approval shows, preferring the localized display text. */
function approvalReason(req, language) {
  const display = req && req.displayReason
  if (display && typeof display === 'object') {
    const localized = display[language] || display.en
    if (localized) return shorten(localized, 120)
  }
  return shorten(req && req.reason, 120)
}

/** First question text of an `ask_user_question` request, plus how many there are. */
function questionSummary(request) {
  const list = Array.isArray(request && request.questions) ? request.questions : []
  const first = list[0] || {}
  const text = first.question || first.header || ''
  return { text: shorten(text, 120), count: list.length }
}

/** What the human selected, joined into one short line. */
function answerSummary(answer) {
  const items = Array.isArray(answer && answer.answers) ? answer.answers : []
  const picked = []
  for (const item of items) {
    if (!item) continue
    if (Array.isArray(item.selected)) {
      for (const label of item.selected) {
        if (label) picked.push(String(label))
      }
    }
    if (item.custom) picked.push(String(item.custom))
  }
  return shorten(picked.join('、'), 120)
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }
  if (!cfg.enabled) return

  if (process.platform !== 'win32') {
    console.warn('[desktop-notify] Windows-only plugin; inactive on ' + process.platform)
    return
  }
  if (!fs.existsSync(SCRIPT_PATH)) {
    console.warn('[desktop-notify] notify.ps1 is missing next to index.js; no notifications will be shown')
    return
  }

  const t = copyFor(cfg.language)
  const inflight = new Set()
  const lastShownAt = new Map()
  let warnings = 0

  /**
   * The desktop application's executable, when this Host runs inside it. The
   * notification shim resolves the running app on its own; this is only a hint
   * for the case where the app is not running yet. A plain `node.exe` is never
   * a useful hint here.
   */
  const appExe = (() => {
    try {
      const exe = String(process.execPath || '')
      if (!exe || !/\.exe$/i.test(exe)) return ''
      if (/[\\/]node\.exe$/i.test(exe)) return ''
      return fs.existsSync(exe) ? exe : ''
    } catch (error) {
      return ''
    }
  })()

  /** The GUI address, used only when clicking cannot reach the desktop window. */
  const guiUrl = (() => {
    try {
      const server = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
      if (server && typeof server.getOrigin === 'function') return String(server.getOrigin() || '')
    } catch (error) { /* fall through */ }
    try {
      const app = typeof ctx.get === 'function' ? ctx.get('webApp') : undefined
      if (app && typeof app.getAdvertisedUrl === 'function') return String(app.getAdvertisedUrl() || '')
    } catch (error) { /* no GUI address */ }
    return ''
  })()

  function warnOnce(message) {
    if (warnings >= 3) return
    warnings += 1
    console.warn('[desktop-notify] ' + message)
  }

  /**
   * Fire one notification. Never throws: a notification that cannot be shown
   * must not disturb the approval / question / turn it is reporting on.
   */
  function show(kind, title, body) {
    try {
      if (!cfg.enabled) return
      const now = Date.now()
      if (now - (lastShownAt.get(kind) || 0) < cfg.coalesceMs) return
      lastShownAt.set(kind, now)
      if (inflight.size >= cfg.maxConcurrent) return

      const payload = Buffer.from(JSON.stringify({
        title: String(title || ''),
        body: String(body || ''),
        kind,
        sound: !!cfg.sound,
        onClick: cfg.clickAction,
        appProcessName: cfg.appProcessName,
        exePath: appExe,
        url: guiUrl,
        dwellMs: Math.max(1000, Math.round((Number(cfg.dwellSeconds) || 8) * 1000)),
      }), 'utf8').toString('base64')

      const child = spawn(cfg.powershellPath, [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle', 'Hidden',
        '-ExecutionPolicy', 'Bypass',
        '-File', SCRIPT_PATH,
        '-PayloadBase64', payload,
      ], { detached: true, stdio: 'ignore', windowsHide: true })

      inflight.add(child)
      child.on('error', (error) => {
        inflight.delete(child)
        warnOnce('could not start ' + cfg.powershellPath + ': ' + (error && error.message))
      })
      child.on('exit', () => { inflight.delete(child) })
      child.unref()
    } catch (error) {
      warnOnce('notification failed: ' + (error && error.message))
    }
  }

  // A notification is only worth showing if the request actually waited for a
  // human, so each request arms a timer and the human's own answer cancels it.
  function armPrompt(kind, title, body) {
    const timer = setTimeout(() => {
      show(kind, title, body)
    }, Math.max(0, Number(cfg.interactionDelayMs) || 0))
    return timer
  }

  // Requests currently waiting on a human: while one is open, a turn that
  // closes is an interruption, not a finished task, so its notification is held.
  let waiting = 0

  if (cfg.confirm || cfg.answered) {
    ctx.on('approval/request', async (req, next) => {
      const startedAt = Date.now()
      const tool = shorten((req && req.toolName) || 'tool', 48)
      const timer = cfg.confirm
        ? armPrompt('approval', t.approvalTitle, t.approvalBody(tool, approvalReason(req, cfg.language)))
        : null
      waiting += 1
      try {
        const outcome = await next()
        if (timer) clearTimeout(timer)
        if (cfg.answered && outcome !== 'unavailable' && Date.now() - startedAt >= cfg.interactionDelayMs) {
          show('answered', t.answeredTitle, t.answeredApproval(tool, t.outcome[outcome] || String(outcome || '')))
        }
        return outcome
      } finally {
        if (timer) clearTimeout(timer)
        waiting = Math.max(0, waiting - 1)
      }
    })

    ctx.on('user-questions/request', async (request, next) => {
      const startedAt = Date.now()
      const summary = questionSummary(request)
      const timer = cfg.confirm
        ? armPrompt('question', t.questionTitle, t.questionBody(summary.text || t.questionFallback, summary.count))
        : null
      waiting += 1
      try {
        const answer = await next()
        if (timer) clearTimeout(timer)
        if (cfg.answered && Date.now() - startedAt >= cfg.interactionDelayMs) {
          show('answered', t.answeredTitle, t.answeredQuestion(answerSummary(answer)))
        }
        return answer
      } finally {
        if (timer) clearTimeout(timer)
        waiting = Math.max(0, waiting - 1)
      }
    })
  }

  if (cfg.taskEnd) {
    /** sessionId → when this plugin watched the turn begin. */
    const turnStarts = new Map()
    /** sessionId → short error text from `agent/error`, consumed by that turn's end. */
    const turnErrors = new Map()
    /** Subagent sessions run their own turns; a notification per child is noise. */
    const subagentSessions = new Set()
    const SUBAGENT_MEMORY = 500

    function rememberSubagent(info) {
      const id = info && info.id ? String(info.id) : ''
      if (!id) return
      if (subagentSessions.size >= SUBAGENT_MEMORY) subagentSessions.clear()
      subagentSessions.add(id)
    }

    function sessionTitle(session) {
      if (!cfg.showSessionTitle || !session) return ''
      try {
        const titles = typeof ctx.get === 'function' ? ctx.get('sessionTitle') : undefined
        if (!titles || typeof titles.get !== 'function') return ''
        const snapshot = titles.get(session)
        const value = typeof snapshot === 'string'
          ? snapshot
          : snapshot && (snapshot.title || snapshot.text)
        return shorten(value, 60)
      } catch (error) {
        return ''
      }
    }

    ctx.on('subagent/start', rememberSubagent)
    ctx.on('subagent/end', rememberSubagent)

    ctx.on('agent/error', ({ agent, error }) => {
      const id = agent && agent.id ? String(agent.id) : ''
      if (!id) return
      turnErrors.set(id, shorten(error && error.message ? error.message : error, 100))
    })

    ctx.on('session/event', (session, event) => {
      try {
        const type = event && event.type
        const id = session && session.id ? String(session.id) : ''
        if (!id) return
        if (type === 'turn/start') {
          turnStarts.set(id, Date.now())
          return
        }
        if (type !== 'turn/end') return

        const startedAt = turnStarts.get(id)
        turnStarts.delete(id)
        const failure = turnErrors.get(id) || ''
        turnErrors.delete(id)

        if (cfg.hideWhenSubagent && subagentSessions.has(id)) return
        if (waiting > 0) return
        // A turn this plugin did not watch begin still counts as finished; only
        // its duration is unknown, so the short-task filter cannot be applied.
        if (startedAt) {
          const elapsed = Date.now() - startedAt
          if (elapsed < (Number(cfg.taskEndMinSeconds) || 0) * 1000) return
          if (failure && !cfg.taskError) return
          if (failure) {
            show('error', t.errorTitle, t.errorMeta(sessionTitle(session), failure))
          } else {
            show('done', t.doneTitle, t.doneMeta(sessionTitle(session), formatDuration(elapsed, cfg.language)))
          }
          return
        }
        if (failure && !cfg.taskError) return
        if (failure) {
          show('error', t.errorTitle, t.errorMeta(sessionTitle(session), failure))
        } else {
          show('done', t.doneTitle, t.doneMeta(sessionTitle(session), ''))
        }
      } catch (error) {
        warnOnce('turn handling failed: ' + (error && error.message))
      }
    })

    ctx.on('session/disposed', (session) => {
      const id = session && session.id ? String(session.id) : ''
      if (!id) return
      turnStarts.delete(id)
      turnErrors.delete(id)
    })
  }
}

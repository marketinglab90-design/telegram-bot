/**
 * bot.js — Railway/GitHub ready
 * ✅ Polling with webhook cleanup
 * ✅ Handles 409 Conflict gracefully (keeps retrying)
 * ✅ Single window per habit until 23:59 MSK, +3 only
 * ✅ Positive reinforcement: milestones (1/3/5) + streak
 * ✅ Daily summary (positive tone)
 */

const { Telegraf, Markup } = require('telegraf')
const cron = require('node-cron')
const express = require('express')
const fs = require('fs')
const path = require('path')

// =====================
// ENV / constants
// =====================
const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim()
const PORT = Number(process.env.PORT || 3000)

const CHAT_ID = 653653812
const TZ = 'Europe/Moscow'

const DAY_END = '23:59'
const FIXED_POINTS = 3
const PRAISE_MILESTONES = [1, 3, 5]

// =====================
// Files
// =====================
const DATA_FILE = path.join(__dirname, 'data.json')
const CONFIG_FILE = path.join(__dirname, 'config.json')

// =====================
// Safety logs
// =====================
process.on('unhandledRejection', (reason) => console.error('UNHANDLED_REJECTION:', reason))
process.on('uncaughtException', (err) => console.error('UNCAUGHT_EXCEPTION:', err))

// =====================
// Helpers: time
// =====================
function nowMsk() {
  return new Date().toLocaleString('ru-RU', { timeZone: TZ })
}
function todayKey() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date()) // YYYY-MM-DD
}
function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec((s || '').trim())
  if (!m) return null
  const hh = Number(m[1])
  const mm = Number(m[2])
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null
  return { hh, mm }
}
function toCron(hhmm) {
  const t = parseHHMM(hhmm)
  if (!t) return null
  return `${t.mm} ${t.hh} * * *`
}
function isValidId(id) {
  return /^[a-z0-9_]{2,32}$/.test(id)
}
function decDay(dayStr) {
  // YYYY-MM-DD -> previous day (UTC safe)
  const [y, m, d] = dayStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() - 1)
  return dt.toISOString().slice(0, 10)
}

// =====================
// Data (points / events / praise)
// =====================
function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return { days: {} }
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'))
  } catch {
    return { days: {} }
  }
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8')
}
function ensureDay(data, day) {
  if (!data.days) data.days = {}
  if (!data.days[day]) {
    data.days[day] = { total: 0, events: [], praise: { countsSent: [] } }
    return
  }
  if (!Array.isArray(data.days[day].events)) data.days[day].events = []
  if (!data.days[day].praise) data.days[day].praise = { countsSent: [] }
  if (!Array.isArray(data.days[day].praise.countsSent)) data.days[day].praise.countsSent = []
}
function addPoints(points, taskId, taskName) {
  const data = loadData()
  const day = todayKey()
  ensureDay(data, day)

  data.days[day].total += points
  data.days[day].events.push({
    time: nowMsk(),
    taskId,
    taskName,
    points
  })

  saveData(data)

  return {
    day,
    total: data.days[day].total,
    count: data.days[day].events.length,
    data
  }
}
function calcStreak(data, day) {
  // consecutive days including day with at least 1 event
  let streak = 0
  let cur = day
  for (let i = 0; i < 3660; i++) {
    const dd = data.days?.[cur]
    if (!dd || !dd.events || dd.events.length === 0) break
    streak += 1
    cur = decDay(cur)
  }
  return streak
}

// =====================
// Config (habits schedule)
// =====================
const DEFAULT_CONFIG = {
  summaryTime: '23:59',
  tasks: [
    { id: 'wake', name: 'Подъём', start: '07:00' },
    { id: 'run', name: 'Бег', start: '07:11' },
    { id: 'plan', name: 'План на день', start: '08:00' },
    { id: 'report', name: 'Отчёт', start: '22:00' }
  ]
}

function clone(obj) {
  // Node 22 has structuredClone, but keep safe
  return JSON.parse(JSON.stringify(obj))
}

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8')
      return clone(DEFAULT_CONFIG)
    }
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))
    if (!cfg || !Array.isArray(cfg.tasks)) return clone(DEFAULT_CONFIG)
    if (!cfg.summaryTime) cfg.summaryTime = DEFAULT_CONFIG.summaryTime

    // normalize tasks
    cfg.tasks = cfg.tasks
      .map(t => ({ id: t.id, name: t.name, start: t.start }))
      .filter(t => t?.id && t?.name && t?.start)

    return cfg
  } catch {
    return clone(DEFAULT_CONFIG)
  }
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8')
}

let config = loadConfig()

// =====================
// Telegraf init
// =====================
if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN is missing. Set it in Railway Variables and redeploy.')
  process.exit(1)
}

const bot = new Telegraf(BOT_TOKEN)

bot.catch((err, ctx) => {
  console.error('TELEGRAF_ERROR:', err, 'update:', ctx?.update)
})

// =====================
// State: active buttons until 23:59
// =====================
const state = {} // taskId -> { active, pressed, msgId }
function ensureTaskState(taskId) {
  if (!state[taskId]) state[taskId] = { active: false, pressed: false, msgId: null }
}
function resetTaskWindow(taskId) {
  ensureTaskState(taskId)
  state[taskId].active = false
  state[taskId].pressed = false
  state[taskId].msgId = null
}

// =====================
// Cron jobs
// =====================
const jobs = []
function stopAllJobs() {
  while (jobs.length) {
    const j = jobs.pop()
    try { j.stop() } catch {}
  }
}

function taskButton(task) {
  return `✅ ${task.name} (+${FIXED_POINTS})`
}

async function sendTask(task) {
  ensureTaskState(task.id)
  console.log(`[${task.id}] SEND fired at MSK=${nowMsk()} (start=${task.start}, window->${DAY_END})`)
  try {
    resetTaskWindow(task.id)
    state[task.id].active = true

    const msg = await bot.telegram.sendMessage(
      CHAT_ID,
      `🌟 ${task.name}\nНажми кнопку, когда сделаешь — и получишь +${FIXED_POINTS}.\nОкно сегодня до ${DAY_END} (МСК).`,
      Markup.inlineKeyboard([Markup.button.callback(taskButton(task), `done:${task.id}`)])
    )

    state[task.id].msgId = msg.message_id
  } catch (e) {
    console.error(`[${task.id}] SEND ERROR`, e)
  }
}

// Quietly close all windows at end of day (no negative messages)
async function closeAllAtDayEnd() {
  console.log(`[DAY] CLOSE windows fired at MSK=${nowMsk()}`)
  try {
    for (const task of config.tasks) {
      ensureTaskState(task.id)
      state[task.id].active = false

      if (!state[task.id].pressed && state[task.id].msgId) {
        await bot.telegram.deleteMessage(CHAT_ID, state[task.id].msgId).catch(() => {})
      }
      state[task.id].msgId = null
    }
  } catch (e) {
    console.error('[DAY] CLOSE ERROR', e)
  }
}

// Positive reinforcement
function pickPraise(count, streak) {
  const variants = [
    `🔥 Есть! Это ${count}-я отметка сегодня. Серия: ${streak} дн. Продолжаем!`,
    `✨ Классно! Сегодня уже ${count}. Серия: ${streak} дн.`,
    `💪 Сила привычки: ${count} выполнено сегодня. Серия: ${streak} дн.`,
    `🏅 Отличный темп: ${count} за день. Серия: ${streak} дн.`
  ]
  return variants[Math.floor(Math.random() * variants.length)]
}

async function maybeSendPraise(day, totalCount, data) {
  ensureDay(data, day)
  const sent = data.days[day].praise.countsSent

  if (!PRAISE_MILESTONES.includes(totalCount)) return
  if (sent.includes(totalCount)) return

  sent.push(totalCount)
  saveData(data)

  const streak = calcStreak(data, day)
  const text = pickPraise(totalCount, streak)
  await bot.telegram.sendMessage(CHAT_ID, text).catch(() => {})
}

async function sendDailySummary() {
  console.log(`[DAILY] SUMMARY fired at MSK=${nowMsk()}`)
  try {
    const data = loadData()
    const day = todayKey()
    const dayData = data.days?.[day] ?? { total: 0, events: [] }

    const streak = calcStreak(data, day)
    const count = dayData.events?.length ?? 0

    let text = `📊 Итоги дня (${day}): ${dayData.total} баллов ✨\n`
    text += `✅ Отметок: ${count}\n`
    text += `🔁 Серия дней: ${streak}\n`

    if (count) {
      const byTask = {}
      for (const e of dayData.events) {
        byTask[e.taskName] = (byTask[e.taskName] || 0) + e.points
      }

      text += '\n🏅 Сегодня отмечено:\n' +
        Object.entries(byTask).map(([k, v]) => `• ${k}: +${v}`).join('\n')

      text += '\n\n🧾 Лента отметок:\n' +
        dayData.events.map(e => `• ${e.time} — ${e.taskName}: +${e.points}`).join('\n')

      text += '\n\n🔥 Ты молодец. Завтра — ещё проще.'
    } else {
      text += '\nТихий день — тоже часть пути.\nЗавтра начнём с малого и нарастим 💪'
    }

    await bot.telegram.sendMessage(CHAT_ID, text)
  } catch (e) {
    console.error('[DAILY] ERROR', e)
  }
}

function scheduleAllFromConfig() {
  stopAllJobs()

  for (const task of config.tasks) {
    ensureTaskState(task.id)
    const cStart = toCron(task.start)
    if (!cStart) {
      console.log(`[SCHED] invalid time format for ${task.id}`)
      continue
    }
    jobs.push(cron.schedule(cStart, () => sendTask(task), { timezone: TZ }))
  }

  const endCron = toCron(DAY_END)
  if (endCron) jobs.push(cron.schedule(endCron, closeAllAtDayEnd, { timezone: TZ }))

  const sumCron = toCron(config.summaryTime)
  if (sumCron) jobs.push(cron.schedule(sumCron, sendDailySummary, { timezone: TZ }))
  else console.log('[SCHED] invalid summaryTime:', config.summaryTime)

  console.log(`[SCHED] rescheduled: tasks=${config.tasks.length}, dayEnd=${DAY_END}, summary=${config.summaryTime}, MSK=${nowMsk()}`)
}

// =====================
// Admin check
// =====================
function isAdmin(ctx) {
  return ctx?.chat?.id === CHAT_ID
}

// =====================
// Commands (positive)
// =====================
bot.start((ctx) => ctx.reply(
  'Бот работает ✅\n\n' +
  'Смысл: позитивные отметки привычек (+3), без негатива.\n' +
  'Есть похвала за вехи (1/3/5 отметок) и серия дней.\n\n' +
  'Команды:\n' +
  '/habits — список привычек\n' +
  '/score — очки за сегодня\n' +
  '/set <id> <start>\n' +
  '/rename <id> <new name...>\n' +
  '/add <id> <start> | <name...>\n' +
  '/del <id>\n' +
  '/setsummary <HH:MM>\n' +
  '/reset'
))

bot.command('score', async (ctx) => {
  const data = loadData()
  const day = todayKey()
  const total = data.days?.[day]?.total ?? 0
  const count = data.days?.[day]?.events?.length ?? 0
  const streak = calcStreak(data, day)
  await ctx.reply(`Сегодня (${day}): ${total} баллов ✨ | отметок: ${count} | серия: ${streak} дн.`)
})

bot.command('habits', async (ctx) => {
  const lines = []
  lines.push(`🗓 Расписание (МСК). Окна привычек: со старта и до ${DAY_END}. Итог дня: ${config.summaryTime}`)
  for (const t of config.tasks) {
    lines.push(`• ${t.id} — ${t.name}: старт ${t.start} | +${FIXED_POINTS}`)
  }
  await ctx.reply(lines.join('\n'))
})

// /set wake 07:00
bot.command('set', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Нет доступа 🙂')

  const parts = (ctx.message.text || '').trim().split(/\s+/)
  if (parts.length !== 3) return ctx.reply('Формат: /set <id> <start>\nПример: /set wake 07:00')

  const [, id, start] = parts
  const task = config.tasks.find(t => t.id === id)
  if (!task) return ctx.reply(`Не нашёл id="${id}". Смотри /habits`)
  if (!parseHHMM(start)) return ctx.reply('Неверный формат времени. Нужно HH:MM (например 07:05).')

  task.start = start
  saveConfig(config)
  scheduleAllFromConfig()
  await ctx.reply(`✅ Обновил: ${task.name}. Старт ${start}, окно до ${DAY_END}`)
})

// /rename wake Подъём без телефона
bot.command('rename', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Нет доступа 🙂')

  const raw = (ctx.message.text || '').trim()
  const m = /^\/rename\s+([a-z0-9_]{2,32})\s+(.+)$/i.exec(raw)
  if (!m) return ctx.reply('Формат: /rename <id> <new name...>\nПример: /rename wake Подъём без телефона')

  const id = m[1]
  const newName = m[2].trim()

  const task = config.tasks.find(t => t.id === id)
  if (!task) return ctx.reply(`Не нашёл id="${id}". Смотри /habits`)
  if (newName.length < 2 || newName.length > 60) return ctx.reply('Название должно быть 2..60 символов.')

  task.name = newName
  saveConfig(config)
  scheduleAllFromConfig()
  await ctx.reply(`✅ Переименовал: ${id} — ${newName}`)
})

// /add water 10:00 | Стакан воды
bot.command('add', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Нет доступа 🙂')

  const raw = (ctx.message.text || '').trim()
  const m = /^\/add\s+(.+)$/.exec(raw)
  if (!m) return

  const rest = m[1]
  const parts = rest.split('|')
  if (parts.length !== 2) {
    return ctx.reply('Формат: /add <id> <start> | <name...>\nПример: /add water 10:00 | Стакан воды')
  }

  const left = parts[0].trim().split(/\s+/)
  const name = parts[1].trim()
  if (left.length !== 2) return ctx.reply('Слева должно быть 2 аргумента: <id> <start>')

  const [id, start] = left
  if (!isValidId(id)) return ctx.reply('id должен быть латиницей/цифрами/underscore, 2..32 символа. Пример: water_1')
  if (config.tasks.some(t => t.id === id)) return ctx.reply(`id "${id}" уже существует.`)
  if (!parseHHMM(start)) return ctx.reply('Неверный формат времени. Нужно HH:MM (например 10:05).')
  if (name.length < 2 || name.length > 60) return ctx.reply('Название должно быть 2..60 символов.')

  config.tasks.push({ id, name, start })
  saveConfig(config)
  scheduleAllFromConfig()

  await ctx.reply(`✅ Добавил привычку: ${id} — ${name}\nСтарт ${start}, окно до ${DAY_END} | +${FIXED_POINTS}`)
})

// /del water
bot.command('del', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Нет доступа 🙂')

  const parts = (ctx.message.text || '').trim().split(/\s+/)
  if (parts.length !== 2) return ctx.reply('Формат: /del <id>\nПример: /del water')

  const id = parts[1]
  const idx = config.tasks.findIndex(t => t.id === id)
  if (idx === -1) return ctx.reply(`Не нашёл id="${id}".`)

  const removed = config.tasks.splice(idx, 1)[0]
  saveConfig(config)

  if (state[id]) {
    if (state[id].msgId) await bot.telegram.deleteMessage(CHAT_ID, state[id].msgId).catch(() => {})
    delete state[id]
  }

  scheduleAllFromConfig()
  await ctx.reply(`✅ Удалил привычку: ${removed.id} — ${removed.name}`)
})

// /setsummary 23:59
bot.command('setsummary', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Нет доступа 🙂')

  const parts = (ctx.message.text || '').trim().split(/\s+/)
  if (parts.length !== 2) return ctx.reply('Формат: /setsummary <HH:MM>\nПример: /setsummary 23:59')

  const time = parts[1]
  if (!parseHHMM(time)) return ctx.reply('Неверный формат времени. Нужно HH:MM')

  config.summaryTime = time
  saveConfig(config)
  scheduleAllFromConfig()
  await ctx.reply(`✅ Итог дня теперь в ${time} (МСК)`)
})

// /reset
bot.command('reset', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Нет доступа 🙂')
  config = clone(DEFAULT_CONFIG)
  saveConfig(config)
  scheduleAllFromConfig()
  await ctx.reply('✅ Конфиг сброшен на дефолтный.')
})

// =====================
// Button actions
// =====================
bot.action(/^done:(.+)$/, async (ctx) => {
  const taskId = ctx.match[1]
  const task = config.tasks.find(t => t.id === taskId)
  if (!task) return

  try {
    ensureTaskState(taskId)

    if (!state[taskId].active || state[taskId].pressed) {
      await ctx.answerCbQuery('Уже неактуально 🙂')
      return
    }

    state[taskId].pressed = true
    state[taskId].active = false

    const { day, total, count, data } = addPoints(FIXED_POINTS, task.id, task.name)

    await ctx.answerCbQuery(`+${FIXED_POINTS} ✅`)
    await ctx.editMessageText(
      `✅ ${task.name} — супер!\n+${FIXED_POINTS} балла в копилку ✨\nСчёт за сегодня: ${total}`
    )

    await maybeSendPraise(day, count, data)
  } catch (e) {
    console.error(`[${taskId}] ACTION done ERROR`, e)
  }
})

// =====================
// Express server (Railway health)
// =====================
const app = express()
app.get('/', (req, res) => res.status(200).send('Bot is running'))
app.get('/health', (req, res) => res.status(200).json({ ok: true, time: nowMsk() }))
app.listen(PORT, () => console.log('✅ Server started on', PORT))

// =====================
// Robust start (no more silent failures)
// =====================
let stopping = false

async function startPollingLoop() {
  // This loop prevents "dead green" deploys:
  // if Telegram returns 409, we keep retrying and logging.
  let attempt = 0

  while (!stopping) {
    attempt += 1
    try {
      console.log(`\n=== BOOT attempt #${attempt} @ MSK=${nowMsk()} ===`)

      // If webhook exists — remove it (polling mode)
      try {
        await bot.telegram.deleteWebhook({ drop_pending_updates: true })
        console.log('✅ deleteWebhook OK (polling mode)')
      } catch (e) {
        console.warn('⚠️ deleteWebhook failed (can be ok):', e?.message || e)
      }

      // Token sanity check
      const me = await bot.telegram.getMe()
      console.log('✅ Bot identity:', me.username, me.id)

      scheduleAllFromConfig()

      await bot.launch({
        dropPendingUpdates: true,
        allowedUpdates: ['message', 'callback_query']
      })

      console.log('✅ Bot launched (polling).')
      return // success: exit loop

    } catch (err) {
      const msg = err?.message || String(err)
      console.error('❌ Bot launch error:', msg)

      // 409 means another instance is polling; can't fix in code,
      // but we can keep retrying so it self-recovers when other instance stops.
      const is409 =
        msg.includes('409') ||
        msg.toLowerCase().includes('conflict') ||
        (err?.response?.error_code === 409)

      // Stop any partially started polling
      try { bot.stop('launch_error') } catch {}

      const waitMs = is409 ? 15000 : 5000
      console.log(`⏳ Retry in ${Math.round(waitMs / 1000)}s... (hint: stop other bot instances)`)
      await new Promise(r => setTimeout(r, waitMs))
    }
  }
}

startPollingLoop()

// Graceful shutdown
process.once('SIGINT', () => { stopping = true; bot.stop('SIGINT') })
process.once('SIGTERM', () => { stopping = true; bot.stop('SIGTERM') })

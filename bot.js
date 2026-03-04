const { Telegraf, Markup } = require('telegraf')
const cron = require('node-cron')
const express = require('express')
const fs = require('fs')
const path = require('path')

const bot = new Telegraf(process.env.BOT_TOKEN)
const app = express()

// ====== ТВОЙ CHAT_ID (админ) ======
const CHAT_ID = 653653812

// ====== Часовой пояс ======
const TZ = 'Europe/Moscow'

// ====== Файлы ======
const DATA_FILE = path.join(__dirname, 'data.json')     // очки
const CONFIG_FILE = path.join(__dirname, 'config.json') // расписание/привычки

// =====================
// Утилиты времени
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
  // dayStr: YYYY-MM-DD -> previous day (calendar), safe in UTC
  const [y, m, d] = dayStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() - 1)
  return dt.toISOString().slice(0, 10)
}

// =====================
// Очки (data.json)
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
  if (!data.days[day]) {
    data.days[day] = { total: 0, events: [], praise: { countsSent: [] } }
  } else {
    if (!data.days[day].events) data.days[day].events = []
    if (!data.days[day].praise) data.days[day].praise = { countsSent: [] }
    if (!Array.isArray(data.days[day].praise.countsSent)) data.days[day].praise.countsSent = []
  }
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
  // Стрик: количество подряд идущих дней (включая today), где есть хотя бы 1 событие
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
// Конфиг (config.json)
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

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8')
      return structuredClone(DEFAULT_CONFIG)
    }
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))
    if (!cfg || !Array.isArray(cfg.tasks)) return structuredClone(DEFAULT_CONFIG)
    if (!cfg.summaryTime) cfg.summaryTime = DEFAULT_CONFIG.summaryTime

    // миграция со старого формата: оставим start/id/name
    cfg.tasks = cfg.tasks.map(t => ({
      id: t.id,
      name: t.name,
      start: t.start
    })).filter(t => t?.id && t?.name && t?.start)

    return cfg
  } catch {
    return structuredClone(DEFAULT_CONFIG)
  }
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8')
}

let config = loadConfig()

// =====================
// Состояние по задачам
// =====================
const state = {} // taskId -> { active, pressed, msgId }
function ensureTaskState(taskId) {
  if (!state[taskId]) {
    state[taskId] = { active: false, pressed: false, msgId: null }
  }
}
function resetTaskWindow(taskId) {
  ensureTaskState(taskId)
  state[taskId].active = false
  state[taskId].pressed = false
  state[taskId].msgId = null
}

// =====================
// Cron jobs (динамически)
// =====================
const jobs = []
function stopAllJobs() {
  while (jobs.length) {
    const j = jobs.pop()
    try { j.stop() } catch {}
  }
}

const DAY_END = '23:59'
const FIXED_POINTS = 3

function taskButton(task) {
  return `✅ ${task.name} (+${FIXED_POINTS})`
}

async function sendTask(task) {
  ensureTaskState(task.id)
  console.log(`[${task.id}] SEND fired at MSK=${nowMsk()} (start=${task.start}, window->${DAY_END})`)
  try {
    resetTaskWindow(task.id)
    state[task.id].active = true

    const btn = taskButton(task)

    const msg = await bot.telegram.sendMessage(
      CHAT_ID,
      `🌟 ${task.name}\nНажми кнопку, когда сделаешь — и получишь +${FIXED_POINTS}.\nОкно сегодня до ${DAY_END} (МСК).`,
      Markup.inlineKeyboard([Markup.button.callback(btn, `done:${task.id}`)])
    )
    state[task.id].msgId = msg.message_id
  } catch (e) {
    console.log(`[${task.id}] SEND ERROR`, e)
  }
}

// Тихо закрываем окна в конце дня (без сообщений)
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
    console.log('[DAY] CLOSE ERROR', e)
  }
}

// =====================
// Позитивное подкрепление (стрик + вехи)
// =====================
const PRAISE_MILESTONES = [1, 3, 5]

function pickPraise(count, streak) {
  const variants = [
    `🔥 Есть! Это ${count}-я отметка сегодня. Серия: ${streak} дн. Продолжаем!`,
    `✨ Классно сделано. Сегодня уже ${count}. Серия: ${streak} дн.`,
    `💪 Сила привычки! ${count} выполнено сегодня. Серия: ${streak} дн.`,
    `🏅 Отличный темп: ${count} за день. Серия: ${streak} дн.`
  ]
  return variants[Math.floor(Math.random() * variants.length)]
}

async function maybeSendPraise(day, totalCount, data) {
  ensureDay(data, day)
  const sent = data.days[day].praise.countsSent

  if (!PRAISE_MILESTONES.includes(totalCount)) return

  if (sent.includes(totalCount)) return

  // отметим, что отправили, чтобы не спамить
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
        Object.entries(byTask)
          .map(([k, v]) => `• ${k}: +${v}`)
          .join('\n')

      text += '\n\n🧾 Лента отметок:\n' +
        dayData.events.map(e => `• ${e.time} — ${e.taskName}: +${e.points}`).join('\n')

      text += '\n\n🔥 Ты молодец. Завтра — ещё проще.'
    } else {
      text += '\nТихий день — тоже часть пути.\nЗавтра начнём с малого и нарастим 💪'
    }

    await bot.telegram.sendMessage(CHAT_ID, text)
  } catch (e) {
    console.log('[DAILY] ERROR', e)
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
// Админ-доступ
// =====================
function isAdmin(ctx) {
  return ctx?.chat?.id === CHAT_ID
}

// =====================
// Команды
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
  lines.push(`🗓 Расписание (МСК). Окна привычек: с времени старта и до ${DAY_END}. Итог дня: ${config.summaryTime}`)
  for (const t of config.tasks) {
    lines.push(`• ${t.id} — ${t.name}: старт ${t.start} | +${FIXED_POINTS}`)
  }
  await ctx.reply(lines.join('\n'))
})

// /set wake 07:00
bot.command('set', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Нет доступа 🙂')

  const parts = (ctx.message.text || '').trim().split(/\s+/)
  if (parts.length !== 3) {
    return ctx.reply('Формат: /set <id> <start>\nПример: /set wake 07:00')
  }
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

  config = structuredClone(DEFAULT_CONFIG)
  saveConfig(config)
  scheduleAllFromConfig()
  await ctx.reply('✅ Конфиг сброшен на дефолтный.')
})

// =====================
// Нажатия кнопок
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

    // Похвала за вехи + стрик (без негатива)
    await maybeSendPraise(day, count, data)
  } catch (e) {
    console.log(`[${taskId}] ACTION done ERROR`, e)
  }
})

// =====================
// Web server (Railway)
// =====================
app.get('/', (req, res) => res.send('Bot is running'))
app.listen(process.env.PORT || 3000, () => console.log('Server started'))

// старт
scheduleAllFromConfig()
bot.launch({ dropPendingUpdates: true })

process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))

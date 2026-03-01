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
function minutesOfDay(hhmm) {
  const t = parseHHMM(hhmm)
  if (!t) return null
  return t.hh * 60 + t.mm
}
function isOrderValid(start, end, fallbackEnd) {
  const a = minutesOfDay(start)
  const b = minutesOfDay(end)
  const c = minutesOfDay(fallbackEnd)
  if (a == null || b == null || c == null) return false
  // в рамках одного дня: start < end <= fallbackEnd
  return a < b && b <= c
}
function safeInt(s) {
  if (!/^-?\d+$/.test(String(s))) return null
  const n = Number(s)
  if (!Number.isFinite(n)) return null
  return n
}
function isValidId(id) {
  // латиница/цифры/underscore, 2..32
  return /^[a-z0-9_]{2,32}$/.test(id)
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
  if (!data.days[day]) data.days[day] = { total: 0, events: [] }
}
function addPoints(points, taskId, taskName, kind) {
  const data = loadData()
  const day = todayKey()
  ensureDay(data, day)

  data.days[day].total += points
  data.days[day].events.push({
    time: nowMsk(),
    taskId,
    taskName,
    kind, // "main" | "fallback"
    points
  })

  saveData(data)
  return data.days[day].total
}

// =====================
// Конфиг (config.json)
// =====================
const DEFAULT_CONFIG = {
  summaryTime: '23:05',
  tasks: [
    {
      id: 'wake',
      name: 'Подъём',
      start: '07:00',
      end: '07:10',
      fallbackEnd: '07:30',
      mainPoints: 3,
      fallbackPoints: 1
    },
    {
      id: 'run',
      name: 'Бег',
      start: '07:11',
      end: '07:15',
      fallbackEnd: '07:30',
      mainPoints: 3,
      fallbackPoints: 1
    },
    {
      id: 'plan',
      name: 'План на день',
      start: '08:00',
      end: '08:20',
      fallbackEnd: '09:00',
      mainPoints: 3,
      fallbackPoints: 1
    },
    {
      id: 'report',
      name: 'Отчёт',
      start: '22:00',
      end: '22:30',
      fallbackEnd: '23:00',
      mainPoints: 3,
      fallbackPoints: 1
    }
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
// Состояние по задачам (окна/сообщения)
// =====================
const state = {} // taskId -> state
function ensureTaskState(taskId) {
  if (!state[taskId]) {
    state[taskId] = {
      mainActive: false,
      fallbackActive: false,
      mainPressed: false,
      fallbackPressed: false,
      mainMsgId: null,
      fallbackMsgId: null
    }
  }
}
function resetTaskWindow(taskId) {
  ensureTaskState(taskId)
  state[taskId].mainActive = false
  state[taskId].fallbackActive = false
  state[taskId].mainPressed = false
  state[taskId].fallbackPressed = false
  state[taskId].mainMsgId = null
  state[taskId].fallbackMsgId = null
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

function taskButtons(task) {
  const mainBtn = `✅ ${task.name} (+${task.mainPoints})`
  const fbBtn = `🟡 ${task.name} (+${task.fallbackPoints})`
  return { mainBtn, fbBtn }
}

async function sendMain(task) {
  ensureTaskState(task.id)
  console.log(`[${task.id}] MAIN START fired at MSK=${nowMsk()} (${task.start}-${task.end}, fb->${task.fallbackEnd})`)
  try {
    resetTaskWindow(task.id)
    state[task.id].mainActive = true

    const { mainBtn } = taskButtons(task)

    const msg = await bot.telegram.sendMessage(
      CHAT_ID,
      `⏱ ${task.name}\nОсновное окно: ${task.start}–${task.end} (+${task.mainPoints})`,
      Markup.inlineKeyboard([Markup.button.callback(mainBtn, `main:${task.id}`)])
    )
    state[task.id].mainMsgId = msg.message_id
  } catch (e) {
    console.log(`[${task.id}] MAIN START ERROR`, e)
  }
}

async function closeMain(task) {
  ensureTaskState(task.id)
  console.log(`[${task.id}] MAIN END fired at MSK=${nowMsk()}`)
  try {
    state[task.id].mainActive = false

    if (!state[task.id].mainPressed) {
      if (state[task.id].mainMsgId) {
        await bot.telegram.deleteMessage(CHAT_ID, state[task.id].mainMsgId).catch(() => {})
      }

      state[task.id].fallbackActive = true
      const { fbBtn } = taskButtons(task)

      const msg2 = await bot.telegram.sendMessage(
        CHAT_ID,
        `❌ Не успел на +${task.mainPoints} (${task.name}).\nЗапасное окно до ${task.fallbackEnd}: +${task.fallbackPoints}`,
        Markup.inlineKeyboard([Markup.button.callback(fbBtn, `fb:${task.id}`)])
      )
      state[task.id].fallbackMsgId = msg2.message_id
    }
  } catch (e) {
    console.log(`[${task.id}] MAIN END ERROR`, e)
  }
}

async function closeFallback(task) {
  ensureTaskState(task.id)
  console.log(`[${task.id}] FALLBACK END fired at MSK=${nowMsk()}`)
  try {
    state[task.id].fallbackActive = false

    if (!state[task.id].fallbackPressed && state[task.id].fallbackMsgId) {
      await bot.telegram.deleteMessage(CHAT_ID, state[task.id].fallbackMsgId).catch(() => {})
      await bot.telegram.sendMessage(CHAT_ID, `⌛ ${task.name}: время вышло.`)
    }
  } catch (e) {
    console.log(`[${task.id}] FALLBACK END ERROR`, e)
  }
}

async function sendDailySummary() {
  console.log(`[DAILY] SUMMARY fired at MSK=${nowMsk()}`)
  try {
    const data = loadData()
    const day = todayKey()
    const dayData = data.days?.[day] ?? { total: 0, events: [] }

    let text = `📊 Итоги дня (${day}): ${dayData.total} баллов\n`
    if (dayData.events.length) {
      const byTask = {}
      for (const e of dayData.events) {
        byTask[e.taskName] = (byTask[e.taskName] || 0) + e.points
      }
      text += '\nПо привычкам:\n' + Object.entries(byTask).map(([k, v]) => `• ${k}: ${v}`).join('\n')
      text += '\n\nСобытия:\n' + dayData.events.map(e => `• ${e.time} — ${e.taskName} (${e.kind}): +${e.points}`).join('\n')
    } else {
      text += '\nСегодня без выполнений.'
    }

    await bot.telegram.sendMessage(CHAT_ID, text)
  } catch (e) {
    console.log('[DAILY] ERROR', e)
  }
}

function scheduleAllFromConfig() {
  stopAllJobs()

  // задачи
  for (const task of config.tasks) {
    ensureTaskState(task.id)

    const cStart = toCron(task.start)
    const cEnd = toCron(task.end)
    const cFb = toCron(task.fallbackEnd)

    if (!cStart || !cEnd || !cFb) {
      console.log(`[SCHED] invalid time format for ${task.id}`)
      continue
    }

    jobs.push(cron.schedule(cStart, () => sendMain(task), { timezone: TZ }))
    jobs.push(cron.schedule(cEnd, () => closeMain(task), { timezone: TZ }))
    jobs.push(cron.schedule(cFb, () => closeFallback(task), { timezone: TZ }))
  }

  // итог дня
  const sumCron = toCron(config.summaryTime)
  if (sumCron) {
    jobs.push(cron.schedule(sumCron, sendDailySummary, { timezone: TZ }))
  } else {
    console.log('[SCHED] invalid summaryTime:', config.summaryTime)
  }

  console.log(`[SCHED] rescheduled: tasks=${config.tasks.length}, summary=${config.summaryTime}, MSK=${nowMsk()}`)
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
  'Команды:\n' +
  '/habits — список привычек\n' +
  '/score — очки за сегодня\n' +
  '/set <id> <start> <end> <fallbackEnd>\n' +
  '/points <id> <mainPoints> <fallbackPoints>\n' +
  '/rename <id> <new name...>\n' +
  '/add <id> <start> <end> <fallbackEnd> <mainPoints> <fallbackPoints> | <name...>\n' +
  '/del <id>\n' +
  '/setsummary <HH:MM>\n' +
  '/reset'
))

bot.command('score', async (ctx) => {
  const data = loadData()
  const day = todayKey()
  const total = data.days?.[day]?.total ?? 0
  await ctx.reply(`Очки за сегодня (${day}): ${total}`)
})

bot.command('habits', async (ctx) => {
  const lines = []
  lines.push(`🗓 Расписание (МСК). Итог дня: ${config.summaryTime}`)
  for (const t of config.tasks) {
    lines.push(`• ${t.id} — ${t.name}: ${t.start}–${t.end}, запасное до ${t.fallbackEnd} | +${t.mainPoints}/+${t.fallbackPoints}`)
  }
  await ctx.reply(lines.join('\n'))
})

// /set wake 07:00 07:10 07:30
bot.command('set', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Нет доступа 🙂')

  const parts = (ctx.message.text || '').trim().split(/\s+/)
  if (parts.length !== 5) {
    return ctx.reply('Формат: /set <id> <start> <end> <fallbackEnd>\nПример: /set wake 07:00 07:10 07:30')
  }
  const [, id, start, end, fallbackEnd] = parts
  const task = config.tasks.find(t => t.id === id)
  if (!task) return ctx.reply(`Не нашёл id="${id}". Смотри /habits`)

  if (!parseHHMM(start) || !parseHHMM(end) || !parseHHMM(fallbackEnd)) {
    return ctx.reply('Неверный формат времени. Нужно HH:MM (например 07:05).')
  }
  if (!isOrderValid(start, end, fallbackEnd)) {
    return ctx.reply('Порядок времени неверный. Нужно: start < end <= fallbackEnd (в рамках одного дня).')
  }

  task.start = start
  task.end = end
  task.fallbackEnd = fallbackEnd

  saveConfig(config)
  scheduleAllFromConfig()

  await ctx.reply(`✅ Обновил ${task.name}: ${start}–${end}, запасное до ${fallbackEnd}`)
})

// /points wake 5 2
bot.command('points', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Нет доступа 🙂')

  const parts = (ctx.message.text || '').trim().split(/\s+/)
  if (parts.length !== 4) {
    return ctx.reply('Формат: /points <id> <mainPoints> <fallbackPoints>\nПример: /points wake 3 1')
  }
  const [, id, mainP, fbP] = parts
  const task = config.tasks.find(t => t.id === id)
  if (!task) return ctx.reply(`Не нашёл id="${id}". Смотри /habits`)

  const mp = safeInt(mainP)
  const fp = safeInt(fbP)
  if (mp == null || fp == null || mp < 0 || fp < 0) {
    return ctx.reply('Баллы должны быть целыми числами >= 0.')
  }

  task.mainPoints = mp
  task.fallbackPoints = fp

  saveConfig(config)
  scheduleAllFromConfig()

  await ctx.reply(`✅ Баллы обновлены для "${task.name}": +${mp} / +${fp}`)
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

// /add water 10:00 10:05 10:30 3 1 | Стакан воды
bot.command('add', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Нет доступа 🙂')

  const raw = (ctx.message.text || '').trim()
  const m = /^\/add\s+(.+)$/.exec(raw)
  if (!m) return

  const rest = m[1]
  const parts = rest.split('|')
  if (parts.length !== 2) {
    return ctx.reply('Формат: /add <id> <start> <end> <fallbackEnd> <mainPoints> <fallbackPoints> | <name...>\n' +
      'Пример: /add water 10:00 10:05 10:30 3 1 | Стакан воды')
  }

  const left = parts[0].trim().split(/\s+/)
  const name = parts[1].trim()

  if (left.length !== 6) {
    return ctx.reply('Слева должно быть 6 аргументов: <id> <start> <end> <fallbackEnd> <mainPoints> <fallbackPoints>')
  }

  const [id, start, end, fallbackEnd, mainP, fbP] = left

  if (!isValidId(id)) return ctx.reply('id должен быть латиницей/цифрами/underscore, 2..32 символа. Пример: water_1')
  if (config.tasks.some(t => t.id === id)) return ctx.reply(`id "${id}" уже существует.`)

  if (!parseHHMM(start) || !parseHHMM(end) || !parseHHMM(fallbackEnd)) {
    return ctx.reply('Неверный формат времени. Нужно HH:MM (например 10:05).')
  }
  if (!isOrderValid(start, end, fallbackEnd)) {
    return ctx.reply('Порядок времени неверный. Нужно: start < end <= fallbackEnd (в рамках одного дня).')
  }

  const mp = safeInt(mainP)
  const fp = safeInt(fbP)
  if (mp == null || fp == null || mp < 0 || fp < 0) return ctx.reply('Баллы должны быть целыми числами >= 0.')
  if (name.length < 2 || name.length > 60) return ctx.reply('Название должно быть 2..60 символов.')

  config.tasks.push({
    id,
    name,
    start,
    end,
    fallbackEnd,
    mainPoints: mp,
    fallbackPoints: fp
  })

  saveConfig(config)
  scheduleAllFromConfig()

  await ctx.reply(`✅ Добавил привычку: ${id} — ${name}\n${start}–${end}, запасное до ${fallbackEnd} | +${mp}/+${fp}`)
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

  // стопнем окна/сообщения этой привычки
  if (state[id]) {
    if (state[id].mainMsgId) await bot.telegram.deleteMessage(CHAT_ID, state[id].mainMsgId).catch(() => {})
    if (state[id].fallbackMsgId) await bot.telegram.deleteMessage(CHAT_ID, state[id].fallbackMsgId).catch(() => {})
    delete state[id]
  }

  scheduleAllFromConfig()
  await ctx.reply(`✅ Удалил привычку: ${removed.id} — ${removed.name}`)
})

// /setsummary 23:05
bot.command('setsummary', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Нет доступа 🙂')

  const parts = (ctx.message.text || '').trim().split(/\s+/)
  if (parts.length !== 2) return ctx.reply('Формат: /setsummary <HH:MM>\nПример: /setsummary 23:05')

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
bot.action(/^main:(.+)$/, async (ctx) => {
  const taskId = ctx.match[1]
  const task = config.tasks.find(t => t.id === taskId)
  if (!task) return

  try {
    ensureTaskState(taskId)

    if (!state[taskId].mainActive || state[taskId].mainPressed) {
      await ctx.answerCbQuery('Уже неактуально 🙂')
      return
    }

    state[taskId].mainPressed = true
    state[taskId].mainActive = false
    state[taskId].fallbackActive = false

    const total = addPoints(task.mainPoints, task.id, task.name, 'main')
    await ctx.answerCbQuery(`+${task.mainPoints} ✅`)
    await ctx.editMessageText(`✅ ${task.name} выполнено! +${task.mainPoints}\nСчёт за сегодня: ${total}`)

    if (state[taskId].fallbackMsgId) {
      await bot.telegram.deleteMessage(CHAT_ID, state[taskId].fallbackMsgId).catch(() => {})
      state[taskId].fallbackMsgId = null
    }
  } catch (e) {
    console.log(`[${taskId}] ACTION main ERROR`, e)
  }
})

bot.action(/^fb:(.+)$/, async (ctx) => {
  const taskId = ctx.match[1]
  const task = config.tasks.find(t => t.id === taskId)
  if (!task) return

  try {
    ensureTaskState(taskId)

    if (!state[taskId].fallbackActive || state[taskId].fallbackPressed || state[taskId].mainPressed) {
      await ctx.answerCbQuery('Уже неактуально 🙂')
      return
    }

    state[taskId].fallbackPressed = true
    state[taskId].fallbackActive = false

    const total = addPoints(task.fallbackPoints, task.id, task.name, 'fallback')
    await ctx.answerCbQuery(`+${task.fallbackPoints} 🟡`)
    await ctx.editMessageText(`🟡 ${task.name} поздно, но зачтено: +${task.fallbackPoints}\nСчёт за сегодня: ${total}`)
  } catch (e) {
    console.log(`[${taskId}] ACTION fb ERROR`, e)
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

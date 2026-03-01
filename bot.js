const { Telegraf, Markup } = require('telegraf')
const cron = require('node-cron')
const express = require('express')
const fs = require('fs')
const path = require('path')

const bot = new Telegraf(process.env.BOT_TOKEN)
const app = express()

// твой chat id
const CHAT_ID = 653653812

const TZ = 'Europe/Moscow'
const DATA_FILE = path.join(__dirname, 'data.json')

// ===== Хранилище очков =====
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
function todayKey() {
  // YYYY-MM-DD по Москве
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date())
}
function nowMsk() {
  return new Date().toLocaleString('ru-RU', { timeZone: TZ })
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

// ===== Конфиг привычек =====
// cron формат: "минута час * * *"
const TASKS = [
  {
    id: 'wake',
    name: 'Подъём',
    mainStart: '0 7 * * *',     // 07:00
    mainEnd: '10 7 * * *',      // 07:10
    fallbackEnd: '30 7 * * *',  // 07:30
    mainPoints: 3,
    fallbackPoints: 1,
    mainBtn: '✅ Подъём (+3)',
    fallbackBtn: '🟡 Подъём (+1)'
  },
  {
    id: 'run',
    name: 'Бег',
    mainStart: '11 7 * * *',    // 07:11
    mainEnd: '15 7 * * *',      // 07:15
    fallbackEnd: '30 7 * * *',  // 07:30
    mainPoints: 3,
    fallbackPoints: 1,
    mainBtn: '✅ Бег (+3)',
    fallbackBtn: '🟡 Бег (+1)'
  },
  {
    id: 'plan',
    name: 'План на день',
    mainStart: '0 8 * * *',     // 08:00
    mainEnd: '20 8 * * *',      // 08:20
    fallbackEnd: '0 9 * * *',   // 09:00
    mainPoints: 3,
    fallbackPoints: 1,
    mainBtn: '✅ План (+3)',
    fallbackBtn: '🟡 План (+1)'
  },
  {
    id: 'report',
    name: 'Отчёт',
    mainStart: '0 22 * * *',     // 22:00
    mainEnd: '30 22 * * *',      // 22:30
    fallbackEnd: '0 23 * * *',   // 23:00
    mainPoints: 3,
    fallbackPoints: 1,
    mainBtn: '✅ Отчёт (+3)',
    fallbackBtn: '🟡 Отчёт (+1)'
  }
]

// ===== Состояние по задачам (сообщения/окна) =====
const state = Object.fromEntries(
  TASKS.map(t => [t.id, {
    mainActive: false,
    fallbackActive: false,
    mainPressed: false,
    fallbackPressed: false,
    mainMsgId: null,
    fallbackMsgId: null
  }])
)

function resetTaskWindow(taskId) {
  state[taskId].mainActive = false
  state[taskId].fallbackActive = false
  state[taskId].mainPressed = false
  state[taskId].fallbackPressed = false
  state[taskId].mainMsgId = null
  state[taskId].fallbackMsgId = null
}

// ===== Команды =====
bot.start((ctx) => ctx.reply('Бот работает ✅\n/score — очки за сегодня'))

bot.command('score', async (ctx) => {
  const data = loadData()
  const day = todayKey()
  const total = data.days?.[day]?.total ?? 0
  await ctx.reply(`Очки за сегодня (${day}): ${total}`)
})

// ===== Логика окон =====
async function sendMain(task) {
  console.log(`[${task.id}] MAIN START fired at MSK=${nowMsk()}`)
  try {
    resetTaskWindow(task.id)
    state[task.id].mainActive = true

    const msg = await bot.telegram.sendMessage(
      CHAT_ID,
      `⏱ ${task.name}\nНажми в основном окне — +${task.mainPoints}`,
      Markup.inlineKeyboard([
        Markup.button.callback(task.mainBtn, `main:${task.id}`)
      ])
    )
    state[task.id].mainMsgId = msg.message_id
  } catch (e) {
    console.log(`[${task.id}] MAIN START ERROR`, e)
  }
}

async function closeMain(task) {
  console.log(`[${task.id}] MAIN END fired at MSK=${nowMsk()}`)
  try {
    state[task.id].mainActive = false

    if (!state[task.id].mainPressed) {
      // удалить основное сообщение
      if (state[task.id].mainMsgId) {
        await bot.telegram.deleteMessage(CHAT_ID, state[task.id].mainMsgId).catch(() => {})
      }

      // показать запасную кнопку
      state[task.id].fallbackActive = true
      const msg2 = await bot.telegram.sendMessage(
        CHAT_ID,
        `❌ Не успел на +${task.mainPoints} (${task.name}).\nЕсть запасная кнопка — +${task.fallbackPoints} (активна до конца окна)`,
        Markup.inlineKeyboard([
          Markup.button.callback(task.fallbackBtn, `fb:${task.id}`)
        ])
      )
      state[task.id].fallbackMsgId = msg2.message_id
    }
  } catch (e) {
    console.log(`[${task.id}] MAIN END ERROR`, e)
  }
}

async function closeFallback(task) {
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

// ===== Обработчики нажатий =====
bot.action(/^main:(.+)$/, async (ctx) => {
  const taskId = ctx.match[1]
  const task = TASKS.find(t => t.id === taskId)
  if (!task) return

  try {
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

    // если запасное сообщение вдруг уже было — удалим
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
  const task = TASKS.find(t => t.id === taskId)
  if (!task) return

  try {
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

// ===== Итог дня =====
async function sendDailySummary() {
  console.log(`[DAILY] SUMMARY fired at MSK=${nowMsk()}`)
  try {
    const data = loadData()
    const day = todayKey()
    const dayData = data.days?.[day] ?? { total: 0, events: [] }

    let text = `📊 Итоги дня (${day}): ${dayData.total} баллов\n`
    if (dayData.events.length) {
      // сгруппируем по привычкам
      const byTask = {}
      for (const e of dayData.events) {
        const key = e.taskName
        if (!byTask[key]) byTask[key] = 0
        byTask[key] += e.points
      }
      text += '\nПо привычкам:\n' + Object.entries(byTask).map(([k, v]) => `• ${k}: ${v}`).join('\n')
    } else {
      text += '\nСегодня без выполнений.'
    }

    await bot.telegram.sendMessage(CHAT_ID, text)
  } catch (e) {
    console.log('[DAILY] ERROR', e)
  }
}

// 23:05 МСК — итог дня
cron.schedule('5 23 * * *', sendDailySummary, { timezone: TZ })

// ===== Планировщики по задачам =====
for (const task of TASKS) {
  cron.schedule(task.mainStart, () => sendMain(task), { timezone: TZ })
  cron.schedule(task.mainEnd, () => closeMain(task), { timezone: TZ })
  cron.schedule(task.fallbackEnd, () => closeFallback(task), { timezone: TZ })
}

// ===== Web server (Railway) =====
app.get('/', (req, res) => res.send('Bot is running'))
app.listen(process.env.PORT || 3000, () => console.log('Server started'))

bot.launch({ dropPendingUpdates: true })

process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))

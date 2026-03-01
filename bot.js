const { Telegraf, Markup } = require('telegraf')
const cron = require('node-cron')
const express = require('express')
const fs = require('fs')
const path = require('path')

const bot = new Telegraf(process.env.BOT_TOKEN)
const app = express()

// Твой chat id (личка)
const CHAT_ID = 653653812

// ====== Настройки расписания (Москва) ======
const TZ = 'Europe/Moscow'
const MAIN_TIME = '55 16 * * *'    // 16:55 отправка основной кнопки
const MAIN_END = '57 16 * * *'     // 16:57 закрытие основной кнопки + запуск запасной
const FALLBACK_END = '55 17 * * *' // 17:55 закрытие запасной (через 1 час после 16:55)
const DAILY_REPORT = '59 23 * * *' // 23:59 отчёт за день

// ====== Хранилище ======
const DATA_FILE = path.join(__dirname, 'data.json')

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
  const d = new Date()
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d)
  return parts
}

function nowMsk() {
  return new Date().toLocaleString('ru-RU', { timeZone: TZ })
}

function ensureDay(data, day) {
  if (!data.days[day]) {
    data.days[day] = {
      total: 0,
      events: [] // [{time, type, points}]
    }
  }
}

function addPoints(points, type) {
  const data = loadData()
  const day = todayKey()
  ensureDay(data, day)

  data.days[day].total += points
  data.days[day].events.push({
    time: nowMsk(),
    type,
    points
  })

  saveData(data)
  return data.days[day].total
}

// ====== Состояние текущего дня (сообщения/окна) ======
let mainMessageId = null
let fallbackMessageId = null

let mainActive = false
let fallbackActive = false

let mainPressed = false
let fallbackPressed = false

function resetWindowsState() {
  mainMessageId = null
  fallbackMessageId = null
  mainActive = false
  fallbackActive = false
  mainPressed = false
  fallbackPressed = false
}

// ====== Команды ======
bot.start(async (ctx) => {
  await ctx.reply('Бот работает ✅\nКоманды: /score — очки за сегодня')
})

bot.command('score', async (ctx) => {
  const data = loadData()
  const day = todayKey()
  const total = data.days?.[day]?.total ?? 0

  await ctx.reply(`Очки за сегодня (${day}): ${total}`)
})

// ====== Основная кнопка (3 балла) ======
async function sendMainButton() {
  console.log(`[CRON MAIN SEND] fired at MSK=${nowMsk()}`)

  try {
    // новая попытка дня
    resetWindowsState()
    mainActive = true

    const msg = await bot.telegram.sendMessage(
      CHAT_ID,
      '⏱ У тебя 2 минуты! Нажимай кнопку 👇\n(за неё +3 балла)',
      Markup.inlineKeyboard([Markup.button.callback('✅ Успеть (+3)', 'main_press')])
    )

    mainMessageId = msg.message_id
    console.log(`[CRON MAIN SEND] sent message_id=${mainMessageId}`)
  } catch (e) {
    console.log('[CRON MAIN SEND] ERROR:', e)
  }
}

// ====== Закрыть основное окно; если не успел — показать запасную (1 балл) ======
async function closeMainAndMaybeFallback() {
  console.log(`[CRON MAIN CLOSE] fired at MSK=${nowMsk()}`)

  try {
    mainActive = false

    // если основное не нажато — удаляем сообщение и запускаем запасную кнопку
    if (!mainPressed) {
      if (mainMessageId) {
        await bot.telegram.deleteMessage(CHAT_ID, mainMessageId).catch(() => {})
      }

      // включаем запасную на 1 час
      fallbackActive = true

      const msg2 = await bot.telegram.sendMessage(
        CHAT_ID,
        '❌ Ты не успел на +3.\nНо есть шанс в течение часа 👇 (+1 балл)',
        Markup.inlineKeyboard([Markup.button.callback('🟡 Поздно, но засчитать (+1)', 'fallback_press')])
      )

      fallbackMessageId = msg2.message_id
      console.log(`[CRON FALLBACK SEND] sent message_id=${fallbackMessageId}`)
    } else {
      console.log('[CRON MAIN CLOSE] main was pressed, no fallback')
    }
  } catch (e) {
    console.log('[CRON MAIN CLOSE] ERROR:', e)
  }
}

// ====== Закрыть запасную кнопку через час ======
async function closeFallbackWindow() {
  console.log(`[CRON FALLBACK CLOSE] fired at MSK=${nowMsk()}`)

  try {
    fallbackActive = false

    if (!fallbackPressed && fallbackMessageId) {
      await bot.telegram.deleteMessage(CHAT_ID, fallbackMessageId).catch(() => {})
      await bot.telegram.sendMessage(CHAT_ID, '⌛ Время вышло. Сегодняшняя попытка закрыта.')
      console.log('[CRON FALLBACK CLOSE] fallback expired')
    } else {
      console.log('[CRON FALLBACK CLOSE] fallback was pressed or no message')
    }
  } catch (e) {
    console.log('[CRON FALLBACK CLOSE] ERROR:', e)
  }
}

// ====== Нажатия ======
bot.action('main_press', async (ctx) => {
  try {
    // защита от повторов/неактивного окна
    if (!mainActive || mainPressed) {
      await ctx.answerCbQuery('Уже неактуально 🙂', { show_alert: false })
      return
    }

    mainPressed = true
    mainActive = false
    fallbackActive = false // запасная не нужна

    const total = addPoints(3, 'main(+3)')

    await ctx.answerCbQuery('Засчитано: +3 ✅')
    // редактируем исходное сообщение с кнопкой
    await ctx.editMessageText(`✅ Успел! +3 балла.\nТекущий счёт за сегодня: ${total}`)

    // если вдруг уже была запасная — удалим
    if (fallbackMessageId) {
      await bot.telegram.deleteMessage(CHAT_ID, fallbackMessageId).catch(() => {})
      fallbackMessageId = null
    }
  } catch (e) {
    console.log('[ACTION main_press] ERROR:', e)
  }
})

bot.action('fallback_press', async (ctx) => {
  try {
    // если запасная не активна — отказываем
    if (!fallbackActive || fallbackPressed || mainPressed) {
      await ctx.answerCbQuery('Уже неактуально 🙂', { show_alert: false })
      return
    }

    fallbackPressed = true
    fallbackActive = false

    const total = addPoints(1, 'fallback(+1)')

    await ctx.answerCbQuery('Засчитано: +1 🟡')
    await ctx.editMessageText(`🟡 Поздно, но засчитано: +1 балл.\nТекущий счёт за сегодня: ${total}`)
  } catch (e) {
    console.log('[ACTION fallback_press] ERROR:', e)
  }
})

// ====== Отчёт в конце дня ======
async function sendDailyReport() {
  console.log(`[CRON DAILY REPORT] fired at MSK=${nowMsk()}`)

  try {
    const data = loadData()
    const day = todayKey()
    const dayData = data.days?.[day]
    const total = dayData?.total ?? 0
    const events = dayData?.events ?? []

    let text = `📊 Итоги дня (${day}): ${total} баллов\n`
    if (events.length) {
      text += '\nСобытия:\n' + events.map(e => `• ${e.time} — ${e.type}: +${e.points}`).join('\n')
    } else {
      text += '\nСобытий не было.'
    }

    await bot.telegram.sendMessage(CHAT_ID, text)

    // после отчёта можно сбросить окна (на новый день)
    resetWindowsState()
  } catch (e) {
    console.log('[CRON DAILY REPORT] ERROR:', e)
  }
}

// ====== Cron расписания (Москва) ======
cron.schedule(MAIN_TIME, sendMainButton, { timezone: TZ })
cron.schedule(MAIN_END, closeMainAndMaybeFallback, { timezone: TZ })
cron.schedule(FALLBACK_END, closeFallbackWindow, { timezone: TZ })
cron.schedule(DAILY_REPORT, sendDailyReport, { timezone: TZ })

// ====== Web server (Railway требует порт) ======
app.get('/', (req, res) => res.send('Bot is running'))
app.listen(process.env.PORT || 3000, () => console.log('Server started'))

// 409 защита при рестартах
bot.launch({ dropPendingUpdates: true })

process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))

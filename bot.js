const { Telegraf, Markup } = require('telegraf')
const cron = require('node-cron')
const express = require('express')

const bot = new Telegraf(process.env.BOT_TOKEN)
const app = express()

// Твой chat id (личка)
const CHAT_ID = 653653812

let lastMessageId = null
let wasPressed = false

function nowMsk() {
  return new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })
}

// Команда /start
bot.start((ctx) => {
  ctx.reply('Бот работает ✅')
})

// =====================
// 16:55 — отправить кнопку
// =====================
cron.schedule(
  '50 17 * * *',
  async () => {
    console.log(`[CRON 16:55] fired at MSK=${nowMsk()}`)

    try {
      wasPressed = false

      const message = await bot.telegram.sendMessage(
        CHAT_ID,
        'У тебя 2 минуты! Нажимай кнопку 👇',
        Markup.inlineKeyboard([Markup.button.callback('Успеть!', 'press')])
      )

      lastMessageId = message.message_id
      console.log(`[CRON 16:55] sent message_id=${lastMessageId}`)
    } catch (e) {
      console.log('[CRON 16:55] ERROR:', e)
    }
  },
  { timezone: 'Europe/Moscow' }
)

// =====================
// 17:51 — удалить и написать “не успел”
// =====================
cron.schedule(
  '57 16 * * *',
  async () => {
    console.log(`[CRON 16:57] fired at MSK=${nowMsk()}`)

    try {
      if (!wasPressed && lastMessageId) {
        await bot.telegram.deleteMessage(CHAT_ID, lastMessageId)
        console.log(`[CRON 16:57] deleted message_id=${lastMessageId}`)

        await bot.telegram.sendMessage(
          CHAT_ID,
          'Ты не успел, в следующий раз получится 😔'
        )
        console.log('[CRON 16:57] sent fail message')
      } else {
        console.log(
          `[CRON 16:57] skip (wasPressed=${wasPressed}, lastMessageId=${lastMessageId})`
        )
      }
    } catch (e) {
      console.log('[CRON 16:57] ERROR:', e)
    }
  },
  { timezone: 'Europe/Moscow' }
)

// =====================
// Нажатие кнопки
// =====================
bot.action('press', async (ctx) => {
  try {
    wasPressed = true
    await ctx.answerCbQuery()
    // заменяем сообщение с кнопкой на текст "успел"
    await ctx.editMessageText('Ты успел! 🎉')
    console.log(`[BUTTON] pressed at MSK=${nowMsk()}`)
  } catch (e) {
    console.log('[BUTTON] ERROR:', e)
  }
})

// =====================
// Web server (нужен Railway)
// =====================
app.get('/', (req, res) => {
  res.send('Bot is running')
})

// Чтобы не ловить 409 при перезапусках
bot.launch({ dropPendingUpdates: true })

app.listen(process.env.PORT || 3000, () => {
  console.log('Server started')
})

// Корректное завершение
process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))

const { Telegraf, Markup } = require('telegraf')
const cron = require('node-cron')
const express = require('express')

const bot = new Telegraf(process.env.BOT_TOKEN)
const app = express()

// 👉 ВСТАВЬ СЮДА СВОЙ CHAT_ID
const CHAT_ID = 653653812  // без кавычек

let lastMessageId = null
let wasPressed = false

// ===== START =====
bot.start((ctx) => {
  ctx.reply('Бот работает ✅')
})

// ===== 16:55 — отправка кнопки =====
cron.schedule('00 17 * * *', async () => {
  try {
    wasPressed = false

    const message = await bot.telegram.sendMessage(
      CHAT_ID,
      'У тебя 2 минуты! Нажимай кнопку 👇',
      Markup.inlineKeyboard([
        Markup.button.callback('Успеть!', 'press')
      ])
    )

    lastMessageId = message.message_id
    console.log('Сообщение отправлено')

  } catch (error) {
    console.log(error)
  }

}, {
  timezone: "Europe/Moscow"
})


// ===== 16:57 — удаление и сообщение о неуспехе =====
cron.schedule('01 17 * * *', async () => {
  try {
    if (!wasPressed && lastMessageId) {

      await bot.telegram.deleteMessage(CHAT_ID, lastMessageId)

      await bot.telegram.sendMessage(
        CHAT_ID,
        'Ты не успел, в следующий раз получится 😔'
      )

      console.log('Сообщение удалено, отправлено уведомление')
    }

  } catch (error) {
    console.log(error)
  }

}, {
  timezone: "Europe/Moscow"
})


// ===== НАЖАТИЕ КНОПКИ =====
bot.action('press', async (ctx) => {
  try {
    wasPressed = true

    await ctx.answerCbQuery()
    await ctx.editMessageText('Ты успел! 🎉')

    console.log('Кнопка нажата')

  } catch (error) {
    console.log(error)
  }
})


// ===== Web сервер (нужен для Railway) =====
app.get('/', (req, res) => {
  res.send('Bot is running')
})

bot.launch()

app.listen(process.env.PORT || 3000, () => {
  console.log('Server started')
})

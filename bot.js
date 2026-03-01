const { Telegraf, Markup } = require('telegraf')
const cron = require('node-cron')
const express = require('express')

const bot = new Telegraf(process.env.BOT_TOKEN)
const app = express()

let lastMessageId = null
const CHAT_ID = '653653812'

// ===== КОМАНДА START =====
bot.start((ctx) => {
  ctx.reply('Бот работает ✅')
})

// ===== 08:00 ОТПРАВКА =====
cron.schedule('57 16 * * *', async () => {
  try {
    const message = await bot.telegram.sendMessage(
      CHAT_ID,
      'У тебя 10 минут! Нажимай кнопку 👇',
      Markup.inlineKeyboard([
        Markup.button.callback('Успеть!', 'press')
      ])
    )

    lastMessageId = message.message_id
  } catch (error) {
    console.log(error)
  }
})

// ===== 08:10 УДАЛЕНИЕ =====
cron.schedule('58 16 * * *', async () => {
  try {
    if (lastMessageId) {
      await bot.telegram.deleteMessage(CHAT_ID, lastMessageId)
    }

    await bot.telegram.sendMessage(
      CHAT_ID,
      'Ты не успел, в следующий раз получится 😔'
    )
  } catch (error) {
    console.log(error)
  }
})

// ===== НАЖАТИЕ =====
bot.action('press', async (ctx) => {
  await ctx.answerCbQuery()
  await ctx.reply('Ты успел! 🎉')
})

// ===== WEB SERVER (Railway требует) =====
app.get('/', (req, res) => {
  res.send('Bot is running')
})

bot.launch()

app.listen(process.env.PORT || 3000, () => {
  console.log('Server started')
})

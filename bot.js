const { Telegraf, Markup } = require('telegraf')

const bot = new Telegraf(process.env.BOT_TOKEN)

bot.start((ctx) => {
  ctx.reply(
    'Привет! Вот кнопка:',
    Markup.inlineKeyboard([
      Markup.button.callback('Нажми меня', 'press')
    ])
  )
})

bot.action('press', async (ctx) => {
  await ctx.answerCbQuery()
  await ctx.reply('Кнопка была нажата!')
})

// Render требует веб-сервер
const express = require('express')
const app = express()

app.get('/', (req, res) => {
  res.send('Bot is running')
})

bot.launch()

app.listen(process.env.PORT || 3000, () => {
  console.log('Server started')
})

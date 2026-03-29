const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')
const pino = require('pino')

// ===== הגדרות =====
const OWNER_PHONE = '972507983306'
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY

// היסטוריית שיחות לכל משתמש
const conversations = {}

// ===== מערכת ג'ימי החכם =====
const JIMMY_SYSTEM = `אתה ג'ימי, העוזר האישי של יאיר - ספר ובעל חנות בגדים בלוד.
אתה מדבר עברית, בשפה ישראלית קז'ואלית וחברותית - כמו אחי, חברה, וכו'.
אתה תמיד בזכר.

פרטי העסק:
- שם: ספרייה וחנות בגדים של יאיר
- כתובת: אלי כהן 12, לוד
- שעות פעילות: ימים א-ה 08:00-20:00, יום ו 08:00-14:00, שבת סגור
- קישור ישיר ליאיר: https://wa.me/972507983306

הוראות התנהגות:
1. דבר תמיד בצורה חברותית וטבעית, לא רובוטית
2. אם מישהו שואל על תור, רוצה לבוא, שואל אם אפשר היום - שאל באיזה יום ושעה ואשר את התור בחברותיות
3. אם מישהו שואל על שעות או כתובת - ענה ישר
4. אם מישהו שואל על בגדים, מלאי, מחירים, מבצעים - תגיד שהמלאי משתנה כל הזמן ותעביר ליאיר: https://wa.me/972507983306
5. אם ההודעה נראית אישית (חבר/משפחה שמדבר עם יאיר ישירות) - תגיד בחברותיות שתעביר ליאיר: https://wa.me/972507983306
6. לעולם אל תמציא מחירים או מידע על בגדים
7. שמור על שיחה טבעית וזכור מה נאמר קודם`

async function askJimmy(userPhone, userMessage) {
  if (!conversations[userPhone]) conversations[userPhone] = []
  conversations[userPhone].push({ role: 'user', content: userMessage })

  if (conversations[userPhone].length > 20) {
    conversations[userPhone] = conversations[userPhone].slice(-20)
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 500,
      system: JIMMY_SYSTEM,
      messages: conversations[userPhone]
    })
  })

  const data = await response.json()
  const reply = data.content[0].text

  conversations[userPhone].push({ role: 'assistant', content: reply })
  return reply
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info')
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    auth: state,
    printQRInTerminal: true,
    browser: ['Jimmy Bot', 'Chrome', '1.0'],
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\n✂️ ===== בוט של יאיר - גי\'מי =====')
      console.log('📱 סרוק את ה-QR Code עם הוואטסאפ של יאיר')
      console.log('וואטסאפ → שלוש נקודות → מכשירים מקושרים → קשר מכשיר')
      console.log('=====================================\n')
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
        : true
      if (shouldReconnect) setTimeout(startBot, 3000)
    }

    if (connection === 'open') {
      console.log("✅ ג'ימי מחובר ועובד! 💈")
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return

    for (const msg of messages) {
      if (msg.key.fromMe) continue
      if (msg.key.remoteJid.endsWith('@g.us')) continue

      const sender = msg.key.remoteJid
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        ''

      if (!text) continue

      console.log(`📩 מ-${sender}: ${text}`)

      try {
        await sock.sendPresenceUpdate('composing', sender)
        const reply = await askJimmy(sender, text)
        await sock.sendMessage(sender, { text: reply })
        console.log(`📤 ג'ימי ענה`)
      } catch (err) {
        console.error('שגיאה:', err)
        await sock.sendMessage(sender, {
          text: 'אוי, משהו השתבש אצלי 😅 נסה שוב עוד רגע!'
        })
      }
    }
  })
}

startBot()

import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import pino from 'pino'

const OWNER_PHONE = '972507983306'
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY

const conversations = {}

const JIMMY_SYSTEM = `אתה ג'ימי, העוזר האישי של יאיר - ספר ובעל חנות בגדים בלוד.
אתה מדבר עברית, בשפה ישראלית קז'ואלית וחברותית.
אתה תמיד בזכר.

פרטי העסק:
- כתובת: אלי כהן 12, לוד
- שעות: ימים א-ה 08:00-20:00, יום ו 08:00-14:00, שבת סגור
- קישור ליאיר: https://wa.me/972507983306

הוראות:
1. דבר בצורה חברותית וטבעית, לא רובוטית
2. אם מישהו רוצה תור או שואל אם אפשר לבוא - שאל יום ושעה ואשר את התור
3. שעות וכתובת - ענה ישר
4. שאלות על בגדים, מלאי, מחירים - תגיד שהמלאי משתנה ותעביר ליאיר: https://wa.me/972507983306
5. הודעות אישיות - העבר ליאיר: https://wa.me/972507983306
6. לעולם אל תמציא מחירים`

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
      model: 'claude-haiku-4-5-20251001',
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
  const logger = pino({ level: 'silent' })

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: true,
    browser: ['Jimmy', 'Chrome', '1.0'],
    syncFullHistory: false,
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\n===== סרוק את ה-QR עם הוואטסאפ של יאיר =====')
      console.log('וואטסאפ → שלוש נקודות → מכשירים מקושרים → קשר מכשיר')
    }
    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode
      if (code !== DisconnectReason.loggedOut) {
        console.log('מתחבר מחדש...')
        setTimeout(startBot, 3000)
      }
    }
    if (connection === 'open') {
      console.log("✅ ג'ימי מחובר ועובד!")
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
        msg.message?.imageMessage?.caption || ''

      if (!text) continue
      console.log(`📩 ${sender}: ${text}`)

      try {
        await sock.sendPresenceUpdate('composing', sender)
        const reply = await askJimmy(sender, text)
        await sock.sendMessage(sender, { text: reply })
      } catch (err) {
        console.error('שגיאה:', err?.message)
        await sock.sendMessage(sender, { text: 'אוי משהו השתבש 😅 נסה שוב!' })
      }
    }
  })
}

startBot()

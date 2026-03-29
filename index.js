import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import pino from 'pino'
import { toDataURL } from 'qrcode'
import { createServer } from 'http'

const OWNER_PHONE = '972507983306@s.whatsapp.net'
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
const MAX_PER_SLOT = 2
const conversations = {}
const appointments = {}
let botSocket = null

let currentQR = null
createServer((req, res) => {
  if (currentQR) {
    toDataURL(currentQR, (err, url) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(`<html><body style="display:flex;justify-content:center;align-items:center;height:100vh;background:#111">
        <div style="text-align:center">
          <h2 style="color:white;font-family:sans-serif">סרוק עם וואטסאפ של יאיר</h2>
          <img src="${url}" style="width:300px;height:300px"/>
          <p style="color:#aaa;font-family:sans-serif">וואטסאפ ← שלוש נקודות ← מכשירים מקושרים ← קשר מכשיר</p>
        </div>
      </body></html>`)
    })
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(`<html><body style="background:#111;color:white;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh"><h2>✅ הבוט מחובר!</h2></body></html>`)
  }
}).listen(process.env.PORT || 3000)

// ========== פונקציית תאריך ישראלי ==========
function getIsraeliDateInfo() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }))
  const days = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת']
  const today = days[now.getDay()]
  const tomorrow = days[(now.getDay() + 1) % 7]
  const currentHour = now.getHours()
  const currentMinutes = now.getMinutes()
  const currentTime = `${String(currentHour).padStart(2, '0')}:${String(currentMinutes).padStart(2, '0')}`
  return { today, tomorrow, currentTime, currentHour, dayIndex: now.getDay() }
}

// ========== פונקציות ניהול תורים ==========
function getSlotKey(day, time) {
  return `${day}-${time}`
}

function isSlotAvailable(day, time) {
  const key = getSlotKey(day, time)
  return (appointments[key] || 0) < MAX_PER_SLOT
}

function bookSlot(day, time) {
  const key = getSlotKey(day, time)
  appointments[key] = (appointments[key] || 0) + 1
}

function getAvailableSlots(day) {
  const allSlots = ['08:00','09:00','10:00','11:00','12:00','13:00','14:00','15:00','16:00','17:00','18:00','19:00']
  // ביום שישי עד 14:00 בלבד
  const fridaySlots = ['08:00','09:00','10:00','11:00','12:00','13:00']
  const slots = day === 'שישי' ? fridaySlots : allSlots
  return slots.filter(t => isSlotAvailable(day, t))
}

// ========== System Prompt ==========
const JIMMY_SYSTEM_BASE = `אתה ג'ימי, העוזר האישי של יאיר - ספר ובעל חנות בגדים בלוד.
אתה מדבר עברית, בשפה ישראלית קז'ואלית וחברותית - "אחי", "וואלה", "סבבה" וכו'.
אתה תמיד בזכר.
ברכת הפתיחה שלך תמיד: "היי מה קורה? 👋 אני ג'ימי העוזר האישי של יאיר, איך אני יכול לעזור אחי? 😊"

פרטי העסק:
- כתובת: אלי כהן 12, לוד
- ניווט בוויז: https://waze.com/ul?q=אלי+כהן+12+לוד&navigate=yes
- שעות: ימים א-ה 08:00-20:00, יום ו 08:00-14:00, שבת סגור
- מקסימום 2 לקוחות בכל שעה
- קישור ליאיר: https://wa.me/972507983306

הוראות:
1. דבר בצורה חברותית וטבעית, לא רובוטית
2. אם מישהו רוצה תור - שאל יום ושעה
3. כשלקוח אומר "היום" או "מחר" - השתמש בימים הנוכחיים שקיבלת בהקשר
4. לפני אישור תור - המערכת תבדוק אם השעה פנויה. אם קיבלת SLOT_FULL בהקשר - תגיד ללקוח שהשעה תפוסה ותציע שעות אחרות
5. כשתור אושר סופית - כתוב בדיוק כך: APPOINTMENT_BOOKED,יום:XXX,שעה:XXX
   ואז מיד אחרי זה שלח ללקוח סיכום יפה בפורמט הזה:
   "✅ *סבבה, הכל מסודר אחי!*
   📅 *יום:* [שם היום]
   ⏰ *שעה:* [השעה]
   📍 *כתובת:* אלי כהן 12, לוד
   מחכים לך! 💈"
6. שעות וכתובת - ענה ישר
7. שאלות על בגדים - תגיד שהמלאי משתנה ותעביר ליאיר: https://wa.me/972507983306
8. הודעות אישיות - העבר ליאיר: https://wa.me/972507983306
9. אל תקבע תור ביום שבת - העסק סגור
10. ביום שישי - תורים רק עד 14:00`

// ========== שאילת ג'ימי ==========
async function askJimmy(userPhone, userMessage) {
  if (!conversations[userPhone]) conversations[userPhone] = []

  // קבל מידע על הזמן הנוכחי בישראל
  const { today, tomorrow, currentTime, dayIndex } = getIsraeliDateInfo()

  // הוסף מידע דינמי ל-system prompt
  const dynamicSystem = JIMMY_SYSTEM_BASE + `

==מידע נוכחי==
- היום: יום ${today}
- מחר: יום ${tomorrow}
- השעה עכשיו בישראל: ${currentTime}
- כשלקוח אומר "היום" - הכוונה ליום ${today}
- כשלקוח אומר "מחר" - הכוונה ליום ${tomorrow}
- אם היום שבת (dayIndex=6) ומישהו רוצה תור היום - אמור שהעסק סגור היום ותציע מחר`

  // זיהוי יום ושעה מההודעה
  const timeMatch = userMessage.match(/(\d{1,2}:\d{2}|\b\d{1,2}\b)/)
  const dayMatch = userMessage.match(/(ראשון|שני|שלישי|רביעי|חמישי|שישי|א'|ב'|ג'|ד'|ה'|ו'|מחר|היום)/)

  let contextMessage = userMessage

  if (timeMatch && dayMatch) {
    let time = timeMatch[0].includes(':') ? timeMatch[0] : `${timeMatch[0]}:00`
    // פד עם אפס אם צריך (7:00 -> 07:00)
    if (time.length === 4) time = '0' + time

    // המר "היום"/"מחר" לשם יום אמיתי
    let resolvedDay = dayMatch[0]
    if (resolvedDay === 'היום') resolvedDay = today
    if (resolvedDay === 'מחר') resolvedDay = tomorrow

    if (!isSlotAvailable(resolvedDay, time)) {
      const available = getAvailableSlots(resolvedDay)
      const availableText = available.length > 0 ? available.join(', ') : 'אין שעות פנויות ביום זה'
      contextMessage = userMessage + `\n[SLOT_FULL - השעה ${time} ביום ${resolvedDay} תפוסה! שעות פנויות: ${availableText}]`
    }
  }

  conversations[userPhone].push({ role: 'user', content: contextMessage })
  if (conversations[userPhone].length > 20) conversations[userPhone] = conversations[userPhone].slice(-20)

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
      system: dynamicSystem,
      messages: conversations[userPhone]
    })
  })

  const data = await response.json()
  let reply = data.content[0].text
  conversations[userPhone].push({ role: 'assistant', content: reply })

  // בדוק אם נקבע תור
  if (reply.includes('APPOINTMENT_BOOKED')) {
    const parts = reply.split('APPOINTMENT_BOOKED,')
    const details = parts[1] || ''

    const dayM = details.match(/יום:([^,\n]+)/)
    const timeM = details.match(/שעה:([^,\n\s]+)/)

    if (dayM && timeM) {
      let day = dayM[1].trim()
      let time = timeM[1].trim()

      // המר "היום"/"מחר" לשם יום אמיתי גם כאן
      if (day === 'היום') day = today
      if (day === 'מחר') day = tomorrow

      if (isSlotAvailable(day, time)) {
        bookSlot(day, time)
        await notifyYair(`📅 יום: ${day}\n⏰ שעה: ${time}`, userPhone)
      }
    }

    // הסר את שורת APPOINTMENT_BOOKED מהתשובה ללקוח
    reply = parts[0].trim()

    // אם הסיכום לא נכלל בתשובה - הוסף אותו
    if (!reply.includes('✅')) {
      const day = dayM?.[1]?.trim() === 'היום' ? today : dayM?.[1]?.trim() === 'מחר' ? tomorrow : dayM?.[1]?.trim()
      const time = timeM?.[1]?.trim()
      if (day && time) {
        reply += `\n\n✅ *סבבה, הכל מסודר אחי!*\n📅 *יום:* ${day}\n⏰ *שעה:* ${time}\n📍 *כתובת:* אלי כהן 12, לוד\n🗺️ *וויז:* https://waze.com/ul?q=אלי+כהן+12+לוד&navigate=yes\nמחכים לך! 💈`
      }
    }
  }

  return reply
}

// ========== שליחת הודעה ליאיר ==========
async function notifyYair(appointmentDetails, customerPhone) {
  if (!botSocket) return
  try {
    const msg = `✂️ *תור חדש נקבע!*\n\n${appointmentDetails}\n📱 לקוח: ${customerPhone.replace('@s.whatsapp.net', '')}`
    await botSocket.sendMessage(OWNER_PHONE, { text: msg })
  } catch (err) {
    console.error('שגיאה בשליחה ליאיר:', err?.message)
  }
}

// ========== הפעלת הבוט ==========
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info')
  const { version } = await fetchLatestBaileysVersion()
  const logger = pino({ level: 'silent' })

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    printQRInTerminal: false,
    browser: ['Jimmy', 'Chrome', '1.0'],
    syncFullHistory: false,
  })

  botSocket = sock
  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) { currentQR = qr; console.log('✅ QR מוכן!') }
    if (connection === 'open') { currentQR = null; console.log("✅ ג'ימי מחובר!") }
    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode
      if (code !== DisconnectReason.loggedOut) setTimeout(startBot, 3000)
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

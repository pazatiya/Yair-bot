import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import pino from 'pino'
import { toDataURL } from 'qrcode'
import { createServer } from 'http'
import { writeFileSync, readFileSync, existsSync } from 'fs'

const OWNER_PHONE = '972507983306@s.whatsapp.net'
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
const MAX_PER_SLOT = 2
const conversations = {}
const appointments = {}
let botSocket = null

// ========== שמירת תזכורות ==========
const REMINDERS_FILE = 'reminders.json'

function loadReminders() {
  if (existsSync(REMINDERS_FILE)) {
    try { return JSON.parse(readFileSync(REMINDERS_FILE, 'utf8')) } catch { return [] }
  }
  return []
}

function saveReminders(reminders) {
  writeFileSync(REMINDERS_FILE, JSON.stringify(reminders, null, 2))
}

function addReminder(phone, day, time, resolvedDate) {
  const reminders = loadReminders()
  const filtered = reminders.filter(r => r.phone !== phone)
  filtered.push({ phone, day, time, resolvedDate, sentDay: false, sentHour: false })
  saveReminders(filtered)
}

// ========== שרת HTTP לQR ==========
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
  return { today, tomorrow, currentTime, currentHour, dayIndex: now.getDay(), now }
}

function resolveToDate(dayName, isToday, isTomorrow) {
  const { now } = getIsraeliDateInfo()
  if (isToday) return new Date(now)
  if (isTomorrow) {
    const d = new Date(now)
    d.setDate(d.getDate() + 1)
    return d
  }
  const dayMap = { 'ראשון': 0, 'שני': 1, 'שלישי': 2, 'רביעי': 3, 'חמישי': 4, 'שישי': 5, 'שבת': 6 }
  const target = dayMap[dayName]
  if (target === undefined) return null
  const d = new Date(now)
  const diff = (target - d.getDay() + 7) % 7 || 7
  d.setDate(d.getDate() + diff)
  return d
}

// ========== ניהול תורים ==========
function getSlotKey(day, time) { return `${day}-${time}` }
function isSlotAvailable(day, time) {
  return (appointments[getSlotKey(day, time)] || 0) < MAX_PER_SLOT
}
function bookSlot(day, time) {
  const key = getSlotKey(day, time)
  appointments[key] = (appointments[key] || 0) + 1
}
function getAvailableSlots(day) {
  const allSlots = ['08:00','09:00','10:00','11:00','12:00','13:00','14:00','15:00','16:00','17:00','18:00','19:00']
  const fridaySlots = ['08:00','09:00','10:00','11:00','12:00','13:00']
  const slots = day === 'שישי' ? fridaySlots : allSlots
  return slots.filter(t => isSlotAvailable(day, t))
}

// ========== System Prompt ==========
const JIMMY_SYSTEM_BASE = `אתה ג'ימי, העוזר האישי של יאיר - ספר בלוד.
אתה מדבר עברית, בשפה ישראלית קז'ואלית וחברותית - "אחי", "וואלה", "סבבה" וכו'.
אתה תמיד בזכר.
ברכת הפתיחה שלך תמיד: "היי מה קורה? 👋 אני ג'ימי העוזר האישי של יאיר 😊 איך אני יכול לעזור?"

פרטי העסק:
- כתובת: אלי כהן 12, לוד
- ניווט בוויז: https://waze.com/ul?q=אלי+כהן+12+לוד&navigate=yes
- שעות: ימים א-ה 08:00-20:00, יום ו 08:00-14:00, שבת סגור

הוראות:
1. דבר בצורה חברותית וטבעית, לא רובוטית
2. אם מישהו רוצה תור - שאל יום ושעה
3. כשלקוח אומר "היום" או "מחר" - השתמש בימים הנוכחיים שקיבלת בהקשר
4. כשלקוח מבקש שעה - ענה תחילה בקצרה "רגע אחי, בודק... 🔍"
5. אם קיבלת SLOT_FULL בהקשר - אמור: "סליחה אחי, השעה XX תפוסה 😅 יש מקום ב-[שעות פנויות] - איזו שעה נוח לך?"
6. אל תסביר על מגבלות או כמות לקוחות - פשוט תגיד תפוס ותציע חלופה
7. כשתור אושר סופית - כתוב APPOINTMENT_BOOKED,יום:XXX,שעה:XXX ואז שלח סיכום:
   "✅ *סבבה, הכל מסודר אחי!*
   📅 *יום:* [יום]
   ⏰ *שעה:* [שעה]
   📍 *כתובת:* אלי כהן 12, לוד
   🗺️ *וויז:* https://waze.com/ul?q=אלי+כהן+12+לוד&navigate=yes
   מחכים לך! 💈"
8. שאלות על בגדים - תגיד שהמלאי משתנה ושאל אם להעביר ליאיר
9. אם מישהו רוצה לדבר עם יאיר - אמור:
   "היי אני ג'ימי העוזר האישי של יאיר 😊 אם אתה רוצה לדבר עם יאיר אני יכול להעביר אותך - רוצה?"
   אם ענה כן - כתוב TRANSFER_TO_YAIR בלבד
10. אל תשלח קישורי wa.me - אם רוצים לדבר עם יאיר תשאל אם להעביר
11. שבת סגור, ביום שישי תורים עד 14:00 בלבד
12. אם לא הבנת בכלל מה הלקוח רצה - אמור: "סליחה אחי, לא הבנתי 😅 תוכל להסביר לי שוב מה רצית?"

// ========== שאילת ג'ימי ==========
async function askJimmy(userPhone, userMessage) {
  if (!conversations[userPhone]) conversations[userPhone] = []

  const { today, tomorrow, currentTime } = getIsraeliDateInfo()

  const dynamicSystem = JIMMY_SYSTEM_BASE + `

==מידע נוכחי==
- היום: יום ${today}
- מחר: יום ${tomorrow}
- השעה עכשיו בישראל: ${currentTime}
- כשלקוח אומר "היום" - הכוונה ליום ${today}
- כשלקוח אומר "מחר" - הכוונה ליום ${tomorrow}`

  const timeMatch = userMessage.match(/(\d{1,2}:\d{2}|\b\d{1,2}\b)/)
  const dayMatch = userMessage.match(/(ראשון|שני|שלישי|רביעי|חמישי|שישי|א'|ב'|ג'|ד'|ה'|ו'|מחר|היום)/)

  let contextMessage = userMessage

  if (timeMatch && dayMatch) {
    let time = timeMatch[0].includes(':') ? timeMatch[0] : `${timeMatch[0]}:00`
    if (time.length === 4) time = '0' + time

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

  // ========== תור שנקבע ==========
  if (reply.includes('APPOINTMENT_BOOKED')) {
    const parts = reply.split('APPOINTMENT_BOOKED,')
    const details = parts[1] || ''

    const dayM = details.match(/יום:([^,\n]+)/)
    const timeM = details.match(/שעה:([^,\n\s]+)/)

    if (dayM && timeM) {
      let day = dayM[1].trim()
      let time = timeM[1].trim()

      if (day === 'היום') day = today
      if (day === 'מחר') day = tomorrow

      if (isSlotAvailable(day, time)) {
        bookSlot(day, time)
        const isToday = day === today
        const isTomorrow = day === tomorrow
        const appointmentDate = resolveToDate(day, isToday, isTomorrow)
        if (appointmentDate) addReminder(userPhone, day, time, appointmentDate.toISOString())
        await notifyYair(`📅 יום: ${day}\n⏰ שעה: ${time}`, userPhone)
      }
    }

    reply = parts[0].trim()

    if (!reply.includes('✅')) {
      const day = dayM?.[1]?.trim() === 'היום' ? today : dayM?.[1]?.trim() === 'מחר' ? tomorrow : dayM?.[1]?.trim()
      const time = timeM?.[1]?.trim()
      if (day && time) {
        reply += `\n\n✅ *סבבה, הכל מסודר אחי!*\n📅 *יום:* ${day}\n⏰ *שעה:* ${time}\n📍 *כתובת:* אלי כהן 12, לוד\n🗺️ *וויז:* https://waze.com/ul?q=אלי+כהן+12+לוד&navigate=yes\nמחכים לך! 💈`
      }
    }
  }

  // ========== העברה ליאיר ==========
  if (reply.includes('TRANSFER_TO_YAIR')) {
    reply = 'סבבה אחי! 😊 העברתי את הפרטים ליאיר - הוא יתפנה ויחזור אליך בהקדם, הוא עונה לכולם! 🙌'
    await notifyYair(`📲 לקוח מבקש לדבר איתך ישירות`, userPhone)
  }

  return reply
}

// ========== שליחת הודעה ליאיר ==========
async function notifyYair(details, customerPhone) {
  if (!botSocket) return
  try {
    const phone = customerPhone.replace('@s.whatsapp.net', '')
    const msg = `✂️ *הודעה חדשה!*\n\n${details}\n📱 לקוח: ${phone}\n🔗 wa.me/${phone}`
    await botSocket.sendMessage(OWNER_PHONE, { text: msg })
  } catch (err) {
    console.error('שגיאה בשליחה ליאיר:', err?.message)
  }
}

// ========== מערכת תזכורות ==========
async function sendReminders() {
  if (!botSocket) return
  const reminders = loadReminders()
  if (reminders.length === 0) return

  const { now } = getIsraeliDateInfo()
  let changed = false

  for (const reminder of reminders) {
    if (!reminder.resolvedDate) continue

    const appointmentDate = new Date(reminder.resolvedDate)
    const [hours, minutes] = reminder.time.split(':').map(Number)
    appointmentDate.setHours(hours, minutes, 0, 0)

    const msUntil = appointmentDate - now
    const hoursUntil = msUntil / (1000 * 60 * 60)

    // תזכורת יום לפני
    if (!reminder.sentDay && hoursUntil > 3 && hoursUntil <= 24) {
      try {
        await botSocket.sendMessage(reminder.phone, {
          text: `היי אחי! 👋\nתזכורת - יש לך תור *מחר יום ${reminder.day}* בשעה *${reminder.time}* אצל יאיר 💈\n📍 אלי כהן 12, לוד\n🗺️ https://waze.com/ul?q=אלי+כהן+12+לוד&navigate=yes`
        })
        reminder.sentDay = true
        changed = true
        console.log(`📅 תזכורת יום נשלחה ל-${reminder.phone}`)
      } catch (err) {
        console.error('שגיאה בתזכורת יום:', err?.message)
      }
    }

    // תזכורת 3 שעות לפני
    if (!reminder.sentHour && hoursUntil > 0 && hoursUntil <= 3) {
      try {
        await botSocket.sendMessage(reminder.phone, {
          text: `היי אחי! ⏰\nתזכורת - התור שלך היום בשעה *${reminder.time}* - נתראה בקרוב! 💈\n📍 אלי כהן 12, לוד`
        })
        reminder.sentHour = true
        changed = true
        console.log(`⏰ תזכורת שעה נשלחה ל-${reminder.phone}`)
      } catch (err) {
        console.error('שגיאה בתזכורת שעה:', err?.message)
      }
    }
  }

  // נקה תורים שעברו
  const cleaned = reminders.filter(r => {
    const d = new Date(r.resolvedDate)
    const [h, m] = r.time.split(':').map(Number)
    d.setHours(h, m, 0, 0)
    return d > now
  })

  if (changed || cleaned.length !== reminders.length) saveReminders(cleaned)
}

// ========== הפעלת הבוט ==========
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info')
  const { version } = await fetchLatestBaileysVersion()
  const logger = pino({ level: 'silent' })

  const sock = makeWASocket({
    version, logger,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    printQRInTerminal: false,
    browser: ['Jimmy', 'Chrome', '1.0'],
    syncFullHistory: false,
  })

  botSocket = sock
  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) { currentQR = qr; console.log('✅ QR מוכן!') }
    if (connection === 'open') {
      currentQR = null
      console.log("✅ ג'ימי מחובר!")
      setInterval(sendReminders, 10 * 60 * 1000) // בדיקה כל 10 דקות
    }
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

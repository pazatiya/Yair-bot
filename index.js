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

// ========== משפחת יאיר - עוברים ישירות בלי בוט ==========
const FAMILY_PHONES = [
  '972547734708', // אשתו
  '972549878444', // אדל (בת)
  '972542295295', // לירן (בת)
]

const FAMILY_KEYWORDS = [
  'אבא', 'אמא אמרה', 'מאמי', 'אמי', 'אמא שלי', 'אמא שלנו',
  'אבא שלי', 'אבא שלנו', 'אמרה לי אמא', 'שלחה אותי אמא',
  'זה אדל', 'זה לירן', 'זו אדל', 'זו לירן'
]

function isFamilyMember(sender, text) {
  const phone = sender.replace('@s.whatsapp.net', '')
  if (FAMILY_PHONES.includes(phone)) return true
  return FAMILY_KEYWORDS.some(kw => text.includes(kw))
}

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
          <p style="color:#aaa;font-family:sans-serif">וואטסאפ - שלוש נקודות - מכשירים מקושרים - קשר מכשיר</p>
        </div>
      </body></html>`)
    })
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(`<html><body style="background:#111;color:white;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh"><h2>הבוט מחובר!</h2></body></html>`)
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
  const currentTime = String(currentHour).padStart(2, '0') + ':' + String(currentMinutes).padStart(2, '0')
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
function getSlotKey(day, time) { return day + '-' + time }
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

// ========== סיכום שיחה ==========
function buildConversationSummary(userPhone) {
  const history = conversations[userPhone] || []
  if (history.length === 0) return 'אין היסטוריית שיחה'
  return history
    .map(m => (m.role === 'user' ? 'לקוח: ' : "ג'ימי: ") + m.content)
    .join('\n')
}

// ========== System Prompt ==========
const JIMMY_SYSTEM_BASE = `אתה ג'ימי, העוזר האישי של יאיר - ספר בלוד.
אתה מדבר עברית, בשפה ישראלית קז'ואלית וחברותית - "אחי", "וואלה", "סבבה" וכו'.
אתה תמיד בזכר.
ברכת הפתיחה שלך תמיד: "היי מה קורה? אני ג'ימי העוזר האישי של יאיר, איך אני יכול לעזור?"

פרטי העסק:
- כתובת: אלי כהן 12, לוד
- ניווט בוויז: https://waze.com/ul?q=אלי+כהן+12+לוד&navigate=yes
- שעות: ימים א-ה 08:00-20:00, יום ו 08:00-14:00, שבת סגור

הוראות:
1. דבר בצורה חברותית וטבעית, לא רובוטית
2. אם מישהו רוצה תור - שאל יום ושעה
3. כשלקוח אומר "היום" או "מחר" - השתמש בימים הנוכחיים שקיבלת בהקשר
4. כשלקוח מבקש שעה - ענה תחילה בקצרה "רגע אחי, בודק..."
5. אם קיבלת SLOT_FULL בהקשר - אמור: "סליחה אחי, השעה XX תפוסה, יש מקום ב-[שעות פנויות] - איזו שעה נוח לך?"
6. אל תסביר על מגבלות או כמות לקוחות - פשוט תגיד תפוס ותציע חלופה
7. כשתור אושר סופית - כתוב APPOINTMENT_BOOKED,יום:XXX,שעה:XXX ואז שלח סיכום ללקוח עם היום, שעה, כתובת וקישור וויז
8. שאלות על בגדים - תגיד שהמלאי משתנה ושאל אם להעביר ליאיר
9. אם מישהו רוצה לדבר עם יאיר - אמור:
   "בטח! רק תגיד לי את שמך ובמה יאיר יכול לעזור לך - ואני אעביר לו את הפרטים"
   אחרי שהלקוח נותן שם ונושא - אמור:
   "סבבה [שם]! העברתי את הפרטים ליאיר - כשהוא יתפנה הוא יחזור אליך בהקדם, הוא עונה לכולם!"
   ואז כתוב בשורה נפרדת: TRANSFER_TO_YAIR,שם:[שם],נושא:[נושא]
10. אל תשלח קישורי wa.me ללקוחות
11. שבת סגור, ביום שישי תורים עד 14:00 בלבד
12. אם לא הבנת בכלל מה הלקוח רצה - אמור: "סליחה אחי, לא הבנתי, תוכל להסביר לי שוב מה רצית?"`

// ========== שאילת ג'ימי ==========
async function askJimmy(userPhone, userMessage) {
  if (!conversations[userPhone]) conversations[userPhone] = []

  const { today, tomorrow, currentTime } = getIsraeliDateInfo()

  const dynamicSystem = JIMMY_SYSTEM_BASE + '\n\n--- מידע נוכחי ---\n- היום: יום ' + today + '\n- מחר: יום ' + tomorrow + '\n- השעה עכשיו בישראל: ' + currentTime + '\n- כשלקוח אומר "היום" - הכוונה ליום ' + today + '\n- כשלקוח אומר "מחר" - הכוונה ליום ' + tomorrow

  const timeMatch = userMessage.match(/(\d{1,2}:\d{2}|\b\d{1,2}\b)/)
  const dayMatch = userMessage.match(/(ראשון|שני|שלישי|רביעי|חמישי|שישי|מחר|היום)/)

  let contextMessage = userMessage

  if (timeMatch && dayMatch) {
    let time = timeMatch[0].includes(':') ? timeMatch[0] : timeMatch[0] + ':00'
    if (time.length === 4) time = '0' + time

    let resolvedDay = dayMatch[0]
    if (resolvedDay === 'היום') resolvedDay = today
    if (resolvedDay === 'מחר') resolvedDay = tomorrow

    if (!isSlotAvailable(resolvedDay, time)) {
      const available = getAvailableSlots(resolvedDay)
      const availableText = available.length > 0 ? available.join(', ') : 'אין שעות פנויות ביום זה'
      contextMessage = userMessage + '\n[SLOT_FULL - השעה ' + time + ' ביום ' + resolvedDay + ' תפוסה! שעות פנויות: ' + availableText + ']'
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

  const { today: todayNow, tomorrow: tomorrowNow } = getIsraeliDateInfo()

  // ========== תור שנקבע ==========
  if (reply.includes('APPOINTMENT_BOOKED')) {
    const parts = reply.split('APPOINTMENT_BOOKED,')
    const details = parts[1] || ''

    const dayM = details.match(/יום:([^,\n]+)/)
    const timeM = details.match(/שעה:([^,\n\s]+)/)

    if (dayM && timeM) {
      let day = dayM[1].trim()
      let time = timeM[1].trim()

      if (day === 'היום') day = todayNow
      if (day === 'מחר') day = tomorrowNow

      if (isSlotAvailable(day, time)) {
        bookSlot(day, time)
        const isToday = day === todayNow
        const isTomorrow = day === tomorrowNow
        const appointmentDate = resolveToDate(day, isToday, isTomorrow)
        if (appointmentDate) addReminder(userPhone, day, time, appointmentDate.toISOString())

        const phone = userPhone.replace('@s.whatsapp.net', '')
        const summary = buildConversationSummary(userPhone)
        const yairMsg = 'תור חדש נקבע!\n\n' +
          'יום: ' + day + '\n' +
          'שעה: ' + time + '\n' +
          'לקוח: ' + phone + '\n' +
          'וואטסאפ: https://wa.me/' + phone + '\n\n' +
          'סיכום השיחה:\n' + summary
        await notifyYairRaw(yairMsg)
      }
    }

    reply = parts[0].trim()

    if (!reply.includes('סבבה') && !reply.includes('מסודר')) {
      const day = dayM?.[1]?.trim() === 'היום' ? todayNow : dayM?.[1]?.trim() === 'מחר' ? tomorrowNow : dayM?.[1]?.trim()
      const time = timeM?.[1]?.trim()
      if (day && time) {
        reply += '\n\nסבבה, הכל מסודר אחי!\nיום: ' + day + '\nשעה: ' + time + '\nכתובת: אלי כהן 12, לוד\nוויז: https://waze.com/ul?q=אלי+כהן+12+לוד&navigate=yes\nמחכים לך!'
      }
    }
  }

  // ========== העברה ליאיר ==========
  if (reply.includes('TRANSFER_TO_YAIR')) {
    const transferParts = reply.split('TRANSFER_TO_YAIR,')
    const transferDetails = transferParts[1] || ''

    const nameM = transferDetails.match(/שם:([^,\n]+)/)
    const topicM = transferDetails.match(/נושא:([^,\n]+)/)

    const customerName = nameM?.[1]?.trim() || 'לא צוין'
    const customerTopic = topicM?.[1]?.trim() || 'לא צוין'

    reply = transferParts[0].trim()
    if (!reply || reply.length < 10) {
      reply = 'סבבה ' + customerName + '! העברתי את הפרטים ליאיר - כשהוא יתפנה הוא יחזור אליך בהקדם, הוא עונה לכולם!'
    }

    const phone = userPhone.replace('@s.whatsapp.net', '')
    const summary = buildConversationSummary(userPhone)
    const yairMsg = 'לקוח מבקש לדבר איתך!\n\n' +
      'שם: ' + customerName + '\n' +
      'נושא: ' + customerTopic + '\n' +
      'מספר: ' + phone + '\n' +
      'וואטסאפ: https://wa.me/' + phone + '\n\n' +
      'סיכום השיחה:\n' + summary
    await notifyYairRaw(yairMsg)
  }

  return reply
}

// ========== שליחת הודעה ליאיר ==========
async function notifyYairRaw(msg) {
  if (!botSocket) return
  try {
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

    if (!reminder.sentDay && hoursUntil > 3 && hoursUntil <= 24) {
      try {
        await botSocket.sendMessage(reminder.phone, {
          text: 'היי אחי! תזכורת - יש לך תור מחר יום ' + reminder.day + ' בשעה ' + reminder.time + ' אצל יאיר!\nכתובת: אלי כהן 12, לוד\nוויז: https://waze.com/ul?q=אלי+כהן+12+לוד&navigate=yes'
        })
        reminder.sentDay = true
        changed = true
      } catch (err) {
        console.error('שגיאה בתזכורת יום:', err?.message)
      }
    }

    if (!reminder.sentHour && hoursUntil > 0 && hoursUntil <= 3) {
      try {
        await botSocket.sendMessage(reminder.phone, {
          text: 'היי אחי! תזכורת - התור שלך היום בשעה ' + reminder.time + ' - נתראה בקרוב!\nכתובת: אלי כהן 12, לוד'
        })
        reminder.sentHour = true
        changed = true
      } catch (err) {
        console.error('שגיאה בתזכורת שעה:', err?.message)
      }
    }
  }

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
    if (qr) { currentQR = qr; console.log('QR מוכן!') }
    if (connection === 'open') {
      currentQR = null
      console.log("ג'ימי מחובר!")
      setInterval(sendReminders, 10 * 60 * 1000)
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

      console.log('הודעה מ-' + sender + ': ' + text)

      // ========== משפחה - העברה ישירה ליאיר בלי בוט ==========
      if (isFamilyMember(sender, text)) {
        console.log('הודעה ממשפחה - מועברת ישירות ליאיר')
        const phone = sender.replace('@s.whatsapp.net', '')
        const yairMsg = 'הודעה ממשפחה!\n\nמספר: ' + phone + '\nוואטסאפ: https://wa.me/' + phone + '\n\nההודעה:\n' + text
        await notifyYairRaw(yairMsg)
        continue // לא עונים ללקוח - ישירות ליאיר
      }

      try {
        await sock.sendPresenceUpdate('composing', sender)
        const reply = await askJimmy(sender, text)
        await sock.sendMessage(sender, { text: reply })
      } catch (err) {
        console.error('שגיאה:', err?.message)
        await sock.sendMessage(sender, { text: 'אוי משהו השתבש, נסה שוב!' })
      }
    }
  })
}

startBot()

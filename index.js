import baileys from '@whiskeysockets/baileys'
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = baileys
import { Boom } from '@hapi/boom'
import pino from 'pino'
import { toDataURL } from 'qrcode'
import { createServer } from 'http'
import { writeFileSync, readFileSync, existsSync, rmSync } from 'fs'

// מחיקת session אם צריך QR חדש
if (process.env.DELETE_AUTH === 'true') {
  try { rmSync('auth_info', { recursive: true, force: true }); console.log('auth_info נמחק - ממתין ל-QR חדש') } catch {}
}

const OWNER_PHONE = '972507983306@s.whatsapp.net'
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
const MAX_PER_SLOT = 2
const conversations = {}
const appointments = {}
let botSocket = null

// ========== מספרים חסומים - בוט לא עונה בכלל ==========
const BLOCKED_PHONES = [
  '972547734708',
  '972549878444',
  '972542295295',
  '972526472323',
  '972533030598',
  '972545449945',
  '972526728787',
  '972584943389',
  '972547467841',
  '972546284000',
  '972527587752',
  '972504135426',
  '972522156057',
]

// ========== משפחת יאיר - עוברים ישירות ליאיר בלי בוט ==========
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

function isBlocked(sender) {
  const phone = sender.replace('@s.whatsapp.net', '')
  return BLOCKED_PHONES.includes(phone)
}

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
      res.end('<html><body style="display:flex;justify-content:center;align-items:center;height:100vh;background:#111"><div style="text-align:center"><h2 style="color:white;font-family:sans-serif">סרוק עם וואטסאפ של יאיר</h2><img src="' + url + '" style="width:300px;height:300px"/><p style="color:#aaa;font-family:sans-serif">וואטסאפ - שלוש נקודות - מכשירים מקושרים - קשר מכשיר</p></div></body></html>')
    })
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end('<html><body style="background:#111;color:white;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh"><h2>הבוט מחובר!</h2></body></html>')
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

מחירים:
- תספורת לקוח חדש: 70 שקל
- תספורת לקוח חוזר: 50 שקל
- בגדים: אל תתמחר - תגיד שאתה בודק ומעביר ליאיר

הוראות:
1. דבר בצורה חברותית וטבעית, לא רובוטית
2. אם מישהו רוצה תור - שאל "איזה יום ושעה מתאים לך אחי?"
3. כשלקוח אומר "היום" או "מחר" - השתמש בימים הנוכחיים שקיבלת בהקשר
4. כשלקוח מבקש שעה - ענה תחילה בקצרה "רגע אחי, בודק..."
5. אם קיבלת SLOT_FULL בהקשר - אמור: "סליחה אחי, השעה XX תפוסה, יש מקום ב-[שעות פנויות] - איזו שעה נוח לך?"
6. אל תסביר על מגבלות או כמות לקוחות - פשוט תגיד תפוס ותציע חלופה
7. כשתור אושר סופית - כתוב APPOINTMENT_BOOKED,יום:XXX,שעה:XXX
   ואז שלח סיכום ללקוח בסגנון:
   "סבבה אחי, הכל מסודר!
   קבעתי לך תור אצל יאיר:
   יום: [יום]
   שעה: [שעה]
   כתובת: אלי כהן 12, לוד
   וויז: https://waze.com/ul?q=אלי+כהן+12+לוד&navigate=yes
   מחכים לך!"
8. שאלות על בגדים - אמור: "וואלה אחי, אני בודק לך את זה ומעביר את הפנייה שלך ליאיר - הוא יחזור אליך!" ואז כתוב CLOTHES_INQUIRY
9. שאלות מחיר תספורת - ענה ישר: לקוח חדש 70 שקל, לקוח חוזר 50 שקל. אם לא יודע אם חדש או חוזר - שאל
10. אם מישהו רוצה לדבר עם יאיר - אמור: "בטח! רק תגיד לי את שמך ובמה יאיר יכול לעזור לך - ואני אעביר לו את הפרטים"
    אחרי שהלקוח נותן שם ונושא - אמור: "סבבה [שם]! העברתי את הפרטים ליאיר - כשהוא יתפנה הוא יחזור אליך בהקדם!"
    ואז כתוב בשורה נפרדת: TRANSFER_TO_YAIR,שם:[שם],נושא:[נושא]
11. אל תשלח קישורי wa.me ללקוחות
12. שבת סגור, ביום שישי תורים עד 14:00 בלבד
13. אם לא הבנת - אמור: "סליחה אחי, לא הבנתי, תוכל להסביר לי שוב?"
14. בסוף כל שיחה שבה נקבע תור - שלח תמיד סיכום מסודר עם כל הפרטים`

// ========== שאילת ג'ימי ==========
async function askJimmy(userPhone, userMessage) {
  if (!conversations[userPhone]) conversations[userPhone] = []

  const { today, tomorrow, currentTime } = getIsraeliDateInfo()

  const dynamicSystem = JIMMY_SYSTEM_BASE + '\n\n--- מידע נוכחי ---\n- היום: יום ' + today + '\n- מחר: יום ' + tomorrow + '\n- השעה עכשיו בישראל: ' + currentTime

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
      max_tokens: 600,
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
        logAppointment(day, time, userPhone.replace('@s.whatsapp.net', ''))
        const isToday = day === todayNow
        const isTomorrow = day === tomorrowNow
        const appointmentDate = resolveToDate(day, isToday, isTomorrow)
        if (appointmentDate) addReminder(userPhone, day, time, appointmentDate.toISOString())

        // הודעה ליאיר עם סיכום שיחה
        const phone = userPhone.replace('@s.whatsapp.net', '')
        const summary = buildConversationSummary(userPhone)
        await notifyYairRaw(
          '📅 תור חדש נקבע!\n' +
          '─────────────────\n' +
          '👤 לקוח: ' + phone + '\n' +
          '📞 וואטסאפ: https://wa.me/' + phone + '\n' +
          '📆 יום: ' + day + '\n' +
          '🕐 שעה: ' + time + '\n' +
          '─────────────────\n' +
          '💬 סיכום השיחה:\n' + summary
        )
      }
    }

    reply = parts[0].trim()

    // אם אין סיכום ללקוח - ג'ימי יבנה אחד
    if (!reply.includes('סבבה') && !reply.includes('מסודר') && !reply.includes('קבעתי')) {
      const day = dayM?.[1]?.trim() === 'היום' ? todayNow : dayM?.[1]?.trim() === 'מחר' ? tomorrowNow : dayM?.[1]?.trim()
      const time = timeM?.[1]?.trim()
      if (day && time) {
        reply = (reply ? reply + '\n\n' : '') +
          'סבבה אחי, הכל מסודר!\n' +
          'קבעתי לך תור אצל יאיר:\n' +
          'יום: ' + day + '\n' +
          'שעה: ' + time + '\n' +
          'כתובת: אלי כהן 12, לוד\n' +
          'וויז: https://waze.com/ul?q=אלי+כהן+12+לוד&navigate=yes\n' +
          'מחכים לך!'
      }
    }
  }

  // ========== שאלה על בגדים ==========
  if (reply.includes('CLOTHES_INQUIRY')) {
    reply = reply.replace('CLOTHES_INQUIRY', '').trim()
    const phone = userPhone.replace('@s.whatsapp.net', '')
    const summary = buildConversationSummary(userPhone)
    await notifyYairRaw(
      'לקוח שואל על בגדים!\n\n' +
      'מספר: ' + phone + '\n' +
      'וואטסאפ: https://wa.me/' + phone + '\n\n' +
      'סיכום השיחה:\n' + summary
    )
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
      reply = 'סבבה ' + customerName + '! העברתי את הפרטים ליאיר - כשהוא יתפנה הוא יחזור אליך בהקדם!'
    }

    const phone = userPhone.replace('@s.whatsapp.net', '')
    const summary = buildConversationSummary(userPhone)
    await notifyYairRaw(
      'לקוח מבקש לדבר איתך!\n\n' +
      'שם: ' + customerName + '\n' +
      'נושא: ' + customerTopic + '\n' +
      'מספר: ' + phone + '\n' +
      'וואטסאפ: https://wa.me/' + phone + '\n\n' +
      'סיכום השיחה:\n' + summary
    )
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


// ========== סיכום יומי לפי תורים ==========
const APPOINTMENTS_FILE = 'appointments_log.json'

function logAppointment(day, time, phone) {
  let logs = []
  if (existsSync(APPOINTMENTS_FILE)) {
    try { logs = JSON.parse(readFileSync(APPOINTMENTS_FILE, 'utf8')) } catch { logs = [] }
  }
  const { now } = getIsraeliDateInfo()
  logs.push({ day, time, phone, createdAt: now.toISOString() })
  writeFileSync(APPOINTMENTS_FILE, JSON.stringify(logs, null, 2))
}

function getTodayAppointments() {
  if (!existsSync(APPOINTMENTS_FILE)) return []
  try {
    const logs = JSON.parse(readFileSync(APPOINTMENTS_FILE, 'utf8'))
    const { today } = getIsraeliDateInfo()
    return logs
      .filter(a => a.day === today)
      .sort((a, b) => a.time.localeCompare(b.time))
  } catch { return [] }
}

async function sendDailySummary() {
  if (!botSocket) return
  const { today } = getIsraeliDateInfo()
  const todays = getTodayAppointments()

  let msg = '🗓️ תורים להיום - יום ' + today + ':\n'
  msg += '─────────────────\n'

  if (todays.length === 0) {
    msg += 'אין תורים מתוכננים להיום\n'
  } else {
    for (const a of todays) {
      msg += '🕐 ' + a.time + ' - ' + a.phone + '\n'
    }
    msg += '─────────────────\n'
    msg += '✅ סה"כ: ' + todays.length + ' תורים היום'
  }

  await notifyYairRaw(msg)
}

function scheduleDailySummary() {
  const checkEveryMinute = () => {
    const { now } = getIsraeliDateInfo()
    const h = now.getHours()
    const m = now.getMinutes()
    if (h === 8 && m === 0) {
      sendDailySummary()
    }
  }
  setInterval(checkEveryMinute, 60 * 1000)
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
      scheduleDailySummary()
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

      // ========== מספרים חסומים - לא עונים בכלל ==========
      if (isBlocked(sender)) {
        console.log('מספר חסום - מדלג: ' + sender)
        continue
      }

      // ========== משפחה - העברה ישירה ליאיר בלי בוט ==========
      if (isFamilyMember(sender, text)) {
        console.log('הודעה ממשפחה - מועברת ישירות ליאיר')
        const phone = sender.replace('@s.whatsapp.net', '')
        await notifyYairRaw(
          'הודעה ממשפחה!\n\n' +
          'מספר: ' + phone + '\n' +
          'וואטסאפ: https://wa.me/' + phone + '\n\n' +
          'ההודעה:\n' + text
        )
        continue
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

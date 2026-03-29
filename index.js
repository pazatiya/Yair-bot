import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys'
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

// ========== רישום מספרי טלפון אמיתיים ==========
// וואטסאפ לפעמים שולח lid במקום מספר - שומרים את המספר האמיתי כשזמין
const phoneRegistry = {}

function extractPhone(sender) {
  // פורמט רגיל: 972507983306@s.whatsapp.net
  if (sender.includes('@s.whatsapp.net')) {
    const phone = sender.replace('@s.whatsapp.net', '')
    phoneRegistry[sender] = phone // שמור לשימוש עתידי
    return phone
  }
  // פורמט lid - נסה מהרישום
  if (phoneRegistry[sender]) return phoneRegistry[sender]
  return null // לא ידוע
}

// ========== פורמט מספר טלפון ישראלי קריא ==========
function formatIsraeliPhone(phone) {
  if (!phone || !phone.startsWith('972')) return phone || ''
  const local = '0' + phone.slice(3)
  if (local.length === 10) {
    return local.slice(0, 3) + '-' + local.slice(3, 6) + '-' + local.slice(6)
  }
  return local
}

// ========== בניית בלוק איש קשר ליאיר ==========
function buildContactBlock(sender, customerName) {
  const phone = extractPhone(sender)
  const hasPhone = phone && phone.startsWith('972')

  let block = ''
  if (customerName && customerName !== 'לא צוין') block += '👤 שם: ' + customerName + '\n'
  if (hasPhone) {
    block += '📞 טלפון: ' + formatIsraeliPhone(phone) + '\n'
    block += '💬 וואטסאפ: https://wa.me/' + phone + '\n'
  } else {
    block += '⚠️ מספר לא זמין (lid) - חפש את הצ׳אט ידנית בוואטסאפ\n'
  }
  return block
}

function getWALink(sender) {
  const phone = extractPhone(sender)
  if (phone && phone.startsWith('972')) return 'https://wa.me/' + phone
  return null
}

function isBlocked(sender) {
  const phone = extractPhone(sender)
  return BLOCKED_PHONES.includes(phone)
}

function isFamilyMember(sender, text) {
  const phone = extractPhone(sender)
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
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`<html><head><meta charset="utf-8"></head><body style="display:flex;justify-content:center;align-items:center;height:100vh;background:#111">
        <div style="text-align:center">
          <h2 style="color:white;font-family:sans-serif">סרוק עם וואטסאפ של יאיר</h2>
          <img src="${url}" style="width:300px;height:300px"/>
          <p style="color:#aaa;font-family:sans-serif">וואטסאפ - שלוש נקודות - מכשירים מקושרים - קשר מכשיר</p>
        </div>
      </body></html>`)
    })
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<html><head><meta charset="utf-8"></head><body style="background:#111;color:white;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh">
      <h2>הבוט מחובר!</h2>
    </body></html>`)
  }
}).listen(process.env.PORT || 8080)

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
אתה בוט חכם - תבין גם כשכותבים בקיצור, עם שגיאות כתיב, או לא בדיוק - הבן את הכוונה!
ברכת פתיחה: "היי מה קורה? 👋 אני ג'ימי, העוזר של יאיר - איך אני יכול לעזור?"

פרטי העסק:
- כתובת: אלי כהן 12, לוד
- ניווט בוויז: https://waze.com/ul?q=אלי+כהן+12+לוד&navigate=yes
- שעות: ימים א-ה 08:00-20:00, יום ו 08:00-14:00, שבת סגור

מחירים:
- תספורת לקוח חדש: 70 שקל
- תספורת לקוח חוזר: אל תגלה מחיר! תגיד רק "אין בעיה אחי!" ותמשיך לקבוע תור
- בגדים: אל תתמחר - תגיד שאתה בודק ומעביר ליאיר

הוראות:
1. דבר בצורה חברותית וטבעית, קצר וענייני - לא רובוטי
2. תבין גם כתיב לא מדויק: "מחר ב17" = מחר בשעה 17:00, "שני ב10" = יום שני בשעה 10:00 וכו'
3. כשמישהו רוצה לקבוע תור - קודם שאל את שמו: "סבבה! ומה שמך אחי?" (אם עדיין לא יודע)
   אחרי שיש שם - שאל "איזה יום ושעה מתאים לך [שם]?"
4. כשלקוח אומר "היום" או "מחר" - השתמש בימים מההקשר
5. כשלקוח מבקש שעה ספציפית - כתוב CHECKING_SLOT,יום:XXX,שעה:XXX ואל תכתוב שום דבר אחר
6. אם קיבלת SLOT_AVAILABLE בהקשר - כתוב: "פנוי! 🎉
סבבה [שם], הכל מסודר!
קבעתי לך תור אצל יאיר:
יום: [יום]
שעה: [שעה]
כתובת: אלי כהן 12, לוד
וויז: https://waze.com/ul?q=אלי+כהן+12+לוד&navigate=yes
מחכים לך! 💈"
   ואז כתוב APPOINTMENT_BOOKED,יום:XXX,שעה:XXX,שם:XXX
7. אם קיבלת SLOT_FULL בהקשר - כתוב: "אוי אחי, השעה הזו תפוסה 😅 יש מקום ב: [שעות פנויות] - איזו שעה בא לך?"
8. אל תסביר על מגבלות או כמות לקוחות
9. שאלות על בגדים - "אני בודק לך ומעביר ליאיר! 👌" ואז כתוב CLOTHES_INQUIRY
10. שאלות מחיר תספורת - שאל "אתה לקוח חדש או חוזר אצל יאיר?"
    לקוח חדש: "70 שקל אחי 💈 מתי בא לך לקבוע?"
    לקוח חוזר: "אין בעיה אחי! 💪 מתי בא לך לקבוע?"
11. אם מישהו רוצה לדבר עם יאיר - "בטח! תגיד לי שמך ובמה יאיר יכול לעזור - ואני אעביר לו"
    אחרי שם ונושא: "סבבה [שם]! העברתי ליאיר - הוא יחזור אליך בהקדם!"
    ואז: TRANSFER_TO_YAIR,שם:[שם],נושא:[נושא]
12. אל תשלח קישורי wa.me ללקוחות
13. שבת סגור, שישי עד 14:00 בלבד
14. אם לא הבנת - "סליחה אחי, לא הבנתי 😅 תוכל לנסח שוב?"`

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

        const nameM2 = details.match(/שם:([^,\n]+)/)
        const customerNameBooked = nameM2?.[1]?.trim() || 'לא צוין'
        const summary = buildConversationSummary(userPhone)
        const contactBlock = buildContactBlock(userPhone, customerNameBooked)
        await notifyYairRaw(
          '✂️ תור חדש נקבע!\n\n' +
          '📅 יום: ' + day + '\n' +
          '⏰ שעה: ' + time + '\n' +
          contactBlock + '\n' +
          'סיכום שיחה:\n' + summary
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
    await notifyYairRaw(
      'לקוח שואל על בגדים!\n' +
      buildContactBlock(userPhone, null)
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

    await notifyYairRaw(
      'לקוח רוצה לדבר איתך!\n' +
      'נושא: ' + customerTopic + '\n' +
      buildContactBlock(userPhone, customerName)
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
    browser: ['Jimmy-Bot', 'Safari', '605.1.15'],
    syncFullHistory: false,
  })

  botSocket = sock
  sock.ev.on('creds.update', saveCreds)

  // Keepalive - מניע ניתוק בגלל חוסר פעילות
  setInterval(async () => {
    if (botSocket && botSocket.user) {
      try {
        await botSocket.sendPresenceUpdate('available', botSocket.user.id)
      } catch {}
    }
  }, 4 * 60 * 1000) // כל 4 דקות

  let remindersInterval = null
  let summaryScheduled = false

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) { currentQR = qr; console.log('QR מוכן!') }

    if (connection === 'open') {
      currentQR = null
      console.log("ג'ימי מחובר!")
      // הפעל תזכורות רק פעם אחת
      if (!remindersInterval) {
        remindersInterval = setInterval(sendReminders, 10 * 60 * 1000)
      }
      if (!summaryScheduled) {
        scheduleDailySummary()
        summaryScheduled = true
      }
    }

    if (connection === 'close') {
      botSocket = null
      const err = lastDisconnect?.error
      const code = new Boom(err)?.output?.statusCode
      console.log('התנתק - קוד:', code, 'שגיאה:', err?.message)

      if (code === DisconnectReason.loggedOut) {
        // יאיר התנתק מהמכשיר - צריך QR חדש
        console.log('יאיר התנתק - צריך לסרוק QR מחדש')
        currentQR = null
        setTimeout(startBot, 5000)
      } else if (code === DisconnectReason.restartRequired) {
        // נדרש restart - מתחבר מחדש מיד
        setTimeout(startBot, 1000)
      } else if (code === 408 || code === 503 || code === 500) {
        // בעיית רשת זמנית - נסה שוב אחרי 5 שניות
        setTimeout(startBot, 5000)
      } else {
        // כל סיבה אחרת - נסה שוב אחרי 3 שניות
        setTimeout(startBot, 3000)
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const msg of messages) {
      if (msg.key.fromMe) continue
      if (msg.key.remoteJid.endsWith('@g.us')) continue

      const sender = msg.key.remoteJid
      // רשום את המספר ברגיסטרי (אם זה @s.whatsapp.net - נשמר לשימוש עם lid)
      extractPhone(sender)

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
        await notifyYairRaw(
          '👨‍👩‍👧 הודעה ממשפחה!\n\n' +
          buildContactBlock(sender, null) + '\n' +
          '✉️ ההודעה:\n' + text
        )
        continue
      }

      try {
        await sock.sendPresenceUpdate('composing', sender)
        const reply = await askJimmy(sender, text)

        // אם הבוט רוצה לבדוק שעה - שלח "רגע בודק" תחילה, המתן, ואז שלח תשובה
        if (reply.startsWith('CHECKING_SLOT')) {
          const checkMatch = reply.match(/יום:([^,\n]+),שעה:([^,\n\s]+)/)
          if (checkMatch) {
            const checkDay = checkMatch[1].trim()
            const checkTime = checkMatch[2].trim()
            await sock.sendMessage(sender, { text: 'רגע אחי, בודק אם ' + checkDay + ' ב-' + checkTime + ' פנוי... 🔍' })
            await new Promise(r => setTimeout(r, 2500))

            // בדוק זמינות ושלח הקשר לבוט
            const { today, tomorrow } = getIsraeliDateInfo()
            let resolvedDay = checkDay
            if (resolvedDay === 'היום') resolvedDay = today
            if (resolvedDay === 'מחר') resolvedDay = tomorrow
            const available = getAvailableSlots(resolvedDay)
            const availableText = available.length > 0 ? available.join(', ') : 'אין שעות פנויות'

            let slotContext
            if (isSlotAvailable(resolvedDay, checkTime)) {
              slotContext = '[SLOT_AVAILABLE - יום ' + resolvedDay + ' בשעה ' + checkTime + ' פנוי!]'
            } else {
              slotContext = '[SLOT_FULL - השעה ' + checkTime + ' ביום ' + resolvedDay + ' תפוסה! שעות פנויות: ' + availableText + ']'
            }

            const followUp = await askJimmy(sender, slotContext)
            await sock.sendMessage(sender, { text: followUp })
          }
        } else {
          await sock.sendMessage(sender, { text: reply })
        }
      } catch (err) {
        console.error('שגיאה:', err?.message)
        await sock.sendMessage(sender, { text: 'אוי משהו השתבש, נסה שוב!' })
      }
    }
  })
}

startBot()

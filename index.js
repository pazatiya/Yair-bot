import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import pino from 'pino'
import { toDataURL } from 'qrcode'
import { createServer } from 'http'
import { writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'

// ========== Firebase Setup ==========
const firebaseConfig = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}')
initializeApp({ credential: cert(firebaseConfig) })
const db = getFirestore()

// Firebase Collections
const appointmentsCol = db.collection('appointments')
const remindersCol = db.collection('reminders')
const blockedCol = db.collection('blocked_phones')
const familyCol = db.collection('family_phones')
const lidMapCol = db.collection('lid_map')

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

// ========== קאש מקומי - נטען מ-Firebase ==========
let BLOCKED_PHONES = []
let FAMILY_PHONES = []
let lidToPhone = {}
let phoneToLid = {}

// ========== מעקב נטישה (abandon follow-up) ==========
// מבנה: { [sender]: { timer: TimeoutRef, step: string, lastActivity: Date } }
const abandonTimers = {}
const ABANDON_DELAY_MS = 30 * 60 * 1000 // 30 דקות

// שלבים ב-flow שנחשבים "באמצע תהליך" - אם משתמש נטש כשהוא כאן, נשלח הודעת follow-up
const ACTIVE_FLOW_KEYWORDS = [
  'CHECKING_SLOT', // בודקים שעה
  'מה שמך',
  'ומה שמך',
  'איזה יום',
  'באיזה יום',
  'שאל את שמו',
  'שמו',
]

function markAbandonTimer(sender, lastBotReply) {
  // בטל טיימר קיים
  if (abandonTimers[sender]?.timer) {
    clearTimeout(abandonTimers[sender].timer)
  }

  // בדוק אם השיחה האחרונה היא שלב אמצעי ב-flow
  const isInProgress = ACTIVE_FLOW_KEYWORDS.some(kw =>
    lastBotReply && lastBotReply.includes(kw)
  ) || (
    // גם אם ג'ימי שאל שם / יום / שעה
    lastBotReply && (
      lastBotReply.includes('מה שמך') ||
      lastBotReply.includes('שמך') ||
      lastBotReply.includes('איזה יום') ||
      lastBotReply.includes('מתי בא לך') ||
      lastBotReply.includes('איזו שעה')
    )
  )

  if (!isInProgress) return // לא באמצע תהליך - לא צריך follow-up

  const timer = setTimeout(async () => {
    if (!botSocket) return
    // בדוק שהמשתמש לא שלח הודעה בינתיים (הטיימר בוטל אם שלח)
    try {
      const followUpMsg =
        'היי אחי! 😊\n' +
        'ראיתי שהתחלנו לדבר אבל לא סיימנו...\n' +
        'רוצה שאקבע לך תור? 💈 אני כאן!'
      await botSocket.sendMessage(sender, { text: followUpMsg })
      console.log('נשלחה הודעת follow-up לנטוש: ' + sender)
    } catch (err) {
      console.error('שגיאה בשליחת follow-up:', err?.message)
    }
    delete abandonTimers[sender]
  }, ABANDON_DELAY_MS)

  abandonTimers[sender] = { timer, lastActivity: new Date() }
}

function cancelAbandonTimer(sender) {
  if (abandonTimers[sender]?.timer) {
    clearTimeout(abandonTimers[sender].timer)
    delete abandonTimers[sender]
  }
}

// ========== טעינה מ-Firebase ==========
async function loadBlockedFromFirebase() {
  try {
    const snapshot = await blockedCol.get()
    BLOCKED_PHONES = snapshot.docs.map(doc => doc.id)
    console.log('נטענו ' + BLOCKED_PHONES.length + ' מספרים חסומים מ-Firebase')
  } catch (err) {
    console.error('שגיאה בטעינת חסומים:', err?.message)
    BLOCKED_PHONES = [
      '972526472323', '972533030598', '972545449945', '972526728787',
      '972584943389', '972547467841', '972546284000', '972527587752',
      '972504135426', '972522156057', '972543147703', '972506484030',
      '972532318008', '972528605086', '972507088775',
    ]
  }
}

async function loadFamilyFromFirebase() {
  try {
    const snapshot = await familyCol.get()
    FAMILY_PHONES = snapshot.docs.map(doc => doc.id)
    console.log('נטענו ' + FAMILY_PHONES.length + ' מספרי משפחה מ-Firebase')
  } catch (err) {
    console.error('שגיאה בטעינת משפחה:', err?.message)
    FAMILY_PHONES = ['972547734708', '972549878444', '972542295295']
  }
}

async function loadLidMapFromFirebase() {
  try {
    const snapshot = await lidMapCol.get()
    snapshot.docs.forEach(doc => {
      const data = doc.data()
      lidToPhone[doc.id] = data.phone
      phoneToLid[data.phone] = doc.id
    })
    console.log('נטענו ' + Object.keys(lidToPhone).length + ' מיפויי LID מ-Firebase')
  } catch (err) {
    console.error('שגיאה בטעינת LID map:', err?.message)
  }
}

// ========== שמירת מיפוי LID ==========
async function saveLidMapping(lid, phone) {
  if (!lid || !phone) return
  if (lidToPhone[lid] === phone) return // כבר קיים
  lidToPhone[lid] = phone
  phoneToLid[phone] = lid
  try {
    await lidMapCol.doc(lid).set({ phone, updatedAt: FieldValue.serverTimestamp() })
    console.log('LID mapping saved: ' + lid + ' -> ' + phone)
  } catch (err) {
    console.error('שגיאה בשמירת LID mapping:', err?.message)
  }
}

// ========== פתרון LID למספר טלפון - שיטה משולבת ==========
async function resolveLidToPhone(sender) {
  if (!sender.includes('@lid')) return null
  const lid = sender.replace('@lid', '')

  // 1. בדוק קאש מקומי
  if (lidToPhone[lid]) return lidToPhone[lid]

  // 2. נסה את Baileys המובנה - getPNForLID
  if (botSocket?.signalRepository?.lidMapping) {
    try {
      const pn = await botSocket.signalRepository.lidMapping.getPNForLID(sender)
      if (pn && pn.includes('@s.whatsapp.net')) {
        const phone = pn.replace('@s.whatsapp.net', '').replace(/:.*/, '')
        await saveLidMapping(lid, phone)
        return phone
      }
    } catch (err) {
      console.log('getPNForLID failed for ' + lid + ':', err?.message)
    }
  }

  // 3. נסה onWhatsApp
  if (botSocket) {
    try {
      const [result] = await botSocket.onWhatsApp(sender)
      if (result?.jid?.includes('@s.whatsapp.net')) {
        const phone = result.jid.replace('@s.whatsapp.net', '')
        await saveLidMapping(lid, phone)
        return phone
      }
    } catch {}
  }

  return null
}

// ========== חילוץ מספר טלפון מכל פורמט ==========
function extractPhoneSync(sender) {
  if (sender.includes('@s.whatsapp.net')) {
    return sender.replace('@s.whatsapp.net', '')
  }
  if (sender.includes('@lid')) {
    const lid = sender.replace('@lid', '')
    if (lidToPhone[lid]) return lidToPhone[lid]
    return null
  }
  return sender
}

async function extractPhone(sender) {
  // נסה sync קודם
  const syncResult = extractPhoneSync(sender)
  if (syncResult) return syncResult

  // אם LID - נסה resolve
  if (sender.includes('@lid')) {
    const resolved = await resolveLidToPhone(sender)
    if (resolved) return resolved
  }

  return null
}

function getWALink(phone) {
  if (phone && phone.startsWith('972')) {
    return 'https://wa.me/' + phone
  }
  return 'מספר לא ידוע'
}

// ========== isBlocked / isFamilyMember - גרסה אסינכרונית (תומכת ב-LID) ==========
// הפונקציות הסינכרוניות הישנות (שמשתמשות בקאש בלבד) - לשימוש פנימי
function isBlockedSync(sender) {
  if (sender.includes('@s.whatsapp.net')) {
    const phone = sender.replace('@s.whatsapp.net', '')
    return BLOCKED_PHONES.includes(phone)
  }
  if (sender.includes('@lid')) {
    const lid = sender.replace('@lid', '')
    const phone = lidToPhone[lid]
    if (phone) return BLOCKED_PHONES.includes(phone)
  }
  return false
}

function isFamilyMemberSync(sender) {
  if (sender.includes('@s.whatsapp.net')) {
    const phone = sender.replace('@s.whatsapp.net', '')
    return FAMILY_PHONES.includes(phone)
  }
  if (sender.includes('@lid')) {
    const lid = sender.replace('@lid', '')
    const phone = lidToPhone[lid]
    if (phone) return FAMILY_PHONES.includes(phone)
  }
  return false
}

// גרסאות אסינכרוניות - resolving LID אם צריך
async function isBlocked(sender) {
  if (isBlockedSync(sender)) return true
  if (sender.includes('@lid')) {
    const resolved = await resolveLidToPhone(sender)
    if (resolved) return BLOCKED_PHONES.includes(resolved)
  }
  return false
}

async function isFamilyMember(sender) {
  if (isFamilyMemberSync(sender)) return true
  if (sender.includes('@lid')) {
    const resolved = await resolveLidToPhone(sender)
    if (resolved) return FAMILY_PHONES.includes(resolved)
  }
  return false
}

// ========== ניהול חסומים מ-Firebase ==========
async function addBlockedPhone(phone) {
  BLOCKED_PHONES.push(phone)
  try {
    await blockedCol.doc(phone).set({ addedAt: FieldValue.serverTimestamp() })
  } catch (err) { console.error('שגיאה בהוספת חסום:', err?.message) }
}

async function removeBlockedPhone(phone) {
  BLOCKED_PHONES = BLOCKED_PHONES.filter(p => p !== phone)
  try {
    await blockedCol.doc(phone).delete()
  } catch (err) { console.error('שגיאה בהסרת חסום:', err?.message) }
}

// ========== תזכורות - Firebase ==========
async function loadReminders() {
  try {
    const snapshot = await remindersCol.get()
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }))
  } catch (err) {
    console.error('שגיאה בטעינת תזכורות:', err?.message)
    return []
  }
}

async function addReminder(phone, day, time, resolvedDate) {
  try {
    const existing = await remindersCol.where('phone', '==', phone).get()
    const batch = db.batch()
    existing.docs.forEach(doc => batch.delete(doc.ref))
    await batch.commit()
    await remindersCol.add({
      phone, day, time, resolvedDate,
      sentDay: false, sentHour: false,
      createdAt: FieldValue.serverTimestamp()
    })
  } catch (err) { console.error('שגיאה בהוספת תזכורת:', err?.message) }
}

async function cancelReminder(phone) {
  try {
    const existing = await remindersCol.where('phone', '==', phone).get()
    const batch = db.batch()
    existing.docs.forEach(doc => batch.delete(doc.ref))
    await batch.commit()
  } catch (err) { console.error('שגיאה בביטול תזכורת:', err?.message) }
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
function cancelSlot(day, time) {
  const key = getSlotKey(day, time)
  if (appointments[key] && appointments[key] > 0) appointments[key]--
}
function getAvailableSlots(day) {
  const allSlots = ['08:00','09:00','10:00','11:00','12:00','13:00','14:00','15:00','16:00','17:00','18:00','19:00']
  const fridaySlots = ['08:00','09:00','10:00','11:00','12:00','13:00']
  const slots = day === 'שישי' ? fridaySlots : allSlots
  return slots.filter(t => isSlotAvailable(day, t))
}

// ========== תורים - Firebase ==========
async function logAppointment(day, time, phone) {
  try {
    const { now } = getIsraeliDateInfo()
    await appointmentsCol.add({
      day, time, phone,
      cancelled: false,
      createdAt: FieldValue.serverTimestamp(),
      createdAtLocal: now.toISOString()
    })
  } catch (err) { console.error('שגיאה ברישום תור:', err?.message) }
}

async function getUserAppointment(phone) {
  try {
    const snapshot = await appointmentsCol
      .where('phone', '==', phone)
      .where('cancelled', '==', false)
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get()
    if (snapshot.empty) return null
    return { id: snapshot.docs[0].id, ...snapshot.docs[0].data() }
  } catch (err) {
    console.error('שגיאה בחיפוש תור:', err?.message)
    return null
  }
}

async function cancelUserAppointment(phone) {
  try {
    const appointment = await getUserAppointment(phone)
    if (!appointment) return null
    await appointmentsCol.doc(appointment.id).update({ cancelled: true })
    cancelSlot(appointment.day, appointment.time)
    await cancelReminder(phone + '@s.whatsapp.net')
    return appointment
  } catch (err) {
    console.error('שגיאה בביטול תור:', err?.message)
    return null
  }
}

async function getTodayAppointments() {
  try {
    const { today } = getIsraeliDateInfo()
    const snapshot = await appointmentsCol
      .where('day', '==', today)
      .where('cancelled', '==', false)
      .get()
    return snapshot.docs
      .map(doc => doc.data())
      .sort((a, b) => a.time.localeCompare(b.time))
  } catch (err) {
    console.error('שגיאה בטעינת תורי היום:', err?.message)
    return []
  }
}

async function loadSlotsFromFirebase() {
  try {
    const snapshot = await appointmentsCol.where('cancelled', '==', false).get()
    snapshot.docs.forEach(doc => {
      const data = doc.data()
      const key = getSlotKey(data.day, data.time)
      appointments[key] = (appointments[key] || 0) + 1
    })
    console.log('נטענו ' + snapshot.docs.length + ' תורים פעילים מ-Firebase')
  } catch (err) {
    console.error('שגיאה בטעינת תורים:', err?.message)
  }
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
אתה מדבר בצורה יוניסקס - לא זכר ולא נקבה. השתמש במילים כמו: 'אחלה', 'סבבה', 'וואלה', 'בסדר גמור', 'מעולה', 'נשמע טוב' — במקום 'אחי' או 'אחותי'.
אתה בוט חכם - תבין גם כשכותבים בקיצור, עם שגיאות כתיב, או לא בדיוק - הבן את הכוונה!

ברכת פתיחה (חובה תמיד להתחיל בזה בהודעה הראשונה בלבד):
"היי אני ג'ימי העוזר האישי של יאיר 😊
איך אני יכול לעזור?"

פרטי העסק:
- כתובת: אלי כהן 12, לוד
- ניווט בוויז: https://waze.com/ul?q=אלי+כהן+12+לוד&navigate=yes
- שעות: ימים א-ה 08:00-20:00, יום ו 08:00-14:00, שבת סגור

מחירים:
- תספורת לקוח חדש: 70 שקל
- תספורת לקוח חוזר: אל תגלה מחיר! תגיד רק "אין בעיה אחי!" ותמשיך לקבוע תור
- בגדים: אל תתמחר - תגיד שאתה בודק ומעביר ליאיר

הוראות:
1. דבר בצורה חברותית וטבעית, קצר וענייני - לא רובוטי. היה אנושי, חם, ומבין עניין.
2. תבין גם כתיב לא מדויק: "מחר ב17" = מחר בשעה 17:00, "שני ב10" = יום שני בשעה 10:00 וכו'
3. כשמישהו רוצה לקבוע תור - קודם שאל את שמו: "סבבה! ומה שמך?" (אם עדיין לא יודע)
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
7. אם קיבלת SLOT_FULL בהקשר - כתוב: "אוי, השעה הזו תפוסה 😅 יש מקום ב: [שעות פנויות] - איזו שעה בא לך?"
8. אל תסביר על מגבלות או כמות לקוחות
9. שאלות על בגדים - "אני בודק לך ומעביר ליאיר! 👌" ואז כתוב CLOTHES_INQUIRY
10. שאלות מחיר תספורת - שאל "אתה לקוח חדש או חוזר אצל יאיר?"
    לקוח חדש: "70 שקל 💈 מתי בא לך לקבוע?"
    לקוח חוזר: "אין בעיה! 💪 מתי בא לך לקבוע?"
11. אם מישהו רוצה לדבר עם יאיר או להעביר הודעה אליו:
    - שאל שמו: "בטח! תגיד לי שמך קודם 😊"
    - אחרי שם, שאל מה הנושא: "ומה הנושא אחי?"
    - אחרי שם + נושא: "סבבה [שם]! העברתי את הפרטים ליאיר - כשהוא יתפנה הוא יחזור אליך!"
    - ואז: TRANSFER_TO_YAIR,שם:[שם],נושא:[נושא]
12. אל תשלח קישורי wa.me ללקוחות
13. שבת סגור, שישי עד 14:00 בלבד
14. אם לא הבנת - "סליחה, לא הבנתי 😅 תוכל לנסח שוב?"
15. ביטול או דחיית תור:
    - אם מישהו רוצה לבטל תור - כתוב CANCEL_APPOINTMENT
    - אם מישהו רוצה לדחות/לשנות תור - כתוב RESCHEDULE_APPOINTMENT
    - בשני המקרים, קודם אמור "רגע אחי, בודק את התור שלך..." ואחרי כן בוט יטפל בזה`

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
        const phone = await extractPhone(userPhone) || userPhone.replace(/@.+/, '')
        await logAppointment(day, time, phone)
        const appointmentDate = resolveToDate(day, day === todayNow, day === tomorrowNow)
        if (appointmentDate) await addReminder(userPhone, day, time, appointmentDate.toISOString())

        const nameM2 = details.match(/שם:([^,\n]+)/)
        const customerNameBooked = nameM2?.[1]?.trim() || 'לא צוין'
        const summary = buildConversationSummary(userPhone)
        await notifyYairRaw(
          '✂️ תור חדש נקבע!\n\n' +
          '👤 שם: ' + customerNameBooked + '\n' +
          '📅 יום: ' + day + '\n' +
          '⏰ שעה: ' + time + '\n' +
          '📱 מספר: ' + phone + '\n' +
          '💬 וואטסאפ: https://wa.me/' + phone + '\n\n' +
          'סיכום שיחה:\n' + summary
        )
      }
    }

    reply = parts[0].trim()
    if (!reply.includes('סבבה') && !reply.includes('מסודר') && !reply.includes('קבעתי')) {
      const day = dayM?.[1]?.trim() === 'היום' ? todayNow : dayM?.[1]?.trim() === 'מחר' ? tomorrowNow : dayM?.[1]?.trim()
      const time = timeM?.[1]?.trim()
      if (day && time) {
        reply = (reply ? reply + '\n\n' : '') +
          'סבבה, הכל מסודר! ✅\nקבעתי תור אצל יאיר:\nיום: ' + day + '\nשעה: ' + time + '\nכתובת: אלי כהן 12, לוד\nוויז: https://waze.com/ul?q=אלי+כהן+12+לוד&navigate=yes\nמחכים לך!'
      }
    }
  }

  if (reply.includes('CLOTHES_INQUIRY')) {
    reply = reply.replace('CLOTHES_INQUIRY', '').trim()
    const phone = await extractPhone(userPhone) || userPhone.replace(/@.+/, '')
    await notifyYairRaw('👕 לקוח שואל על בגדים!\n📱 ' + phone + '\n💬 https://wa.me/' + phone)
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
      reply = 'סבבה ' + customerName + '! העברתי את הפרטים ליאיר - כשהוא יתפנה הוא יחזור אליך!'
    }
    const phone = await extractPhone(userPhone) || userPhone.replace(/@.+/, '')
    const waLink = 'https://wa.me/' + phone
    await notifyYairRaw(
      '📲 לקוח רוצה לדבר איתך!\n' +
      '👤 שם: ' + customerName + '\n' +
      '📝 נושא: ' + customerTopic + '\n' +
      '💬 לינק ישיר לצ\'אט: ' + waLink
    )
  }

  // ========== ביטול תור ==========
  if (reply.includes('CANCEL_APPOINTMENT')) {
    reply = reply.replace('CANCEL_APPOINTMENT', '').trim()
    const phone = await extractPhone(userPhone) || userPhone.replace(/@.+/, '')
    const appointment = await cancelUserAppointment(phone)
    if (appointment) {
      reply = 'סבבה אחי, ביטלתי את התור שלך ביום ' + appointment.day + ' בשעה ' + appointment.time + ' ✅\nאם תרצה לקבוע מחדש - אני כאן!'
      await notifyYairRaw(
        '❌ תור בוטל!\n' +
        '📅 יום: ' + appointment.day + '\n' +
        '⏰ שעה: ' + appointment.time + '\n' +
        '📱 מספר: ' + phone + '\n' +
        '💬 לינק לצ\'אט: https://wa.me/' + phone
      )
    } else {
      reply = 'אחי לא מצאתי תור פעיל על המספר שלך 🤔 אם אתה חושב שיש שגיאה, דבר ישירות עם יאיר!'
    }
  }

  // ========== דחיית/שינוי תור ==========
  if (reply.includes('RESCHEDULE_APPOINTMENT')) {
    reply = reply.replace('RESCHEDULE_APPOINTMENT', '').trim()
    const phone = await extractPhone(userPhone) || userPhone.replace(/@.+/, '')
    const appointment = await getUserAppointment(phone)
    if (appointment) {
      await cancelUserAppointment(phone)
      reply = 'סבבה אחי! ביטלתי את התור הקיים שלך ביום ' + appointment.day + ' בשעה ' + appointment.time + ' 🔄\nאיזה יום ושעה חדשים מתאימים לך?'
      await notifyYairRaw(
        '🔄 לקוח רוצה לדחות תור!\n' +
        '📅 תור ישן: יום ' + appointment.day + ' שעה ' + appointment.time + '\n' +
        '📱 מספר: ' + phone + '\n' +
        '💬 לינק לצ\'אט: https://wa.me/' + phone
      )
    } else {
      reply = 'אחי לא מצאתי תור פעיל על המספר שלך 🤔 תרצה לקבוע תור חדש?'
    }
  }

  return reply
}

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
  const reminders = await loadReminders()
  if (reminders.length === 0) return
  const { now } = getIsraeliDateInfo()

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
        await remindersCol.doc(reminder.id).update({ sentDay: true })
      } catch (err) { console.error('שגיאה בתזכורת יום:', err?.message) }
    }

    if (!reminder.sentHour && hoursUntil > 0 && hoursUntil <= 3) {
      try {
        await botSocket.sendMessage(reminder.phone, {
          text: 'היי אחי! תזכורת - התור שלך היום בשעה ' + reminder.time + ' - נתראה בקרוב!\nכתובת: אלי כהן 12, לוד'
        })
        await remindersCol.doc(reminder.id).update({ sentHour: true })
      } catch (err) { console.error('שגיאה בתזכורת שעה:', err?.message) }
    }

    if (msUntil < 0) {
      try { await remindersCol.doc(reminder.id).delete() } catch {}
    }
  }
}

async function sendDailySummary() {
  if (!botSocket) return
  const { today } = getIsraeliDateInfo()
  const todays = await getTodayAppointments()
  let msg = '🗓️ תורים להיום - יום ' + today + ':\n─────────────────\n'
  if (todays.length === 0) {
    msg += 'אין תורים מתוכננים להיום\n'
  } else {
    for (const a of todays) {
      msg += '🕐 ' + a.time + ' - ' + a.phone + '\n'
    }
  }
  msg += '─────────────────\n✅ סה"כ: ' + todays.length + ' תורים היום'
  await notifyYairRaw(msg)
}

function scheduleDailySummary() {
  setInterval(() => {
    const { now } = getIsraeliDateInfo()
    if (now.getHours() === 8 && now.getMinutes() === 0) sendDailySummary()
  }, 60 * 1000)
}

// ========== סקריפט אתחול Firebase ==========
async function initFirebaseData() {
  const blockedSnapshot = await blockedCol.limit(1).get()
  if (blockedSnapshot.empty) {
    console.log('מאתחל מספרים חסומים ב-Firebase...')
    const initialBlocked = [
      '972526472323', '972533030598', '972545449945', '972526728787',
      '972584943389', '972547467841', '972546284000', '972527587752',
      '972504135426', '972522156057', '972543147703', '972506484030',
      '972532318008', '972528605086', '972507088775',
    ]
    const batch = db.batch()
    initialBlocked.forEach(phone => {
      batch.set(blockedCol.doc(phone), { addedAt: FieldValue.serverTimestamp() })
    })
    await batch.commit()
  }

  const familySnapshot = await familyCol.limit(1).get()
  if (familySnapshot.empty) {
    console.log('מאתחל מספרי משפחה ב-Firebase...')
    const initialFamily = [
      { phone: '972547734708', name: 'אשתו' },
      { phone: '972549878444', name: 'אדל (בת)' },
      { phone: '972542295295', name: 'לירן (בת)' },
    ]
    const batch = db.batch()
    initialFamily.forEach(f => {
      batch.set(familyCol.doc(f.phone), { name: f.name, addedAt: FieldValue.serverTimestamp() })
    })
    await batch.commit()
  }
}

async function startBot() {
  console.log('טוען נתונים מ-Firebase...')
  await initFirebaseData()
  await loadBlockedFromFirebase()
  await loadFamilyFromFirebase()
  await loadLidMapFromFirebase()
  await loadSlotsFromFirebase()
  console.log('כל הנתונים נטענו!')

  // רענן כל 5 דקות
  setInterval(async () => {
    await loadBlockedFromFirebase()
    await loadFamilyFromFirebase()
    await loadLidMapFromFirebase()
  }, 5 * 60 * 1000)

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

  // ========== האזנה ל-lid-mapping.update מ-Baileys ==========
  sock.ev.on('lid-mapping.update', async (mappings) => {
    console.log('קיבלתי lid-mapping.update מ-Baileys! ' + JSON.stringify(mappings))
    if (Array.isArray(mappings)) {
      for (const m of mappings) {
        if (m.lid && m.phoneNumber) {
          const lid = m.lid.replace('@lid', '')
          const phone = m.phoneNumber.replace('@s.whatsapp.net', '').replace(/:.*/, '')
          await saveLidMapping(lid, phone)
        }
      }
    }
  })

  // ========== האזנה ל-contacts.update/upsert לחילוץ מיפויים ==========
  sock.ev.on('contacts.upsert', async (contacts) => {
    for (const contact of contacts) {
      if (contact.id && contact.phoneNumber) {
        const lid = contact.id.replace('@lid', '').replace('@s.whatsapp.net', '')
        const phone = contact.phoneNumber.replace('@s.whatsapp.net', '').replace(/:.*/, '')
        if (contact.id.includes('@lid') && phone.match(/^972/)) {
          await saveLidMapping(lid, phone)
        }
      }
      if (contact.lid && contact.phoneNumber) {
        const lid = contact.lid.replace('@lid', '')
        const phone = contact.phoneNumber.replace('@s.whatsapp.net', '').replace(/:.*/, '')
        if (phone.match(/^\d{10,}/)) {
          await saveLidMapping(lid, phone)
        }
      }
    }
  })

  sock.ev.on('contacts.update', async (contacts) => {
    for (const contact of contacts) {
      if (contact.id && contact.phoneNumber) {
        const lid = contact.id.replace('@lid', '').replace('@s.whatsapp.net', '')
        const phone = contact.phoneNumber.replace('@s.whatsapp.net', '').replace(/:.*/, '')
        if (contact.id.includes('@lid') && phone.match(/^972/)) {
          await saveLidMapping(lid, phone)
        }
      }
    }
  })

  setInterval(async () => {
    if (botSocket && botSocket.user) {
      try { await botSocket.sendPresenceUpdate('available', botSocket.user.id) } catch {}
    }
  }, 4 * 60 * 1000)

  let remindersInterval = null
  let summaryScheduled = false

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) { currentQR = qr; console.log('QR מוכן!') }
    if (connection === 'open') {
      currentQR = null
      console.log("ג'ימי מחובר!")
      if (!remindersInterval) remindersInterval = setInterval(sendReminders, 10 * 60 * 1000)
      if (!summaryScheduled) { scheduleDailySummary(); summaryScheduled = true }
    }
    if (connection === 'close') {
      botSocket = null
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode
      console.log('התנתק - קוד:', code)
      if (code === DisconnectReason.loggedOut) { setTimeout(startBot, 5000) }
      else if (code === DisconnectReason.restartRequired) { setTimeout(startBot, 1000) }
      else { setTimeout(startBot, 3000) }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const msg of messages) {
      if (msg.key.fromMe) continue
      if (msg.key.remoteJid.endsWith('@g.us')) continue
      const sender = msg.key.remoteJid
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || ''
      if (!text) continue

      // ========== נסה לפענח LID לפני הכל ==========
      // ✅ גרסה 6.8+: בדוק senderPn (Alt JID) - המספר הממשי מ-Baileys
      const senderPn = msg.key?.senderPn
      if (senderPn) {
        const pnPhone = senderPn.replace('@s.whatsapp.net', '').replace(/:.*/, '')
        console.log('[senderPn] זוהה! sender=' + sender + ' senderPn=' + senderPn + ' phone=' + pnPhone)
        if (sender.includes('@lid')) {
          const lid = sender.replace('@lid', '')
          await saveLidMapping(lid, pnPhone)
        }
      } else if (sender.includes('@lid')) {
        // לוג מפורט לדיאגנוסטיקה - כל השדות הרלוונטיים
        console.log('[LID DEBUG] sender=' + sender)
        console.log('[LID DEBUG] msg.key fields:', JSON.stringify({
          remoteJid: msg.key?.remoteJid,
          participant: msg.key?.participant,
          senderPn: msg.key?.senderPn,
          fromMe: msg.key?.fromMe,
        }))
        // nnסה resolve מ-Baileys
        const resolved = await resolveLidToPhone(sender)
        if (resolved) {
          console.log('[LID] resolved: ' + sender + ' => ' + resolved)
        } else {
          console.log('[LID] לא ממופה עדיין: ' + sender)
        }
      } else {
        console.log('הודעה מ-' + sender + ': ' + text)
      }

      // ========== בדיקת participant לגיבוי ==========
      if (msg.key.participant) {
        const partJid = msg.key.participant
        if (sender.includes('@lid') && partJid.includes('@s.whatsapp.net')) {
          const lid = sender.replace('@lid', '')
          const phone = partJid.replace('@s.whatsapp.net', '')
          await saveLidMapping(lid, phone)
        }
      }

      // ========== משפחה / חסומים - עם resolve אסינכרוני ==========
      // חשוב: קודם resolve ה-LID, אחר כך בדוק
      if (await isFamilyMember(sender)) {
        console.log('הודעה ממשפחה - מועברת ליאיר בלי תשובה')
        const phone = await extractPhone(sender) || sender.replace(/@.+/, '')
        const waLink = getWALink(phone)
        await notifyYairRaw(
          '👨‍👩‍👧 הודעה ממשפחה!\n' +
          '💬 לינק ישיר לצ\'אט: ' + waLink + '\n\n' +
          '✉️ ההודעה:\n' + text
        )
        continue
      }

      if (await isBlocked(sender)) {
        console.log('מספר חסום - מדלג: ' + sender)
        continue
      }

      // ========== ביטול טיימר נטישה (המשתמש חזר) ==========
      cancelAbandonTimer(sender)

      try {
        await sock.sendPresenceUpdate('composing', sender)
        const reply = await askJimmy(sender, text)
        const checkingMatch = reply.match(/CHECKING_SLOT,יום:([^,\n]+),שעה:([^,\n\s]+)/)
        if (checkingMatch) {
          const checkDay = checkingMatch[1].trim()
          const checkTime = checkingMatch[2].trim()
          await sock.sendMessage(sender, { text: 'רגע, בודק אם ' + checkDay + ' ב-' + checkTime + ' פנוי... 🔍' })
          await new Promise(r => setTimeout(r, 2500))
          const { today, tomorrow } = getIsraeliDateInfo()
          let resolvedDay = checkDay
          if (resolvedDay === 'היום') resolvedDay = today
          if (resolvedDay === 'מחר') resolvedDay = tomorrow
          const available = getAvailableSlots(resolvedDay)
          const availableText = available.length > 0 ? available.join(', ') : 'אין שעות פנויות'
          const slotContext = isSlotAvailable(resolvedDay, checkTime)
            ? '[SLOT_AVAILABLE - יום ' + resolvedDay + ' בשעה ' + checkTime + ' פנוי!]'
            : '[SLOT_FULL - השעה ' + checkTime + ' ביום ' + resolvedDay + ' תפוסה! שעות פנויות: ' + availableText + ']'
          const followUp = await askJimmy(sender, slotContext)
          await sock.sendMessage(sender, { text: followUp })
          // הפעל טיימר נטישה אחרי תשובת ג'ימי
          markAbandonTimer(sender, followUp)
        } else {
          await sock.sendMessage(sender, { text: reply })
          // הפעל טיימר נטישה אחרי תשובת ג'ימי
          markAbandonTimer(sender, reply)
        }
      } catch (err) {
        console.error('שגיאה:', err?.message)
        await sock.sendMessage(sender, { text: 'אוי, משהו השתבש - נסה שוב! 😅' })
      }
    }
  })
}

startBot()

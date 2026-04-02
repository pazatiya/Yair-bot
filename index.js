import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import pino from 'pino'
import { toDataURL } from 'qrcode'
import { createServer } from 'http'
import { rmSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

// ========== Supabase Setup ==========
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

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

// ========== קאש מקומי ==========
let BLOCKED_PHONES = []
let FAMILY_PHONES = []
let lidToPhone = {}
let phoneToLid = {}
let knownLids = []
let notifiedLids = new Set()

// ========== יצירת טבלאות אוטומטית ==========
async function initSupabaseTables() {
  console.log('בודק ויוצר טבלאות ב-Supabase...')

  // יצירת טבלאות באמצעות rpc - אם לא קיימות
  const { error } = await supabase.rpc('exec_sql', {
    query: `
      CREATE TABLE IF NOT EXISTS blocked_phones (id TEXT PRIMARY KEY, added_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS family_phones (id TEXT PRIMARY KEY, name TEXT, added_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS lid_map (lid TEXT PRIMARY KEY, phone TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS known_lids (lid TEXT PRIMARY KEY, added_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS appointments (id SERIAL PRIMARY KEY, day TEXT NOT NULL, time TEXT NOT NULL, phone TEXT, cancelled BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS reminders (id SERIAL PRIMARY KEY, phone TEXT NOT NULL, day TEXT NOT NULL, time TEXT NOT NULL, resolved_date TEXT, sent_day BOOLEAN DEFAULT FALSE, sent_hour BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS customers (phone TEXT PRIMARY KEY, name TEXT, haircut_count INTEGER DEFAULT 0, clothes_inquiry_count INTEGER DEFAULT 0, first_seen TIMESTAMPTZ DEFAULT NOW(), last_seen TIMESTAMPTZ DEFAULT NOW());
    `
  })

  // אם rpc לא עובד, ננסה דרך REST ישירות
  if (error) {
    console.log('rpc לא זמין, מנסה ליצור טבלאות דרך fetch...')
    try {
      const dbUrl = process.env.SUPABASE_URL.replace('.supabase.co', '.supabase.co/rest/v1/rpc/exec_sql')
      // ננסה פשוט לקרוא מהטבלאות - אם הן קיימות זה יעבוד
      const { data, error: testError } = await supabase.from('blocked_phones').select('id').limit(1)
      if (testError && testError.code === '42P01') {
        // טבלה לא קיימת - צריך ליצור ידנית ב-SQL Editor
        console.error('⚠️ הטבלאות לא קיימות! צריך להריץ את ה-SQL ב-Supabase SQL Editor')
        console.error('הבוט ימשיך לעבוד עם fallback מקומי')
      } else {
        console.log('טבלאות קיימות!')
      }
    } catch (e) {
      console.error('שגיאה בבדיקת טבלאות:', e?.message)
    }
  } else {
    console.log('טבלאות נוצרו בהצלחה!')
  }
}

// ========== אתחול נתונים ראשוני ==========
async function initData() {
  // בדוק אם יש חסומים - אם לא, הוסף את הרשימה הראשונית
  const { data: blocked } = await supabase.from('blocked_phones').select('id')
  if (!blocked || blocked.length === 0) {
    console.log('מאתחל מספרים חסומים...')
    const initialBlocked = [
      '972526472323', '972533030598', '972545449945', '972526728787',
      '972584943389', '972547467841', '972546284000', '972527587752',
      '972504135426', '972522156057', '972543147703', '972506484030',
      '972532318008', '972528605086', '972507088775',
    ]
    await supabase.from('blocked_phones').upsert(initialBlocked.map(id => ({ id })))
  }

  const { data: family } = await supabase.from('family_phones').select('id')
  if (!family || family.length === 0) {
    console.log('מאתחל מספרי משפחה...')
    await supabase.from('family_phones').upsert([
      { id: '972547734708', name: 'אשתו' },
      { id: '972549878444', name: 'אדל' },
      { id: '972542295295', name: 'לירן' },
    ])
  }
}

// ========== טעינה מ-Supabase ==========
async function loadAllData() {
  try {
    const { data: blocked } = await supabase.from('blocked_phones').select('id')
    BLOCKED_PHONES = (blocked || []).map(r => r.id)
    console.log('נטענו ' + BLOCKED_PHONES.length + ' מספרים חסומים')
  } catch (err) {
    console.error('שגיאה בטעינת חסומים:', err?.message)
    BLOCKED_PHONES = ['972526472323','972533030598','972545449945','972526728787','972584943389','972547467841','972546284000','972527587752','972504135426','972522156057','972543147703','972506484030','972532318008','972528605086','972507088775']
  }

  try {
    const { data: family } = await supabase.from('family_phones').select('id')
    FAMILY_PHONES = (family || []).map(r => r.id)
    console.log('נטענו ' + FAMILY_PHONES.length + ' מספרי משפחה')
  } catch (err) {
    console.error('שגיאה בטעינת משפחה:', err?.message)
    FAMILY_PHONES = ['972547734708','972549878444','972542295295']
  }

  try {
    const { data: lids } = await supabase.from('lid_map').select('lid, phone')
    if (lids) lids.forEach(r => { lidToPhone[r.lid] = r.phone; phoneToLid[r.phone] = r.lid })
    console.log('נטענו ' + Object.keys(lidToPhone).length + ' מיפויי LID')
  } catch (err) { console.error('שגיאה בטעינת LID map:', err?.message) }

  try {
    const { data: known } = await supabase.from('known_lids').select('lid')
    knownLids = (known || []).map(r => r.lid)
    console.log('נטענו ' + knownLids.length + ' LIDs מוכרים')
  } catch (err) { console.error('שגיאה בטעינת known LIDs:', err?.message) }

  try {
    const { data: appts } = await supabase.from('appointments').select('day, time').eq('cancelled', false)
    if (appts) appts.forEach(a => {
      const key = a.day + '-' + a.time
      appointments[key] = (appointments[key] || 0) + 1
    })
    console.log('נטענו ' + (appts?.length || 0) + ' תורים פעילים')
  } catch (err) { console.error('שגיאה בטעינת תורים:', err?.message) }
}

// ========== שמירת מיפוי LID ==========
async function saveLidMapping(lid, phone) {
  if (!lid || !phone || lidToPhone[lid] === phone) return
  lidToPhone[lid] = phone
  phoneToLid[phone] = lid
  try {
    await supabase.from('lid_map').upsert({ lid, phone, updated_at: new Date().toISOString() })
    console.log('LID mapping saved: ' + lid + ' -> ' + phone)
  } catch (err) { console.error('שגיאה בשמירת LID:', err?.message) }
}

// ========== חילוץ מספר טלפון ==========
function extractPhone(sender) {
  if (sender.includes('@s.whatsapp.net')) return sender.replace('@s.whatsapp.net', '')
  if (sender.includes('@lid')) {
    const lid = sender.replace('@lid', '')
    if (lidToPhone[lid]) return lidToPhone[lid]
    return null
  }
  return sender
}

function getWALink(phone) {
  if (phone && phone.startsWith('972')) return 'https://wa.me/' + phone
  return 'מספר לא ידוע'
}

// ========== בדיקת חסום / משפחה ==========
function isBlocked(sender) {
  if (sender.includes('@s.whatsapp.net')) {
    return BLOCKED_PHONES.includes(sender.replace('@s.whatsapp.net', ''))
  }
  if (sender.includes('@lid')) {
    const lid = sender.replace('@lid', '')
    if (BLOCKED_PHONES.includes(lid)) return true
    const phone = lidToPhone[lid]
    if (phone && BLOCKED_PHONES.includes(phone)) return true
  }
  return false
}

function isFamilyMember(sender) {
  if (sender.includes('@s.whatsapp.net')) {
    return FAMILY_PHONES.includes(sender.replace('@s.whatsapp.net', ''))
  }
  if (sender.includes('@lid')) {
    const lid = sender.replace('@lid', '')
    if (FAMILY_PHONES.includes(lid)) return true
    const phone = lidToPhone[lid]
    if (phone && FAMILY_PHONES.includes(phone)) return true
  }
  return false
}

function isKnownLid(sender) {
  if (!sender.includes('@lid')) return true
  const lid = sender.replace('@lid', '')
  return BLOCKED_PHONES.includes(lid) || FAMILY_PHONES.includes(lid) || knownLids.includes(lid) || !!lidToPhone[lid]
}

// ========== נסה לפענח LID ==========
async function tryResolveLid(sender) {
  if (!sender.includes('@lid')) return
  const lid = sender.replace('@lid', '')
  if (lidToPhone[lid]) return

  if (botSocket?.signalRepository?.lidMapping) {
    try {
      const pn = await botSocket.signalRepository.lidMapping.getPNForLID(sender)
      if (pn?.includes('@s.whatsapp.net')) {
        const phone = pn.replace('@s.whatsapp.net', '').replace(/:.*/, '')
        await saveLidMapping(lid, phone)
        return
      }
    } catch {}
  }

  if (botSocket) {
    try {
      const [result] = await botSocket.onWhatsApp(sender)
      if (result?.jid?.includes('@s.whatsapp.net')) {
        await saveLidMapping(lid, result.jid.replace('@s.whatsapp.net', ''))
      }
    } catch {}
  }
}

// ========== פקודות יאיר ==========
async function handleYairCommand(text) {
  const blockMatch = text.match(/^חסום\s+(\S+)/i)
  if (blockMatch) {
    const id = blockMatch[1].trim()
    if (!BLOCKED_PHONES.includes(id)) {
      BLOCKED_PHONES.push(id)
      await supabase.from('blocked_phones').upsert({ id })
    }
    return '✅ ' + id + ' נחסם!'
  }

  const familyMatch = text.match(/^משפחה\s+(\S+)/i)
  if (familyMatch) {
    const id = familyMatch[1].trim()
    if (!FAMILY_PHONES.includes(id)) {
      FAMILY_PHONES.push(id)
      await supabase.from('family_phones').upsert({ id })
    }
    return '✅ ' + id + ' נוסף למשפחה!'
  }

  const normalMatch = text.match(/^רגיל\s+(\S+)/i)
  if (normalMatch) {
    const id = normalMatch[1].trim()
    if (!knownLids.includes(id)) {
      knownLids.push(id)
      await supabase.from('known_lids').upsert({ lid: id })
    }
    return '✅ ' + id + ' סומן כלקוח רגיל!'
  }

  const unblockMatch = text.match(/^(בטל.?חסימה|שחרר)\s+(\S+)/i)
  if (unblockMatch) {
    const id = unblockMatch[2].trim()
    BLOCKED_PHONES = BLOCKED_PHONES.filter(p => p !== id)
    await supabase.from('blocked_phones').delete().eq('id', id)
    return '✅ ' + id + ' הוסר מחסומים!'
  }

  const statusMatch = text.match(/^סטטוס$/i)
  if (statusMatch) {
    return '📊 סטטוס ג\'ימי:\n🚫 חסומים: ' + BLOCKED_PHONES.length + '\n👨‍👩‍👧 משפחה: ' + FAMILY_PHONES.length + '\n🗺️ מיפויי LID: ' + Object.keys(lidToPhone).length + '\n✅ LIDs רגילים: ' + knownLids.length
  }

  return null
}

// ========== מעקב נטישה ==========
const abandonTimers = {}
const ABANDON_DELAY_MS = 30 * 60 * 1000
const ACTIVE_FLOW_KEYWORDS = ['CHECKING_SLOT', 'מה שמך', 'ומה שמך', 'איזה יום', 'באיזה יום', 'שאל את שמו', 'שמו']

function markAbandonTimer(sender, lastBotReply) {
  if (abandonTimers[sender]?.timer) clearTimeout(abandonTimers[sender].timer)
  const isInProgress = ACTIVE_FLOW_KEYWORDS.some(kw => lastBotReply?.includes(kw)) ||
    (lastBotReply && (lastBotReply.includes('מה שמך') || lastBotReply.includes('שמך') ||
      lastBotReply.includes('איזה יום') || lastBotReply.includes('מתי בא לך') || lastBotReply.includes('איזו שעה')))
  if (!isInProgress) return
  const timer = setTimeout(async () => {
    if (!botSocket) return
    try {
      await botSocket.sendMessage(sender, { text: 'היי! 😊\nראיתי שהתחלנו לדבר אבל לא סיימנו...\nרוצה שאקבע לך תור? 💈 אני כאן!' })
    } catch {}
    delete abandonTimers[sender]
  }, ABANDON_DELAY_MS)
  abandonTimers[sender] = { timer, lastActivity: new Date() }
}

function cancelAbandonTimer(sender) {
  if (abandonTimers[sender]?.timer) { clearTimeout(abandonTimers[sender].timer); delete abandonTimers[sender] }
}

// ========== תזכורות ==========
async function loadReminders() {
  try {
    const { data } = await supabase.from('reminders').select('*')
    return data || []
  } catch { return [] }
}

async function addReminder(phone, day, time, resolvedDate) {
  try {
    await supabase.from('reminders').delete().eq('phone', phone)
    await supabase.from('reminders').insert({ phone, day, time, resolved_date: resolvedDate, sent_day: false, sent_hour: false })
  } catch (err) { console.error('שגיאה בתזכורת:', err?.message) }
}

async function cancelReminder(phone) {
  try { await supabase.from('reminders').delete().eq('phone', phone) } catch {}
}

// ========== מאגר לקוחות ==========
async function upsertCustomer(phone, name, type) {
  try {
    const { data: existing } = await supabase.from('customers').select('*').eq('phone', phone).single()
    if (existing) {
      const updates = { last_seen: new Date().toISOString() }
      if (name && name !== 'לא צוין') updates.name = name
      if (type === 'haircut') updates.haircut_count = (existing.haircut_count || 0) + 1
      if (type === 'clothes') updates.clothes_inquiry_count = (existing.clothes_inquiry_count || 0) + 1
      await supabase.from('customers').update(updates).eq('phone', phone)
    } else {
      const newCustomer = { phone, name: (name && name !== 'לא צוין') ? name : null, last_seen: new Date().toISOString(), first_seen: new Date().toISOString(), haircut_count: type === 'haircut' ? 1 : 0, clothes_inquiry_count: type === 'clothes' ? 1 : 0 }
      await supabase.from('customers').insert(newCustomer)
    }
  } catch (err) { console.error('שגיאה בשמירת לקוח:', err?.message) }
}


async function logAppointment(day, time, phone) {
  try {
    await supabase.from('appointments').insert({ day, time, phone, cancelled: false })
  } catch (err) { console.error('שגיאה ברישום תור:', err?.message) }
}

async function getUserAppointment(phone) {
  try {
    const { data } = await supabase.from('appointments').select('*').eq('phone', phone).eq('cancelled', false).order('created_at', { ascending: false }).limit(1)
    return data?.[0] || null
  } catch { return null }
}

async function cancelUserAppointment(phone) {
  try {
    const appt = await getUserAppointment(phone)
    if (!appt) return null
    await supabase.from('appointments').update({ cancelled: true }).eq('id', appt.id)
    const key = appt.day + '-' + appt.time
    if (appointments[key] > 0) appointments[key]--
    await cancelReminder(phone + '@s.whatsapp.net')
    return appt
  } catch { return null }
}

async function getTodayAppointments() {
  try {
    const { today } = getIsraeliDateInfo()
    const { data } = await supabase.from('appointments').select('*').eq('day', today).eq('cancelled', false).order('time')
    return data || []
  } catch { return [] }
}

// ========== שרת HTTP לQR ==========
let currentQR = null
createServer((req, res) => {
  if (currentQR) {
    toDataURL(currentQR, (err, url) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`<html><head><meta charset="utf-8"></head><body style="display:flex;justify-content:center;align-items:center;height:100vh;background:#111"><div style="text-align:center"><h2 style="color:white;font-family:sans-serif">סרוק עם וואטסאפ של יאיר</h2><img src="${url}" style="width:300px;height:300px"/></div></body></html>`)
    })
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<html><head><meta charset="utf-8"></head><body style="background:#111;color:white;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh"><h2>הבוט מחובר!</h2></body></html>`)
  }
}).listen(process.env.PORT || 8080)

// ========== תאריך ישראלי ==========
function getIsraeliDateInfo() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }))
  const days = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת']
  const today = days[now.getDay()]
  const tomorrow = days[(now.getDay() + 1) % 7]
  const currentTime = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0')
  return { today, tomorrow, currentTime, currentHour: now.getHours(), dayIndex: now.getDay(), now }
}

function resolveToDate(dayName, isToday, isTomorrow) {
  const { now } = getIsraeliDateInfo()
  if (isToday) return new Date(now)
  if (isTomorrow) { const d = new Date(now); d.setDate(d.getDate() + 1); return d }
  const dayMap = { 'ראשון': 0, 'שני': 1, 'שלישי': 2, 'רביעי': 3, 'חמישי': 4, 'שישי': 5, 'שבת': 6 }
  const target = dayMap[dayName]
  if (target === undefined) return null
  const d = new Date(now)
  d.setDate(d.getDate() + ((target - d.getDay() + 7) % 7 || 7))
  return d
}

// ========== ניהול תורים ==========
function getSlotKey(day, time) { return day + '-' + time }
function isSlotAvailable(day, time) { return (appointments[getSlotKey(day, time)] || 0) < MAX_PER_SLOT }
function bookSlot(day, time) { const key = getSlotKey(day, time); appointments[key] = (appointments[key] || 0) + 1 }
function cancelSlot(day, time) { const key = getSlotKey(day, time); if (appointments[key] > 0) appointments[key]-- }
function getAvailableSlots(day) {
  const allSlots = ['08:00','09:00','10:00','11:00','12:00','13:00','14:00','15:00','16:00','17:00','18:00','19:00']
  const fridaySlots = ['08:00','09:00','10:00','11:00','12:00','13:00']
  return (day === 'שישי' ? fridaySlots : allSlots).filter(t => isSlotAvailable(day, t))
}

// ========== סיכום שיחה ==========
function buildConversationSummary(userPhone) {
  const history = conversations[userPhone] || []
  if (history.length === 0) return 'אין היסטוריית שיחה'
  return history.map(m => (m.role === 'user' ? 'לקוח: ' : "ג'ימי: ") + m.content).join('\n')
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
- תספורת לקוח חוזר: אל תגלה מחיר! תגיד רק "אין בעיה!" ותמשיך לקבוע תור
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
    - אחרי שם, שאל מה הנושא: "ומה הנושא?"
    - אחרי שם + נושא: "סבבה [שם]! העברתי את הפרטים ליאיר - כשהוא יתפנה הוא יחזור אליך!"
    - ואז: TRANSFER_TO_YAIR,שם:[שם],נושא:[נושא]
12. אל תשלח קישורי wa.me ללקוחות
13. שבת סגור, שישי עד 14:00 בלבד
14. אם לא הבנת - "סליחה, לא הבנתי 😅 תוכל לנסח שוב?"
15. ביטול או דחיית תור:
    - אם מישהו רוצה לבטל תור - כתוב CANCEL_APPOINTMENT
    - אם מישהו רוצה לדחות/לשנות תור - כתוב RESCHEDULE_APPOINTMENT
    - בשני המקרים, קודם אמור "רגע, בודק את התור שלך..." ואחרי כן בוט יטפל בזה`

// ========== שאילת ג'ימי ==========
async function askJimmy(userPhone, userMessage) {
  if (!conversations[userPhone]) conversations[userPhone] = []
  const { today, tomorrow, currentTime } = getIsraeliDateInfo()
  const dynamicSystem = JIMMY_SYSTEM_BASE + '\n\n--- מידע נוכחי ---\n- היום: יום ' + today + '\n- מחר: יום ' + tomorrow + '\n- השעה עכשיו: ' + currentTime

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
      contextMessage = userMessage + '\n[SLOT_FULL - השעה ' + time + ' ביום ' + resolvedDay + ' תפוסה! שעות פנויות: ' + (available.join(', ') || 'אין') + ']'
    }
  }

  conversations[userPhone].push({ role: 'user', content: contextMessage })
  if (conversations[userPhone].length > 20) conversations[userPhone] = conversations[userPhone].slice(-20)

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 600, system: dynamicSystem, messages: conversations[userPhone] })
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
      let day = dayM[1].trim(); let time = timeM[1].trim()
      if (day === 'היום') day = todayNow; if (day === 'מחר') day = tomorrowNow
      if (isSlotAvailable(day, time)) {
        bookSlot(day, time)
        const phone = extractPhone(userPhone) || userPhone.replace(/@.+/, '')
        await logAppointment(day, time, phone)
        const appointmentDate = resolveToDate(day, day === todayNow, day === tomorrowNow)
        if (appointmentDate) await addReminder(userPhone, day, time, appointmentDate.toISOString())
        const nameM2 = details.match(/שם:([^,\n]+)/)
        const customerName = nameM2?.[1]?.trim() || 'לא צוין'
        await upsertCustomer(phone, customerName, 'haircut')
        await notifyYairRaw('✂️ תור חדש נקבע!\n\n👤 שם: ' + customerName + '\n📅 יום: ' + day + '\n⏰ שעה: ' + time + '\n📱 מספר: ' + phone + '\n💬 וואטסאפ: https://wa.me/' + phone + '\n\nסיכום שיחה:\n' + buildConversationSummary(userPhone))
      }
    }
    reply = parts[0].trim()
    if (!reply.includes('סבבה') && !reply.includes('מסודר') && !reply.includes('קבעתי')) {
      const day = dayM?.[1]?.trim() === 'היום' ? todayNow : dayM?.[1]?.trim() === 'מחר' ? tomorrowNow : dayM?.[1]?.trim()
      const time = timeM?.[1]?.trim()
      if (day && time) reply = (reply ? reply + '\n\n' : '') + 'סבבה, הכל מסודר! ✅\nקבעתי תור אצל יאיר:\nיום: ' + day + '\nשעה: ' + time + '\nכתובת: אלי כהן 12, לוד\nוויז: https://waze.com/ul?q=אלי+כהן+12+לוד&navigate=yes\nמחכים לך!'
    }
  }

  if (reply.includes('CLOTHES_INQUIRY')) {
    reply = reply.replace('CLOTHES_INQUIRY', '').trim()
    const phone = extractPhone(userPhone) || userPhone.replace(/@.+/, '')
    await upsertCustomer(phone, null, 'clothes')
    await notifyYairRaw('👕 לקוח שואל על בגדים!\n📱 ' + phone + '\n💬 https://wa.me/' + phone)
  }

  if (reply.includes('TRANSFER_TO_YAIR')) {
    const transferParts = reply.split('TRANSFER_TO_YAIR,')
    const td = transferParts[1] || ''
    const nameM = td.match(/שם:([^,\n]+)/); const topicM = td.match(/נושא:([^,\n]+)/)
    const cn = nameM?.[1]?.trim() || 'לא צוין'; const ct = topicM?.[1]?.trim() || 'לא צוין'
    reply = transferParts[0].trim()
    if (!reply || reply.length < 10) reply = 'סבבה ' + cn + '! העברתי את הפרטים ליאיר - כשהוא יתפנה הוא יחזור אליך!'
    const phone = extractPhone(userPhone) || userPhone.replace(/@.+/, '')
    await upsertCustomer(phone, cn, null)
    await notifyYairRaw('📲 לקוח רוצה לדבר איתך!\n👤 שם: ' + cn + '\n📝 נושא: ' + ct + '\n💬 לינק: https://wa.me/' + phone)
  }

  if (reply.includes('CANCEL_APPOINTMENT')) {
    reply = reply.replace('CANCEL_APPOINTMENT', '').trim()
    const phone = extractPhone(userPhone) || userPhone.replace(/@.+/, '')
    const appt = await cancelUserAppointment(phone)
    if (appt) {
      reply = 'סבבה, ביטלתי את התור שלך ביום ' + appt.day + ' בשעה ' + appt.time + ' ✅\nאם תרצה לקבוע מחדש - אני כאן!'
      await notifyYairRaw('❌ תור בוטל!\n📅 יום: ' + appt.day + '\n⏰ שעה: ' + appt.time + '\n📱 ' + phone)
    } else reply = 'לא מצאתי תור פעיל על המספר שלך 🤔 דבר ישירות עם יאיר!'
  }

  if (reply.includes('RESCHEDULE_APPOINTMENT')) {
    reply = reply.replace('RESCHEDULE_APPOINTMENT', '').trim()
    const phone = extractPhone(userPhone) || userPhone.replace(/@.+/, '')
    const appt = await getUserAppointment(phone)
    if (appt) {
      await cancelUserAppointment(phone)
      reply = 'סבבה! ביטלתי את התור ביום ' + appt.day + ' בשעה ' + appt.time + ' 🔄\nאיזה יום ושעה חדשים מתאימים?'
      await notifyYairRaw('🔄 לקוח רוצה לדחות תור!\n📅 תור ישן: ' + appt.day + ' ' + appt.time + '\n📱 ' + phone)
    } else reply = 'לא מצאתי תור פעיל 🤔 תרצה לקבוע תור חדש?'
  }

  return reply
}

async function notifyYairRaw(msg) {
  if (!botSocket) return
  try { await botSocket.sendMessage(OWNER_PHONE, { text: msg }) } catch (err) { console.error('שגיאה בשליחה ליאיר:', err?.message) }
}

// ========== תזכורות ==========
async function sendReminders() {
  if (!botSocket) return
  const reminders = await loadReminders()
  if (reminders.length === 0) return
  const { now } = getIsraeliDateInfo()
  for (const r of reminders) {
    if (!r.resolved_date) continue
    const apptDate = new Date(r.resolved_date)
    const [h, m] = r.time.split(':').map(Number); apptDate.setHours(h, m, 0, 0)
    const hoursUntil = (apptDate - now) / (1000 * 60 * 60)
    if (!r.sent_day && hoursUntil > 3 && hoursUntil <= 24) {
      try {
        await botSocket.sendMessage(r.phone, { text: 'היי! תזכורת - יש לך תור מחר יום ' + r.day + ' בשעה ' + r.time + ' אצל יאיר!\nכתובת: אלי כהן 12, לוד\nוויז: https://waze.com/ul?q=אלי+כהן+12+לוד&navigate=yes' })
        await supabase.from('reminders').update({ sent_day: true }).eq('id', r.id)
      } catch {}
    }
    if (!r.sent_hour && hoursUntil > 0 && hoursUntil <= 3) {
      try {
        await botSocket.sendMessage(r.phone, { text: 'היי! תזכורת - התור שלך היום בשעה ' + r.time + ' - נתראה בקרוב!\nכתובת: אלי כהן 12, לוד' })
        await supabase.from('reminders').update({ sent_hour: true }).eq('id', r.id)
      } catch {}
    }
    if (apptDate - now < 0) { try { await supabase.from('reminders').delete().eq('id', r.id) } catch {} }
  }
}

async function sendDailySummary() {
  if (!botSocket) return
  const { today } = getIsraeliDateInfo()
  const todays = await getTodayAppointments()
  let msg = '🗓️ תורים להיום - יום ' + today + ':\n─────────────────\n'
  if (todays.length === 0) msg += 'אין תורים מתוכננים להיום\n'
  else todays.forEach(a => { msg += '🕐 ' + a.time + ' - ' + a.phone + '\n' })
  msg += '─────────────────\n✅ סה"כ: ' + todays.length + ' תורים'
  await notifyYairRaw(msg)
}

// ========== startBot ==========
async function startBot() {
  console.log('מתחיל...')
  await initSupabaseTables()
  await initData()
  await loadAllData()
  console.log('כל הנתונים נטענו! מתחבר לוואטסאפ...')

  const { state, saveCreds } = await useMultiFileAuthState('auth_info')
  const { version } = await fetchLatestBaileysVersion()
  const logger = pino({ level: 'silent' })

  const sock = makeWASocket({
    version, logger,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    printQRInTerminal: false, browser: ['Jimmy-Bot', 'Safari', '605.1.15'], syncFullHistory: false,
  })

  botSocket = sock
  sock.ev.on('creds.update', saveCreds)

  // LID mapping events
  sock.ev.on('lid-mapping.update', async (mappings) => {
    if (Array.isArray(mappings)) for (const m of mappings) {
      if (m.lid && m.phoneNumber) await saveLidMapping(m.lid.replace('@lid', ''), m.phoneNumber.replace('@s.whatsapp.net', '').replace(/:.*/, ''))
    }
  })
  sock.ev.on('contacts.upsert', async (contacts) => {
    for (const c of contacts) {
      if (c.id?.includes('@lid') && c.phoneNumber) await saveLidMapping(c.id.replace('@lid', ''), c.phoneNumber.replace('@s.whatsapp.net', '').replace(/:.*/, ''))
      if (c.lid && c.phoneNumber) await saveLidMapping(c.lid.replace('@lid', ''), c.phoneNumber.replace('@s.whatsapp.net', '').replace(/:.*/, ''))
    }
  })

  setInterval(async () => { if (botSocket?.user) try { await botSocket.sendPresenceUpdate('available', botSocket.user.id) } catch {} }, 4 * 60 * 1000)

  let remindersInterval = null, summaryScheduled = false

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) { currentQR = qr; console.log('QR מוכן!') }
    if (connection === 'open') {
      currentQR = null; console.log("ג'ימי מחובר!")
      if (!remindersInterval) remindersInterval = setInterval(sendReminders, 10 * 60 * 1000)
      if (!summaryScheduled) { setInterval(() => { const { now } = getIsraeliDateInfo(); if (now.getHours() === 8 && now.getMinutes() === 0) sendDailySummary() }, 60 * 1000); summaryScheduled = true }
    }
    if (connection === 'close') {
      botSocket = null
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode
      console.log('התנתק - קוד:', code)
      if (code === DisconnectReason.loggedOut) setTimeout(startBot, 5000)
      else if (code === DisconnectReason.restartRequired) setTimeout(startBot, 1000)
      else setTimeout(startBot, 3000)
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
      console.log('הודעה מ-' + sender + ': ' + text)

      // ========== פקודות יאיר ==========
      if (sender === OWNER_PHONE) {
        const cmdResult = await handleYairCommand(text)
        if (cmdResult) { await sock.sendMessage(sender, { text: cmdResult }); continue }
      }

      // ========== נסה לפענח LID ==========
      if (sender.includes('@lid')) {
        const senderPn = msg.key?.senderPn
        if (senderPn) {
          const phone = senderPn.replace('@s.whatsapp.net', '').replace(/:.*/, '')
          await saveLidMapping(sender.replace('@lid', ''), phone)
          console.log('[senderPn] ' + sender + ' => ' + phone)
        } else {
          await tryResolveLid(sender)
        }
        if (msg.key.participant?.includes('@s.whatsapp.net')) {
          await saveLidMapping(sender.replace('@lid', ''), msg.key.participant.replace('@s.whatsapp.net', ''))
        }
      }

      // ========== משפחה ==========
      if (isFamilyMember(sender)) {
        console.log('הודעה ממשפחה - מועברת ליאיר')
        const phone = extractPhone(sender) || sender.replace(/@.+/, '')
        await notifyYairRaw('👨‍👩‍👧 הודעה ממשפחה!\n💬 ' + getWALink(phone) + '\n\n✉️ ההודעה:\n' + text)
        continue
      }

      // ========== חסום ==========
      if (isBlocked(sender)) { console.log('חסום - מדלג: ' + sender); continue }

      // ========== LID לא מוכר - שלח ליאיר פעם אחת ==========
      if (!isKnownLid(sender)) {
        const lid = sender.replace('@lid', '')
        if (!notifiedLids.has(lid)) {
          notifiedLids.add(lid)
          await notifyYairRaw(
            '🆕 מספר חדש (LID)!\n' +
            '💬 ההודעה: ' + text + '\n' +
            '🔑 ID: ' + lid + '\n\n' +
            'מה לעשות? שלח:\n' +
            '• חסום ' + lid + '\n' +
            '• משפחה ' + lid + '\n' +
            '• רגיל ' + lid
          )
        }
      }

      // ========== ביטול טיימר נטישה ==========
      cancelAbandonTimer(sender)

      try {
        await sock.sendPresenceUpdate('composing', sender)
        const reply = await askJimmy(sender, text)
        const checkingMatch = reply.match(/CHECKING_SLOT,יום:([^,\n]+),שעה:([^,\n\s]+)/)
        if (checkingMatch) {
          const checkDay = checkingMatch[1].trim(); const checkTime = checkingMatch[2].trim()
          await sock.sendMessage(sender, { text: 'רגע, בודק אם ' + checkDay + ' ב-' + checkTime + ' פנוי... 🔍' })
          await new Promise(r => setTimeout(r, 2500))
          const { today, tomorrow } = getIsraeliDateInfo()
          let resolvedDay = checkDay
          if (resolvedDay === 'היום') resolvedDay = today; if (resolvedDay === 'מחר') resolvedDay = tomorrow
          const available = getAvailableSlots(resolvedDay)
          const slotContext = isSlotAvailable(resolvedDay, checkTime)
            ? '[SLOT_AVAILABLE - יום ' + resolvedDay + ' בשעה ' + checkTime + ' פנוי!]'
            : '[SLOT_FULL - השעה ' + checkTime + ' ביום ' + resolvedDay + ' תפוסה! שעות פנויות: ' + (available.join(', ') || 'אין') + ']'
          const followUp = await askJimmy(sender, slotContext)
          await sock.sendMessage(sender, { text: followUp })
          markAbandonTimer(sender, followUp)
        } else {
          await sock.sendMessage(sender, { text: reply })
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

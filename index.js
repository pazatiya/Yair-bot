import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import pino from 'pino'
import { toDataURL } from 'qrcode'
import { createServer } from 'http'
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

// ========== Supabase Setup ==========
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

if (process.env.DELETE_AUTH === 'true') {
  try { rmSync('auth_info', { recursive: true, force: true }); console.log('auth_info נמחק - ממתין ל-QR חדש') } catch {}
  // מוחק גם מ-Supabase כשמגדירים DELETE_AUTH=true
  try {
    const supabaseDel = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
    await supabaseDel.from('bot_auth').delete().eq('id', 'main')
    console.log('auth נמחק מ-Supabase — ממתין ל-QR חדש')
  } catch {}
}

const OWNER_PHONE = '972507983306@s.whatsapp.net'
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
const MAX_PER_SLOT = 2
const conversations = {}
const appointments = {}
let botSocket = null
let badMacCount = 0
// ✅ תיקון: מונה נפרד ל-loggedOut כדי לא למחוק auth בגלל disconnect זמני
let loggedOutCount = 0

process.on("uncaughtException", (err) => {
  const msg = err?.message || ""
  if (msg.includes("Bad MAC") || msg.includes("bad mac") || msg.includes("TAG-MISMATCH") || msg.includes("Session error")) {
    console.error("⚠️ [Global] Bad MAC / Session error — ממשיך")
    badMacCount++
  } else {
    console.error("🔴 Uncaught Exception:", msg)
  }
})
process.on("unhandledRejection", (err) => {
  const msg = err?.message || String(err)
  if (msg.includes("Bad MAC") || msg.includes("bad mac") || msg.includes("Session error")) {
    console.error("⚠️ [Global] Bad MAC rejection — ממשיך")
  } else {
    console.error("🔴 Unhandled Rejection:", msg)
  }
})

let BLOCKED_PHONES = []
let FAMILY_PHONES = []
let lidToPhone = {}
let phoneToLid = {}
let knownLids = []
let notifiedLids = new Set()

// ========== שמירת Auth ב-Supabase ==========
async function saveAuthToSupabase(authData) {
  try {
    const serialized = JSON.stringify(authData, (key, value) => {
      if (value && typeof value === 'object' && value.type === 'Buffer') {
        return { type: 'Buffer', data: value.data }
      }
      if (Buffer.isBuffer(value)) {
        return { type: 'Buffer', data: Array.from(value) }
      }
      return value
    })
    await supabase.from('bot_auth').upsert({
      id: 'main',
      auth_data: serialized,
      updated_at: new Date().toISOString()
    })
  } catch (err) {
    console.error('שגיאה בשמירת auth:', err?.message)
  }
}

async function loadAuthFromSupabase() {
  try {
    const { data } = await supabase.from('bot_auth').select('auth_data').eq('id', 'main').single()
    if (!data?.auth_data) return null
    return JSON.parse(data.auth_data, (key, value) => {
      if (value && typeof value === 'object' && value.type === 'Buffer' && Array.isArray(value.data)) {
        return Buffer.from(value.data)
      }
      return value
    })
  } catch {
    return null
  }
}

async function useSupabaseAuthState() {
  let authData = await loadAuthFromSupabase()

  if (!authData) {
    console.log('אין auth שמור — מנקה ומחכה ל-QR')
    // ✅ תיקון קריטי: מוחק auth_info ישן כדי ש-Baileys לא יטעון creds פגומים
    try { rmSync('auth_info', { recursive: true, force: true }) } catch {}
    try { mkdirSync('auth_info', { recursive: true }) } catch {}
  } else {
    try {
      mkdirSync('auth_info', { recursive: true })
      if (authData.files) {
        for (const [filename, content] of Object.entries(authData.files)) {
          writeFileSync(`auth_info/${filename}`, typeof content === 'string' ? content : JSON.stringify(content))
        }
      }
    } catch (err) {
      console.error('שגיאה בכתיבת auth לקובץ:', err?.message)
    }
  }

  const { state, saveCreds } = await useMultiFileAuthState('auth_info')

  const saveCredsAndSync = async () => {
    await saveCreds()
    try {
      const files = {}
      try {
        const { readdirSync } = await import('fs')
        const allFiles = readdirSync('auth_info')
        for (const f of allFiles) {
          try { files[f] = readFileSync(`auth_info/${f}`, 'utf-8') } catch {}
        }
      } catch {}
      await saveAuthToSupabase({ files, savedAt: new Date().toISOString() })
    } catch (err) {
      console.error('שגיאה בסנכרון auth:', err?.message)
    }
  }

  return { state, saveCreds: saveCredsAndSync }
}

// ========== מערכת חגים ישראליים 2025-2036 ==========
const ISRAELI_HOLIDAYS = {}
ISRAELI_HOLIDAYS[2025] = [
  { date: '2025-03-13', name: 'ערב פורים', type: 'erev' },
  { date: '2025-03-14', name: 'פורים', type: 'halfday' },
  { date: '2025-04-13', name: 'ערב פסח', type: 'erev' },
  { date: '2025-04-14', name: 'פסח', type: 'holiday' },
  { date: '2025-04-15', name: 'חוה"מ פסח', type: 'chol', parentHoliday: 'פסח' },
  { date: '2025-04-16', name: 'חוה"מ פסח', type: 'chol', parentHoliday: 'פסח' },
  { date: '2025-04-17', name: 'חוה"מ פסח', type: 'chol', parentHoliday: 'פסח' },
  { date: '2025-04-18', name: 'חוה"מ פסח', type: 'chol', parentHoliday: 'פסח' },
  { date: '2025-04-19', name: 'ערב שביעי של פסח', type: 'erev' },
  { date: '2025-04-20', name: 'שביעי של פסח', type: 'holiday' },
  { date: '2025-04-30', name: 'ערב יום הזיכרון', type: 'erev' },
  { date: '2025-05-01', name: 'יום הזיכרון', type: 'memorial' },
  { date: '2025-05-02', name: 'יום העצמאות', type: 'holiday' },
  { date: '2025-06-01', name: 'ערב שבועות', type: 'erev' },
  { date: '2025-06-02', name: 'שבועות', type: 'holiday' },
  { date: '2025-09-22', name: 'ערב ראש השנה', type: 'erev' },
  { date: '2025-09-23', name: 'ראש השנה א', type: 'holiday' },
  { date: '2025-09-24', name: 'ראש השנה ב', type: 'holiday' },
  { date: '2025-10-01', name: 'ערב יום כיפור', type: 'erev' },
  { date: '2025-10-02', name: 'יום כיפור', type: 'holiday' },
  { date: '2025-10-06', name: 'ערב סוכות', type: 'erev' },
  { date: '2025-10-07', name: 'סוכות', type: 'holiday' },
  { date: '2025-10-08', name: 'חוה"מ סוכות', type: 'chol', parentHoliday: 'סוכות' },
  { date: '2025-10-09', name: 'חוה"מ סוכות', type: 'chol', parentHoliday: 'סוכות' },
  { date: '2025-10-10', name: 'חוה"מ סוכות', type: 'chol', parentHoliday: 'סוכות' },
  { date: '2025-10-11', name: 'חוה"מ סוכות', type: 'chol', parentHoliday: 'סוכות' },
  { date: '2025-10-12', name: 'הושענא רבה', type: 'erev' },
  { date: '2025-10-13', name: 'שמחת תורה', type: 'holiday' },
]
ISRAELI_HOLIDAYS[2026] = [
  { date: '2026-03-03', name: 'ערב פורים', type: 'erev' },
  { date: '2026-03-04', name: 'פורים', type: 'halfday' },
  { date: '2026-04-02', name: 'ערב פסח', type: 'erev' },
  { date: '2026-04-03', name: 'פסח', type: 'holiday' },
  { date: '2026-04-04', name: 'חוה"מ פסח', type: 'chol', parentHoliday: 'פסח' },
  { date: '2026-04-05', name: 'חוה"מ פסח', type: 'chol', parentHoliday: 'פסח' },
  { date: '2026-04-06', name: 'חוה"מ פסח', type: 'chol', parentHoliday: 'פסח' },
  { date: '2026-04-07', name: 'חוה"מ פסח', type: 'chol', parentHoliday: 'פסח' },
  { date: '2026-04-08', name: 'ערב שביעי של פסח', type: 'erev' },
  { date: '2026-04-09', name: 'שביעי של פסח', type: 'holiday' },
  { date: '2026-04-21', name: 'ערב יום הזיכרון', type: 'erev' },
  { date: '2026-04-22', name: 'יום הזיכרון', type: 'memorial' },
  { date: '2026-04-23', name: 'יום העצמאות', type: 'holiday' },
  { date: '2026-05-21', name: 'ערב שבועות', type: 'erev' },
  { date: '2026-05-22', name: 'שבועות', type: 'holiday' },
  { date: '2026-09-11', name: 'ערב ראש השנה', type: 'erev' },
  { date: '2026-09-12', name: 'ראש השנה א', type: 'holiday' },
  { date: '2026-09-13', name: 'ראש השנה ב', type: 'holiday' },
  { date: '2026-09-20', name: 'ערב יום כיפור', type: 'erev' },
  { date: '2026-09-21', name: 'יום כיפור', type: 'holiday' },
  { date: '2026-09-25', name: 'ערב סוכות', type: 'erev' },
  { date: '2026-09-26', name: 'סוכות', type: 'holiday' },
  { date: '2026-09-27', name: 'חוה"מ סוכות', type: 'chol', parentHoliday: 'סוכות' },
  { date: '2026-09-28', name: 'חוה"מ סוכות', type: 'chol', parentHoliday: 'סוכות' },
  { date: '2026-09-29', name: 'חוה"מ סוכות', type: 'chol', parentHoliday: 'סוכות' },
  { date: '2026-09-30', name: 'חוה"מ סוכות', type: 'chol', parentHoliday: 'סוכות' },
  { date: '2026-10-01', name: 'הושענא רבה', type: 'erev' },
  { date: '2026-10-02', name: 'שמחת תורה', type: 'holiday' },
]
ISRAELI_HOLIDAYS[2027] = [
  { date: '2027-03-23', name: 'ערב פורים', type: 'erev' },
  { date: '2027-03-24', name: 'פורים', type: 'halfday' },
  { date: '2027-04-22', name: 'ערב פסח', type: 'erev' },
  { date: '2027-04-23', name: 'פסח', type: 'holiday' },
  { date: '2027-04-24', name: 'חוה"מ פסח', type: 'chol', parentHoliday: 'פסח' },
  { date: '2027-04-25', name: 'חוה"מ פסח', type: 'chol', parentHoliday: 'פסח' },
  { date: '2027-04-26', name: 'חוה"מ פסח', type: 'chol', parentHoliday: 'פסח' },
  { date: '2027-04-27', name: 'חוה"מ פסח', type: 'chol', parentHoliday: 'פסח' },
  { date: '2027-04-28', name: 'ערב שביעי של פסח', type: 'erev' },
  { date: '2027-04-29', name: 'שביעי של פסח', type: 'holiday' },
  { date: '2027-05-11', name: 'ערב יום הזיכרון', type: 'erev' },
  { date: '2027-05-12', name: 'יום הזיכרון', type: 'memorial' },
  { date: '2027-05-13', name: 'יום העצמאות', type: 'holiday' },
  { date: '2027-06-11', name: 'ערב שבועות', type: 'erev' },
  { date: '2027-06-12', name: 'שבועות', type: 'holiday' },
  { date: '2027-10-01', name: 'ערב ראש השנה', type: 'erev' },
  { date: '2027-10-02', name: 'ראש השנה א', type: 'holiday' },
  { date: '2027-10-03', name: 'ראש השנה ב', type: 'holiday' },
  { date: '2027-10-10', name: 'ערב יום כיפור', type: 'erev' },
  { date: '2027-10-11', name: 'יום כיפור', type: 'holiday' },
  { date: '2027-10-15', name: 'ערב סוכות', type: 'erev' },
  { date: '2027-10-16', name: 'סוכות', type: 'holiday' },
  { date: '2027-10-17', name: 'חוה"מ סוכות', type: 'chol', parentHoliday: 'סוכות' },
  { date: '2027-10-18', name: 'חוה"מ סוכות', type: 'chol', parentHoliday: 'סוכות' },
  { date: '2027-10-19', name: 'חוה"מ סוכות', type: 'chol', parentHoliday: 'סוכות' },
  { date: '2027-10-20', name: 'חוה"מ סוכות', type: 'chol', parentHoliday: 'סוכות' },
  { date: '2027-10-22', name: 'הושענא רבה', type: 'erev' },
  { date: '2027-10-23', name: 'שמחת תורה', type: 'holiday' },
]
ISRAELI_HOLIDAYS[2028] = [
  { date: '2028-03-12', name: 'ערב פורים', type: 'erev' },
  { date: '2028-03-13', name: 'פורים', type: 'halfday' },
  { date: '2028-04-10', name: 'ערב פסח', type: 'erev' },
  { date: '2028-04-11', name: 'פסח', type: 'holiday' },
  { date: '2028-04-12', name: 'חוה"מ פסח', type: 'chol', parentHoliday: 'פסח' },
  { date: '2028-04-13', name: 'חוה"מ פסח', type: 'chol', parentHoliday: 'פסח' },
  { date: '2028-04-14', name: 'חוה"מ פסח', type: 'chol', parentHoliday: 'פסח' },
  { date: '2028-04-15', name: 'חוה"מ פסח', type: 'chol', parentHoliday: 'פסח' },
  { date: '2028-04-16', name: 'ערב שביעי של פסח', type: 'erev' },
  { date: '2028-04-17', name: 'שביעי של פסח', type: 'holiday' },
  { date: '2028-04-30', name: 'ערב יום הזיכרון', type: 'erev' },
  { date: '2028-05-01', name: 'יום הזיכרון', type: 'memorial' },
  { date: '2028-05-02', name: 'יום העצמאות', type: 'holiday' },
  { date: '2028-05-30', name: 'ערב שבועות', type: 'erev' },
  { date: '2028-05-31', name: 'שבועות', type: 'holiday' },
  { date: '2028-09-20', name: 'ערב ראש השנה', type: 'erev' },
  { date: '2028-09-21', name: 'ראש השנה א', type: 'holiday' },
  { date: '2028-09-22', name: 'ראש השנה ב', type: 'holiday' },
  { date: '2028-09-29', name: 'ערב יום כיפור', type: 'erev' },
  { date: '2028-09-30', name: 'יום כיפור', type: 'holiday' },
  { date: '2028-10-04', name: 'ערב סוכות', type: 'erev' },
  { date: '2028-10-05', name: 'סוכות', type: 'holiday' },
  { date: '2028-10-06', name: 'חוה"מ סוכות', type: 'chol', parentHoliday: 'סוכות' },
  { date: '2028-10-07', name: 'חוה"מ סוכות', type: 'chol', parentHoliday: 'סוכות' },
  { date: '2028-10-08', name: 'חוה"מ סוכות', type: 'chol', parentHoliday: 'סוכות' },
  { date: '2028-10-09', name: 'חוה"מ סוכות', type: 'chol', parentHoliday: 'סוכות' },
  { date: '2028-10-11', name: 'הושענא רבה', type: 'erev' },
  { date: '2028-10-12', name: 'שמחת תורה', type: 'holiday' },
]
ISRAELI_HOLIDAYS[2029] = [
  { date: '2029-03-01', name: 'ערב פורים', type: 'erev' },
  { date: '2029-03-02', name: 'פורים', type: 'halfday' },
  { date: '2029-03-30', name: 'ערב פסח', type: 'erev' },
  { date: '2029-03-31', name: 'פסח', type: 'holiday' },
  { date: '2029-04-01', name: 'חוה"מ פסח', type: 'chol', parentHoliday: 'פסח' },
  { date: '2029-04-02', name: 'חוה"מ פסח', type: 'chol', parentHoliday: 'פסח' },
  { date: '2029-04-03', name: 'חוה"מ פסח', type: 'chol', parentHoliday: 'פסח' },
  { date: '2029-04-04', name: 'חוה"מ פסח', type: 'chol', parentHoliday: 'פסח' },
  { date: '2029-04-05', name: 'ערב שביעי של פסח', type: 'erev' },
  { date: '2029-04-06', name: 'שביעי של פסח', type: 'holiday' },
  { date: '2029-04-17', name: 'ערב יום הזיכרון', type: 'erev' },
  { date: '2029-04-18', name: 'יום הזיכרון', type: 'memorial' },
  { date: '2029-04-19', name: 'יום העצמאות', type: 'holiday' },
  { date: '2029-05-19', name: 'ערב שבועות', type: 'erev' },
  { date: '2029-05-20', name: 'שבועות', type: 'holiday' },
  { date: '2029-09-10', name: 'ערב ראש השנה', type: 'erev' },
  { date: '2029-09-11', name: 'ראש השנה א', type: 'holiday' },
  { date: '2029-09-12', name: 'ראש השנה ב', type: 'holiday' },
  { date: '2029-09-19', name: 'ערב יום כיפור', type: 'erev' },
  { date: '2029-09-20', name: 'יום כיפור', type: 'holiday' },
  { date: '2029-09-24', name: 'ערב סוכות', type: 'erev' },
  { date: '2029-09-25', name: 'סוכות', type: 'holiday' },
  { date: '2029-09-26', name: 'חוה"מ סוכות', type: 'chol', parentHoliday: 'סוכות' },
  { date: '2029-09-27', name: 'חוה"מ סוכות', type: 'chol', parentHoliday: 'סוכות' },
  { date: '2029-09-28', name: 'חוה"מ סוכות', type: 'chol', parentHoliday: 'סוכות' },
  { date: '2029-09-29', name: 'חוה"מ סוכות', type: 'chol', parentHoliday: 'סוכות' },
  { date: '2029-10-01', name: 'הושענא רבה', type: 'erev' },
  { date: '2029-10-02', name: 'שמחת תורה', type: 'holiday' },
]
ISRAELI_HOLIDAYS[2030] = [
  { date: '2030-03-21', name: 'ערב פורים', type: 'erev' },
  { date: '2030-03-22', name: 'פורים', type: 'halfday' },
  { date: '2030-04-18', name: 'ערב פסח', type: 'erev' },
  { date: '2030-04-19', name: 'פסח', type: 'holiday' },
  { date: '2030-04-20', name: 'חוה"מ פסח', type: 'chol', parentHoliday: 'פסח' },
  { date: '2030-04-21', name: 'חוה"מ פסח', type: 'chol', parentHoliday: 'פסח' },
  { date: '2030-04-22', name: 'חוה"מ פסח', type: 'chol', parentHoliday: 'פסח' },
  { date: '2030-04-23', name: 'חוה"מ פסח', type: 'chol', parentHoliday: 'פסח' },
  { date: '2030-04-24', name: 'ערב שביעי של פסח', type: 'erev' },
  { date: '2030-04-25', name: 'שביעי של פסח', type: 'holiday' },
  { date: '2030-05-07', name: 'ערב יום הזיכרון', type: 'erev' },
  { date: '2030-05-08', name: 'יום הזיכרון', type: 'memorial' },
  { date: '2030-05-09', name: 'יום העצמאות', type: 'holiday' },
  { date: '2030-06-07', name: 'ערב שבועות', type: 'erev' },
  { date: '2030-06-08', name: 'שבועות', type: 'holiday' },
  { date: '2030-09-28', name: 'ערב ראש השנה', type: 'erev' },
  { date: '2030-09-29', name: 'ראש השנה א', type: 'holiday' },
  { date: '2030-09-30', name: 'ראש השנה ב', type: 'holiday' },
  { date: '2030-10-07', name: 'ערב יום כיפור', type: 'erev' },
  { date: '2030-10-08', name: 'יום כיפור', type: 'holiday' },
  { date: '2030-10-12', name: 'ערב סוכות', type: 'erev' },
  { date: '2030-10-13', name: 'סוכות', type: 'holiday' },
  { date: '2030-10-14', name: 'חוה"מ סוכות', type: 'chol', parentHoliday: 'סוכות' },
  { date: '2030-10-15', name: 'חוה"מ סוכות', type: 'chol', parentHoliday: 'סוכות' },
  { date: '2030-10-16', name: 'חוה"מ סוכות', type: 'chol', parentHoliday: 'סוכות' },
  { date: '2030-10-17', name: 'חוה"מ סוכות', type: 'chol', parentHoliday: 'סוכות' },
  { date: '2030-10-19', name: 'הושענא רבה', type: 'erev' },
  { date: '2030-10-20', name: 'שמחת תורה', type: 'holiday' },
]

let erevHolidayHours = {}

// ========== פונקציות חגים ==========
function getDateString(date) {
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0')
}
function getHolidayInfo(dateStr) {
  const year = parseInt(dateStr.split('-')[0])
  const holidays = ISRAELI_HOLIDAYS[year] || []
  return holidays.find(h => h.date === dateStr) || null
}
function getTodayHoliday() { const { now } = getIsraeliDateInfo(); return getHolidayInfo(getDateString(now)) }
function getTomorrowHoliday() { const { now } = getIsraeliDateInfo(); const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1); return getHolidayInfo(getDateString(tomorrow)) }
function checkDayHoliday(dayName, isToday, isTomorrow) {
  const { now } = getIsraeliDateInfo()
  let targetDate
  if (isToday || dayName === 'היום') targetDate = new Date(now)
  else if (isTomorrow || dayName === 'מחר') { targetDate = new Date(now); targetDate.setDate(targetDate.getDate() + 1) }
  else targetDate = resolveToDate(dayName, false, false)
  if (!targetDate) return null
  return getHolidayInfo(getDateString(targetDate))
}
function canBookOnDay(dayName, isToday, isTomorrow) {
  const holiday = checkDayHoliday(dayName, isToday, isTomorrow)
  if (!holiday) return { canBook: true }
  switch (holiday.type) {
    case 'holiday': return { canBook: false, reason: 'סגור בגלל ' + holiday.name, holiday }
    case 'memorial': return { canBook: false, reason: 'סגור - ' + holiday.name, holiday }
    case 'erev': { const hours = erevHolidayHours[holiday.date]; if (hours === 'CLOSED') return { canBook: false, reason: holiday.name + ' - סגור', holiday }; if (hours) return { canBook: true, limitedHours: hours, holiday }; return { canBook: 'pending', reason: holiday.name, holiday } }
    case 'chol': { const hours = erevHolidayHours[holiday.date]; if (hours === 'CLOSED') return { canBook: false, reason: holiday.name + ' - סגור', holiday }; if (hours) return { canBook: true, limitedHours: hours, holiday }; return { canBook: 'pending', reason: holiday.name, holiday } }
    case 'fast': return { canBook: true, holiday }
    case 'chanukah': return { canBook: true, holiday }
    case 'halfday': return { canBook: true, holiday }
    default: return { canBook: true }
  }
}
function getAvailableSlotsWithHolidays(day, isToday, isTomorrow) {
  const bookCheck = canBookOnDay(day, isToday, isTomorrow)
  if (bookCheck.canBook === false) return { slots: [], reason: bookCheck.reason }
  if (bookCheck.canBook === 'pending') return { slots: [], reason: bookCheck.reason, pendingYairAnswer: true, holiday: bookCheck.holiday }
  let allSlots = getAvailableSlots(day)
  if (bookCheck.limitedHours) { const limitHour = parseInt(bookCheck.limitedHours.split(':')[0]); allSlots = allSlots.filter(t => parseInt(t.split(':')[0]) < limitHour) }
  return { slots: allSlots, holiday: bookCheck.holiday }
}

// ========== שאלות ליאיר על חגים ==========
let pendingErevQuestions = {}
async function askYairAboutHolidayHours(holiday) {
  const dateStr = holiday.date
  if (pendingErevQuestions[dateStr]?.asked) return
  pendingErevQuestions[dateStr] = { asked: true, askedAt: new Date() }
  const isChol = holiday.type === 'chol'
  const parentName = holiday.parentHoliday || holiday.name
  let msg
  if (isChol) {
    msg = 'יאיר! 👋\n\n📅 בעוד כמה ימים יש ' + parentName + '\nביום ' + dateStr + ' זה ' + holiday.name + '\n\nאתה עובד ב' + holiday.name + '?\nאם כן - עד מתי?\n\n✏️ שלח: שעות ' + dateStr + ' 14:00 (לדוגמה)\n🚫 שלח: סגור ' + dateStr + ' (אם לא עובד)\n\n(יש עוד ימי חול המועד - תעדכן על כל יום בנפרד)'
  } else {
    msg = 'יאיר! 👋\n\n🕎 בעוד כמה ימים: ' + holiday.name + '\n📅 תאריך: ' + dateStr + '\n\nעד איזה שעה אתה עובד?\n\n✏️ שלח: שעות ' + dateStr + ' 13:00\n🚫 או: סגור ' + dateStr
  }
  await notifyYairRaw(msg)
}
async function loadErevHours() {
  try { const { data } = await supabase.from('erev_hours').select('*'); if (data) data.forEach(r => { erevHolidayHours[r.date_str] = r.close_time }); console.log('נטענו ' + Object.keys(erevHolidayHours).length + ' הגדרות שעות חג') } catch (err) { console.error('שגיאה בטעינת שעות חג:', err?.message) }
}
async function saveErevHours(dateStr, closeTime) {
  erevHolidayHours[dateStr] = closeTime
  try { await supabase.from('erev_hours').upsert({ date_str: dateStr, close_time: closeTime, updated_at: new Date().toISOString() }) } catch (err) { console.error('שגיאה בשמירת שעות חג:', err?.message) }
}
async function checkUpcomingHolidays() {
  const { now } = getIsraeliDateInfo()
  for (let i = 1; i <= 5; i++) {
    const futureDate = new Date(now); futureDate.setDate(futureDate.getDate() + i)
    const dateStr = getDateString(futureDate)
    const holiday = getHolidayInfo(dateStr)
    if (!holiday) continue
    if ((holiday.type === 'erev' || holiday.type === 'chol') && !erevHolidayHours[dateStr]) await askYairAboutHolidayHours(holiday)
    if (holiday.type === 'holiday' && i === 1) await notifyYairRaw('🕎 תזכורת: מחר ' + holiday.name + ' — הבוט לא יקבע תורים!')
  }
}

// ========== יצירת טבלאות ==========
async function initSupabaseTables() {
  console.log('בודק טבלאות ב-Supabase...')
  const { error } = await supabase.rpc('exec_sql', {
    query: `
      CREATE TABLE IF NOT EXISTS blocked_phones (id TEXT PRIMARY KEY, added_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS family_phones (id TEXT PRIMARY KEY, name TEXT, added_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS lid_map (lid TEXT PRIMARY KEY, phone TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS known_lids (lid TEXT PRIMARY KEY, added_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS appointments (id SERIAL PRIMARY KEY, day TEXT NOT NULL, time TEXT NOT NULL, phone TEXT, cancelled BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS reminders (id SERIAL PRIMARY KEY, phone TEXT NOT NULL, day TEXT NOT NULL, time TEXT NOT NULL, resolved_date TEXT, sent_day BOOLEAN DEFAULT FALSE, sent_hour BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS customers (phone TEXT PRIMARY KEY, name TEXT, haircut_count INTEGER DEFAULT 0, clothes_inquiry_count INTEGER DEFAULT 0, first_seen TIMESTAMPTZ DEFAULT NOW(), last_seen TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS erev_hours (date_str TEXT PRIMARY KEY, close_time TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS customer_memory (phone TEXT PRIMARY KEY, name TEXT, notes TEXT, last_haircut TEXT, preferences TEXT, updated_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS yair_memory (id TEXT PRIMARY KEY, content TEXT NOT NULL, is_private BOOLEAN DEFAULT FALSE, updated_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS pending_yair_approvals (id SERIAL PRIMARY KEY, customer_phone TEXT NOT NULL, customer_name TEXT, request_type TEXT, request_details TEXT, yair_conversation TEXT, status TEXT DEFAULT 'pending', remind_tomorrow BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS yair_reminders (id SERIAL PRIMARY KEY, message TEXT NOT NULL, remind_at TIMESTAMPTZ NOT NULL, sent BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS bot_auth (id TEXT PRIMARY KEY, auth_data TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW());
    `
  })
  if (error) {
    try { const { error: testError } = await supabase.from('blocked_phones').select('id').limit(1); if (testError?.code === '42P01') console.error('⚠️ הטבלאות לא קיימות! הרץ SQL ב-Supabase SQL Editor'); else console.log('טבלאות קיימות!') } catch (e) { console.error('שגיאה:', e?.message) }
  } else console.log('טבלאות OK!')
}

async function initData() {
  const { data: blocked } = await supabase.from('blocked_phones').select('id')
  if (!blocked || blocked.length === 0) {
    const initialBlocked = ['972526472323','972533030598','972545449945','972526728787','972584943389','972547467841','972546284000','972527587752','972504135426','972522156057','972543147703','972506484030','972532318008','972528605086','972507088775']
    await supabase.from('blocked_phones').upsert(initialBlocked.map(id => ({ id })))
  }
  const { data: family } = await supabase.from('family_phones').select('id')
  if (!family || family.length === 0) {
    await supabase.from('family_phones').upsert([
      { id: '972547734708', name: 'פז' },
      { id: '972549878444', name: 'אדל' },
      { id: '972542295295', name: 'לירן' },
    ])
  }
}

async function loadAllData() {
  try { const { data } = await supabase.from('blocked_phones').select('id'); BLOCKED_PHONES = (data || []).map(r => r.id) } catch { BLOCKED_PHONES = ['972526472323','972533030598','972545449945','972526728787','972584943389','972547467841','972546284000','972527587752','972504135426','972522156057','972543147703','972506484030','972532318008','972528605086','972507088775'] }
  try { const { data } = await supabase.from('family_phones').select('id'); FAMILY_PHONES = (data || []).map(r => r.id) } catch { FAMILY_PHONES = ['972547734708','972549878444','972542295295'] }

  try { const { data } = await supabase.from('lid_map').select('lid, phone'); if (data) data.forEach(r => { lidToPhone[r.lid] = r.phone; phoneToLid[r.phone] = r.lid }) } catch {}
  try { const { data } = await supabase.from('known_lids').select('lid'); knownLids = (data || []).map(r => r.lid) } catch {}
  try { const { data } = await supabase.from('appointments').select('day, time').eq('cancelled', false); if (data) data.forEach(a => { const key = a.day + '-' + a.time; appointments[key] = (appointments[key] || 0) + 1 }) } catch {}
  await loadErevHours()
  await loadYairMemory()
  console.log('נתונים נטענו: ' + BLOCKED_PHONES.length + ' חסומים, ' + FAMILY_PHONES.length + ' משפחה, ' + Object.keys(lidToPhone).length + ' LID, ' + Object.keys(erevHolidayHours).length + ' שעות חג, ' + Object.keys(yairMemoryCache).length + ' זיכרונות יאיר')
}

// ========== זיכרון לקוחות ==========
async function loadCustomerMemory(phone) { try { const { data } = await supabase.from('customer_memory').select('*').eq('phone', phone).single(); return data || null } catch { return null } }
async function saveCustomerMemory(phone, updates) {
  try {
    const existing = await loadCustomerMemory(phone)
    if (existing) { await supabase.from('customer_memory').update({ ...updates, updated_at: new Date().toISOString() }).eq('phone', phone) }
    else { await supabase.from('customer_memory').insert({ phone, ...updates, updated_at: new Date().toISOString() }) }
  } catch {}
}
async function updateCustomerMemoryFromConversation(phone, conversationText) {
  try {
    const existing = await loadCustomerMemory(phone)
    const existingInfo = existing ? `מידע קיים:\nשם: ${existing.name || 'לא ידוע'}\nהעדפות: ${existing.preferences || 'לא ידוע'}\nהערות: ${existing.notes || 'אין'}\nתספורת אחרונה: ${existing.last_haircut || 'לא ידוע'}` : 'לקוח חדש'
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 300, system: `חלץ מידע רלוונטי על הלקוח מהשיחה. ענה רק ב-JSON תקין ללא שום דבר אחר.\nפורמט: {"name":"שם אם הוזכר אחרת null","preferences":"העדפות תספורת/מאפיינים אם הוזכרו אחרת null","notes":"כל דבר מעניין אחר אחרת null","last_haircut":"תאריך אם נקבע תור אחרת null"}`, messages: [{ role: 'user', content: `${existingInfo}\n\nשיחה חדשה:\n${conversationText}` }] })
    })
    const data = await response.json()
    const text = data.content[0].text.replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(text)
    const updates = {}
    if (parsed.name) updates.name = parsed.name
    if (parsed.preferences) updates.preferences = parsed.preferences
    if (parsed.notes) updates.notes = (existing?.notes ? existing.notes + ' | ' : '') + parsed.notes
    if (parsed.last_haircut) updates.last_haircut = parsed.last_haircut
    if (Object.keys(updates).length > 0) await saveCustomerMemory(phone, updates)
  } catch {}
}

// ========== זיכרון יאיר ==========
let yairMemoryCache = {}
async function loadYairMemory() { try { const { data } = await supabase.from('yair_memory').select('*'); if (data) data.forEach(r => { yairMemoryCache[r.id] = { content: r.content, is_private: r.is_private } }) } catch {} }
async function saveYairInstruction(id, content, isPrivate = false) {
  yairMemoryCache[id] = { content, is_private: isPrivate }
  try { await supabase.from('yair_memory').upsert({ id, content, is_private: isPrivate, updated_at: new Date().toISOString() }) } catch {}
}

// ========== תזכורות ליאיר ==========
async function saveYairReminder(message, remindAt) {
  try {
    await supabase.from('yair_reminders').insert({ message, remind_at: remindAt.toISOString(), sent: false })
    return true
  } catch { return false }
}

async function checkYairReminders() {
  if (!botSocket) return
  try {
    const now = new Date()
    const { data } = await supabase.from('yair_reminders').select('*').eq('sent', false).lte('remind_at', now.toISOString())
    for (const r of (data || [])) {
      await notifyYairRaw('⏰ תזכורת!\n' + r.message)
      await supabase.from('yair_reminders').update({ sent: true }).eq('id', r.id)
    }
  } catch {}
}

function parseReminderTime(text) {
  const { now } = getIsraeliDateInfo()
  const target = new Date(now)
  const timeMatch = text.match(/ב[- ]?(\d{1,2})(?::(\d{2}))?/)
  if (timeMatch) {
    const hour = parseInt(timeMatch[1])
    const min = parseInt(timeMatch[2] || '0')
    target.setHours(hour, min, 0, 0)
    if (target <= now) target.setDate(target.getDate() + 1)
  }
  if (text.includes('מחר')) target.setDate(target.getDate() + 1)
  const minutesMatch = text.match(/בעוד (\d+) דקות/)
  if (minutesMatch) { target.setTime(now.getTime() + parseInt(minutesMatch[1]) * 60000) }
  const hoursMatch = text.match(/בעוד (\d+) שעות/)
  if (hoursMatch) { target.setTime(now.getTime() + parseInt(hoursMatch[1]) * 3600000) }
  return target
}

// ========== ניתוח הודעות יאיר ==========
async function processYairFreeMessage(text) {
  try {
    const existingMemory = Object.entries(yairMemoryCache).map(([k, v]) => `${k}: ${v.content}`).join('\n') || 'אין'
    const pendingApprovals = await supabase.from('pending_yair_approvals').select('*').eq('status', 'pending')
    const pendingList = (pendingApprovals.data || []).map(p =>
      `ID ${p.id}: ${p.customer_name || 'לא ידוע'} - ${p.request_details}${p.yair_conversation ? '\nשיחה עד כה:\n' + p.yair_conversation : ''}`
    ).join('\n\n') || 'אין'

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 700,
        system: `אתה עוזר חכם שמנתח הודעות של יאיר הספר לג'ימי הבוט שלו.
תפקידך לזהות בדיוק מה יאיר אומר ולהחזיר JSON תקין בלבד.

זיכרון קיים: ${existingMemory}
בקשות ממתינות: ${pendingList}

===== זיהוי סוגי הודעות =====

סוג 1 — BOOK_FOR_CUSTOMER: כשיאיר אומר לקבוע תור ללקוח
זיהוי: "תכניס אותו", "תקבע לו", "תכניס את [שם]", "קבע לו תור", "תוסיף אותו"
→ action: "book_for_customer"
→ customer_name: שם הלקוח אם הוזכר, אחרת null
→ customer_phone: טלפון אם הוזכר, אחרת null
→ day: יום אם הוזכר, אחרת null  
→ time: שעה אם הוזכרה, אחרת null

סוג 2 — SET_YAIR_REMINDER: כשיאיר מבקש תזכורת לעצמו
זיהוי: "תזכיר לי", "שלח לי הודעה", "תעיר אותי", "תזכור לשאול אותי", "תזכיר לי ב-X"
→ action: "set_yair_reminder"
→ reminder_message: מה להזכיר (בדיוק מה יאיר רוצה)
→ reminder_time_text: הטקסט עם הזמן (לפרסור)

סוג 3 — SAVE_INSTRUCTION: כשיאיר נותן הוראה כללית לבוט
→ action: "save_instruction"

סוג 4 — APPROVE/DENY: אישור/דחיית בקשת לקוח
→ action: "approve_request" | "deny_request"

סוג 5 — NEED_CLARIFICATION: יאיר לא ברור עדיין
→ action: "need_clarification"
→ set_reminder: true אם אמר "מחר/אחר כך/אעדכן"

סוג 6 — NONE: שיחה רגילה

חוק ברזל: book_for_customer רק כשיאיר אומר לקבוע/להכניס. אם חסרים פרטים (שם/שעה/יום) — החזר אותם כ-null.

החזר JSON בלבד:
{
  "action": "book_for_customer" | "set_yair_reminder" | "save_instruction" | "approve_request" | "deny_request" | "need_clarification" | "none",
  "customer_name": null,
  "customer_phone": null,
  "day": null,
  "time": null,
  "reminder_message": null,
  "reminder_time_text": null,
  "instruction_id": null,
  "instruction_content": null,
  "is_private": false,
  "approval_id": 0,
  "approval_response": null,
  "set_reminder": false,
  "clarification_question": null,
  "summary_for_jimmy": null
}`,
        messages: [{ role: 'user', content: `הודעת יאיר: "${text}"` }]
      })
    })
    const data = await response.json()
    const raw = data.content[0].text.replace(/```json|```/g, '').trim()
    return JSON.parse(raw)
  } catch { return null }
}

// ========== מצב קביעת תור ע"י יאיר ==========
let yairBookingState = null

async function handleYairBookingFlow(text) {
  if (!yairBookingState) return null

  const { today, tomorrow } = getIsraeliDateInfo()

  if (yairBookingState.step === 'ask_name') {
    yairBookingState.name = text.trim()
    yairBookingState.step = 'ask_day'
    return 'מעולה! איזה יום ושעה? 📅'
  }

  if (yairBookingState.step === 'ask_day') {
    const dayMatch = text.match(/(ראשון|שני|שלישי|רביעי|חמישי|שישי|מחר|היום)/)
    const timeMatch = text.match(/(\d{1,2}):?(\d{0,2})/)

    if (!dayMatch && !timeMatch) {
      return 'לא הבנתי 😅 כתוב כמו: "שלישי 14:00" או "מחר ב10"'
    }

    let day = dayMatch?.[0] || today
    if (day === 'היום') day = today
    if (day === 'מחר') day = tomorrow

    if (!timeMatch) {
      yairBookingState.day = day
      yairBookingState.step = 'ask_time'
      return 'באיזה שעה?'
    }

    let hour = parseInt(timeMatch[1])
    let min = parseInt(timeMatch[2] || '0')
    let time = String(hour).padStart(2, '0') + ':' + String(min).padStart(2, '0')

    const isToday = day === today
    const isTomorrow = day === tomorrow
    const holidayCheck = canBookOnDay(day, isToday, isTomorrow)

    if (holidayCheck.canBook === false) {
      yairBookingState = null
      return '❌ ביום הזה סגור (' + holidayCheck.reason + '). תקבע יום אחר.'
    }

    if (!isSlotAvailable(day, time)) {
      const slots = getAvailableSlots(day)
      yairBookingState.day = day
      yairBookingState.step = 'ask_time'
      return '⚠️ השעה ' + time + ' תפוסה ביום ' + day + '.\nפנוי: ' + (slots.join(', ') || 'אין מקום') + '\nבאיזה שעה?'
    }

    const name = yairBookingState.name
    const phone = yairBookingState.phone
    yairBookingState = null

    bookSlot(day, time)
    const ph = phone ? extractPhone(phone) || phone.replace(/@.+/, '') : null
    await logAppointment(day, time, ph || 'יאיר_קבע')

    if (ph) {
      const appointmentDate = resolveToDate(day, isToday, isTomorrow)
      if (appointmentDate) await addReminder(ph + '@s.whatsapp.net', day, time, appointmentDate.toISOString())
      await upsertCustomer(ph, name, 'haircut')
      try {
        await botSocket.sendMessage(ph + '@s.whatsapp.net', {
          text: 'היי ' + (name || '') + '! 😊\nיאיר קבע לך תור:\n📅 יום ' + day + ' בשעה ' + time + '\n📍 אלי כהן 12, לוד\nוויז: https://waze.com/ul?q=אלי+כהן+12+לוד&navigate=yes\nנתראה! 💈'
        })
      } catch {}
    }

    return '✅ תור נקבע!\n👤 ' + name + '\n📅 ' + day + ' ' + time + (ph ? '\n📱 ' + ph : '') + '\n' + (ph ? 'שלחתי אישור ללקוח 💬' : '')
  }

  if (yairBookingState.step === 'ask_time') {
    const timeMatch = text.match(/(\d{1,2}):?(\d{0,2})/)
    if (!timeMatch) return 'כתוב שעה כמו: "14:00" או "14"'

    let hour = parseInt(timeMatch[1])
    let min = parseInt(timeMatch[2] || '0')
    let time = String(hour).padStart(2, '0') + ':' + String(min).padStart(2, '0')
    const day = yairBookingState.day
    const { today: todayNow, tomorrow: tomorrowNow } = getIsraeliDateInfo()
    const isToday = day === todayNow
    const isTomorrow = day === tomorrowNow

    if (!isSlotAvailable(day, time)) {
      const slots = getAvailableSlots(day)
      return '⚠️ ' + time + ' תפוס. פנוי: ' + (slots.join(', ') || 'אין') + '\nאיזה שעה?'
    }

    const name = yairBookingState.name
    const phone = yairBookingState.phone
    yairBookingState = null

    bookSlot(day, time)
    const ph = phone ? extractPhone(phone) || phone.replace(/@.+/, '') : null
    await logAppointment(day, time, ph || 'יאיר_קבע')

    if (ph) {
      const appointmentDate = resolveToDate(day, isToday, isTomorrow)
      if (appointmentDate) await addReminder(ph + '@s.whatsapp.net', day, time, appointmentDate.toISOString())
      await upsertCustomer(ph, name, 'haircut')
      try {
        await botSocket.sendMessage(ph + '@s.whatsapp.net', {
          text: 'היי ' + (name || '') + '! 😊\nיאיר קבע לך תור:\n📅 יום ' + day + ' בשעה ' + time + '\n📍 אלי כהן 12, לוד\nוויז: https://waze.com/ul?q=אלי+כהן+12+לוד&navigate=yes\nנתראה! 💈'
        })
      } catch {}
    }

    return '✅ תור נקבע!\n👤 ' + name + '\n📅 ' + day + ' ' + time + (ph ? '\n💬 שלחתי אישור ללקוח' : '')
  }

  return null
}

// ========== תזכורות אישורים ממתינים ==========
async function checkPendingApprovalReminders() {
  if (!botSocket) return
  try {
    const { data } = await supabase.from('pending_yair_approvals').select('*').eq('status', 'pending').eq('remind_tomorrow', true)
    for (const approval of (data || [])) {
      const msg = `היי יאיר! 😊\nאתמול אמרת שתחזור אליי לגבי ${approval.customer_name || 'לקוח'}\n📝 ${approval.request_details}\n\nמה ההחלטה? 🙏`
      await notifyYairRaw(msg)
      await supabase.from('pending_yair_approvals').update({ remind_tomorrow: false }).eq('id', approval.id)
    }
  } catch (err) { console.error('שגיאה בתזכורות אישור:', err?.message) }
}

// ========== אישורי יאיר ==========
async function createPendingApproval(customerPhone, customerName, requestType, requestDetails) {
  try { const { data } = await supabase.from('pending_yair_approvals').insert({ customer_phone: customerPhone, customer_name: customerName, request_type: requestType, request_details: requestDetails, status: 'pending', remind_tomorrow: false }).select().single(); return data?.id } catch { return null }
}
async function getPendingApproval(id) { try { const { data } = await supabase.from('pending_yair_approvals').select('*').eq('id', id).single(); return data } catch { return null } }
async function updateApprovalStatus(id, status) { try { await supabase.from('pending_yair_approvals').update({ status }).eq('id', id) } catch {} }
async function appendYairConversation(id, yairText, jimmyQuestion) {
  try {
    const approval = await getPendingApproval(id)
    const existing = approval?.yair_conversation || ''
    const newEntry = (existing ? existing + '\n' : '') + "יאיר: " + yairText + (jimmyQuestion ? "\nג'ימי: " + jimmyQuestion : '')
    await supabase.from('pending_yair_approvals').update({ yair_conversation: newEntry }).eq('id', id)
  } catch {}
}

async function saveLidMapping(lid, phone) {
  if (!lid || !phone || lidToPhone[lid] === phone) return
  lidToPhone[lid] = phone; phoneToLid[phone] = lid
  try { await supabase.from('lid_map').upsert({ lid, phone, updated_at: new Date().toISOString() }) } catch {}
}
function extractPhone(sender) {
  if (sender.includes('@s.whatsapp.net')) return sender.replace('@s.whatsapp.net', '')
  if (sender.includes('@lid')) { const lid = sender.replace('@lid', ''); return lidToPhone[lid] || null }
  return sender
}
function getWALink(phone) { return phone?.startsWith('972') ? 'https://wa.me/' + phone : 'מספר לא ידוע' }
function isBlocked(sender) {
  if (sender.includes('@s.whatsapp.net')) return BLOCKED_PHONES.includes(sender.replace('@s.whatsapp.net', ''))
  if (sender.includes('@lid')) { const lid = sender.replace('@lid', ''); return BLOCKED_PHONES.includes(lid) || (lidToPhone[lid] && BLOCKED_PHONES.includes(lidToPhone[lid])) }
  return false
}
function isFamilyMember(sender) {
  if (sender.includes('@s.whatsapp.net')) return FAMILY_PHONES.includes(sender.replace('@s.whatsapp.net', ''))
  if (sender.includes('@lid')) { const lid = sender.replace('@lid', ''); return FAMILY_PHONES.includes(lid) || (lidToPhone[lid] && FAMILY_PHONES.includes(lidToPhone[lid])) }
  return false
}
function isKnownLid(sender) {
  if (!sender.includes('@lid')) return true
  const lid = sender.replace('@lid', '')
  return BLOCKED_PHONES.includes(lid) || FAMILY_PHONES.includes(lid) || knownLids.includes(lid) || !!lidToPhone[lid]
}
async function tryResolveLid(sender) {
  if (!sender.includes('@lid')) return
  const lid = sender.replace('@lid', ''); if (lidToPhone[lid]) return
  if (botSocket?.signalRepository?.lidMapping) { try { const pn = await botSocket.signalRepository.lidMapping.getPNForLID(sender); if (pn?.includes('@s.whatsapp.net')) { await saveLidMapping(lid, pn.replace('@s.whatsapp.net', '').replace(/:.*/, '')); return } } catch {} }
  if (botSocket) { try { const [result] = await botSocket.onWhatsApp(sender); if (result?.jid?.includes('@s.whatsapp.net')) await saveLidMapping(lid, result.jid.replace('@s.whatsapp.net', '')) } catch {} }
}

// ========== פקודות יאיר ==========
async function handleYairCommand(text) {

  if (yairBookingState) {
    const bookResult = await handleYairBookingFlow(text)
    if (bookResult) return bookResult
  }

  const blockMatch = text.match(/^חסום\s+(\S+)/i)
  if (blockMatch) { const id = blockMatch[1].trim(); if (!BLOCKED_PHONES.includes(id)) { BLOCKED_PHONES.push(id); await supabase.from('blocked_phones').upsert({ id }) }; return '✅ ' + id + ' נחסם!' }

  const familyMatch = text.match(/^משפחה\s+(\S+)/i)
  if (familyMatch) { const id = familyMatch[1].trim(); if (!FAMILY_PHONES.includes(id)) { FAMILY_PHONES.push(id); await supabase.from('family_phones').upsert({ id }) }; return '✅ ' + id + ' נוסף למשפחה!' }

  const normalMatch = text.match(/^רגיל\s+(\S+)/i)
  if (normalMatch) { const id = normalMatch[1].trim(); if (!knownLids.includes(id)) { knownLids.push(id); await supabase.from('known_lids').upsert({ lid: id }) }; return '✅ ' + id + ' סומן כלקוח רגיל!' }

  const unblockMatch = text.match(/^(בטל.?חסימה|שחרר)\s+(\S+)/i)
  if (unblockMatch) { const id = unblockMatch[2].trim(); BLOCKED_PHONES = BLOCKED_PHONES.filter(p => p !== id); await supabase.from('blocked_phones').delete().eq('id', id); return '✅ ' + id + ' הוסר מחסומים!' }

  const hoursMatch = text.match(/^שעות\s+(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})/i)
  if (hoursMatch) {
    const dateStr = hoursMatch[1]; const closeTime = hoursMatch[2]
    await saveErevHours(dateStr, closeTime)
    const holiday = getHolidayInfo(dateStr)
    return '✅ מעולה! ביום ' + (holiday?.name || dateStr) + ' עובד עד ' + closeTime + '\nהבוט יקבע תורים רק עד השעה הזו 👌'
  }

  const closedMatch = text.match(/^סגור\s+(\d{4}-\d{2}-\d{2})/i)
  if (closedMatch) {
    const dateStr = closedMatch[1]
    await saveErevHours(dateStr, 'CLOSED')
    const holiday = getHolidayInfo(dateStr)
    return '✅ סבבה! ביום ' + (holiday?.name || dateStr) + ' סגור.\nהבוט לא יקבע תורים ליום הזה 🙌'
  }

  if (text.match(/^חגים$/i)) {
    const { now } = getIsraeliDateInfo()
    const todayStr = getDateString(now)
    const allHolidays = []
    for (let y = now.getFullYear(); y <= now.getFullYear() + 1; y++) { if (ISRAELI_HOLIDAYS[y]) allHolidays.push(...ISRAELI_HOLIDAYS[y]) }
    const upcoming = allHolidays.filter(h => h.date >= todayStr && ['holiday','erev','chol','memorial'].includes(h.type)).slice(0, 12)
    if (upcoming.length === 0) return '📅 אין חגים קרובים'
    let msg = '📅 חגים קרובים:\n─────────────────\n'
    upcoming.forEach(h => {
      const hasHours = erevHolidayHours[h.date]
      const status = h.type === 'holiday' || h.type === 'memorial' ? '🔴 סגור' : hasHours === 'CLOSED' ? '🔴 סגור' : hasHours ? '🟡 עד ' + hasHours : '⚪ לא הוגדר'
      msg += h.date + ' | ' + h.name + ' | ' + status + '\n'
    })
    msg += '─────────────────\nלעדכן: שעות YYYY-MM-DD HH:MM\nלסגור: סגור YYYY-MM-DD'
    return msg
  }

  if (text.match(/^סטטוס$/i)) {
    const todayH = getTodayHoliday(); const tomorrowH = getTomorrowHoliday()
    let hs = ''
    if (todayH) hs += '\n🕎 היום: ' + todayH.name
    if (tomorrowH) hs += '\n🕎 מחר: ' + tomorrowH.name
    if (!todayH && !tomorrowH) hs = '\n📅 אין חגים קרובים'
    return '📊 סטטוס ג\'ימי:\n🚫 חסומים: ' + BLOCKED_PHONES.length + '\n👨‍👩‍👧 משפחה: ' + FAMILY_PHONES.length + '\n🗺️ LID: ' + Object.keys(lidToPhone).length + '\n✅ LIDs רגילים: ' + knownLids.length + '\n🧠 זיכרונות: ' + Object.keys(yairMemoryCache).length + hs
  }

  const parsed = await processYairFreeMessage(text)
  if (parsed) {

    if (parsed.action === 'book_for_customer') {
      const name = parsed.customer_name
      const phone = parsed.customer_phone
      const day = parsed.day
      const time = parsed.time

      if (name && day && time) {
        const { today, tomorrow } = getIsraeliDateInfo()
        const resolvedDay = day === 'היום' ? today : day === 'מחר' ? tomorrow : day
        const isToday = resolvedDay === today
        const isTomorrow = resolvedDay === tomorrow
        const formattedTime = time.includes(':') ? time : time + ':00'

        if (!isSlotAvailable(resolvedDay, formattedTime)) {
          const slots = getAvailableSlots(resolvedDay)
          return '⚠️ ' + formattedTime + ' ביום ' + resolvedDay + ' תפוס!\nפנוי: ' + (slots.join(', ') || 'אין מקום')
        }

        bookSlot(resolvedDay, formattedTime)
        const ph = phone ? extractPhone(phone) || phone.replace(/@.+/, '') : null
        await logAppointment(resolvedDay, formattedTime, ph || 'יאיר_קבע')

        if (ph) {
          const appointmentDate = resolveToDate(resolvedDay, isToday, isTomorrow)
          if (appointmentDate) await addReminder(ph + '@s.whatsapp.net', resolvedDay, formattedTime, appointmentDate.toISOString())
          await upsertCustomer(ph, name, 'haircut')
          try {
            await botSocket.sendMessage(ph + '@s.whatsapp.net', {
              text: 'היי ' + name + '! 😊\nיאיר קבע לך תור:\n📅 יום ' + resolvedDay + ' בשעה ' + formattedTime + '\n📍 אלי כהן 12, לוד\nוויז: https://waze.com/ul?q=אלי+כהן+12+לוד&navigate=yes\nנתראה! 💈'
            })
          } catch {}
        }

        return '✅ תור נקבע!\n👤 ' + name + '\n📅 ' + resolvedDay + ' ' + formattedTime + (ph ? '\n💬 שלחתי אישור ללקוח' : '')
      }

      yairBookingState = {
        step: name ? 'ask_day' : 'ask_name',
        name: name || null,
        phone: phone || null,
        day: day || null
      }

      if (!name) return 'מה השם של הלקוח? 👤'
      if (!day && !time) return 'מעולה! איזה יום ושעה מתאים ל' + name + '? 📅'
      if (day && !time) return 'ביום ' + day + ' — באיזה שעה? ⏰'
      return 'איזה יום ושעה? 📅'
    }

    if (parsed.action === 'set_yair_reminder' && parsed.reminder_message) {
      const remindAt = parseReminderTime(parsed.reminder_time_text || text)
      const saved = await saveYairReminder(parsed.reminder_message, remindAt)
      if (saved) {
        const timeStr = remindAt.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' })
        const dateStr = remindAt.toLocaleDateString('he-IL', { weekday: 'long', timeZone: 'Asia/Jerusalem' })
        return '✅ מסודר! אתזכיר לך ' + dateStr + ' ב-' + timeStr + ':\n"' + parsed.reminder_message + '"'
      }
      return 'אוי, לא הצלחתי לשמור את התזכורת 😅'
    }

    if (parsed.action === 'save_instruction' && parsed.instruction_id && parsed.instruction_content) {
      await saveYairInstruction(parsed.instruction_id, parsed.instruction_content, parsed.is_private || false)
      const privateNote = parsed.is_private ? ' (שמרתי בסוד 🤫)' : ''
      return '✅ הבנתי ושמרתי' + privateNote + '!\n"' + parsed.instruction_content + '"'
    }

    if ((parsed.action === 'approve_request' || parsed.action === 'deny_request') && parsed.approval_id) {
      const approval = await getPendingApproval(parsed.approval_id)
      if (approval && approval.status === 'pending') {
        await updateApprovalStatus(parsed.approval_id, parsed.action === 'approve_request' ? 'approved' : 'denied')
        const customerPhone = approval.customer_phone
        if (botSocket) {
          try {
            if (parsed.action === 'approve_request') {
              const customerMemory = await loadCustomerMemory(customerPhone.replace('@s.whatsapp.net','').replace(/@.+/,''))
              const customerName = customerMemory?.name || approval.customer_name || ''
              const yairSaid = parsed.approval_response || 'אישר'
              const replyResponse = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
                body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 250, system: `אתה ג'ימי, עוזר חכם של יאיר ספר בלוד. קיבלת תשובה מיאיר ועכשיו אתה צריך לענות ללקוח בצורה מקצועית, חמה, ואנושית. אל תעתיק מה שיאיר כתב — תרגם לשפה נעימה. אל תחשוף פרטים אישיים של יאיר. תהיה קצר — 1-3 משפטים.`, messages: [{ role: 'user', content: `בקשת הלקוח: ${approval.request_details}\nמה יאיר ענה: ${yairSaid}\nשם הלקוח: ${customerName || 'לא ידוע'}\nנסח תשובה ללקוח:` }] })
              })
              const replyData = await replyResponse.json()
              await botSocket.sendMessage(customerPhone.includes('@') ? customerPhone : customerPhone + '@s.whatsapp.net', { text: replyData.content[0].text })
            } else {
              const denyResponse = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
                body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 200, system: `אתה ג'ימי, עוזר של יאיר ספר. יאיר לא יכול לאשר את הבקשה. תנסח תשובה נעימה ומנומסת ללקוח, אל תחשוף למה, ותציע חלופה אם רלוונטי.`, messages: [{ role: 'user', content: `בקשת הלקוח: ${approval.request_details}\nמה יאיר אמר: ${parsed.approval_response || 'לא'}\nשם לקוח: ${approval.customer_name || ''}\nנסח תשובה:` }] })
              })
              const denyData = await denyResponse.json()
              await botSocket.sendMessage(customerPhone.includes('@') ? customerPhone : customerPhone + '@s.whatsapp.net', { text: denyData.content[0].text })
            }
          } catch {}
        }
        return '✅ הבנתי! עדכנתי את ' + (approval.customer_name || 'הלקוח')
      }
    }

    if (parsed.action === 'need_clarification' && parsed.approval_id) {
      if (parsed.set_reminder) {
        await supabase.from('pending_yair_approvals').update({ remind_tomorrow: true }).eq('id', parsed.approval_id)
        await appendYairConversation(parsed.approval_id, text, null)
        return '✅ סבבה! אתזכר לשאול אותך מחר בבוקר 👍'
      }
      const question = parsed.clarification_question
      if (question) { await appendYairConversation(parsed.approval_id, text, question); return question }
    }

    if (parsed.action === 'none' && parsed.summary_for_jimmy) {
      const id = 'general_' + Date.now()
      await saveYairInstruction(id, parsed.summary_for_jimmy, false)
      return '✅ הבנתי ורשמתי לעצמי!'
    }
  }

  return null
}

// ========== נטישה ==========
const abandonTimers = {}
const ABANDON_DELAY_MS = 30 * 60 * 1000
const ACTIVE_FLOW_KEYWORDS = ['CHECKING_SLOT', 'מה שמך', 'ומה שמך', 'איזה יום', 'באיזה יום', 'שאל את שמו', 'שמו']
function markAbandonTimer(sender, lastBotReply) {
  if (abandonTimers[sender]?.timer) clearTimeout(abandonTimers[sender].timer)
  const isInProgress = ACTIVE_FLOW_KEYWORDS.some(kw => lastBotReply?.includes(kw)) || (lastBotReply && (lastBotReply.includes('מה שמך') || lastBotReply.includes('שמך') || lastBotReply.includes('איזה יום') || lastBotReply.includes('מתי בא לך') || lastBotReply.includes('איזו שעה')))
  if (!isInProgress) return
  const timer = setTimeout(async () => { if (!botSocket) return; try { await botSocket.sendMessage(sender, { text: 'היי! 😊\nראיתי שהתחלנו לדבר אבל לא סיימנו...\nרוצה שאקבע לך תור? 💈 אני כאן!' }) } catch {}; delete abandonTimers[sender] }, ABANDON_DELAY_MS)
  abandonTimers[sender] = { timer, lastActivity: new Date() }
}
function cancelAbandonTimer(sender) { if (abandonTimers[sender]?.timer) { clearTimeout(abandonTimers[sender].timer); delete abandonTimers[sender] } }

// ========== תזכורות ==========
async function loadReminders() { try { const { data } = await supabase.from('reminders').select('*'); return data || [] } catch { return [] } }
async function addReminder(phone, day, time, resolvedDate) { try { await supabase.from('reminders').delete().eq('phone', phone); await supabase.from('reminders').insert({ phone, day, time, resolved_date: resolvedDate, sent_day: false, sent_hour: false }) } catch {} }
async function cancelReminder(phone) { try { await supabase.from('reminders').delete().eq('phone', phone) } catch {} }

// ========== לקוחות ==========
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
      await supabase.from('customers').insert({ phone, name: (name && name !== 'לא צוין') ? name : null, last_seen: new Date().toISOString(), first_seen: new Date().toISOString(), haircut_count: type === 'haircut' ? 1 : 0, clothes_inquiry_count: type === 'clothes' ? 1 : 0 })
    }
  } catch {}
}

// ========== תורים ==========
async function logAppointment(day, time, phone) { try { await supabase.from('appointments').insert({ day, time, phone, cancelled: false }) } catch {} }
async function getUserAppointment(phone) { try { const { data } = await supabase.from('appointments').select('*').eq('phone', phone).eq('cancelled', false).order('created_at', { ascending: false }).limit(1); return data?.[0] || null } catch { return null } }
async function cancelUserAppointment(phone) {
  try {
    const appt = await getUserAppointment(phone); if (!appt) return null
    await supabase.from('appointments').update({ cancelled: true }).eq('id', appt.id)
    const key = appt.day + '-' + appt.time; if (appointments[key] > 0) appointments[key]--
    await cancelReminder(phone + '@s.whatsapp.net'); return appt
  } catch { return null }
}
async function getTodayAppointments() { try { const { today } = getIsraeliDateInfo(); const { data } = await supabase.from('appointments').select('*').eq('day', today).eq('cancelled', false).order('time'); return data || [] } catch { return [] } }

// ========== שרת QR ==========
let currentQR = null
createServer((req, res) => {
  if (currentQR) { toDataURL(currentQR, (err, url) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<html><head><meta charset="utf-8"><meta http-equiv="refresh" content="10"></head><body style="display:flex;justify-content:center;align-items:center;height:100vh;background:#111"><div style="text-align:center"><h2 style="color:white;font-family:sans-serif">סרוק עם וואטסאפ של יאיר</h2><img src="' + url + '" style="width:300px;height:300px"/><p style="color:#aaa;font-family:sans-serif">הדף מתרענן אוטומטית כל 10 שניות</p></div></body></html>') }) }
  else { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<html><head><meta charset="utf-8"></head><body style="background:#111;color:white;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh"><h2>הבוט מחובר! ✅</h2></body></html>') }
}).listen(process.env.PORT || 8080)

// ========== תאריך ישראלי ==========
function getIsraeliDateInfo() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }))
  const days = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת']
  return { today: days[now.getDay()], tomorrow: days[(now.getDay() + 1) % 7], currentTime: String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0'), currentHour: now.getHours(), dayIndex: now.getDay(), now }
}
function resolveToDate(dayName, isToday, isTomorrow) {
  const { now } = getIsraeliDateInfo()
  if (isToday) return new Date(now)
  if (isTomorrow) { const d = new Date(now); d.setDate(d.getDate() + 1); return d }
  const dayMap = { 'ראשון': 0, 'שני': 1, 'שלישי': 2, 'רביעי': 3, 'חמישי': 4, 'שישי': 5, 'שבת': 6 }
  const target = dayMap[dayName]; if (target === undefined) return null
  const d = new Date(now); d.setDate(d.getDate() + ((target - d.getDay() + 7) % 7 || 7)); return d
}
function getSlotKey(day, time) { return day + '-' + time }
function isSlotAvailable(day, time) { return (appointments[getSlotKey(day, time)] || 0) < MAX_PER_SLOT }
function bookSlot(day, time) { const key = getSlotKey(day, time); appointments[key] = (appointments[key] || 0) + 1 }
function getAvailableSlots(day) {
  const allSlots = ['08:00','09:00','10:00','11:00','12:00','13:00','14:00','15:00','16:00','17:00','18:00','19:00']
  const fridaySlots = ['08:00','09:00','10:00','11:00','12:00','13:00']
  return (day === 'שישי' ? fridaySlots : allSlots).filter(t => isSlotAvailable(day, t))
}
function buildConversationSummary(userPhone) {
  const history = conversations[userPhone] || []
  if (history.length === 0) return 'אין היסטוריית שיחה'
  return history.map(m => (m.role === 'user' ? 'לקוח: ' : "ג'ימי: ") + m.content).join('\n')
}

// ========== System Prompt ==========
function buildSystemPrompt(customerMemory = null) {
  const { today, tomorrow, currentTime, now } = getIsraeliDateInfo()
  const todayDateStr = getDateString(now)

  let yairInstructions = ''
  const publicMemory = Object.values(yairMemoryCache).filter(m => !m.is_private).map(m => m.content)
  if (publicMemory.length > 0) yairInstructions = '\n--- הוראות מיאיר ---\n' + publicMemory.join('\n')

  let customerContext = ''
  if (customerMemory) {
    customerContext = '\n--- הלקוח הזה ---\n'
    if (customerMemory.name) customerContext += 'שם: ' + customerMemory.name + '\n'
    if (customerMemory.preferences) customerContext += 'העדפות: ' + customerMemory.preferences + '\n'
    if (customerMemory.notes) customerContext += 'הערות: ' + customerMemory.notes + '\n'
    if (customerMemory.last_haircut) customerContext += 'תספורת אחרונה: ' + customerMemory.last_haircut + '\n'
  }

  let holidayContext = ''
  for (let i = 0; i <= 6; i++) {
    const d = new Date(now); d.setDate(d.getDate() + i)
    const ds = getDateString(d)
    const h = getHolidayInfo(ds)
    if (!h) continue
    const days = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת']
    const dayLabel = i === 0 ? 'היום' : i === 1 ? 'מחר' : 'יום ' + days[d.getDay()] + ' (' + ds + ')'
    if (h.type === 'holiday' || h.type === 'memorial') { holidayContext += '\n🔴 ' + dayLabel + ': ' + h.name + ' — סגור! אל תקבע תורים!' }
    else if (h.type === 'erev' || h.type === 'chol') {
      const hours = erevHolidayHours[ds]
      if (hours === 'CLOSED') holidayContext += '\n🔴 ' + dayLabel + ': ' + h.name + ' — סגור!'
      else if (hours) holidayContext += '\n🟡 ' + dayLabel + ': ' + h.name + ' — עובד עד ' + hours + ' בלבד!'
      else holidayContext += '\n⚪ ' + dayLabel + ': ' + h.name + ' — לא ידוע אם עובד. תגיד שבודק עם יאיר!'
    } else if (h.type === 'chanukah') { holidayContext += '\n🕎 ' + dayLabel + ': ' + h.name + ' שמח! פתוח כרגיל' }
  }

  return `אתה ג'ימי, העוזר האישי של יאיר — ספר מקצועי בלוד.
${yairInstructions}${customerContext}

🎯 עיקרון מנחה: אתה מקצועי, אדיב, וטבעי. אתה מדבר כמו בן אדם אמיתי — לא רובוט, אבל גם לא חבר מהרחוב.

סגנון דיבור:
- קצר, ענייני, עם חום אנושי
- "בסדר גמור", "אחלה", "מעולה", "בשמחה"
- כשצריך לסרב — תהיה אמפתי: "לצערי השעה הזו תפוסה, אבל יש מקום ב..."
- אל תחזור על מידע שכבר נאמר

מה לא לעשות:
- לא "אני שמח לעזור!" — נשמע רובוטי
- לא "אחי" / "אחותי" — ניטרלי ומכבד
- לא "וואלה" / סלנג רחוב

ברכת פתיחה (רק בהודעה ראשונה):
"היי! אני ג'ימי, העוזר של יאיר 😊\nאיך אפשר לעזור?"

פרטי העסק:
- כתובת: אלי כהן 12, לוד
- וויז: https://waze.com/ul?q=אלי+כהן+12+לוד&navigate=yes
- שעות: א-ה 08:00-20:00, שישי 08:00-14:00, שבת סגור

מחירים:
- לקוח חדש: 70 ש"ח
- לקוח חוזר: לא לגלות מחיר — תגיד "אין בעיה!" ותמשיך לקבוע
- בגדים: "בודק ומעביר ליאיר!"

--- מצב נוכחי ---
היום: יום ${today} | מחר: יום ${tomorrow} | שעה: ${currentTime} | תאריך: ${todayDateStr}
${holidayContext ? '\n--- חגים ---' + holidayContext : ''}

--- הוראות ---
1. תבין כתיב לא מדויק: "מחר ב17" = מחר 17:00, "שני ב10" = יום שני 10:00
2. לקביעת תור — קודם שם: "מעולה! מה השם?" → אחרי שם: "איזה יום ושעה מתאים [שם]?"
3. שעה ספציפית → כתוב CHECKING_SLOT,יום:XXX,שעה:XXX (בלי שום דבר אחר!)
4. אחרי SLOT_AVAILABLE → אישור + APPOINTMENT_BOOKED,יום:XXX,שעה:XXX,שם:XXX
5. אחרי SLOT_FULL → הצע שעות פנויות
6. בגדים → "בודק ומעביר ליאיר! 👌" + CLOTHES_INQUIRY
7. מחיר → "חדש או חוזר אצל יאיר?" → חדש: "70 ש\"ח 💈" → חוזר: "אין בעיה! 💪"
8. העברה ליאיר → TRANSFER_TO_YAIR,שם:XX,נושא:XX
9. ביטול → CANCEL_APPOINTMENT
10. דחייה → RESCHEDULE_APPOINTMENT
11. שבת סגור, שישי עד 14:00`
}

// ========== שאילת ג'ימי ==========
async function askJimmy(userPhone, userMessage) {
  if (!conversations[userPhone]) conversations[userPhone] = []
  const phone = extractPhone(userPhone) || userPhone.replace(/@.+/, '')
  const customerMemory = await loadCustomerMemory(phone)
  const dynamicSystem = buildSystemPrompt(customerMemory)
  const { today, tomorrow } = getIsraeliDateInfo()

  const timeMatch = userMessage.match(/(\d{1,2}:\d{2}|\b\d{1,2}\b)/)
  const dayMatch = userMessage.match(/(ראשון|שני|שלישי|רביעי|חמישי|שישי|מחר|היום)/)
  let contextMessage = userMessage

  if (timeMatch && dayMatch) {
    let time = timeMatch[0].includes(':') ? timeMatch[0] : timeMatch[0] + ':00'
    if (time.length === 4) time = '0' + time
    let resolvedDay = dayMatch[0]
    const isToday = resolvedDay === 'היום'; const isTomorrow = resolvedDay === 'מחר'
    if (isToday) resolvedDay = today; if (isTomorrow) resolvedDay = tomorrow
    const holidayCheck = canBookOnDay(resolvedDay, isToday, isTomorrow)
    if (holidayCheck.canBook === false) contextMessage = userMessage + '\n[HOLIDAY_CLOSED - ' + holidayCheck.reason + ']'
    else if (holidayCheck.canBook === 'pending') contextMessage = userMessage + '\n[HOLIDAY_PENDING - ' + holidayCheck.reason + ' - לא ידוע אם עובד]'
    else if (!isSlotAvailable(resolvedDay, time)) {
      const slotsInfo = getAvailableSlotsWithHolidays(resolvedDay, isToday, isTomorrow)
      contextMessage = userMessage + '\n[SLOT_FULL - ' + time + ' ביום ' + resolvedDay + ' תפוס! פנוי: ' + (slotsInfo.slots.join(', ') || 'אין') + ']'
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

  if (reply.includes('ASK_YAIR_HOURS')) {
    reply = reply.replace('ASK_YAIR_HOURS', '').trim()
    const { now } = getIsraeliDateInfo()
    for (let i = 0; i <= 6; i++) { const d = new Date(now); d.setDate(d.getDate() + i); const h = getHolidayInfo(getDateString(d)); if (h && (h.type === 'erev' || h.type === 'chol') && !erevHolidayHours[h.date]) { await askYairAboutHolidayHours(h); break } }
  }

  if (reply.includes('ASK_YAIR_APPROVAL')) {
    const parts = reply.split('ASK_YAIR_APPROVAL,'); const details = parts[1] || ''
    const typeM = details.match(/סוג:([^,\n]+)/); const detailsM = details.match(/פרטים:([^\n]+)/)
    const requestType = typeM?.[1]?.trim() || 'כללי'
    const requestDetails = detailsM?.[1]?.trim() || details.trim()
    const phone = extractPhone(userPhone) || userPhone.replace(/@.+/, '')
    const cm = await loadCustomerMemory(phone)
    const customerName = cm?.name || 'לא ידוע'
    const approvalId = await createPendingApproval(userPhone, customerName, requestType, requestDetails)
    reply = parts[0].trim()
    if (approvalId) await notifyYairRaw('❓ בקשה #' + approvalId + ' ממתינה לאישורך:\n👤 ' + customerName + '\n📝 ' + requestDetails + '\n\nענה בכל צורה שרוצה — אני אבין 😊')
  }

  if (reply.includes('APPOINTMENT_BOOKED')) {
    const parts = reply.split('APPOINTMENT_BOOKED,'); const details = parts[1] || ''
    const dayM = details.match(/יום:([^,\n]+)/); const timeM = details.match(/שעה:([^,\n\s]+)/)
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
        await notifyYairRaw('✂️ תור חדש!\n\n👤 ' + customerName + '\n📅 ' + day + ' ' + time + '\n📱 ' + phone + '\n💬 https://wa.me/' + phone + '\n\nשיחה:\n' + buildConversationSummary(userPhone))
        await updateCustomerMemoryFromConversation(phone, buildConversationSummary(userPhone))
      }
    }
    reply = parts[0].trim()
    if (!reply.includes('סבבה') && !reply.includes('מסודר') && !reply.includes('קבעתי')) {
      const day = dayM?.[1]?.trim() === 'היום' ? todayNow : dayM?.[1]?.trim() === 'מחר' ? tomorrowNow : dayM?.[1]?.trim()
      const time = timeM?.[1]?.trim()
      if (day && time) reply = (reply ? reply + '\n\n' : '') + 'סבבה, הכל מסודר! ✅\nתור אצל יאיר:\nיום ' + day + ' בשעה ' + time + '\nאלי כהן 12, לוד\nוויז: https://waze.com/ul?q=אלי+כהן+12+לוד&navigate=yes\nנתראה! 💈'
    }
  }

  if (reply.includes('CLOTHES_INQUIRY')) {
    reply = reply.replace('CLOTHES_INQUIRY', '').trim()
    const phone = extractPhone(userPhone) || userPhone.replace(/@.+/, '')
    await upsertCustomer(phone, null, 'clothes')
    await notifyYairRaw('👕 שאלה על בגדים!\n📱 ' + phone + '\n💬 https://wa.me/' + phone)
  }

  if (reply.includes('TRANSFER_TO_YAIR')) {
    const tp = reply.split('TRANSFER_TO_YAIR,'); const td = tp[1] || ''
    const nm = td.match(/שם:([^,\n]+)/); const tm = td.match(/נושא:([^,\n]+)/)
    const cn = nm?.[1]?.trim() || 'לא צוין'; const ct = tm?.[1]?.trim() || 'לא צוין'
    reply = tp[0].trim()
    if (!reply || reply.length < 10) reply = 'סבבה ' + cn + '! העברתי ליאיר — יחזור אליך כשיתפנה!'
    const phone = extractPhone(userPhone) || userPhone.replace(/@.+/, '')
    await upsertCustomer(phone, cn, null)
    await notifyYairRaw('📲 רוצה לדבר איתך!\n👤 ' + cn + '\n📝 ' + ct + '\n💬 https://wa.me/' + phone)
  }

  if (reply.includes('CANCEL_APPOINTMENT')) {
    reply = reply.replace('CANCEL_APPOINTMENT', '').trim()
    const phone = extractPhone(userPhone) || userPhone.replace(/@.+/, '')
    const appt = await cancelUserAppointment(phone)
    if (appt) { reply = 'סבבה, ביטלתי! (יום ' + appt.day + ' ' + appt.time + ') ✅\nרוצה לקבוע מחדש?'; await notifyYairRaw('❌ תור בוטל!\n📅 ' + appt.day + ' ' + appt.time + '\n📱 ' + phone) }
    else reply = 'לא מצאתי תור פעיל 🤔 דבר ישירות עם יאיר!'
  }

  if (reply.includes('RESCHEDULE_APPOINTMENT')) {
    reply = reply.replace('RESCHEDULE_APPOINTMENT', '').trim()
    const phone = extractPhone(userPhone) || userPhone.replace(/@.+/, '')
    const appt = await getUserAppointment(phone)
    if (appt) { await cancelUserAppointment(phone); reply = 'סבבה! ביטלתי את ' + appt.day + ' ' + appt.time + ' 🔄\nאיזה יום ושעה חדשים?'; await notifyYairRaw('🔄 דחיית תור\n📅 ' + appt.day + ' ' + appt.time + '\n📱 ' + phone) }
    else reply = 'לא מצאתי תור 🤔 נקבע חדש?'
  }

  return reply
}

async function notifyYairRaw(msg) { if (!botSocket) return; try { await botSocket.sendMessage(OWNER_PHONE, { text: msg }) } catch {} }

// ========== תזכורות לקוחות ==========
async function sendReminders() {
  if (!botSocket) return
  const reminders = await loadReminders(); if (reminders.length === 0) return
  const { now } = getIsraeliDateInfo()
  for (const r of reminders) {
    if (!r.resolved_date) continue
    const apptDate = new Date(r.resolved_date)
    const [h, m] = r.time.split(':').map(Number); apptDate.setHours(h, m, 0, 0)
    const hoursUntil = (apptDate - now) / (1000 * 60 * 60)
    if (!r.sent_day && hoursUntil > 3 && hoursUntil <= 24) { try { await botSocket.sendMessage(r.phone, { text: 'היי! תזכורת — תור מחר יום ' + r.day + ' בשעה ' + r.time + ' אצל יאיר!\nאלי כהן 12, לוד\nוויז: https://waze.com/ul?q=אלי+כהן+12+לוד&navigate=yes' }); await supabase.from('reminders').update({ sent_day: true }).eq('id', r.id) } catch {} }
    if (!r.sent_hour && hoursUntil > 0 && hoursUntil <= 3) { try { await botSocket.sendMessage(r.phone, { text: 'היי! עוד מעט התור שלך — ' + r.time + ' 💈\nאלי כהן 12, לוד' }); await supabase.from('reminders').update({ sent_hour: true }).eq('id', r.id) } catch {} }
    if (apptDate - now < 0) { try { await supabase.from('reminders').delete().eq('id', r.id) } catch {} }
  }
}

async function sendDailySummary() {
  if (!botSocket) return
  const { today } = getIsraeliDateInfo()
  const todays = await getTodayAppointments()
  const todayH = getTodayHoliday(); const tomorrowH = getTomorrowHoliday()
  let msg = '🗓️ בוקר טוב יאיר! תורים להיום — יום ' + today + ':\n─────────────────\n'
  if (todayH) msg += '🕎 ' + todayH.name + '\n─────────────────\n'
  if (todays.length === 0) msg += 'אין תורים היום 😎\n'
  else todays.forEach(a => { msg += '🕐 ' + a.time + ' — ' + a.phone + '\n' })
  msg += '─────────────────\n✅ סה"כ: ' + todays.length
  if (tomorrowH) msg += '\n\n🕎 מחר: ' + tomorrowH.name + (tomorrowH.type === 'holiday' ? ' (סגור!)' : '')
  await notifyYairRaw(msg)
}

// ========== startBot ==========
async function startBot() {
  console.log("מתחיל את ג'ימי...")
  await initSupabaseTables(); await initData(); await loadAllData()
  console.log('נתונים נטענו! מתחבר...')

  const { state, saveCreds } = await useSupabaseAuthState()
  const { version } = await fetchLatestBaileysVersion()
  const logger = pino({ level: 'silent' })
  const sock = makeWASocket({
    version,
    logger,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    printQRInTerminal: false,
    browser: ['Jimmy-Bot', 'Safari', '605.1.15'],
    syncFullHistory: false
  })
  botSocket = sock
  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('lid-mapping.update', async (mappings) => { if (Array.isArray(mappings)) for (const m of mappings) { if (m.lid && m.phoneNumber) await saveLidMapping(m.lid.replace('@lid', ''), m.phoneNumber.replace('@s.whatsapp.net', '').replace(/:.*/, '')) } })
  sock.ev.on('contacts.upsert', async (contacts) => { for (const c of contacts) { if (c.id?.includes('@lid') && c.phoneNumber) await saveLidMapping(c.id.replace('@lid', ''), c.phoneNumber.replace('@s.whatsapp.net', '').replace(/:.*/, '')); if (c.lid && c.phoneNumber) await saveLidMapping(c.lid.replace('@lid', ''), c.phoneNumber.replace('@s.whatsapp.net', '').replace(/:.*/, '')) } })

  setInterval(async () => { if (botSocket?.user) try { await botSocket.sendPresenceUpdate('available', botSocket.user.id) } catch {} }, 4 * 60 * 1000)

  let remindersInterval = null, summaryScheduled = false, holidayCheckScheduled = false, yairRemindersInterval = null

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) { currentQR = qr; console.log('QR מוכן! כנסי ל-' + (process.env.RAILWAY_PUBLIC_DOMAIN || 'האתר') + ' לסריקה') }
    if (connection === 'open') {
      currentQR = null
      // ✅ איפוס מונה loggedOut בחיבור מוצלח
      loggedOutCount = 0
      badMacCount = 0
      console.log("ג'ימי מחובר! 💈")
      try { await sock.sendMessage(OWNER_PHONE, { text: "✅ ג'ימי מחובר ופעיל! 💈" }) } catch {}

      if (!remindersInterval) {
        remindersInterval = setInterval(sendReminders, 10 * 60 * 1000)
      }

      if (!yairRemindersInterval) {
        yairRemindersInterval = setInterval(checkYairReminders, 60 * 1000)
      }

      if (!summaryScheduled) {
        setInterval(() => {
          const { now } = getIsraeliDateInfo()
          if (now.getHours() === 8 && now.getMinutes() === 0) {
            sendDailySummary()
            checkPendingApprovalReminders()
          }
        }, 60 * 1000)
        summaryScheduled = true
      }

      if (!holidayCheckScheduled) { checkUpcomingHolidays(); setInterval(checkUpcomingHolidays, 6 * 60 * 60 * 1000); holidayCheckScheduled = true }
    }
    if (connection === 'close') {
      botSocket = null
      const err = lastDisconnect?.error
      const code = new Boom(err)?.output?.statusCode
      const errMsg = err?.message || err?.toString() || ''
      const isBadMac = errMsg.includes('Bad MAC') || errMsg.includes('bad mac') || errMsg.includes('TAG-MISMATCH')
      const isSessionError = errMsg.includes('Session error') || errMsg.includes('session')

      if (isBadMac || isSessionError) {
        console.error('⚠️ Bad MAC / Session error! מנסה להתחבר מחדש...')
        badMacCount++
        // ✅ תיקון: מוחק auth רק אחרי 5 Bad MAC ברצף (לא 3)
        if (badMacCount >= 5) {
          console.error('🔴 5+ Bad MAC errors — מוחק auth ומחכה לQR')
          try { rmSync('auth_info', { recursive: true, force: true }) } catch {}
          try { await supabase.from('bot_auth').delete().eq('id', 'main') } catch {}
          badMacCount = 0
        }
        setTimeout(startBot, 3000)
      } else if (code === DisconnectReason.loggedOut) {
        loggedOutCount++
        console.log('התנתק logged out #' + loggedOutCount)
        // מוחק auth מקומי תמיד
        try { rmSync('auth_info', { recursive: true, force: true }) } catch {}
        // מוחק גם מ-Supabase — כי logged out = session לא תקין
        try { await supabase.from('bot_auth').delete().eq('id', 'main') } catch {}
        loggedOutCount = 0
        console.log('🔴 auth נמחק — ממתין 15 שניות לפני QR חדש...')
        // ✅ מחכה 15 שניות כדי לתת ל-WA לשחרר את ה-session
        setTimeout(startBot, 15000)
      } else if (code === DisconnectReason.restartRequired) {
        setTimeout(startBot, 1000)
      } else {
        console.log('התנתק — קוד: ' + code + ', מתחבר מחדש...')
        setTimeout(startBot, 3000)
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const msg of messages) {
      if (msg.key.fromMe || msg.key.remoteJid.endsWith('@g.us')) continue
      const sender = msg.key.remoteJid
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || ''
      if (!text) continue

      if (sender === OWNER_PHONE) { const cmdResult = await handleYairCommand(text); if (cmdResult) { await sock.sendMessage(sender, { text: cmdResult }); continue } }

      if (sender.includes('@lid')) {
        const senderPn = msg.key?.senderPn
        if (senderPn) { await saveLidMapping(sender.replace('@lid', ''), senderPn.replace('@s.whatsapp.net', '').replace(/:.*/, '')) }
        else await tryResolveLid(sender)
        if (msg.key.participant?.includes('@s.whatsapp.net')) await saveLidMapping(sender.replace('@lid', ''), msg.key.participant.replace('@s.whatsapp.net', ''))
      }

      if (isFamilyMember(sender)) { const phone = extractPhone(sender) || sender.replace(/@.+/, ''); await notifyYairRaw('👨‍👩‍👧 הודעה ממשפחה!\n💬 ' + getWALink(phone) + '\n\n✉️ ' + text); continue }
      if (isBlocked(sender)) continue

      if (!isKnownLid(sender)) {
        const lid = sender.replace('@lid', '')
        if (!notifiedLids.has(lid)) { notifiedLids.add(lid); await notifyYairRaw('🆕 מספר חדש (LID)!\n💬 ' + text + '\n🔑 ' + lid + '\n\nמה לעשות?\n• חסום ' + lid + '\n• משפחה ' + lid + '\n• רגיל ' + lid) }
      }

      cancelAbandonTimer(sender)

      try {
        await sock.sendPresenceUpdate('composing', sender)
        const reply = await askJimmy(sender, text)
        const checkingMatch = reply.match(/CHECKING_SLOT,יום:([^,\n]+),שעה:([^,\n\s]+)/)
        if (checkingMatch) {
          const checkDay = checkingMatch[1].trim(); const checkTime = checkingMatch[2].trim()
          await sock.sendMessage(sender, { text: 'רגע, בודק... 🔍' })
          await new Promise(r => setTimeout(r, 2000))
          const { today, tomorrow } = getIsraeliDateInfo()
          let resolvedDay = checkDay
          const isToday = checkDay === 'היום' || checkDay === today
          const isTomorrow = checkDay === 'מחר' || checkDay === tomorrow
          if (resolvedDay === 'היום') resolvedDay = today; if (resolvedDay === 'מחר') resolvedDay = tomorrow
          const holidayCheck = canBookOnDay(resolvedDay, isToday, isTomorrow)
          let slotContext
          if (holidayCheck.canBook === false) { slotContext = '[HOLIDAY_CLOSED - ' + holidayCheck.reason + ']' }
          else if (holidayCheck.canBook === 'pending') { slotContext = '[HOLIDAY_PENDING - ' + holidayCheck.reason + ']'; if (holidayCheck.holiday) await askYairAboutHolidayHours(holidayCheck.holiday) }
          else {
            const slotsInfo = getAvailableSlotsWithHolidays(resolvedDay, isToday, isTomorrow)
            slotContext = isSlotAvailable(resolvedDay, checkTime)
              ? '[SLOT_AVAILABLE - יום ' + resolvedDay + ' בשעה ' + checkTime + ' פנוי!]'
              : '[SLOT_FULL - ' + checkTime + ' ביום ' + resolvedDay + ' תפוס! פנוי: ' + (slotsInfo.slots.join(', ') || 'אין') + ']'
          }
          const followUp = await askJimmy(sender, slotContext)
          await sock.sendMessage(sender, { text: followUp })
          markAbandonTimer(sender, followUp)
        } else {
          await sock.sendMessage(sender, { text: reply })
          markAbandonTimer(sender, reply)
        }
      } catch (err) {
        console.error('שגיאה:', err?.message)
        await sock.sendMessage(sender, { text: 'אוי, משהו קרה — נסה שוב! 😅' })
      }
    }
  })
}

startBot()

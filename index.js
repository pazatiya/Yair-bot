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

if (process.env.DELETE_AUTH === 'true') {
  try { rmSync('auth_info', { recursive: true, force: true }); console.log('auth_info נמחק - ממתין ל-QR חדש') } catch {}
}

const OWNER_PHONE = '972507983306@s.whatsapp.net'
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
const MAX_PER_SLOT = 2
const conversations = {}
const appointments = {}
let botSocket = null
let badMacCount = 0

// תופס שגיאות Bad MAC גלובליות — מונע crash
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

// ========== מערכת חגים ישראליים 2025-2030 ==========
const ISRAELI_HOLIDAYS = {}
// נבנה אוטומטית — חגים 2025-2030
// t: holiday=סגור, erev=ערב חג, chol=חול המועד, memorial=זיכרון, fast=צום, chanukah=חנוכה, halfday=חצי יום
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
ISRAELI_HOLIDAYS[2031] = [
  { date: '2031-03-11', name: 'ערב פורים', type: 'erev' },
  { date: '2031-03-12', name: 'פורים', type: 'halfday' },
  { date: '2031-04-08', name: 'ערב פסח', type: 'erev' },
  { date: '2031-04-09', name: 'פסח', type: 'holiday' },
  { date: '2031-04-10', name: 'חוה"מ פסח', type: 'chol', parentHoliday: 'פסח' },
  { date: '2031-04-11', name: 'חוה"מ פסח', type: 'chol', parentHoliday: 'פסח' },
  { date: '2031-04-12', name: 'חוה"מ פסח', type: 'chol', parentHoliday: 'פסח' },
  { date: '2031-04-13', name: 'חוה"מ פסח', type: 'chol', parentHoliday: 'פסח' },
  { date: '2031-04-14', name: 'ערב שביעי של פסח', type: 'erev' },
  { date: '2031-04-15', name: 'שביעי של פסח', type: 'holiday' },
  { date: '2031-04-29', name: 'ערב יום הזיכרון', type: 'erev' },
  { date: '2031-04-30', name: 'יום הזיכרון', type: 'memorial' },
  { date: '2031-05-01', name: 'יום העצמאות', type: 'holiday' },
  { date: '2031-05-28', name: 'ערב שבועות', type: 'erev' },
  { date: '2031-05-29', name: 'שבועות', type: 'holiday' },
  { date: '2031-09-18', name: 'ערב ראש השנה', type: 'erev' },
  { date: '2031-09-19', name: 'ראש השנה א', type: 'holiday' },
  { date: '2031-09-20', name: 'ראש השנה ב', type: 'holiday' },
  { date: '2031-09-27', name: 'ערב יום כיפור', type: 'erev' },
  { date: '2031-09-28', name: 'יום כיפור', type: 'holiday' },
  { date: '2031-10-02', name: 'ערב סוכות', type: 'erev' },
  { date: '2031-10-03', name: 'סוכות', type: 'holiday' },
  { date: '2031-10-04', name: 'חוה"מ סוכות', type: 'chol', parentHoliday: 'סוכות' },
  { date: '2031-10-05', name: 'חוה"מ סוכות', type: 'chol', parentHoliday: 'סוכות' },
  { date: '2031-10-06', name: 'חוה"מ סוכות', type: 'chol', parentHoliday: 'סוכות' },
  { date: '2031-10-07', name: 'חוה"מ סוכות', type: 'chol', parentHoliday: 'סוכות' },
  { date: '2031-10-09', name: 'הושענא רבה', type: 'erev' },
  { date: '2031-10-10', name: 'שמחת תורה', type: 'holiday' },
]
ISRAELI_HOLIDAYS[2032] = [
  { date: '2032-02-29', name: 'ערב פורים', type: 'erev' },
  { date: '2032-03-01', name: 'פורים', type: 'halfday' },
  { date: '2032-03-27', name: 'ערב פסח', type: 'erev' },
  { date: '2032-03-28', name: 'פסח', type: 'holiday' },
  { date: '2032-03-29', name: 'חוה"מ פסח', type: 'chol', parentHoliday: 'פסח' },
  { date: '2032-03-30', name: 'חוה"מ פסח', type: 'chol', parentHoliday: 'פסח' },
  { date: '2032-03-31', name: 'חוה"מ פסח', type: 'chol', parentHoliday: 'פסח' },
  { date: '2032-04-01', name: 'חוה"מ פסח', type: 'chol', parentHoliday: 'פסח' },
  { date: '2032-04-02', name: 'ערב שביעי של פסח', type: 'erev' },
  { date: '2032-04-03', name: 'שביעי של פסח', type: 'holiday' },
  { date: '2032-04-20', name: 'ערב יום הזיכרון', type: 'erev' },
  { date: '2032-04-21', name: 'יום הזיכרון', type: 'memorial' },
  { date: '2032-04-22', name: 'יום העצמאות', type: 'holiday' },
  { date: '2032-05-16', name: 'ערב שבועות', type: 'erev' },
  { date: '2032-05-17', name: 'שבועות', type: 'holiday' },
  { date: '2032-09-06', name: 'ערב ראש השנה', type: 'erev' },
  { date: '2032-09-07', name: 'ראש השנה א', type: 'holiday' },
  { date: '2032-09-08', name: 'ראש השנה ב', type: 'holiday' },
  { date: '2032-09-15', name: 'ערב יום כיפור', type: 'erev' },
  { date: '2032-09-16', name: 'יום כיפור', type: 'holiday' },
  { date: '2032-09-20', name: 'ערב סוכות', type: 'erev' },
  { date: '2032-09-21', name: 'סוכות', type: 'holiday' },
  { date: '2032-09-22', name: 'חוה"מ סוכות', type: 'chol', parentHoliday: 'סוכות' },
  { date: '2032-09-23', name: 'חוה"מ סוכות', type: 'chol', parentHoliday: 'סוכות' },
  { date: '2032-09-24', name: 'חוה"מ סוכות', type: 'chol', parentHoliday: 'סוכות' },
  { date: '2032-09-25', name: 'חוה"מ סוכות', type: 'chol', parentHoliday: 'סוכות' },
  { date: '2032-09-27', name: 'הושענא רבה', type: 'erev' },
  { date: '2032-09-28', name: 'שמחת תורה', type: 'holiday' },
]
ISRAELI_HOLIDAYS[2033] = [
  { date: '2033-03-17', name: 'ערב פורים', type: 'erev' },
  { date: '2033-03-18', name: 'פורים', type: 'halfday' },
  { date: '2033-04-14', name: 'ערב פסח', type: 'erev' },
  { date: '2033-04-15', name: 'פסח', type: 'holiday' },
  { date: '2033-04-16', name: 'חוה"מ פסח', type: 'chol', parentHoliday: 'פסח' },
  { date: '2033-04-17', name: 'חוה"מ פסח', type: 'chol', parentHoliday: 'פסח' },
  { date: '2033-04-18', name: 'חוה"מ פסח', type: 'chol', parentHoliday: 'פסח' },
  { date: '2033-04-19', name: 'חוה"מ פסח', type: 'chol', parentHoliday: 'פסח' },
  { date: '2033-04-20', name: 'ערב שביעי של פסח', type: 'erev' },
  { date: '2033-04-21', name: 'שביעי של פסח', type: 'holiday' },
  { date: '2033-05-10', name: 'ערב יום הזיכרון', type: 'erev' },
  { date: '2033-05-11', name: 'יום הזיכרון', type: 'memorial' },
  { date: '2033-05-12', name: 'יום העצמאות', type: 'holiday' },
  { date: '2033-06-03', name: 'ערב שבועות', type: 'erev' },
  { date: '2033-06-04', name: 'שבועות', type: 'holiday' },
  { date: '2033-09-24', name: 'ערב ראש השנה', type: 'erev' },
  { date: '2033-09-25', name: 'ראש השנה א', type: 'holiday' },
  { date: '2033-09-26', name: 'ראש השנה ב', type: 'holiday' },
  { date: '2033-10-03', name: 'ערב יום כיפור', type: 'erev' },
  { date: '2033-10-04', name: 'יום כיפור', type: 'holiday' },
  { date: '2033-10-08', name: 'ערב סוכות', type: 'erev' },
  { date: '2033-10-09', name: 'סוכות', type: 'holiday' },
  { date: '2033-10-10', name: 'חוה"מ סוכות', type: 'chol', parentHoliday: 'סוכות' },
  { date: '2033-10-11', name: 'חוה"מ סוכות', type: 'chol', parentHoliday: 'סוכות' },
  { date: '2033-10-12', name: 'חוה"מ סוכות', type: 'chol', parentHoliday: 'סוכות' },
  { date: '2033-10-13', name: 'חוה"מ סוכות', type: 'chol', parentHoliday: 'סוכות' },
  { date: '2033-10-15', name: 'הושענא רבה', type: 'erev' },
  { date: '2033-10-16', name: 'שמחת תורה', type: 'holiday' },
]
ISRAELI_HOLIDAYS[2034] = [
  { date: '2034-03-07', name: 'ערב פורים', type: 'erev' },
  { date: '2034-03-08', name: 'פורים', type: 'halfday' },
  { date: '2034-04-04', name: 'ערב פסח', type: 'erev' },
  { date: '2034-04-05', name: 'פסח', type: 'holiday' },
  { date: '2034-04-06', name: 'חוה"מ פסח', type: 'chol', parentHoliday: 'פסח' },
  { date: '2034-04-07', name: 'חוה"מ פסח', type: 'chol', parentHoliday: 'פסח' },
  { date: '2034-04-08', name: 'חוה"מ פסח', type: 'chol', parentHoliday: 'פסח' },
  { date: '2034-04-09', name: 'חוה"מ פסח', type: 'chol', parentHoliday: 'פסח' },
  { date: '2034-04-10', name: 'ערב שביעי של פסח', type: 'erev' },
  { date: '2034-04-11', name: 'שביעי של פסח', type: 'holiday' },
  { date: '2034-04-25', name: 'ערב יום הזיכרון', type: 'erev' },
  { date: '2034-04-26', name: 'יום הזיכרון', type: 'memorial' },
  { date: '2034-04-27', name: 'יום העצמאות', type: 'holiday' },
  { date: '2034-05-24', name: 'ערב שבועות', type: 'erev' },
  { date: '2034-05-25', name: 'שבועות', type: 'holiday' },
  { date: '2034-09-14', name: 'ערב ראש השנה', type: 'erev' },
  { date: '2034-09-15', name: 'ראש השנה א', type: 'holiday' },
  { date: '2034-09-16', name: 'ראש השנה ב', type: 'holiday' },
  { date: '2034-09-23', name: 'ערב יום כיפור', type: 'erev' },
  { date: '2034-09-24', name: 'יום כיפור', type: 'holiday' },
  { date: '2034-09-28', name: 'ערב סוכות', type: 'erev' },
  { date: '2034-09-29', name: 'סוכות', type: 'holiday' },
  { date: '2034-09-30', name: 'חוה"מ סוכות', type: 'chol', parentHoliday: 'סוכות' },
  { date: '2034-10-01', name: 'חוה"מ סוכות', type: 'chol', parentHoliday: 'סוכות' },
  { date: '2034-10-02', name: 'חוה"מ סוכות', type: 'chol', parentHoliday: 'סוכות' },
  { date: '2034-10-03', name: 'חוה"מ סוכות', type: 'chol', parentHoliday: 'סוכות' },
  { date: '2034-10-05', name: 'הושענא רבה', type: 'erev' },
  { date: '2034-10-06', name: 'שמחת תורה', type: 'holiday' },
]
ISRAELI_HOLIDAYS[2035] = [
  { date: '2035-03-27', name: 'ערב פורים', type: 'erev' },
  { date: '2035-03-28', name: 'פורים', type: 'halfday' },
  { date: '2035-04-23', name: 'ערב פסח', type: 'erev' },
  { date: '2035-04-24', name: 'פסח', type: 'holiday' },
  { date: '2035-04-25', name: 'חוה"מ פסח', type: 'chol', parentHoliday: 'פסח' },
  { date: '2035-04-26', name: 'חוה"מ פסח', type: 'chol', parentHoliday: 'פסח' },
  { date: '2035-04-27', name: 'חוה"מ פסח', type: 'chol', parentHoliday: 'פסח' },
  { date: '2035-04-28', name: 'חוה"מ פסח', type: 'chol', parentHoliday: 'פסח' },
  { date: '2035-04-29', name: 'ערב שביעי של פסח', type: 'erev' },
  { date: '2035-04-30', name: 'שביעי של פסח', type: 'holiday' },
  { date: '2035-05-13', name: 'ערב יום הזיכרון', type: 'erev' },
  { date: '2035-05-14', name: 'יום הזיכרון', type: 'memorial' },
  { date: '2035-05-15', name: 'יום העצמאות', type: 'holiday' },
  { date: '2035-06-12', name: 'ערב שבועות', type: 'erev' },
  { date: '2035-06-13', name: 'שבועות', type: 'holiday' },
  { date: '2035-10-03', name: 'ערב ראש השנה', type: 'erev' },
  { date: '2035-10-04', name: 'ראש השנה א', type: 'holiday' },
  { date: '2035-10-05', name: 'ראש השנה ב', type: 'holiday' },
  { date: '2035-10-12', name: 'ערב יום כיפור', type: 'erev' },
  { date: '2035-10-13', name: 'יום כיפור', type: 'holiday' },
  { date: '2035-10-17', name: 'ערב סוכות', type: 'erev' },
  { date: '2035-10-18', name: 'סוכות', type: 'holiday' },
  { date: '2035-10-19', name: 'חוה"מ סוכות', type: 'chol', parentHoliday: 'סוכות' },
  { date: '2035-10-20', name: 'חוה"מ סוכות', type: 'chol', parentHoliday: 'סוכות' },
  { date: '2035-10-21', name: 'חוה"מ סוכות', type: 'chol', parentHoliday: 'סוכות' },
  { date: '2035-10-22', name: 'חוה"מ סוכות', type: 'chol', parentHoliday: 'סוכות' },
  { date: '2035-10-24', name: 'הושענא רבה', type: 'erev' },
  { date: '2035-10-25', name: 'שמחת תורה', type: 'holiday' },
]
ISRAELI_HOLIDAYS[2036] = [
  { date: '2036-03-13', name: 'ערב פורים', type: 'erev' },
  { date: '2036-03-14', name: 'פורים', type: 'halfday' },
  { date: '2036-04-11', name: 'ערב פסח', type: 'erev' },
  { date: '2036-04-12', name: 'פסח', type: 'holiday' },
  { date: '2036-04-13', name: 'חוה"מ פסח', type: 'chol', parentHoliday: 'פסח' },
  { date: '2036-04-14', name: 'חוה"מ פסח', type: 'chol', parentHoliday: 'פסח' },
  { date: '2036-04-15', name: 'חוה"מ פסח', type: 'chol', parentHoliday: 'פסח' },
  { date: '2036-04-16', name: 'חוה"מ פסח', type: 'chol', parentHoliday: 'פסח' },
  { date: '2036-04-17', name: 'ערב שביעי של פסח', type: 'erev' },
  { date: '2036-04-18', name: 'שביעי של פסח', type: 'holiday' },
  { date: '2036-04-29', name: 'ערב יום הזיכרון', type: 'erev' },
  { date: '2036-04-30', name: 'יום הזיכרון', type: 'memorial' },
  { date: '2036-05-01', name: 'יום העצמאות', type: 'holiday' },
  { date: '2036-05-30', name: 'ערב שבועות', type: 'erev' },
  { date: '2036-06-01', name: 'שבועות', type: 'holiday' },
  { date: '2036-09-22', name: 'ערב ראש השנה', type: 'erev' },
  { date: '2036-09-23', name: 'ראש השנה א', type: 'holiday' },
  { date: '2036-09-24', name: 'ראש השנה ב', type: 'holiday' },
  { date: '2036-10-01', name: 'ערב יום כיפור', type: 'erev' },
  { date: '2036-10-02', name: 'יום כיפור', type: 'holiday' },
  { date: '2036-10-06', name: 'ערב סוכות', type: 'erev' },
  { date: '2036-10-07', name: 'סוכות', type: 'holiday' },
  { date: '2036-10-08', name: 'חוה"מ סוכות', type: 'chol', parentHoliday: 'סוכות' },
  { date: '2036-10-09', name: 'חוה"מ סוכות', type: 'chol', parentHoliday: 'סוכות' },
  { date: '2036-10-10', name: 'חוה"מ סוכות', type: 'chol', parentHoliday: 'סוכות' },
  { date: '2036-10-11', name: 'חוה"מ סוכות', type: 'chol', parentHoliday: 'סוכות' },
  { date: '2036-10-13', name: 'הושענא רבה', type: 'erev' },
  { date: '2036-10-14', name: 'שמחת תורה', type: 'holiday' },
]

let erevHolidayHours = {} // שעות ערב חג שיאיר הגדיר

// ========== פונקציות חגים ==========
function getDateString(date) {
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0')
}

function getHolidayInfo(dateStr) {
  const year = parseInt(dateStr.split('-')[0])
  const holidays = ISRAELI_HOLIDAYS[year] || []
  return holidays.find(h => h.date === dateStr) || null
}

function getTodayHoliday() {
  const { now } = getIsraeliDateInfo()
  return getHolidayInfo(getDateString(now))
}

function getTomorrowHoliday() {
  const { now } = getIsraeliDateInfo()
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1)
  return getHolidayInfo(getDateString(tomorrow))
}

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
    case 'erev': {
      const hours = erevHolidayHours[holiday.date]
      if (hours === 'CLOSED') return { canBook: false, reason: holiday.name + ' - סגור', holiday }
      if (hours) return { canBook: true, limitedHours: hours, holiday }
      return { canBook: 'pending', reason: holiday.name, holiday }
    }
    case 'chol': {
      const hours = erevHolidayHours[holiday.date]
      if (hours === 'CLOSED') return { canBook: false, reason: holiday.name + ' - סגור', holiday }
      if (hours) return { canBook: true, limitedHours: hours, holiday }
      return { canBook: 'pending', reason: holiday.name, holiday }
    }
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
  if (bookCheck.limitedHours) {
    const limitHour = parseInt(bookCheck.limitedHours.split(':')[0])
    allSlots = allSlots.filter(t => parseInt(t.split(':')[0]) < limitHour)
  }
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
    msg = 'יאיר! 👋\n\n'
      + '📅 בעוד כמה ימים יש ' + parentName + '\n'
      + 'ביום ' + dateStr + ' זה ' + holiday.name + '\n\n'
      + 'אתה עובד ב' + holiday.name + '?\n'
      + 'אם כן - עד מתי?\n\n'
      + '✏️ שלח: שעות ' + dateStr + ' 14:00 (לדוגמה)\n'
      + '🚫 שלח: סגור ' + dateStr + ' (אם לא עובד)\n\n'
      + '(יש עוד ימי חול המועד - תעדכן על כל יום בנפרד)'
  } else {
    msg = 'יאיר! 👋\n\n'
      + '🕎 בעוד כמה ימים: ' + holiday.name + '\n'
      + '📅 תאריך: ' + dateStr + '\n\n'
      + 'עד איזה שעה אתה עובד?\n\n'
      + '✏️ שלח: שעות ' + dateStr + ' 13:00\n'
      + '🚫 או: סגור ' + dateStr
  }

  await notifyYairRaw(msg)
}

async function loadErevHours() {
  try {
    const { data } = await supabase.from('erev_hours').select('*')
    if (data) data.forEach(r => { erevHolidayHours[r.date_str] = r.close_time })
    console.log('נטענו ' + Object.keys(erevHolidayHours).length + ' הגדרות שעות חג')
  } catch (err) { console.error('שגיאה בטעינת שעות חג:', err?.message) }
}

async function saveErevHours(dateStr, closeTime) {
  erevHolidayHours[dateStr] = closeTime
  try {
    await supabase.from('erev_hours').upsert({ date_str: dateStr, close_time: closeTime, updated_at: new Date().toISOString() })
  } catch (err) { console.error('שגיאה בשמירת שעות חג:', err?.message) }
}

// בדיקה יומית — 3 ימים קדימה, שואל יאיר על ערבי חג + חול המועד
async function checkUpcomingHolidays() {
  const { now } = getIsraeliDateInfo()
  for (let i = 1; i <= 5; i++) {
    const futureDate = new Date(now); futureDate.setDate(futureDate.getDate() + i)
    const dateStr = getDateString(futureDate)
    const holiday = getHolidayInfo(dateStr)
    if (!holiday) continue

    if ((holiday.type === 'erev' || holiday.type === 'chol') && !erevHolidayHours[dateStr]) {
      await askYairAboutHolidayHours(holiday)
    }
    if (holiday.type === 'holiday' && i === 1) {
      await notifyYairRaw('🕎 תזכורת: מחר ' + holiday.name + ' — הבוט לא יקבע תורים!')
    }
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
    `
  })
  if (error) {
    try {
      const { error: testError } = await supabase.from('blocked_phones').select('id').limit(1)
      if (testError?.code === '42P01') console.error('⚠️ הטבלאות לא קיימות! הרץ SQL ב-Supabase SQL Editor')
      else console.log('טבלאות קיימות!')
    } catch (e) { console.error('שגיאה:', e?.message) }
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
      { id: '972547734708', name: 'אשתו' },
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
  console.log('נתונים נטענו: ' + BLOCKED_PHONES.length + ' חסומים, ' + FAMILY_PHONES.length + ' משפחה, ' + Object.keys(lidToPhone).length + ' LID, ' + Object.keys(erevHolidayHours).length + ' שעות חג')
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
  const blockMatch = text.match(/^חסום\s+(\S+)/i)
  if (blockMatch) { const id = blockMatch[1].trim(); if (!BLOCKED_PHONES.includes(id)) { BLOCKED_PHONES.push(id); await supabase.from('blocked_phones').upsert({ id }) }; return '✅ ' + id + ' נחסם!' }

  const familyMatch = text.match(/^משפחה\s+(\S+)/i)
  if (familyMatch) { const id = familyMatch[1].trim(); if (!FAMILY_PHONES.includes(id)) { FAMILY_PHONES.push(id); await supabase.from('family_phones').upsert({ id }) }; return '✅ ' + id + ' נוסף למשפחה!' }

  const normalMatch = text.match(/^רגיל\s+(\S+)/i)
  if (normalMatch) { const id = normalMatch[1].trim(); if (!knownLids.includes(id)) { knownLids.push(id); await supabase.from('known_lids').upsert({ lid: id }) }; return '✅ ' + id + ' סומן כלקוח רגיל!' }

  const unblockMatch = text.match(/^(בטל.?חסימה|שחרר)\s+(\S+)/i)
  if (unblockMatch) { const id = unblockMatch[2].trim(); BLOCKED_PHONES = BLOCKED_PHONES.filter(p => p !== id); await supabase.from('blocked_phones').delete().eq('id', id); return '✅ ' + id + ' הוסר מחסומים!' }

  // שעות ערב חג / חול המועד
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

  const holidaysMatch = text.match(/^חגים$/i)
  if (holidaysMatch) {
    const { now } = getIsraeliDateInfo()
    const todayStr = getDateString(now)
    const allHolidays = []
    for (let y = now.getFullYear(); y <= now.getFullYear() + 1; y++) {
      if (ISRAELI_HOLIDAYS[y]) allHolidays.push(...ISRAELI_HOLIDAYS[y])
    }
    const upcoming = allHolidays.filter(h => h.date >= todayStr && ['holiday','erev','chol','memorial'].includes(h.type)).slice(0, 12)
    if (upcoming.length === 0) return '📅 אין חגים קרובים'
    let msg = '📅 חגים קרובים:\n─────────────────\n'
    upcoming.forEach(h => {
      const hasHours = erevHolidayHours[h.date]
      const status = h.type === 'holiday' || h.type === 'memorial' ? '🔴 סגור'
        : hasHours === 'CLOSED' ? '🔴 סגור'
        : hasHours ? '🟡 עד ' + hasHours
        : '⚪ לא הוגדר'
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
    return '📊 סטטוס ג\'ימי:\n🚫 חסומים: ' + BLOCKED_PHONES.length + '\n👨‍👩‍👧 משפחה: ' + FAMILY_PHONES.length + '\n🗺️ LID: ' + Object.keys(lidToPhone).length + '\n✅ LIDs רגילים: ' + knownLids.length + hs
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
  if (currentQR) { toDataURL(currentQR, (err, url) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<html><head><meta charset="utf-8"></head><body style="display:flex;justify-content:center;align-items:center;height:100vh;background:#111"><div style="text-align:center"><h2 style="color:white;font-family:sans-serif">סרוק עם וואטסאפ של יאיר</h2><img src="' + url + '" style="width:300px;height:300px"/></div></body></html>') }) }
  else { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<html><head><meta charset="utf-8"></head><body style="background:#111;color:white;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh"><h2>הבוט מחובר!</h2></body></html>') }
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

// ========== System Prompt — סופר אנושי ==========
function buildSystemPrompt() {
  const { today, tomorrow, currentTime, now } = getIsraeliDateInfo()
  const todayDateStr = getDateString(now)
  const tomorrowDate = new Date(now); tomorrowDate.setDate(tomorrowDate.getDate() + 1)
  const tomorrowDateStr = getDateString(tomorrowDate)

  // בניית הקשר חגים דינמי
  let holidayContext = ''
  for (let i = 0; i <= 6; i++) {
    const d = new Date(now); d.setDate(d.getDate() + i)
    const ds = getDateString(d)
    const h = getHolidayInfo(ds)
    if (!h) continue
    const days = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת']
    const dayLabel = i === 0 ? 'היום' : i === 1 ? 'מחר' : 'יום ' + days[d.getDay()] + ' (' + ds + ')'

    if (h.type === 'holiday' || h.type === 'memorial') {
      holidayContext += '\n🔴 ' + dayLabel + ': ' + h.name + ' — סגור! אל תקבע תורים!'
    } else if (h.type === 'erev' || h.type === 'chol') {
      const hours = erevHolidayHours[ds]
      if (hours === 'CLOSED') holidayContext += '\n🔴 ' + dayLabel + ': ' + h.name + ' — סגור!'
      else if (hours) holidayContext += '\n🟡 ' + dayLabel + ': ' + h.name + ' — עובד עד ' + hours + ' בלבד!'
      else holidayContext += '\n⚪ ' + dayLabel + ': ' + h.name + ' — לא ידוע אם עובד. תגיד שבודק עם יאיר!'
    } else if (h.type === 'chanukah') {
      holidayContext += '\n🕎 ' + dayLabel + ': ' + h.name + ' שמח! פתוח כרגיל'
    }
  }

  return `אתה ג'ימי, העוזר האישי של יאיר — ספר מקצועי בלוד.

🎯 עיקרון מנחה: אתה מקצועי, אדיב, וטבעי. אתה מדבר כמו בן אדם אמיתי — לא רובוט, אבל גם לא חבר מהרחוב. תחשוב על עוזר אישי מנוסה שמבין מה הלקוח צריך ומטפל בזה ברגישות וביעילות.

סגנון דיבור:
- קצר, ענייני, עם חום אנושי
- "בסדר גמור", "אחלה", "מעולה", "בשמחה"
- כשצריך לסרב — תהיה אמפתי: "לצערי השעה הזו תפוסה, אבל יש מקום ב..."
- תבין הקשר — גם כשמישהו כותב בקיצור, עם שגיאות כתיב, סלנג, או לא מדויק — תבין את הכוונה ותגיב בהתאם
- אל תחזור על מידע שכבר נאמר
- אל תכתוב הודעות ארוכות שלא לצורך

מה לא לעשות:
- לא "אני שמח לעזור!" / "בוודאי!" — נשמע רובוטי
- לא "אחי" / "אחותי" / "מותק" / "יא מלך" — אתה ניטרלי ומכבד
- לא "וואלה" / סלנג רחוב — מקצועי
- לא להתנהג כאילו הלקוח חבר שלך מהשכונה — תמיד בכבוד מקצועי
- לא להגיב בצורה חצופה, מזלזלת, או שיפוטית — אפילו אם הלקוח כותב משהו מוזר
- לא לשאול "מה נשמע?" או לעשות small talk — תהיה ישיר ויעיל

ברכת פתיחה (רק בהודעה ראשונה):
"היי! אני ג'ימי, העוזר של יאיר 😊
איך אפשר לעזור?"

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
4. אחרי SLOT_AVAILABLE → "מצוין! הכל מסודר 🎉\nתור אצל יאיר:\nיום: [יום]\nשעה: [שעה]\nכתובת: אלי כהן 12, לוד\nוויז: https://waze.com/ul?q=אלי+כהן+12+לוד&navigate=yes\nמחכים! 💈"
   ואז APPOINTMENT_BOOKED,יום:XXX,שעה:XXX,שם:XXX
5. אחרי SLOT_FULL → "לצערי השעה תפוסה 😅 אבל יש מקום ב: [שעות] — מה מתאים?"
6. בגדים → "בודק ומעביר ליאיר! 👌" + CLOTHES_INQUIRY
7. מחיר → "חדש או חוזר אצל יאיר?" → חדש: "70 ש\"ח 💈" → חוזר: "אין בעיה! 💪"
8. העברה ליאיר → שאל שם → שאל נושא → "העברתי ליאיר, יחזור אליך כשיתפנה!" + TRANSFER_TO_YAIR,שם:XX,נושא:XX
9. ביטול → "רגע, בודק..." + CANCEL_APPOINTMENT
10. דחייה → "רגע, בודק..." + RESCHEDULE_APPOINTMENT
11. לא להשתמש בלינקי wa.me עם לקוחות
12. שבת סגור, שישי עד 14:00

--- חגים ---
13. יום סגור → "לצערי ביום הזה סגור בגלל [חג] 🕎 מה דעתך על [יום אחר]?"
14. ערב חג / חוה"מ עם שעות → קבע רק עד השעה שצוינה
15. ערב חג / חוה"מ בלי שעות → "רגע, בודק עם יאיר לגבי שעות ב[חג] ואחזור עם תשובה!" + ASK_YAIR_HOURS
16. חגים שמחים → ברכה קצרה ומכבדת: "חג שמח! 🕎" / "פורים שמח! 🎭"
17. יום הזיכרון → רגישות ואמפתיה. בלי אימוג'ים שמחים.`
}

// ========== שאילת ג'ימי ==========
async function askJimmy(userPhone, userMessage) {
  if (!conversations[userPhone]) conversations[userPhone] = []
  const dynamicSystem = buildSystemPrompt()
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

  // ASK_YAIR_HOURS
  if (reply.includes('ASK_YAIR_HOURS')) {
    reply = reply.replace('ASK_YAIR_HOURS', '').trim()
    const { now } = getIsraeliDateInfo()
    for (let i = 0; i <= 6; i++) {
      const d = new Date(now); d.setDate(d.getDate() + i)
      const h = getHolidayInfo(getDateString(d))
      if (h && (h.type === 'erev' || h.type === 'chol') && !erevHolidayHours[h.date]) { await askYairAboutHolidayHours(h); break }
    }
  }

  // APPOINTMENT_BOOKED
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

// ========== תזכורות ==========
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

  const { state, saveCreds } = await useMultiFileAuthState('auth_info')
  const { version } = await fetchLatestBaileysVersion()
  const logger = pino({ level: 'silent' })
  const sock = makeWASocket({ version, logger, auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) }, printQRInTerminal: false, browser: ['Jimmy-Bot', 'Safari', '605.1.15'], syncFullHistory: false })
  botSocket = sock
  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('lid-mapping.update', async (mappings) => { if (Array.isArray(mappings)) for (const m of mappings) { if (m.lid && m.phoneNumber) await saveLidMapping(m.lid.replace('@lid', ''), m.phoneNumber.replace('@s.whatsapp.net', '').replace(/:.*/, '')) } })
  sock.ev.on('contacts.upsert', async (contacts) => { for (const c of contacts) { if (c.id?.includes('@lid') && c.phoneNumber) await saveLidMapping(c.id.replace('@lid', ''), c.phoneNumber.replace('@s.whatsapp.net', '').replace(/:.*/, '')); if (c.lid && c.phoneNumber) await saveLidMapping(c.lid.replace('@lid', ''), c.phoneNumber.replace('@s.whatsapp.net', '').replace(/:.*/, '')) } })

  setInterval(async () => { if (botSocket?.user) try { await botSocket.sendPresenceUpdate('available', botSocket.user.id) } catch {} }, 4 * 60 * 1000)

  let remindersInterval = null, summaryScheduled = false, holidayCheckScheduled = false

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) { currentQR = qr; console.log('QR מוכן!') }
    if (connection === 'open') {
      currentQR = null; console.log("ג'ימי מחובר! 💈")
      try { await sock.sendMessage('972547734708@s.whatsapp.net', { text: "✅ ג'ימי מחובר ופעיל! 💈" }) } catch {}
      if (!remindersInterval) remindersInterval = setInterval(sendReminders, 10 * 60 * 1000)
      if (!summaryScheduled) { setInterval(() => { const { now } = getIsraeliDateInfo(); if (now.getHours() === 8 && now.getMinutes() === 0) sendDailySummary() }, 60 * 1000); summaryScheduled = true }
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
        console.error('⚠️ Bad MAC / Session error! מוחק session ומתחבר מחדש...')
        badMacCount++
        if (badMacCount >= 3) {
          console.error('🔴 3+ Bad MAC errors — מוחק auth_info לגמרי, צריך QR חדש!')
          try { rmSync('auth_info', { recursive: true, force: true }) } catch {}
          badMacCount = 0
        }
        setTimeout(startBot, 2000)
      } else if (code === DisconnectReason.loggedOut) {
        console.log('התנתק — logged out, צריך QR חדש')
        try { rmSync('auth_info', { recursive: true, force: true }) } catch {}
        setTimeout(startBot, 5000)
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

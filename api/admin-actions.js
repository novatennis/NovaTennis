// /api/admin-actions.js
// Handles admin login + all admin data operations. The admin password is
// checked here, server-side, against process.env.ADMIN_PASSWORD — it is
// never sent to or stored in the browser's JS bundle (unlike the old
// VITE_ADMIN_PASSWORD approach, which anyone could read straight out of the
// deployed website's JS files).
//
// On successful login we issue a signed, time-limited token (HMAC-SHA256,
// stateless — no server-side session storage needed since serverless
// functions don't share memory between invocations). The browser stores
// this token in sessionStorage and sends it with every subsequent admin
// request; it's verified here every time before any data is returned.

import crypto from "crypto";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET || ADMIN_PASSWORD;
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // โทเคนหมดอายุใน 12 ชั่วโมง
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_TELEGRAM_CHAT_IDS = process.env.ADMIN_TELEGRAM_CHAT_IDS; // คั่นด้วยจุลภาค
const nameLen = (s) => Array.from(String(s ?? "")).length; // นับเป็นตัวอักษร (emoji 1 ตัว ไม่ใช่ 2)
const minutesToLabel = (mins) => `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); // กันอักขระ < > & ในชื่อทำให้ข้อความ Telegram ส่งไม่ผ่าน
async function notifyTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !ADMIN_TELEGRAM_CHAT_IDS) return;
  const chatIds = ADMIN_TELEGRAM_CHAT_IDS.split(",").map(s => s.trim()).filter(Boolean);
  await Promise.all(chatIds.map(chatId =>
    fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    }).catch(() => {})
  ));
}

function sign(expiry) {
  return crypto.createHmac("sha256", TOKEN_SECRET).update(String(expiry)).digest("hex");
}
function issueToken() {
  const expiry = Date.now() + TOKEN_TTL_MS;
  return `${expiry}.${sign(expiry)}`;
}
function verifyToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return false;
  const [expiryStr, sig] = token.split(".");
  const expiry = Number(expiryStr);
  if (!expiry || Date.now() > expiry) return false;
  const expected = sign(expiry);
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

async function sb(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const ct = res.headers.get("content-type") || "";
  const body = ct.includes("application/json") ? await res.json() : null;
  return { ok: res.ok, body };
}

// สิทธิ์แพ็คเกจที่ถูกจองค้างไว้ (การจองของลูกค้าสถานะ "รอการยืนยัน" ที่ยังไม่ถูกหัก) — 60 นาที = 1 ครั้ง, 120 นาที = 2 ครั้ง
async function getReservedCredits(packageId) {
  const { body } = await sb(`bookings?package_id=eq.${packageId}&status=eq.reviewing&select=duration_minutes`);
  return (Array.isArray(body) ? body : []).reduce((s, b) => s + Math.max(1, Math.round((b.duration_minutes || 60) / 60)), 0);
}
const todayBangkok = () => new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
// ─── อายุแพ็คเกจ: เริ่มนับจาก "วันเล่นครั้งแรก" ที่จองด้วยแพ็คเกจนั้น (ไม่ใช่วันที่ซื้อ/ยืนยัน) ──────────────────────
// ซื้อ/ยืนยัน = ยังไม่เริ่มนับ (expiry_date ว่าง) → จองด้วยแพ็คเกจครั้งแรก วันเล่นของการจองนั้นเป็นวันที่ 1 → ใช้เล่นได้ตามจำนวนวันของแพ็คเกจ
// เช่น แพ็ค 7 วัน จองเล่นครั้งแรก 2 พ.ย. ใช้เล่นได้ 2–8 พ.ย. (ถ้าต้องการนับ "7 วันนับจากวันถัดไป" เปลี่ยน COUNT_FIRST_PLAY_DAY เป็น false)
// แพ็คเกจเก่าที่เริ่มนับไปแล้ว (มี expiry_date แต่ไม่มี first_use_date) ใช้วันหมดอายุเดิม ไม่ถูกแก้ ฟังก์ชันชุดนี้ต้องเหมือนกันใน booking-actions.js และ admin-actions.js
const COUNT_FIRST_PLAY_DAY = true;
const addDaysIso = (iso, n) => { const [y, m, d] = iso.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const packageWindowEnd = (firstPlayDate, days) => addDaysIso(firstPlayDate, Math.max(1, Number(days) || 1) - (COUNT_FIRST_PLAY_DAY ? 1 : 0));
// ตรวจวันเล่นกับอายุแพ็คเกจ (ไม่แก้ข้อมูล): คืน { error, ... } หรือ { unstarted: true/false }
function checkPackageWindow(pkg, bookingDate) {
  const exp = pkg.expiry_date ? String(pkg.expiry_date).slice(0, 10) : null;
  if (!exp) return { unstarted: true };
  if (exp < todayBangkok()) return { error: "package_expired", expiry_date: exp };
  const start = pkg.first_use_date ? String(pkg.first_use_date).slice(0, 10) : null;
  if (start && bookingDate < start) return { error: "package_date_before_start", start_date: start, expiry_date: exp };
  if (bookingDate > exp) return { error: "package_date_out_of_range", expiry_date: exp };
  return { unstarted: false };
}
// เริ่มนับอายุแพ็คเกจ (ถ้ายังไม่เริ่ม) แบบ atomic — ถ้ามีคนเริ่มนับตัดหน้าพร้อมกัน จะอ่านช่วงใหม่แล้วตรวจวันเล่นของเรากับช่วงนั้น
async function startPackageIfNeeded(pkg, bookingDate) {
  if (pkg.expiry_date) return { ok: true, started: false };
  const end = packageWindowEnd(bookingDate, pkg.expiry_days);
  const upd = await sb(`packages?id=eq.${pkg.id}&expiry_date=is.null`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ first_use_date: bookingDate, expiry_date: end }) });
  if (!upd.ok) return /first_use_date/.test(JSON.stringify(upd.body || "")) ? { error: "package_columns_missing" } : { error: "package_busy" }; // ยังไม่ได้รัน add-package-first-use-date.sql
  if (Array.isArray(upd.body) && upd.body.length > 0) return { ok: true, started: true, expiry_date: end };
  const { body } = await sb(`packages?id=eq.${pkg.id}&select=*`);
  const fresh = Array.isArray(body) ? body[0] : null;
  if (!fresh) return { error: "package_not_active" };
  const chk = checkPackageWindow(fresh, bookingDate);
  if (chk.error) return chk;
  return chk.unstarted ? { error: "package_busy" } : { ok: true, started: false };
}
// ถ้าแพ็คเกจนี้ไม่เหลือการจองที่ใช้งานอยู่เลย (ยกเลิกหมด/บันทึกไม่สำเร็จ) → ถอยกลับเป็น "ยังไม่เริ่มนับ" ไม่ให้เสียวันฟรี (ไม่แตะแพ็คเกจเก่าที่ไม่มี first_use_date)
async function releasePackageStartIfUnused(packageId) {
  const { body } = await sb(`bookings?package_id=eq.${packageId}&status=neq.cancelled&select=id&limit=1`);
  if (Array.isArray(body) && body.length === 0) await sb(`packages?id=eq.${packageId}&first_use_date=not.is.null`, { method: "PATCH", body: JSON.stringify({ first_use_date: null, expiry_date: null }) });
}

// คืนสิทธิ์ใช้โค้ด 1 ครั้ง (ยกเลิกรายการที่ยังไม่ได้ยืนยัน = ยังไม่เคยได้ใช้ส่วนลดจริง)
async function releaseDiscountByCode(code) {
  if (!code) return;
  const { body } = await sb(`discount_codes?code=eq.${encodeURIComponent(code)}&select=id,used_count`);
  const d = (body || [])[0];
  if (d && d.used_count > 0) await sb(`discount_codes?id=eq.${d.id}`, { method: "PATCH", body: JSON.stringify({ used_count: d.used_count - 1 }) });
}

// บันทึกการจองผ่านฟังก์ชัน SQL ที่ล็อกต่อสนาม/วัน → เช็คว่าง → บันทึกในธุรกรรมเดียว (กันจองซ้อนเมื่อกดพร้อมกัน)
// ถ้ายังไม่ได้รัน SQL หรือฟังก์ชันผิดพลาดแบบอื่น → ถอยกลับไปใช้วิธีเดิม (บันทึกตรงๆ หลังเช็คว่างไว้แล้ว)
async function insertBookingsAtomic(rows) {
  const r = await sb(`rpc/create_bookings_if_free`, { method: "POST", body: JSON.stringify({ rows }) });
  if (r.ok && Array.isArray(r.body) && r.body.length === rows.length) return { rows: r.body };
  const msg = String(r.body?.message || "");
  if (msg.includes("slot_taken")) return { error: "slot_taken", court: Number(msg.split(":")[1]) || null };
  if (r.body?.code !== "PGRST202") console.error("create_bookings_if_free failed — fallback to plain insert:", r.body);
  const ins = await sb(`bookings`, { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(rows) });
  if (!ins.ok || !Array.isArray(ins.body) || ins.body.length !== rows.length) return { error: "insert_failed", detail: ins.body };
  return { rows: ins.body };
}

// ─── ขายแพ็คเกจสนาม/คอร์สโค้ชให้ลูกค้า (แอดมินบันทึกการรับเงินโอนแทนลูกค้า) ─────────────────
// ราคา/อายุต้องตรงกับ api/booking-actions.js (PACKAGE_PRICES, COACH_PRICES) — มีเทสต์เทียบสองไฟล์ไว้ กันราคาไม่ตรงกันเมื่อมีใครแก้ไฟล์เดียว
const PACKAGE_PRICES = {
  offpeak: { 2: { price: 950, days: 7 }, 5: { price: 2350, days: 60 }, 10: { price: 4600, days: 90 } },
  peak:    { 2: { price: 1150, days: 7 }, 5: { price: 2750, days: 60 }, 10: { price: 5000, days: 90 } },
};
const COACH_PRICES = {
  adult: { private: { people: 1, 1: 1190, 5: 5750, 10: 11000 }, duo: { people: 2, 1: 750, 5: 3500, 10: 6500 } },
  kid:   { private: { people: 1, 1: 1190, 5: 5750, 10: 11000 }, duo: { people: 2, 1: 699, 5: 3295, 10: 6290 } },
};
const COACH_SESSIONS = [1, 5, 10];
function coachQuote(audience, type, sessions) {
  const row = COACH_PRICES[audience]?.[type];
  const n = Number(sessions);
  if (!row || !COACH_SESSIONS.includes(n)) return null;
  const perPerson = row[n];
  return { audience, type, sessions: n, people: row.people, perPerson, total: perPerson * row.people };
}
const packageLabel = (tier, credits) => `แพ็คเกจ ${tier === "peak" ? "Peak" : "Off Peak"} ${credits} ครั้ง`;
const SALE_COLUMN_RE = /sold_by|payment_method|admin_note|list_price/;

// สวิตช์ส่งข้อความอัตโนมัติจาก OA ไปหาลูกค้า (ตั้ง COACH_LINE_PUSH=on ที่ Vercel เพื่อเปิด — ปิดไว้เป็นค่าตั้งต้น ใช้แบบให้ลูกค้ากดทักไลน์ OA เอง)
const coachPushOn = () => process.env.COACH_LINE_PUSH === "on";
// ส่งข้อความจาก LINE OA ไปหาลูกค้า (ต้องเป็นเพื่อน OA และไม่ได้บล็อก; นับโควตาข้อความของแผน OA) — ล้มเหลวแล้วคืน false ไม่ทำให้งานหลักพัง
async function pushLine(to, text) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token || !to) return false;
  try {
    const r = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to, messages: [{ type: "text", text }] }),
    });
    if (!r.ok) { console.error("LINE push failed:", r.status, await r.text().catch(() => "")); return false; }
    return true;
  } catch (e) { console.error("LINE push error:", e?.message); return false; }
}
const coachLabel = (o) => `${o.type === "duo" ? "Private Duo (2 คน : 1 โค้ช)" : "Private (1 คน : 1 โค้ช)"} • ${o.audience === "kid" ? "เด็ก" : "ผู้ใหญ่"} • ${Number(o.sessions) === 1 ? "ครั้งเดียว" : `แพ็ค ${o.sessions} ครั้ง`}`;

async function getActiveIntervals(bookingDate, courtId) {
  const { body } = await sb(
    `bookings?booking_date=eq.${bookingDate}&court_id=eq.${courtId}&status=neq.cancelled&select=hour,start_minute,duration_minutes,status,created_time`
  );
  const now = Date.now();
  return (body || [])
    .filter((b) => (b.status === "pending" ? now - new Date(b.created_time).getTime() < 5 * 60 * 1000 : true))
    .map((b) => { const s = (b.hour || 0) * 60 + (b.start_minute || 0); return [s, s + (b.duration_minutes || 60)]; });
}

// ช่วงที่ถูกจองอยู่ของสนาม/วันนั้น "ยกเว้นแถวที่ระบุ" — ใช้ตอนเลื่อนเวลา: การจองเดิมต้องไม่นับเป็นคู่ชนกับตัวเอง (10:00–11:00 → 10:30–11:30)
// คืน null ถ้าดึงข้อมูลไม่สำเร็จ (ผู้เรียกต้องไม่ถือว่า "ว่าง")
async function getActiveIntervalsExcluding(bookingDate, courtId, excludeIds) {
  const { ok, body } = await sb(`bookings?booking_date=eq.${bookingDate}&court_id=eq.${courtId}&status=neq.cancelled&select=id,hour,start_minute,duration_minutes,status,created_time`);
  if (!ok || !Array.isArray(body)) return null;
  const now = Date.now();
  const skip = new Set((excludeIds || []).map(String));
  return body
    .filter((b) => !skip.has(String(b.id)))
    .filter((b) => (b.status === "pending" ? now - new Date(b.created_time).getTime() < 5 * 60 * 1000 : true))
    .map((b) => { const s = (b.hour || 0) * 60 + (b.start_minute || 0); return [s, s + (b.duration_minutes || 60)]; });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (!SUPABASE_URL || !SERVICE_KEY || !ADMIN_PASSWORD) {
    res.status(500).json({ error: "Server not configured" });
    return;
  }

  const { action, token, password, ...p } = req.body || {};

  if (action === "login") {
    if (String(password ?? "").trim() === String(ADMIN_PASSWORD).trim()) {
      res.status(200).json({ ok: true, token: issueToken() });
    } else {
      res.status(401).json({ ok: false });
    }
    return;
  }

  if (!verifyToken(token)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  try {
    switch (action) {
      case "queue": {
        const { body } = await sb(`bookings?status=in.(pending,reviewing)&select=*&order=booking_date.asc,hour.asc`);
        res.status(200).json({ bookings: body || [] });
        return;
      }
      case "byDate": {
        const { date } = p;
        const { body } = await sb(`bookings?booking_date=eq.${date}&select=*&order=hour.asc`);
        res.status(200).json({ bookings: body || [] });
        return;
      }
      case "listDiscounts": {
        const { body } = await sb(`discount_codes?select=*&order=created_at.desc`);
        res.status(200).json({ discounts: body || [] });
        return;
      }
      case "customers": {
        const { body } = await sb(`customers?select=*`);
        const { body: linked } = await sb(`line_users?phone=not.is.null&select=phone,display_name`);
        res.status(200).json({ customers: body || [], linked: linked || [] });
        return;
      }
      case "report": {
        const { from, to } = p;
        const { body } = await sb(`bookings?created_time=gte.${from}T00:00:00&created_time=lte.${to}T23:59:59&select=created_time,price,status&order=created_time.asc`);
        res.status(200).json({ bookings: body || [] });
        return;
      }
      case "reportDetail": {
        const { day } = p;
        const { body } = await sb(`bookings?created_time=gte.${day}T00:00:00&created_time=lte.${day}T23:59:59&select=*&order=created_time.asc`);
        res.status(200).json({ bookings: body || [] });
        return;
      }
      case "updateStatus": {
        const { id, status, refundCredit } = p;
        // อ่านสถานะ "ก่อนหน้า" ก่อนแก้ไข เพื่อตัดสินใจเรื่องสิทธิ์แพ็คเกจให้ถูกต้องตามการเปลี่ยนสถานะจริง
        const { body: beforeRows } = await sb(`bookings?id=eq.${id}&select=*`);
        const before = (beforeRows || [])[0];
        // การจองที่นัดเรียนกับโค้ชถูกสร้างเป็น "ยืนยันแล้ว" และตัดสิทธิ์ไปแล้ว → เปลี่ยนได้เฉพาะ "ยกเลิก" (กันตัด/คืนสิทธิ์ผิดพลาดจากการสลับสถานะไปมา)
        if (before?.coach_order_id && status !== "cancelled") { res.status(400).json({ error: "coach_booking_locked" }); return; }

        // การจองคู่ (2 สนามโอนทีเดียว) — เปลี่ยนสถานะทั้งกลุ่มพร้อมกัน กันแอดมินยืนยันไปแค่สนามเดียว
        if (before?.group_id) {
          await sb(`bookings?group_id=eq.${encodeURIComponent(before.group_id)}`, { method: "PATCH", body: JSON.stringify({ status }) });
        } else {
          await sb(`bookings?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ status }) });
        }

        if (status === "cancelled" && before?.discount_code && before.status !== "confirmed") {
          await releaseDiscountByCode(before.discount_code); // รายการที่ยังไม่เคยยืนยัน = ยังไม่ได้ใช้ส่วนลดจริง → คืนสิทธิ์ (ถ้ายืนยันไปแล้วไม่คืนอัตโนมัติ ใช้ปุ่ม "รีเซ็ต" ที่หน้า ส่วนลด)
        }
        // ยกเลิกการนัดเรียนกับโค้ชที่ยืนยันแล้ว + แอดมินเลือกคืนสิทธิ์ → ลดจำนวนครั้งที่ใช้ไปลง 1 (ไม่ต่ำกว่า 0 และไม่คืนซ้ำถ้ายกเลิกไปแล้ว)
        if (before?.coach_order_id && status === "cancelled" && before.status === "confirmed" && refundCredit) {
          const { body: cur } = await sb(`coach_orders?id=eq.${before.coach_order_id}&select=sessions_used`);
          const c = Array.isArray(cur) ? cur[0] : null;
          const cUnits = Math.max(1, Math.round((before.duration_minutes || 60) / 60)); // คืนเท่าที่ตัดไป: 60 นาที = 1 ครั้ง, 120 นาที = 2 ครั้ง
          if (c && (c.sessions_used || 0) > 0) await sb(`coach_orders?id=eq.${before.coach_order_id}&sessions_used=eq.${c.sessions_used}`, { method: "PATCH", body: JSON.stringify({ sessions_used: Math.max(0, c.sessions_used - cUnits) }) });
        }
        if (before?.package_id) {
          const wasConfirmed = before.status === "confirmed";
          // ยืนยันครั้งแรก (ยังไม่เคยเป็น confirmed มาก่อน) → หักสิทธิ์จริงตอนนี้
          if (status === "confirmed" && !wasConfirmed) {
            const { body: pkgRows } = await sb(`packages?id=eq.${before.package_id}&select=*`);
            const pkg = (pkgRows || [])[0];
            const units = Math.max(1, Math.round((before.duration_minutes || 60) / 60)); // 60 นาที = 1 ครั้ง, 120 นาที = 2 ครั้ง
            if (pkg && pkg.remaining_credits > 0) {
              await sb(`packages?id=eq.${before.package_id}&remaining_credits=eq.${pkg.remaining_credits}`, {
                method: "PATCH",
                body: JSON.stringify({ remaining_credits: Math.max(0, pkg.remaining_credits - units) }),
              });
            }
          }
          // ยกเลิกรายการที่ "เคยยืนยันแล้ว" (เคยหักสิทธิ์ไปจริง) + แอดมินเลือกคืนสิทธิ์ → บวกกลับ
          // (ถ้ายกเลิกจากสถานะ "รอการยืนยัน" ที่ยังไม่เคยหักสิทธิ์เลย จะไม่คืนให้ ไม่ว่า refundCredit จะเป็นอะไร กันการคืนสิทธิ์ที่ไม่เคยถูกหัก)
          if (status === "cancelled" && wasConfirmed && refundCredit) {
            const { body: pkgRows } = await sb(`packages?id=eq.${before.package_id}&select=*`);
            const pkg = (pkgRows || [])[0];
            const units = Math.max(1, Math.round((before.duration_minutes || 60) / 60));
            if (pkg && pkg.remaining_credits < pkg.total_credits) {
              await sb(`packages?id=eq.${before.package_id}`, {
                method: "PATCH",
                body: JSON.stringify({ remaining_credits: Math.min(pkg.total_credits, pkg.remaining_credits + units) }),
              });
            }
          }
        }
        if (status === "cancelled" && before?.package_id) await releasePackageStartIfUnused(before.package_id); // การจองด้วยแพ็คเกจถูกยกเลิก → ถ้าไม่เหลือการจองอื่น ถอยกลับเป็นยังไม่เริ่มนับอายุ
        res.status(200).json({ ok: true });
        return;
      }
      case "rescheduleBooking": {
        // แอดมินเลื่อน วัน/เวลาเริ่ม (และสนาม ถ้าเป็นการจองสนามเดียว) ของการจองที่มีอยู่ — ระยะเวลาเท่าเดิม ไม่คิดราคาใหม่ (ไม่ต้องยกเลิกแล้วจองใหม่)
        // ตรวจ: ว่างจริง (ไม่นับตัวเอง) / ในเวลาเปิด 06:00–23:00 / ไม่ย้อนเวลาที่ผ่านไปแล้ว / กติกาแพ็คเกจ / โค้ชไม่ซ้อนเวลา — บันทึกแล้วตรวจซ้ำ ถ้าชนจะย้อนกลับ
        const { id, newDate } = p;
        const newHour = p.hour, newStartMinute = p.startMinute || 0;
        if (!id) { res.status(400).json({ error: "missing id" }); return; }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate || "")) { res.status(400).json({ error: "invalid date" }); return; }
        if (!Number.isInteger(newHour) || newHour < 0 || newHour > 23 || ![0, 30].includes(newStartMinute)) { res.status(400).json({ error: "invalid time" }); return; }
        const { body: bRows } = await sb(`bookings?id=eq.${encodeURIComponent(id)}&select=*`);
        const bk = Array.isArray(bRows) ? bRows[0] : null;
        if (!bk) { res.status(404).json({ error: "not_found" }); return; }
        if (!["confirmed", "reviewing"].includes(bk.status)) { res.status(400).json({ error: "invalid_status" }); return; } // เลื่อนได้เฉพาะ ยืนยันแล้ว / รอตรวจสอบ
        let rows = [bk];
        if (bk.group_id) {
          const { body: g } = await sb(`bookings?group_id=eq.${encodeURIComponent(bk.group_id)}&status=in.(confirmed,reviewing)&select=*`);
          if (Array.isArray(g) && g.length > 0) rows = g; // จอง 2 สนามพร้อมกัน: ย้ายทั้งกลุ่ม
        }
        const isGroup = rows.length > 1;
        const dur = bk.duration_minutes || 60;
        const oldStart = (bk.hour || 0) * 60 + (bk.start_minute || 0);
        const targetCourts = isGroup ? rows.map((r) => r.court_id).sort() : [p.courtId ? Number(p.courtId) : bk.court_id];
        if (targetCourts.some((c) => c !== 1 && c !== 2)) { res.status(400).json({ error: "invalid_courts" }); return; }
        const newStart = newHour * 60 + newStartMinute, newEnd = newStart + dur;
        if (newStart < 6 * 60 || newEnd > 23 * 60) { res.status(400).json({ error: "outside_hours" }); return; }
        const sameCourt = isGroup || targetCourts[0] === bk.court_id;
        if (newDate === bk.booking_date && newStart === oldStart && sameCourt) { res.status(400).json({ error: "no_change" }); return; }
        const nowBkk = new Date(Date.now() + 7 * 3600e3);
        const today = nowBkk.toISOString().slice(0, 10), nowMin = nowBkk.getUTCHours() * 60 + nowBkk.getUTCMinutes();
        if (bk.booking_date < today || (bk.booking_date === today && oldStart + dur <= nowMin)) { res.status(400).json({ error: "booking_in_past" }); return; } // การจองที่จบไปแล้วไม่ให้เลื่อน
        if (newDate < today || (newDate === today && newStart < nowMin)) { res.status(400).json({ error: "new_time_past" }); return; }

        // การจองที่ใช้สิทธิ์แพ็คเกจ: ชั่วโมงใหม่ต้องตรงกับประเภทแพ็คเกจ / วันที่ใหม่ต้องอยู่ในอายุแพ็คเกจ / การจองที่เป็นตัวกำหนดวันเริ่มนับอายุ ห้ามเลื่อนข้ามวัน
        if (bk.package_id) {
          const { body: pr } = await sb(`packages?id=eq.${bk.package_id}&select=*`);
          const pkg = Array.isArray(pr) ? pr[0] : null;
          if (pkg) {
            const units = Math.max(1, Math.round(dur / 60));
            const dow = new Date(newDate + "T00:00:00").getDay();
            const weekend = dow === 0 || dow === 6;
            if (!Array.from({ length: units }, (_, i) => newHour + i).every((h) => pkg.tier === "peak" || !(weekend || h >= 16))) { res.status(400).json({ error: "package_wrong_tier" }); return; }
            if (newDate !== bk.booking_date) {
              if (pkg.first_use_date && String(pkg.first_use_date).slice(0, 10) === bk.booking_date) {
                const { body: others } = await sb(`bookings?package_id=eq.${pkg.id}&status=neq.cancelled&booking_date=eq.${bk.booking_date}&id=neq.${bk.id}&select=id&limit=1`);
                if (Array.isArray(others) && others.length === 0) { res.status(400).json({ error: "package_start_move" }); return; } // เป็นการจองแรกที่กำหนดวันเริ่มนับอายุ → ยกเลิกแล้วจองใหม่
              }
              const win = checkPackageWindow(pkg, newDate);
              if (win.error) { res.status(400).json(win); return; }
            }
          }
        }
        // การนัดเรียนกับโค้ช: โค้ชคนเดิมห้ามถูกนัดซ้อนเวลาใหม่ (ไม่นับการจองนี้เอง)
        if (bk.coach_name) {
          const norm = (s) => String(s || "").normalize("NFC").replace(/\s+/g, "").toLowerCase();
          const { body: dayRows } = await sb(`bookings?booking_date=eq.${newDate}&status=neq.cancelled&coach_name=not.is.null&select=id,coach_name,hour,start_minute,duration_minutes,court_id`);
          if (!Array.isArray(dayRows)) { res.status(500).json({ error: "availability_check_failed" }); return; }
          const clash = dayRows.find((b) => String(b.id) !== String(bk.id) && norm(b.coach_name) === norm(bk.coach_name) && (() => { const s = (b.hour || 0) * 60 + (b.start_minute || 0); return newStart < s + (b.duration_minutes || 60) && newEnd > s; })());
          if (clash) { const s = (clash.hour || 0) * 60 + (clash.start_minute || 0); res.status(409).json({ error: "coach_busy", coach: bk.coach_name, from: minutesToLabel(s), to: minutesToLabel(s + (clash.duration_minutes || 60)), court: clash.court_id }); return; }
        }
        // ช่องใหม่ต้องว่าง (การจองเดิมของตัวเองไม่นับเป็นคู่ชน)
        const excludeIds = rows.map((r) => r.id);
        for (const cid of targetCourts) {
          const taken = await getActiveIntervalsExcluding(newDate, cid, excludeIds);
          if (!taken) { res.status(500).json({ error: "availability_check_failed" }); return; }
          if (taken.some(([s, e]) => newStart < e && newEnd > s)) { res.status(409).json({ error: "slot_taken", court: cid }); return; }
        }

        const originalCourts = isGroup ? targetCourts.join("+") : String(bk.court_id);
        const movedFrom = bk.moved_from || `${bk.booking_date} ${minutesToLabel(oldStart)}|${originalCourts}`; // เก็บเวลาเดิม "ครั้งแรก" ไว้เสมอ
        const patchBase = { booking_date: newDate, hour: newHour, start_minute: newStartMinute, ...(!isGroup && targetCourts[0] !== bk.court_id ? { court_id: targetCourts[0] } : {}) };
        const target = isGroup ? `bookings?group_id=eq.${encodeURIComponent(bk.group_id)}&status=in.(confirmed,reviewing)` : `bookings?id=eq.${encodeURIComponent(id)}`;
        let hasHistory = true;
        let upd = await sb(target, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ ...patchBase, moved_from: movedFrom, moved_at: new Date(Date.now()).toISOString() }) });
        if (!upd.ok && /moved_from|moved_at/.test(JSON.stringify(upd.body || ""))) { // ยังไม่ได้รัน add-reschedule-columns.sql → เลื่อนให้ตามปกติ แค่ไม่มีป้ายประวัติ
          hasHistory = false;
          upd = await sb(target, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patchBase) });
        }
        const revert = async () => {
          for (const r of rows) await sb(`bookings?id=eq.${r.id}`, { method: "PATCH", body: JSON.stringify({ booking_date: r.booking_date, hour: r.hour, start_minute: r.start_minute || 0, court_id: r.court_id, ...(hasHistory ? { moved_from: r.moved_from ?? null, moved_at: r.moved_at ?? null } : {}) }) });
        };
        if (!upd.ok || !Array.isArray(upd.body) || upd.body.length !== rows.length) { await revert(); console.error("rescheduleBooking update failed:", upd.body); res.status(500).json({ error: "update_failed" }); return; }
        // ตรวจซ้ำหลังบันทึก: ถ้ามีคนจองชนช่องใหม่พอดีระหว่างนั้น ย้อนกลับให้
        for (const cid of targetCourts) {
          const taken = await getActiveIntervalsExcluding(newDate, cid, excludeIds);
          if (!taken || taken.some(([s, e]) => newStart < e && newEnd > s)) { await revert(); res.status(taken ? 409 : 500).json(taken ? { error: "slot_taken", court: cid } : { error: "availability_check_failed" }); return; }
        }
        const tierOf = (d, h) => { const dow = new Date(d + "T00:00:00").getDay(); return (dow === 0 || dow === 6 || h >= 16) ? "peak" : "offpeak"; };
        const priceTierChanged = !bk.package_id && !bk.coach_order_id && tierOf(bk.booking_date, bk.hour || 0) !== tierOf(newDate, newHour); // ช่วงราคาเปลี่ยน: ระบบไม่คิดส่วนต่างให้ แอดมินตัดสินใจเอง
        const courtsLabel = (cs) => cs.map((c) => `Court ${c}`).join(" + ");
        await notifyTelegram(
          `🕐 <b>แอดมินเลื่อนเวลาการจอง</b>\n\n` +
          `👤 ${esc(bk.customer_name || "-")}\n📞 ${bk.customer_id}\n` +
          `📌 เดิม: ${bk.booking_date} ${minutesToLabel(oldStart)}–${minutesToLabel(oldStart + dur)} • ${courtsLabel(isGroup ? targetCourts : [bk.court_id])}\n` +
          `✅ ใหม่: ${newDate} ${minutesToLabel(newStart)}–${minutesToLabel(newEnd)} • ${courtsLabel(targetCourts)}` +
          (bk.coach_name ? `\n👤 โค้ช: ${esc(bk.coach_name)}` : "") +
          (priceTierChanged ? `\n⚠️ ช่วงเวลาใหม่เป็นคนละช่วงราคา (${tierOf(bk.booking_date, bk.hour || 0) === "peak" ? "Peak" : "Off Peak"} → ${tierOf(newDate, newHour) === "peak" ? "Peak" : "Off Peak"}) ไม่ได้คิดส่วนต่างราคาให้` : "")
        );
        res.status(200).json({ ok: true, bookings: upd.body, priceTierChanged, from: { date: bk.booking_date, start: minutesToLabel(oldStart), courts: isGroup ? targetCourts : [bk.court_id] }, to: { date: newDate, start: minutesToLabel(newStart), end: minutesToLabel(newEnd), courts: targetCourts } });
        return;
      }
      case "sourceReport": {
        // สรุปลูกค้า/รายได้ แยกตามแหล่งที่มา (UTM) ตามวันที่ "กดจอง/กดซื้อ" ในช่วงที่เลือก (เวลาไทย)
        const { from, to } = p;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(from || "") || !/^\d{4}-\d{2}-\d{2}$/.test(to || "")) { res.status(400).json({ error: "invalid range" }); return; }
        const fromUtc = new Date(`${from}T00:00:00+07:00`).toISOString();
        const toUtc = new Date(`${to}T23:59:59.999+07:00`).toISOString();
        const bq = await sb(`bookings?created_time=gte.${fromUtc}&created_time=lte.${toUtc}&status=in.(reviewing,confirmed)&select=customer_id,price,utm,package_id`);
        const pq = await sb(`packages?created_time=gte.${fromUtc}&created_time=lte.${toUtc}&status=in.(reviewing,active)&select=customer_id,price,utm`);
        if (!bq.ok || !pq.ok) { res.status(200).json({ error: "utm_column_missing" }); return; } // ยังไม่ได้รัน add-utm-columns.sql
        const map = {};
        const keyOf = (u) => u && Object.keys(u).length ? `${u.utm_source || "-"} / ${u.utm_campaign || "-"} / ${u.utm_content || "-"}` : "(ไม่ทราบ / เข้าตรง)";
        const row = (k) => (map[k] ||= { source: k, customers: new Set(), bookings: 0, bookingRevenue: 0, packages: 0, packageRevenue: 0 });
        for (const b of (bq.body || [])) { const r = row(keyOf(b.utm)); r.customers.add(b.customer_id); r.bookings++; r.bookingRevenue += b.price || 0; }
        for (const k of (pq.body || [])) { const r = row(keyOf(k.utm)); r.customers.add(k.customer_id); r.packages++; r.packageRevenue += k.price || 0; }
        const rows = Object.values(map).map(r => ({ ...r, customers: r.customers.size })).sort((a, b) => (b.bookingRevenue + b.packageRevenue) - (a.bookingRevenue + a.packageRevenue));
        res.status(200).json({ rows });
        return;
      }
      case "lookupCustomer": {
        // ใช้ในหน้าจองแทนลูกค้า: ใส่เบอร์แล้วดึงชื่อเดิม + สถานะ (ผูก LINE แล้วไหม / เคยจองกี่ครั้ง)
        const { phone } = p;
        if (!/^[0-9]{10}$/.test(phone || "")) { res.status(400).json({ error: "invalid phone" }); return; }
        const { body: cust } = await sb(`customers?customer_id=eq.${phone}&select=customer_name`);
        const { body: line } = await sb(`line_users?phone=eq.${phone}&select=display_name,customer_name&limit=1`);
        const { body: hist } = await sb(`bookings?customer_id=eq.${phone}&status=in.(confirmed,reviewing)&select=id&limit=50`);
        // แพ็คเกจของเบอร์นี้: ที่ใช้ได้ไปอยู่ใน packages / ที่ใช้ไม่ได้อธิบายเหตุผลไว้ใน packageIssues (ไม่ปล่อยให้หน้าเว็บเงียบโดยไม่รู้สาเหตุ)
        // ครอบด้วย try/catch: ถ้าดึงแพ็คเกจไม่สำเร็จ ยังส่งชื่อ/สถานะลูกค้ากลับไปได้ตามปกติ และบอกด้วย packagesError
        const packages = [];
        const packageIssues = [];
        let packagesError = false;
        try {
          const pq = await sb(`packages?customer_id=eq.${phone}&status=neq.cancelled&select=*&order=created_time.asc`);
          if (!pq.ok || !Array.isArray(pq.body)) throw new Error("packages query failed");
          const today = todayBangkok();
          for (const x of pq.body) {
            const label = `${x.tier === "peak" ? "Peak" : "Off Peak"} เหลือ ${x.remaining_credits}/${x.total_credits}`;
            const issue = (text) => packageIssues.push({ id: x.id, label, issue: text });
            if (x.status === "pending") { issue("ยังไม่ได้ส่งสลิปชำระเงินค่าแพ็คเกจ"); continue; }
            if (x.status === "reviewing") { issue('รอแอดมินยืนยันการซื้อแพ็คเกจ (ไปที่แท็บ "🎟 แพ็คเกจ" แล้วกด ✅)'); continue; }
            if (x.status !== "active") { issue(`สถานะแพ็คเกจ: ${x.status}`); continue; }
            if (x.expiry_date && String(x.expiry_date).slice(0, 10) < today) { issue(`หมดอายุแล้ว (${String(x.expiry_date).slice(0, 10)})`); continue; }
            if (x.remaining_credits <= 0) { issue("สิทธิ์หมดแล้ว"); continue; }
            const reserved = await getReservedCredits(x.id);
            if (x.remaining_credits - reserved <= 0) { issue(`สิทธิ์ที่เหลือ ${x.remaining_credits} ครั้ง ถูกจองค้างรอยืนยันครบแล้ว (${reserved} ครั้ง) — ไปแท็บ "การจอง" เพื่อยืนยันหรือยกเลิกรายการที่ค้างอยู่`); continue; }
            packages.push({ id: x.id, tier: x.tier, total_credits: x.total_credits, remaining_credits: x.remaining_credits, expiry_date: x.expiry_date, expiry_days: x.expiry_days, first_use_date: x.first_use_date || null, reserved_credits: reserved, available: x.remaining_credits - reserved });
          }
        } catch (e) {
          console.error("lookupCustomer packages error:", e);
          packagesError = true;
        }
        // คอร์สเรียนกับโค้ชของเบอร์นี้: ที่ยืนยันรับเงินแล้วและยังเหลือสิทธิ์ → coachOrders (ใช้ตัดสิทธิ์ได้) / ที่ใช้ไม่ได้ → coachIssues พร้อมเหตุผล
        const coachOrders = [];
        const coachIssues = [];
        try {
          const cq = await sb(`coach_orders?customer_id=eq.${phone}&status=neq.cancelled&select=id,audience,type,sessions,people,sessions_used,status&order=created_time.asc`);
          if (Array.isArray(cq.body)) {
            for (const o of cq.body) {
              const used = o.sessions_used || 0;
              if (o.status !== "confirmed") coachIssues.push({ id: o.id, label: `C-${o.id} ${coachLabel(o)}`, issue: 'ยังไม่ได้ยืนยันการชำระเงิน — ไปที่แท็บ "👤 โค้ช" แล้วกด ✅ ก่อน' });
              else if (used >= o.sessions) coachIssues.push({ id: o.id, label: `C-${o.id} ${coachLabel(o)}`, issue: `ใช้สิทธิ์ครบแล้ว (${used}/${o.sessions} ครั้ง)` });
              else coachOrders.push({ id: o.id, audience: o.audience, type: o.type, sessions: o.sessions, people: o.people, sessions_used: used, remaining: o.sessions - used });
            }
          }
        } catch (e) { console.error("lookupCustomer coach orders error:", e); }
        res.status(200).json({
          name: Array.isArray(cust) ? (cust[0]?.customer_name || null) : null,
          linked: Array.isArray(line) && line.length > 0,
          lineName: Array.isArray(line) ? (line[0]?.display_name || null) : null,
          bookingsCount: Array.isArray(hist) ? hist.length : 0,
          packages,
          packageIssues,
          packagesError,
          coachOrders,
          coachIssues,
        });
        return;
      }
      case "customerHistory": {
        // ประวัติของลูกค้า 1 เบอร์: แพ็คเกจทั้งหมด (พร้อมรายการที่ใช้สิทธิ์/วันเวลาที่ใช้) + การจองทั้งหมดย้อนหลัง
        const { phone } = p;
        if (!/^[0-9]{10}$/.test(phone || "")) { res.status(400).json({ error: "invalid phone" }); return; }
        const { body: cust } = await sb(`customers?customer_id=eq.${phone}&select=customer_name`);
        const { body: line } = await sb(`line_users?phone=eq.${phone}&select=display_name&limit=1`);
        const { body: pkgs } = await sb(`packages?customer_id=eq.${phone}&select=*&order=created_time.desc`);
        const cols = "id,court_id,booking_date,hour,start_minute,duration_minutes,price,status,package_id,discount_code,discount_amount,group_id,created_time";
        let bq = await sb(`bookings?customer_id=eq.${phone}&select=${cols},booked_by&order=booking_date.desc,hour.desc&limit=300`);
        if (!bq.ok) bq = await sb(`bookings?customer_id=eq.${phone}&select=${cols}&order=booking_date.desc,hour.desc&limit=300`); // ยังไม่ได้รัน SQL คอลัมน์ booked_by
        const bookings = (bq.body || []).slice().sort((a, b) => String(b.booking_date).localeCompare(String(a.booking_date)) || (b.hour - a.hour) || ((b.start_minute || 0) - (a.start_minute || 0)));
        const unitsOf = (b) => Math.max(1, Math.round((b.duration_minutes || 60) / 60)); // 60 นาที = 1 ครั้ง, 120 นาที = 2 ครั้ง
        const packages = (pkgs || []).map((pk) => {
          const uses = bookings.filter((b) => b.package_id === pk.id).map((b) => ({ ...b, units: unitsOf(b) }));
          const usedConfirmed = uses.filter((u) => u.status === "confirmed").reduce((s, u) => s + u.units, 0); // ตัดสิทธิ์แล้วจริง
          const pendingUnits = uses.filter((u) => u.status === "reviewing").reduce((s, u) => s + u.units, 0);  // จองไว้รอยืนยัน (ยังไม่ตัด)
          const usedByCredits = pk.status === "active" || pk.status === "cancelled" ? pk.total_credits - pk.remaining_credits : null;
          return { ...pk, uses, usedConfirmed, pendingUnits, usedByCredits,
            // จำนวนที่ตัดจริงในแพ็คเกจ ไม่ตรงกับรายการจองที่ใช้สิทธิ์ (เช่นมีการแก้สิทธิ์ด้วยมือใน Supabase / มีรายการที่ยกเลิกพร้อมคืนสิทธิ์) → ให้แอดมินตรวจ
            mismatch: usedByCredits != null && usedByCredits !== usedConfirmed };
        });
        res.status(200).json({ name: (cust || [])[0]?.customer_name || null, lineName: (line || [])[0]?.display_name || null, packages, bookings });
        return;
      }
      case "createAdminBooking": {
        // แอดมินจองแทนลูกค้า (โทรมาจอง/ไม่มี LINE) — ไม่ต้องล็อกอิน LINE, ไม่มีโปรอัตโนมัติ, แอดมินกำหนดราคาต่อสนามเอง
        // ถ้าภายหลังลูกค้าล็อกอิน LINE แล้วผูกเบอร์นี้ ชื่อ LINE จะแทนชื่อที่แอดมินใส่ในข้อมูลลูกค้า (ดู lineLinkPhone)
        const { customerId, customerName, courtIds, bookingDate, hour, startMinute, durationMinutes, packageId, coachOrderId } = p;
        let { price, status } = p;
        if (!/^[0-9]{10}$/.test(customerId || "")) { res.status(400).json({ error: "invalid phone" }); return; }
        const name = String(customerName || "").trim();
        if (name.length < 1 || nameLen(name) > 40) { res.status(400).json({ error: "invalid name" }); return; }
        const ids = Array.isArray(courtIds) ? [...new Set(courtIds.map(Number))].sort() : [];
        if (ids.length < 1 || ids.length > 2 || ids.some(c => c !== 1 && c !== 2)) { res.status(400).json({ error: "invalid courts" }); return; }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(bookingDate || "")) { res.status(400).json({ error: "invalid date" }); return; }
        if (!Number.isInteger(hour) || hour < 0 || hour > 23 || ![0, 30].includes(startMinute || 0)) { res.status(400).json({ error: "invalid time" }); return; }
        if (![30, 60, 90, 120].includes(durationMinutes)) { res.status(400).json({ error: "invalid duration" }); return; }

        if (coachOrderId && packageId) { res.status(400).json({ error: "coach_with_package" }); return; } // เลือกได้อย่างเดียว: สิทธิ์แพ็คเกจสนาม หรือ สิทธิ์คอร์สโค้ช

        // ── ตัดสิทธิ์แพ็คเกจ (ถ้าเลือก): ราคา 0 / ยืนยันทันที / หักสิทธิ์ทันที (แอดมินเป็นคนยืนยันเอง) ──
        let pkg = null, units = 0;
        if (packageId) {
          if (ids.length !== 1) { res.status(400).json({ error: "package_one_court" }); return; }
          if (![60, 120].includes(durationMinutes)) { res.status(400).json({ error: "package_duration" }); return; }
          units = durationMinutes / 60; // 60 นาที = 1 ครั้ง, 120 นาที = 2 ครั้ง
          const { body: pkgRows } = await sb(`packages?id=eq.${encodeURIComponent(packageId)}&customer_id=eq.${customerId}&select=*`);
          pkg = (pkgRows || [])[0];
          if (!pkg || pkg.status !== "active") { res.status(400).json({ error: "package_not_active" }); return; }
          const win = checkPackageWindow(pkg, bookingDate); // อายุแพ็คเกจเริ่มนับจากวันเล่นครั้งแรก — วันเล่นต้องอยู่ในช่วงนั้น
          if (win.error) { res.status(400).json(win); return; }
          const reserved = await getReservedCredits(pkg.id);
          if (pkg.remaining_credits - reserved < units) { res.status(400).json({ error: "package_no_credits", available: Math.max(0, pkg.remaining_credits - reserved), needed: units }); return; }
          // ทุกชั่วโมงที่จองต้องอยู่ในช่วงที่แพ็คครอบคลุม: แพ็ค Peak ได้ทุกชั่วโมง / แพ็ค Off Peak เฉพาะ จ.–ศ. ก่อน 16:00
          const dow = new Date(bookingDate + "T00:00:00").getDay();
          const weekend = dow === 0 || dow === 6;
          const covered = Array.from({ length: units }, (_, i) => hour + i).every((h) => pkg.tier === "peak" || !(weekend || h >= 16));
          if (!covered) { res.status(400).json({ error: "package_wrong_tier" }); return; }
          price = 0; status = "confirmed";
        }
        // ── นัดเรียนกับโค้ช: 60 นาที = ตัดสิทธิ์ 1 ครั้ง / 120 นาที = ตัด 2 ครั้ง ต่อการจอง / 1 สนาม / ราคา 0 (จ่ายค่าคอร์สไปแล้ว) / ยืนยันทันที / ลงชื่อโค้ช ──
        let coachOrder = null, coachNameClean = "";
        const coachUnits = Math.max(1, Math.round((durationMinutes || 60) / 60));
        if (coachOrderId) {
          if (ids.length !== 1) { res.status(400).json({ error: "coach_one_court" }); return; }
          if (![60, 120].includes(durationMinutes)) { res.status(400).json({ error: "coach_duration" }); return; }
          coachNameClean = String(p.coachName || "").normalize("NFC").replace(/\s+/g, " ").trim();
          if (!coachNameClean || nameLen(coachNameClean) > 30) { res.status(400).json({ error: "coach_name_required" }); return; }
          const { body: coRows } = await sb(`coach_orders?id=eq.${encodeURIComponent(coachOrderId)}&customer_id=eq.${customerId}&select=*`);
          coachOrder = Array.isArray(coRows) ? coRows[0] : null;
          if (!coachOrder || coachOrder.status !== "confirmed") { res.status(400).json({ error: "coach_order_not_active" }); return; }
          const left = coachOrder.sessions - (coachOrder.sessions_used || 0);
          if (left <= 0) { res.status(400).json({ error: "coach_no_sessions" }); return; }
          if (left < coachUnits) { res.status(400).json({ error: "coach_not_enough_sessions", available: left, needed: coachUnits }); return; } // เหลือ 1 ครั้งแต่จะจอง 120 นาที (ต้องใช้ 2 ครั้ง)
          price = 0; status = "confirmed";
        }
        const unit = Number(price);
        if (!Number.isFinite(unit) || unit < 0 || unit > 20000) { res.status(400).json({ error: "invalid price" }); return; }
        if (!["confirmed", "reviewing"].includes(status)) { res.status(400).json({ error: "invalid status" }); return; }

        const startMin = hour * 60 + (startMinute || 0);
        const endMin = startMin + durationMinutes;
        for (const cid of ids) {
          const taken = await getActiveIntervals(bookingDate, cid);
          if (taken.some(([s, e]) => startMin < e && endMin > s)) { res.status(409).json({ error: "slot_taken", court: cid }); return; }
        }

        // โค้ชคนเดียวกันห้ามถูกนัดซ้อนเวลา (ทุกสนาม) — เทียบชื่อโดยไม่สนตัวพิมพ์เล็ก/ใหญ่และช่องว่างทั้งหมด ("โค้ชเอ" = "โค้ช เอ") กันโค้ชถูกนัดซ้อนเพราะพิมพ์ชื่อไม่เหมือนกัน
        const normCoach = (s) => String(s || "").normalize("NFC").replace(/\s+/g, "").toLowerCase();
        if (coachOrder) {
          const { body: dayRows } = await sb(`bookings?booking_date=eq.${bookingDate}&status=neq.cancelled&coach_name=not.is.null&select=coach_name,hour,start_minute,duration_minutes,court_id`);
          if (!Array.isArray(dayRows)) { res.status(500).json({ error: "coach_columns_missing" }); return; } // ยังไม่ได้รัน add-coach-booking-columns.sql
          const clash = dayRows.find((b) => normCoach(b.coach_name) === normCoach(coachNameClean) && (() => { const s = (b.hour || 0) * 60 + (b.start_minute || 0); return startMin < s + (b.duration_minutes || 60) && endMin > s; })());
          if (clash) {
            const s = (clash.hour || 0) * 60 + (clash.start_minute || 0);
            res.status(409).json({ error: "coach_busy", coach: coachNameClean, from: minutesToLabel(s), to: minutesToLabel(s + (clash.duration_minutes || 60)), court: clash.court_id });
            return;
          }
        }
        let coachUsedAfter = null;
        if (coachOrder) {
          let claimed = false;
          for (let attempt = 0; attempt < 3 && !claimed; attempt++) {
            const { body: cur } = await sb(`coach_orders?id=eq.${coachOrder.id}&select=sessions,sessions_used,status`);
            const c0 = Array.isArray(cur) ? cur[0] : null;
            if (!c0 || c0.status !== "confirmed") { res.status(400).json({ error: "coach_order_not_active" }); return; }
            const used = c0.sessions_used || 0;
            if (used >= c0.sessions) { res.status(400).json({ error: "coach_no_sessions" }); return; }
            if (c0.sessions - used < coachUnits) { res.status(400).json({ error: "coach_not_enough_sessions", available: c0.sessions - used, needed: coachUnits }); return; }
            const upd = await sb(`coach_orders?id=eq.${coachOrder.id}&status=eq.confirmed&sessions_used=eq.${used}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ sessions_used: used + coachUnits }) }); // เงื่อนไข sessions_used กันตัดซ้อนพร้อมกันจนเกินสิทธิ์
            if (upd.ok && Array.isArray(upd.body) && upd.body.length > 0) { claimed = true; coachUsedAfter = used + coachUnits; }
          }
          if (!claimed) { res.status(409).json({ error: "coach_order_busy" }); return; }
        }
        const restoreCoach = async () => {
          if (!coachOrder) return;
          const { body: cur } = await sb(`coach_orders?id=eq.${coachOrder.id}&select=sessions_used`);
          const c = Array.isArray(cur) ? cur[0] : null;
          if (c) await sb(`coach_orders?id=eq.${coachOrder.id}`, { method: "PATCH", body: JSON.stringify({ sessions_used: Math.max(0, (c.sessions_used || 0) - coachUnits) }) });
        };

        let remainingAfter = null;
        let pkgStart = null;
        if (pkg) {
          pkgStart = await startPackageIfNeeded(pkg, bookingDate); // เริ่มนับอายุแพ็คเกจถ้านี่คือการจองครั้งแรก (ถอยกลับให้ถ้าบันทึกไม่สำเร็จ)
          if (pkgStart.error) { res.status(pkgStart.error === "package_columns_missing" ? 500 : 400).json(pkgStart); return; }
        }
        const releaseStart = async () => { if (pkgStart?.started) await releasePackageStartIfUnused(pkg.id); };
        if (pkg) {
          let claimed = false;
          for (let attempt = 0; attempt < 3 && !claimed; attempt++) {
            const { body: cur } = await sb(`packages?id=eq.${pkg.id}&select=remaining_credits`);
            const rem = (cur || [])[0]?.remaining_credits ?? 0;
            const reserved = await getReservedCredits(pkg.id);
            if (rem - reserved < units) { await releaseStart(); res.status(400).json({ error: "package_no_credits", available: Math.max(0, rem - reserved), needed: units }); return; }
            const upd = await sb(`packages?id=eq.${pkg.id}&remaining_credits=eq.${rem}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ remaining_credits: rem - units }) });
            if (upd.ok && upd.body && upd.body.length > 0) { claimed = true; remainingAfter = rem - units; }
          }
          if (!claimed) { await releaseStart(); res.status(409).json({ error: "package_busy" }); return; }
        }
        const restoreCredits = async () => {
          if (!pkg) return;
          const { body: cur } = await sb(`packages?id=eq.${pkg.id}&select=remaining_credits,total_credits`);
          const c = (cur || [])[0];
          if (c) await sb(`packages?id=eq.${pkg.id}`, { method: "PATCH", body: JSON.stringify({ remaining_credits: Math.min(c.total_credits, c.remaining_credits + units) }) });
          await releaseStart();
        };

        // ลูกค้าใหม่ → สร้างข้อมูลลูกค้าด้วยชื่อที่แอดมินใส่ / ลูกค้าเดิม → ไม่ทับชื่อเดิม
        await sb(`customers`, { method: "POST", headers: { Prefer: "resolution=ignore-duplicates" }, body: JSON.stringify({ customer_id: customerId, customer_name: name }) });

        const groupId = ids.length > 1 ? crypto.randomUUID() : null;
        const baseRow = (cid) => ({
          court_id: cid, customer_id: customerId, customer_name: name,
          booking_date: bookingDate, hour, start_minute: startMinute || 0, duration_minutes: durationMinutes,
          price: Math.round(unit), discount_amount: 0, status, ...(groupId ? { group_id: groupId } : {}), ...(pkg ? { package_id: pkg.id } : {}),
          ...(coachOrder ? { coach_name: coachNameClean, coach_order_id: coachOrder.id } : {}),
        });
        let ins = await insertBookingsAtomic(ids.map(c => ({ ...baseRow(c), booked_by: "admin" })));
        if (coachOrder && ins.error === "insert_failed" && /coach_(name|order_id)/.test(JSON.stringify(ins.detail || ""))) {
          await restoreCoach(); res.status(500).json({ error: "coach_columns_missing" }); return; // ยังไม่ได้รัน add-coach-booking-columns.sql — คืนสิทธิ์ที่ตัดไปแล้ว
        }
        if (ins.error && ins.error !== "slot_taken") {
          // คอลัมน์ booked_by ยังไม่ถูกสร้าง (ยังไม่ได้รัน SQL) — บันทึกการจองให้ก่อน ไม่ให้งานหลักพัง
          console.error("createAdminBooking: insert with booked_by failed — run add-booked-by-column.sql");
          ins = await insertBookingsAtomic(ids.map(baseRow));
        }
        if (ins.error === "slot_taken") { await restoreCredits(); await restoreCoach(); res.status(409).json({ error: "slot_taken", court: ins.court || ids[0] }); return; } // มีคนจองตัดหน้าพอดี
        if (!ins.rows) { await restoreCredits(); await restoreCoach(); res.status(500).json({ error: "insert_failed" }); return; }
        ins = { ok: true, body: ins.rows };

        await notifyTelegram(
          `📞 <b>แอดมินจองให้ลูกค้า</b>\n\n` +
          `👤 ${esc(name)}\n📞 ${customerId}\n` +
          `🎾 ${ids.map(c => `Court ${c}`).join(" + ")}\n📅 ${bookingDate}\n` +
          `🕐 ${minutesToLabel(startMin)}–${minutesToLabel(endMin)}\n` +
          (coachOrder
            ? `👤 นัดเรียนกับโค้ช: <b>${esc(coachNameClean)}</b>\n📋 ตัดสิทธิ์คอร์ส C-${coachOrder.id} ${coachUnits > 1 ? `${coachUnits} ครั้ง (ครั้งที่ ${coachUsedAfter - coachUnits + 1}–${coachUsedAfter}/${coachOrder.sessions}, ${durationMinutes} นาที)` : `ครั้งที่ ${coachUsedAfter}/${coachOrder.sessions}`} (เหลือ ${coachOrder.sessions - coachUsedAfter} ครั้ง) — ยืนยันแล้ว`
            : pkg
              ? `🎟 ตัดสิทธิ์แพ็คเกจ ${units} ครั้ง (เหลือ ${remainingAfter} / ${pkg.total_credits} ครั้ง) — ยืนยันแล้ว${pkgStart?.started ? `\n🗓 จองครั้งแรกของแพ็คเกจนี้ → เริ่มนับอายุวันที่ ${bookingDate} ใช้เล่นได้ถึง ${pkgStart.expiry_date}` : ""}`
              : `💰 ฿${(Math.round(unit) * ids.length).toLocaleString()} (${status === "confirmed" ? "ชำระแล้ว" : "รอชำระ"})`)
        );
        res.status(200).json({ ok: true, bookings: ins.body, ...(pkg ? { creditsUsed: units, remaining: remainingAfter } : {}), ...(coachOrder ? { coach: { orderId: coachOrder.id, coachName: coachNameClean, sessions: coachOrder.sessions, sessions_used: coachUsedAfter, remaining: coachOrder.sessions - coachUsedAfter, units: coachUnits } } : {}) });
        return;
      }
      case "updateCustomerName": {
        // แก้ชื่อลูกค้า "ที่ยังไม่ผูก LINE" (เช่นแอดมินจองให้แล้วพิมพ์ชื่อผิด) — แก้ทั้งข้อมูลลูกค้า แพ็คเกจ และการจองทุกรายการของเบอร์นี้
        // ลูกค้าที่ผูก LINE แล้วใช้ชื่อ LINE ซึ่งซิงก์ทับทุกครั้งที่ล็อกอิน จึงไม่ให้แก้ตรงนี้ (กันสับสนว่าแก้แล้วชื่อเด้งกลับ)
        const { phone, name } = p;
        const clean = String(name || "").trim();
        if (!/^[0-9]{10}$/.test(phone || "") || clean.length < 1 || nameLen(clean) > 40) { res.status(400).json({ error: "invalid" }); return; }
        const { body: linked } = await sb(`line_users?phone=eq.${phone}&select=line_user_id&limit=1`);
        if (linked && linked.length > 0) { res.status(409).json({ error: "name_from_line" }); return; }
        const patch = { method: "PATCH", body: JSON.stringify({ customer_name: clean }) };
        await sb(`customers?customer_id=eq.${phone}`, patch);
        await sb(`packages?customer_id=eq.${phone}`, patch);
        await sb(`bookings?customer_id=eq.${phone}`, patch);
        res.status(200).json({ ok: true });
        return;
      }
      case "changeCustomerPhone": {
        // เปลี่ยนเบอร์ลูกค้า: ย้ายข้อมูลลูกค้า การจองทุกรายการ แพ็คเกจ และการผูก LINE ไปเบอร์ใหม่ "พร้อมกันในธุรกรรมเดียว" (ฟังก์ชัน SQL change_customer_phone)
        // ถ้ามีขั้นตอนใดล้มเหลว ฐานข้อมูลย้อนกลับทั้งหมด ไม่ค้างครึ่งๆ กลางๆ — เบอร์ใหม่ต้องยังไม่มีข้อมูลในระบบ (ยังไม่รองรับการรวมข้อมูลสองเบอร์)
        const { oldPhone, newPhone } = p;
        if (!/^[0-9]{10}$/.test(oldPhone || "") || !/^[0-9]{10}$/.test(newPhone || "")) { res.status(400).json({ error: "invalid_phone" }); return; }
        if (oldPhone === newPhone) { res.status(400).json({ error: "same_phone" }); return; }
        const r = await sb(`rpc/change_customer_phone`, { method: "POST", body: JSON.stringify({ old_phone: oldPhone, new_phone: newPhone }) });
        if (!r.ok) {
          const msg = String(r.body?.message || "");
          if (msg.includes("phone_exists")) { res.status(409).json({ error: "phone_exists" }); return; }
          if (msg.includes("invalid_phone") || msg.includes("same_phone")) { res.status(400).json({ error: msg.includes("same") ? "same_phone" : "invalid_phone" }); return; }
          if (r.body?.code === "PGRST202" || msg.includes("Could not find the function")) { res.status(500).json({ error: "rpc_missing" }); return; } // ยังไม่ได้รัน add-change-phone-function.sql
          console.error("changeCustomerPhone failed:", r.body);
          res.status(500).json({ error: "change_failed" }); return;
        }
        await notifyTelegram(`🔧 <b>แอดมินเปลี่ยนเบอร์ลูกค้า</b>\n\n📞 ${oldPhone} → ${newPhone}\n(ย้ายข้อมูลลูกค้า การจอง แพ็คเกจ และการผูก LINE ไปเบอร์ใหม่แล้ว)`);
        res.status(200).json({ ok: true });
        return;
      }
      case "coachOrders": {
        // คำสั่งซื้อคอร์สเรียนกับโค้ชทั้งหมด (ล่าสุดก่อน) — ไม่ส่ง line_user_id ออกไปหน้าเว็บ
        const { body } = await sb(`coach_orders?select=*&order=created_time.desc&limit=300`);
        res.status(200).json({ orders: (Array.isArray(body) ? body : []).map(({ line_user_id, ...r }) => r), pushEnabled: coachPushOn() });
        return;
      }
      case "confirmCoachOrder": {
        // แอดมินยืนยันว่าได้รับเงินแล้ว → ส่งข้อความเข้า LINE OA ของลูกค้าให้ด้วย (แอดมินนัดวัน-เวลาต่อในแชท)
        const { id } = p;
        if (!id) { res.status(400).json({ error: "missing id" }); return; }
        const { ok, body } = await sb(`coach_orders?id=eq.${encodeURIComponent(id)}&status=in.(pending,reviewing)`, {
          method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ status: "confirmed", confirmed_time: new Date().toISOString() }),
        });
        const row = Array.isArray(body) ? body[0] : null;
        if (!ok || !row) { res.status(409).json({ error: "update_failed" }); return; }
        const pushed = !coachPushOn() ? false : await pushLine(row.line_user_id,
          `✅ ได้รับชำระเงินแล้วค่ะ — ${coachLabel(row)} (C-${row.id})\n\n` +
          `แอดมินจะติดต่อนัดวัน-เวลาเรียนกับโค้ชในแชทนี้ค่ะ ส่งวัน-เวลาที่สะดวกมาได้เลย 🎾`);
        res.status(200).json({ ok: true, pushed, pushEnabled: coachPushOn() });
        return;
      }
      case "cancelCoachOrder": {
        const { id } = p;
        if (!id) { res.status(400).json({ error: "missing id" }); return; }
        await sb(`coach_orders?id=eq.${encodeURIComponent(id)}&status=in.(pending,reviewing,confirmed)`, { method: "PATCH", body: JSON.stringify({ status: "cancelled" }) });
        res.status(200).json({ ok: true });
        return;
      }
      case "adjustCoachSessions": {
        // ตัด/คืนจำนวนครั้งที่เรียนไปแล้ว (+1 / −1) ใช้กับคำสั่งซื้อที่ยืนยันแล้วเท่านั้น และไม่เกินจำนวนครั้งในแพ็ค
        const { id, delta } = p;
        if (!id || ![1, -1].includes(delta)) { res.status(400).json({ error: "invalid" }); return; }
        const { body } = await sb(`coach_orders?id=eq.${encodeURIComponent(id)}&status=eq.confirmed&select=id,sessions,sessions_used`);
        const row = Array.isArray(body) ? body[0] : null;
        if (!row) { res.status(409).json({ error: "not_confirmed" }); return; }
        const next = Math.min(row.sessions, Math.max(0, (row.sessions_used || 0) + delta));
        await sb(`coach_orders?id=eq.${row.id}&sessions_used=eq.${row.sessions_used || 0}`, { method: "PATCH", body: JSON.stringify({ sessions_used: next }) }); // เงื่อนไขกันกดซ้อนกัน
        res.status(200).json({ ok: true, sessions_used: next });
        return;
      }
      case "customerStats": {
        // สถิติลูกค้า: นับ "การจองที่ยืนยันแล้ว" ต่อเบอร์ (การจอง 2 สนามที่ group_id เดียวกันนับเป็น 1 ครั้ง) ตามวันที่ลูกค้าทำการจอง
        // days = 7 / 30 / 90 = ช่วงล่าสุดกี่วัน, 0 = ทั้งหมด — ใช้ทำมุมมอง ลูกค้าใหม่ / จองซ้ำ / จองเยอะสุด ในหน้าลูกค้า
        const days = [0, 7, 30, 90].includes(Number(p.days)) ? Number(p.days) : 30;
        const rows = [];
        for (let offset = 0; offset < 100000; offset += 1000) { // ดึงเป็นหน้าละ 1,000 แถว (ฐานข้อมูลจำกัดแถวต่อคำขอ)
          const pg = await sb(`bookings?status=eq.confirmed&select=id,customer_id,group_id,price,created_time&order=created_time.asc,id.asc&limit=1000&offset=${offset}`);
          if (!pg.ok || !Array.isArray(pg.body)) { res.status(500).json({ error: "stats_failed" }); return; }
          rows.push(...pg.body);
          if (pg.body.length < 1000) break;
        }
        const cutoff = days ? Date.now() - days * 86400000 : 0;
        const per = {};
        const seen = new Set();
        for (const b of rows) {
          const cid = String(b.customer_id || "");
          if (!/^[0-9]{10}$/.test(cid)) continue; // เฉพาะเบอร์ลูกค้าจริง
          const t = new Date(b.created_time).getTime();
          if (!Number.isFinite(t)) continue;
          const s = (per[cid] ||= { visits: 0, visitsInPeriod: 0, spent: 0, spentInPeriod: 0, first: t, last: t });
          const price = Number(b.price) || 0;
          s.spent += price; if (t >= cutoff) s.spentInPeriod += price;
          const key = `${cid}|${b.group_id || b.id}`;
          if (!seen.has(key)) { seen.add(key); s.visits += 1; if (t >= cutoff) s.visitsInPeriod += 1; }
          if (t < s.first) s.first = t;
          if (t > s.last) s.last = t;
        }
        const stats = {};
        for (const [cid, s] of Object.entries(per)) {
          stats[cid] = { visits: s.visits, visitsInPeriod: s.visitsInPeriod, spent: s.spent, spentInPeriod: s.spentInPeriod, firstCreated: new Date(s.first).toISOString(), lastCreated: new Date(s.last).toISOString(), isNew: days === 0 ? true : s.first >= cutoff };
        }
        const list = Object.values(per);
        const active = list.filter((s) => s.visitsInPeriod >= 1);
        const repeat = list.filter((s) => s.visitsInPeriod >= 2).length;
        res.status(200).json({
          stats,
          summary: {
            days,
            totalCustomers: list.length,
            active: active.length,                                                  // มีการจองในช่วงนี้
            newCustomers: days === 0 ? list.length : list.filter((s) => s.first >= cutoff).length, // จองครั้งแรกในช่วงนี้
            returning: days === 0 ? 0 : active.filter((s) => s.first < cutoff).length, // ลูกค้าเก่าที่กลับมาจองในช่วงนี้
            repeat,                                                                  // จอง 2 ครั้งขึ้นไปในช่วงนี้
            repeatRate: active.length ? Math.round((repeat / active.length) * 100) : 0,
            visits: list.reduce((n, s) => n + s.visitsInPeriod, 0),
            revenue: list.reduce((n, s) => n + s.spentInPeriod, 0),
          },
        });
        return;
      }
      case "sellCatalog": {
        // รายการสินค้าและราคาป้าย สำหรับหน้า "ขายให้ลูกค้า" (หน้าเว็บไม่มีตารางราคาของตัวเอง ใช้จากที่นี่ที่เดียว)
        const packages = [];
        for (const tier of ["peak", "offpeak"]) for (const credits of [2, 5, 10]) packages.push({ tier, credits, price: PACKAGE_PRICES[tier][credits].price, days: PACKAGE_PRICES[tier][credits].days });
        const coach = [];
        for (const audience of ["adult", "kid"]) for (const type of ["duo", "private"]) for (const s of COACH_SESSIONS) coach.push(coachQuote(audience, type, s));
        res.status(200).json({ packages, coach });
        return;
      }
      case "sellToCustomer": {
        // แอดมินบันทึกขายให้ลูกค้าที่โอนเงินแล้ว (ไม่ผ่านเว็บ): ใช้งานได้ทันที ไม่ต้องรอสลิป — รับเงินโอนอย่างเดียว
        // ปลอดภัย: ราคาป้ายคิดที่เซิร์ฟเวอร์ / ลดราคาหรือแจกฟรีได้แต่ต้องมีหมายเหตุ / สูงกว่าป้ายไม่ได้ / กันกดซ้ำ / แจ้ง Telegram ทุกครั้ง
        const { kind, customerId } = p;
        if (!["package", "coach"].includes(kind)) { res.status(400).json({ error: "invalid_kind" }); return; }
        if (!/^[0-9]{10}$/.test(customerId || "")) { res.status(400).json({ error: "invalid_phone" }); return; }

        let list, label, def = null, quote = null;
        if (kind === "package") {
          def = PACKAGE_PRICES[p.tier]?.[Number(p.credits)];
          if (!def) { res.status(400).json({ error: "invalid_product" }); return; }
          list = def.price; label = packageLabel(p.tier, Number(p.credits));
        } else {
          quote = coachQuote(p.audience, p.type, p.sessions);
          if (!quote) { res.status(400).json({ error: "invalid_product" }); return; }
          list = quote.total; label = `คอร์สโค้ช ${coachLabel(quote)}`;
        }
        let price = list;
        if (p.price !== undefined && p.price !== null && p.price !== "") {
          price = Number(p.price);
          if (!Number.isInteger(price) || price < 0 || price > list) { res.status(400).json({ error: "invalid_price" }); return; } // ลดได้ สูงกว่าป้ายไม่ได้
        }
        const note = String(p.note || "").normalize("NFC").replace(/\s+/g, " ").trim();
        if (nameLen(note) > 200) { res.status(400).json({ error: "note_too_long" }); return; }
        if (price !== list && nameLen(note) < 3) { res.status(400).json({ error: "note_required" }); return; } // ลดราคา/แจกฟรี ต้องมีเหตุผล

        // ชื่อลูกค้า: ผูก LINE แล้วใช้ชื่อ LINE (เหมือนที่ลูกค้าซื้อเอง) ถ้ายังไม่ผูกใช้ชื่อที่แอดมินพิมพ์
        const { body: lu } = await sb(`line_users?phone=eq.${customerId}&select=display_name,line_user_id&limit=1`);
        const linked = Array.isArray(lu) ? lu[0] : null;
        const name = Array.from(String(linked?.display_name || p.customerName || "").normalize("NFC").replace(/\s+/g, " ").trim()).slice(0, 40).join("");
        if (nameLen(name) < 1) { res.status(400).json({ error: "invalid_name" }); return; }

        // กันกดซ้ำ: สินค้าเดียวกัน เบอร์เดียวกัน ที่แอดมินขายภายใน 2 นาที
        const table = kind === "package" ? "packages" : "coach_orders";
        const since = new Date(Date.now() - 2 * 60 * 1000).toISOString();
        const { body: recent } = await sb(`${table}?customer_id=eq.${customerId}&sold_by=eq.admin&status=neq.cancelled&created_time=gte.${since}&select=*`);
        if (!Array.isArray(recent)) { res.status(500).json({ error: "sale_columns_missing" }); return; } // ยังไม่ได้รัน add-admin-sale-columns.sql
        const dup = recent.find((r) => kind === "package"
          ? r.tier === p.tier && Number(r.total_credits) === Number(p.credits)
          : r.audience === quote.audience && r.type === quote.type && Number(r.sessions) === quote.sessions);
        if (dup) { res.status(409).json({ error: "duplicate_recent", id: dup.id }); return; }

        const nowMs = Date.now();
        const base = { customer_id: customerId, customer_name: name, price, list_price: list, sold_by: "admin", payment_method: price > 0 ? "transfer" : "free", admin_note: note || null };
        const row = kind === "package"
          ? { ...base, tier: p.tier, total_credits: Number(p.credits), remaining_credits: Number(p.credits), expiry_days: def.days, status: "active", activated_at: new Date(nowMs).toISOString() }
          : { ...base, line_user_id: linked?.line_user_id || null, audience: quote.audience, type: quote.type, sessions: quote.sessions, people: quote.people, status: "confirmed", confirmed_time: new Date(nowMs).toISOString(), sessions_used: 0 };

        await sb(`customers`, { method: "POST", headers: { Prefer: "resolution=ignore-duplicates" }, body: JSON.stringify({ customer_id: customerId, customer_name: name }) });
        const ins = await sb(table, { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(row) });
        const created = Array.isArray(ins.body) ? ins.body[0] : null;
        if (!ins.ok || !created) {
          if (SALE_COLUMN_RE.test(JSON.stringify(ins.body || ""))) { res.status(500).json({ error: "sale_columns_missing" }); return; }
          console.error("sellToCustomer insert failed:", ins.body); res.status(500).json({ error: "insert_failed" }); return;
        }
        await notifyTelegram(
          `🛒 <b>แอดมินบันทึกขาย${kind === "package" ? "แพ็คเกจสนาม" : "คอร์สโค้ช"}ให้ลูกค้า</b>\n\n` +
          `📦 ${esc(label)}\n👤 ${esc(name)}\n📞 ${customerId}\n` +
          `💰 ฿${price.toLocaleString()}${price !== list ? ` (ราคาป้าย ฿${list.toLocaleString()} • ลด ฿${(list - price).toLocaleString()})` : ""} • ${price > 0 ? "รับเงินโอนแล้ว" : "แจกฟรี"}\n` +
          (note ? `📝 ${esc(note)}\n` : "") +
          `ใช้งานได้ทันที — ${kind === "package" ? `ยังไม่เริ่มนับอายุ (เริ่มนับวันเล่นครั้งแรกที่จอง • ใช้เล่นได้ ${def.days} วัน)` : `รหัสคอร์ส C-${created.id}`}`
        );
        const { line_user_id, ...pub } = created;
        res.status(200).json({ ok: true, kind, item: pub, label, price, listPrice: list });
        return;
      }
      case "unlinkLinePhone": {
        // ปลดล็อกเบอร์ที่ผูกกับบัญชี LINE (เช่นลูกค้ากรอกเบอร์ผิดตอนผูก หรือเปลี่ยนเบอร์จริง) — ลูกค้าจะได้ผูกเบอร์ใหม่ตอนจองครั้งถัดไป
        const { phone } = p;
        if (!/^[0-9]{10}$/.test(phone || "")) { res.status(400).json({ error: "invalid phone" }); return; }
        await sb(`line_users?phone=eq.${phone}`, { method: "PATCH", body: JSON.stringify({ phone: null }) });
        res.status(200).json({ ok: true });
        return;
      }
      case "packagesQueue": {
        const { body } = await sb(`packages?status=in.(pending,reviewing)&select=*&order=created_time.asc`);
        res.status(200).json({ packages: body || [] });
        return;
      }
      case "allPackages": {
        const { body } = await sb(`packages?select=*&order=created_time.desc&limit=200`);
        res.status(200).json({ packages: body || [] });
        return;
      }
      case "confirmPackage": {
        const { id } = p;
        if (!id) { res.status(400).json({ error: "missing id" }); return; }
        const nowMs = Date.now();
        const now = new Date(nowMs);
        const { body: pkgRows } = await sb(`packages?id=eq.${id}&select=*`);
        const pkg = (pkgRows || [])[0];
        if (!pkg) { res.status(404).json({ error: "not_found" }); return; }
        // ยืนยันการซื้อ = เปิดใช้งานแพ็คเกจ แต่ "ยังไม่เริ่มนับอายุ" (expiry_date ว่าง) — เริ่มนับตอนจองด้วยแพ็คเกจครั้งแรก (วันเล่นวันแรก = วันที่ 1)
        await sb(`packages?id=eq.${id}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "active", activated_at: now.toISOString() }),
        });
        res.status(200).json({ ok: true });
        return;
      }
      case "cancelPackage": {
        const { id } = p;
        if (!id) { res.status(400).json({ error: "missing id" }); return; }
        await sb(`packages?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ status: "cancelled" }) });
        res.status(200).json({ ok: true });
        return;
      }
      case "createDiscount": {
        const { code, amount, maxUses, expiresAt } = p;
        if (expiresAt && !/^\d{4}-\d{2}-\d{2}$/.test(expiresAt)) { res.status(400).json({ error: "invalid_date" }); return; }
        const row = { code: String(code).toUpperCase(), discount_amount: parseInt(amount), discount_percent: 0, max_uses: parseInt(maxUses), active: true };
        if (expiresAt) row.expires_at = expiresAt;
        const ins = await sb(`discount_codes`, { method: "POST", body: JSON.stringify(row) });
        if (!ins.ok) { res.status(500).json({ error: "insert_failed" }); return; } // เช่นยังไม่ได้รัน SQL เพิ่มคอลัมน์ expires_at
        res.status(200).json({ ok: true });
        return;
      }
      case "resetDiscountUse": {
        // รีเซ็ตจำนวนครั้งที่ใช้โค้ดกลับเป็น 0 (เช่นคืนโค้ดให้ลูกค้าหลังยกเลิกรายการที่ยืนยันไปแล้ว)
        const { id } = p;
        if (!id) { res.status(400).json({ error: "missing id" }); return; }
        await sb(`discount_codes?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ used_count: 0 }) });
        res.status(200).json({ ok: true });
        return;
      }
      case "toggleDiscount": {
        const { id, active } = p;
        await sb(`discount_codes?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ active }) });
        res.status(200).json({ ok: true });
        return;
      }
      case "listBlocks": {
        // แสดงเฉพาะรายการปิดสนามที่ยังไม่ผ่านไปแล้ว (จากวันนี้เป็นต้นไป)
        // ใช้เวลาไทย (+7) แทน UTC ตรงๆ กันวันที่คลาดเคลื่อนตอนใกล้เที่ยงคืน
        const nowBangkok = new Date(Date.now() + 7 * 60 * 60 * 1000);
        const todayIso = nowBangkok.toISOString().split("T")[0];
        const { body } = await sb(`bookings?status=eq.blocked&booking_date=gte.${todayIso}&select=*&order=booking_date.asc,hour.asc`);
        res.status(200).json({ blocks: body || [] });
        return;
      }
      case "blockCourt": {
        const { date, courtId, hour, startMinute, durationMinutes, reason } = p;
        if (!date || !courtId || hour == null || !durationMinutes) {
          res.status(400).json({ error: "missing params" }); return;
        }
        const { ok, body } = await sb(`bookings`, {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({
            court_id: courtId, customer_id: "admin_block",
            customer_name: reason ? `🚫 ปิดสนาม (${reason})` : "🚫 ปิดสนาม",
            booking_date: date, hour, start_minute: startMinute || 0, duration_minutes: durationMinutes,
            price: 0, status: "blocked",
          }),
        });
        if (!ok) {
          console.error("blockCourt insert failed:", body);
          res.status(500).json({ error: "insert_failed", detail: body });
          return;
        }
        res.status(200).json({ block: (body || [])[0] || null });
        return;
      }
      case "unblockCourt": {
        const { id } = p;
        if (!id) { res.status(400).json({ error: "missing id" }); return; }
        // ลบเฉพาะรายการที่เป็น "ปิดสนาม" จริงๆ เท่านั้น กันพลาดไปลบการจองของลูกค้า
        await sb(`bookings?id=eq.${id}&status=eq.blocked`, { method: "DELETE" });
        res.status(200).json({ ok: true });
        return;
      }
      default:
        res.status(400).json({ error: "unknown action" });
    }
  } catch (err) {
    console.error("admin-actions error:", err);
    res.status(500).json({ error: "internal error" });
  }
}

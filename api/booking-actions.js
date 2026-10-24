// /api/booking-actions.js
// All public (non-admin) reads/writes to the bookings/customers/discount_codes
// tables go through this single endpoint, using the Supabase Service Role Key
// server-side. The browser's anon key no longer has any direct table access
// at all — this closes the hole where anyone could previously query the
// entire bookings table (every customer's name/phone/price) in one request,
// and prevents a customer from tampering with price or setting their own
// booking status straight to "confirmed".

import crypto from "crypto";

// ─── LINE Login (ช่วยกรอกชื่อ/เบอร์อัตโนมัติ) ───────────────────────────────────────
// Channel ID/secret อ่านจาก Environment Variables ของ Vercel เท่านั้น (ห้ามฝังในโค้ด)
const LINE_LOGIN_CHANNEL_ID = process.env.LINE_LOGIN_CHANNEL_ID;
const LINE_LOGIN_CHANNEL_SECRET = process.env.LINE_LOGIN_CHANNEL_SECRET;
const LINE_REDIRECT_URI = "https://nova-tennis.vercel.app/line-callback"; // ต้องตรงกับ Callback URL ที่ตั้งใน LINE Developers เป๊ะ
const LINE_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // session อยู่ได้ 30 วัน

// session token = userId.expiry.signature (HMAC) — ไม่ต้องเก็บ session ฝั่งเซิร์ฟเวอร์
function signLineSession(userId) {
  const payload = `${userId}.${Date.now() + LINE_SESSION_TTL_MS}`;
  const sig = crypto.createHmac("sha256", LINE_LOGIN_CHANNEL_SECRET).update(payload).digest("hex");
  return `${payload}.${sig}`;
}
function verifyLineSession(token) {
  if (!token || typeof token !== "string" || !LINE_LOGIN_CHANNEL_SECRET) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userId, expiryStr, sig] = parts;
  const expiry = Number(expiryStr);
  if (!userId || !expiry || Date.now() > expiry) return null;
  const expected = crypto.createHmac("sha256", LINE_LOGIN_CHANNEL_SECRET).update(`${userId}.${expiryStr}`).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) ? userId : null;
  } catch { return null; }
}

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_TELEGRAM_CHAT_IDS = process.env.ADMIN_TELEGRAM_CHAT_IDS; // comma-separated

async function notifyTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !ADMIN_TELEGRAM_CHAT_IDS) return;
  const chatIds = ADMIN_TELEGRAM_CHAT_IDS.split(",").map(s => s.trim()).filter(Boolean);
  await Promise.all(chatIds.map(chatId =>
    fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    }).catch(() => {})
  ));
}
const minutesToLabel = (mins) => `${String(Math.floor(mins/60)).padStart(2,"0")}:${String(mins%60).padStart(2,"0")}`;

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
  return { ok: res.ok, status: res.status, body };
}

// ─── ราคา (ต้องตรงกับฝั่ง frontend เป๊ะ — เซิร์ฟเวอร์เป็นคนตัดสินราคาสุดท้ายเสมอ) ──
const RATE_TABLE = {
  promo:  { offpeak: { 30: 300, 60: 450 }, peak: { 30: 325, 60: 490 } },
  normal: { offpeak: { 30: 350, 60: 490 }, peak: { 30: 375, 60: 590 } },
};
const PROMO_START = new Date(2026, 8, 1, 0, 0, 0);
const PROMO_END = new Date(2026, 8, 30, 23, 59, 59);

// ─── ราคาแพ็คเกจสมาชิก (ตายตัว เซิร์ฟเวอร์เป็นคนตัดสินเสมอ ไม่เชื่อราคาจาก client) ──
const PACKAGE_PRICES = {
  offpeak: { 2: { price: 950, days: 7 }, 5: { price: 2350, days: 60 }, 10: { price: 4600, days: 90 } },
  peak:    { 2: { price: 1150, days: 7 }, 5: { price: 2750, days: 60 }, 10: { price: 5000, days: 90 } },
};

function getDurationPrice(startHour, dateObj, durationMinutes) {
  const inPromo = dateObj >= PROMO_START && dateObj <= PROMO_END;
  const day = dateObj.getDay();
  const isWeekend = day === 0 || day === 6;
  const isPeak = isWeekend || startHour >= 16;
  const tier = inPromo ? RATE_TABLE.promo : RATE_TABLE.normal;
  const rate = isPeak ? tier.peak : tier.offpeak;
  const numHours = Math.floor(durationMinutes / 60);
  const rem = durationMinutes % 60;
  return numHours * rate[60] + (rem === 30 ? rate[30] : 0);
}

// โปรโมชั่นจองครั้งแรก (ต่อชั่วโมง) — จันทร์-ศุกร์ ฿450 / เสาร์-อาทิตย์ ฿490 ไม่ว่าช่วง Off Peak/Peak
// นับตาม "วันที่เล่น" (booking_date) ใช้ได้ถึงวันที่เล่น 31 ต.ค. 2569 (รวมวันนั้น) — ต้องแก้ให้ตรงกับ FIRST_TIME_PROMO ใน nova-tennis.jsx ด้วยถ้าเปลี่ยน
// การจอง/ซื้อแพ็คเกจต้องมาจากบัญชี LINE ที่ผูกเบอร์แล้วเท่านั้น — เซิร์ฟเวอร์ใช้ "เบอร์ที่ผูกไว้" เสมอ ไม่เชื่อเบอร์ที่ส่งมาจากหน้าเว็บ
// ผลคือลูกค้าเปลี่ยนเบอร์เองไม่ได้ (ล็อกจริงที่เซิร์ฟเวอร์ ไม่ใช่แค่ซ่อนช่องในหน้าจอ)
// ชื่อที่ใช้ในการจอง = ชื่อ LINE (ตัดไม่เกิน 16 ตัวอักษรตามกติกาเดิม โดยไม่ตัดกลาง emoji)
const NAME_MAX = 20; // ข้อกำหนดชื่อ LINE: ไม่เกิน 20 ตัวอักษร
// นับเป็น "ตัวอักษรที่ตามองเห็น" (ไม่ใช่จำนวนรหัสตัวอักษร) — ชื่อไทยที่มีสระ/วรรณยุกต์ หรือ emoji จึงไม่ถูกตัดผิดตำแหน่ง/ผิดจำนวน
const graphemes = (s) => {
  const str = String(s ?? "");
  try { return Array.from(new Intl.Segmenter("th", { granularity: "grapheme" }).segment(str), (x) => x.segment); }
  catch { return Array.from(str); }
};
const toBookingName = (s) => graphemes(String(s || "").trim()).slice(0, NAME_MAX).join("").trim();
// ชื่อจาก LINE อาจมีอักขระ < > & ซึ่งทำให้ข้อความ Telegram (โหมด HTML) ส่งไม่ผ่าน — escape ก่อนใส่ในข้อความ
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ─── โค้ดส่วนลด: วันหมดอายุ / ล็อกการใช้ / คืนโค้ด ───
const todayBangkok = () => new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
// หมดอายุ = วันที่ปัจจุบัน (เวลาไทย) เลยวันที่ในคอลัมน์ expires_at ไปแล้ว — ใช้ได้ถึงสิ้นวันที่ระบุ / ไม่ใส่ = ไม่หมดอายุ
const isDiscountExpired = (d) => !!d.expires_at && String(d.expires_at).slice(0, 10) < todayBangkok();

// ล็อกการใช้โค้ด "ก่อน" สร้างการจอง ด้วยการอัปเดตแบบมีเงื่อนไข (used_count ต้องยังเท่าค่าที่เพิ่งอ่าน)
// ถ้ามีคนใช้ตัดหน้าไปพร้อมกัน เงื่อนไขจะไม่ตรง → อ่านใหม่แล้วตรวจอีกรอบ จึงไม่มีทางที่โค้ดใช้ได้ครั้งเดียวถูกใช้ซ้ำสองครั้ง
async function claimDiscount(discountId, basePrice) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { body } = await sb(`discount_codes?id=eq.${encodeURIComponent(discountId)}&select=*`);
    const d = (body || [])[0];
    if (!d || !d.active) return { error: "invalid" };
    if (isDiscountExpired(d)) return { error: "expired" };
    if (d.used_count >= d.max_uses) return { error: "used" };
    const { ok, body: upd } = await sb(`discount_codes?id=eq.${d.id}&used_count=eq.${d.used_count}`, {
      method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ used_count: d.used_count + 1 }),
    });
    if (ok && upd && upd.length > 0) {
      const amount = d.discount_amount > 0 ? d.discount_amount : Math.round(basePrice * d.discount_percent / 100);
      return { row: upd[0], amount };
    }
  }
  return { error: "used" };
}
// คืนสิทธิ์การใช้โค้ด 1 ครั้ง (ใช้ตอนสร้างการจองไม่สำเร็จ หรือยกเลิกรายการที่ยังไม่ได้ชำระ/ยังไม่ได้ยืนยัน)
async function releaseDiscountById(id) {
  const { body } = await sb(`discount_codes?id=eq.${encodeURIComponent(id)}&select=id,used_count`);
  const d = (body || [])[0];
  if (d && d.used_count > 0) await sb(`discount_codes?id=eq.${d.id}`, { method: "PATCH", body: JSON.stringify({ used_count: d.used_count - 1 }) });
}
async function releaseDiscountByCode(code) {
  if (!code) return;
  const { body } = await sb(`discount_codes?code=eq.${encodeURIComponent(code)}&select=id`);
  if ((body || [])[0]) await releaseDiscountById(body[0].id);
}

// สิทธิ์แพ็คเกจที่ถูกจองค้างไว้ (การจองสถานะ "รอการยืนยัน" ที่ยังไม่ถูกหัก) — 60 นาที = 1 ครั้ง, 120 นาที = 2 ครั้ง
async function getReservedCredits(packageId) {
  const { body } = await sb(`bookings?package_id=eq.${packageId}&status=eq.reviewing&select=duration_minutes`);
  return (Array.isArray(body) ? body : []).reduce((s, b) => s + Math.max(1, Math.round((b.duration_minutes || 60) / 60)), 0);
}

// ล็อกอิน LINE อยู่หรือไม่ (ผูกเบอร์แล้วหรือยังก็ได้) — ใช้กับคำสั่งที่ต้องรู้ว่า "เป็นลูกค้าที่ล็อกอิน" แต่ยังไม่ต้องเป็นเจ้าของรายการ
async function getSessionUser(sessionToken) {
  const userId = verifyLineSession(sessionToken);
  if (!userId) return { error: "line_required" };
  const { body } = await sb(`line_users?line_user_id=eq.${encodeURIComponent(userId)}&select=phone`);
  const row = Array.isArray(body) ? body[0] : null;
  if (!row) return { error: "line_required" };
  return { userId, phone: row.phone || null };
}

// ลิงก์สลิปต้องเป็นไฟล์ที่อัปโหลดเข้า bucket ของเราเองและตั้งชื่อตามรายการนี้เท่านั้น (กันแนบลิงก์ภายนอก/ใช้สลิปของรายการอื่น)
// รูปแบบที่หน้าเว็บสร้าง: <SUPABASE_URL>/storage/v1/object/public/slips/slips/<key>_<timestamp>.<นามสกุลรูปภาพ>
function isOwnSlipUrl(url, key) {
  const prefix = `${SUPABASE_URL}/storage/v1/object/public/slips/slips/${key}_`;
  const u = String(url || "");
  return u.startsWith(prefix) && /^\d{10,16}\.(jpe?g|png|webp|heic|heif|gif)$/i.test(u.slice(prefix.length));
}

// แจ้งเตือน Telegram จากเซิร์ฟเวอร์เอง โดยดึงข้อมูลจากฐานข้อมูล (เดิมหน้าเว็บเป็นคนส่งข้อมูลมาให้ ซึ่งใครก็ยิงข้อความปลอมเข้า Telegram แอดมินได้)
async function notifySlipBooking(row) {
  try {
    let all = [row];
    if (row.group_id) {
      const { body } = await sb(`bookings?group_id=eq.${encodeURIComponent(row.group_id)}&select=*&order=court_id.asc`);
      if (Array.isArray(body) && body.length) all = body;
    }
    const startMin = (row.hour || 0) * 60 + (row.start_minute || 0);
    const dur = row.duration_minutes || 60;
    const sentAt = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().substr(11, 5);
    await notifyTelegram(
      `🔔 <b>มีลูกค้าส่งสลิปใหม่</b>\n\n` +
      `🎾 สนาม: ${all.map((r) => `Court ${r.court_id}`).join(" + ")}\n` +
      `📅 วันที่: ${row.booking_date}\n` +
      `🕐 เวลา: ${minutesToLabel(startMin)}–${minutesToLabel(startMin + dur)}\n` +
      `💰 ยอด: ฿${all.reduce((s, r) => s + (r.price || 0), 0).toLocaleString()}\n` +
      `👤 ชื่อ: ${esc(row.customer_name || "-")}\n` +
      `📞 เบอร์: ${row.customer_id}\n` +
      `🕓 ส่งสลิปเมื่อเวลา: ${sentAt} น. (ไทย)\n\n` +
      `สถานะ: รอการตรวจสอบ\nกรุณาเข้าไปตรวจสอบและยืนยันที่หน้า Admin Dashboard`
    );
  } catch (e) { console.error("notifySlipBooking failed:", e); }
}
async function notifySlipPackage(row) {
  try {
    const sentAt = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().substr(11, 5);
    await notifyTelegram(
      `🔔 <b>มีลูกค้าส่งสลิปซื้อแพ็คเกจ</b>\n\n` +
      `🎟 แพ็คเกจ ${row.tier === "peak" ? "Peak" : "Off Peak"} × ${row.total_credits} ครั้ง\n` +
      `💰 ยอด: ฿${(row.price || 0).toLocaleString()}\n` +
      `👤 ชื่อ: ${esc(row.customer_name || "-")}\n` +
      `📞 เบอร์: ${row.customer_id}\n` +
      `🕓 ส่งสลิปเมื่อเวลา: ${sentAt} น. (ไทย)\n\n` +
      `สถานะ: รอการตรวจสอบ\nกรุณาเข้าไปตรวจสอบและยืนยันที่แท็บ "🎟 แพ็คเกจ" ใน Admin Dashboard`
    );
  } catch (e) { console.error("notifySlipPackage failed:", e); }
}

// บันทึกการจองผ่านฟังก์ชัน SQL ที่ "ล็อกต่อสนาม/วัน → เช็คว่าง → บันทึก" ในธุรกรรมเดียว กัน 2 คนกดจองช่วงเดียวกันพร้อมกันแล้วผ่านทั้งคู่
// ถ้ายังไม่ได้รัน SQL (ไม่มีฟังก์ชัน) หรือฟังก์ชันผิดพลาดแบบอื่น → ถอยกลับไปใช้วิธีเดิม (เช็คไว้แล้วก่อนหน้า แล้วบันทึกตรงๆ) การจองจึงไม่หยุดทำงาน
async function insertBookingsAtomic(rows) {
  const r = await sb(`rpc/create_bookings_if_free`, { method: "POST", body: JSON.stringify({ rows }) });
  if (r.ok && Array.isArray(r.body) && r.body.length === rows.length) return { rows: r.body };
  const msg = String(r.body?.message || "");
  if (msg.includes("slot_taken")) return { error: "slot_taken", court: Number(msg.split(":")[1]) || null };
  if (r.body?.code !== "PGRST202") console.error("create_bookings_if_free failed — fallback to plain insert:", r.body);
  const ins = await sb(`bookings`, { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(rows) });
  if (!ins.ok || !Array.isArray(ins.body) || ins.body.length !== rows.length) return { error: "insert_failed" };
  return { rows: ins.body };
}

// ─── เรียนกับโค้ช (สนาม+โค้ช) ─────────────────────────────────────────────────────────
// ซื้อคอร์สแล้วแอดมินนัดวัน-เวลากับลูกค้าทาง LINE OA เอง ไม่มีการเลือกวัน/เวลา/โค้ชในระบบ — ราคาที่นี่เป็นตัวตัดสินเสมอ หน้าเว็บดึงไปแสดง
// ราคาตามป้ายของร้านเป็น "ต่อคน" (Duo = 2 คน : 1 โค้ช) ระบบคิดยอดรวมเป็น ต่อคน × จำนวนคน — ถ้าร้านต้องการขาย Duo ต่อคน ให้เปลี่ยน people ของ duo เป็น 1
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
  return { audience, type, sessions: n, people: row.people, perPerson, perSessionPerPerson: Math.round(perPerson / n), total: perPerson * row.people };
}
const coachLabel = (o) => `${o.type === "duo" ? "Private Duo (2 คน : 1 โค้ช)" : "Private (1 คน : 1 โค้ช)"} • ${o.audience === "kid" ? "เด็ก" : "ผู้ใหญ่"} • ${Number(o.sessions) === 1 ? "ครั้งเดียว" : `แพ็ค ${o.sessions} ครั้ง`}`;
const publicCoachOrder = (r) => ({ id: r.id, customer_name: r.customer_name, customer_id: r.customer_id, audience: r.audience, type: r.type, sessions: r.sessions, people: r.people, price: r.price, learner_note: r.learner_note, status: r.status, sessions_used: r.sessions_used || 0, line_pushed: !!r.line_pushed, created_time: r.created_time });

// ส่งข้อความจาก LINE OA ไปหาลูกค้า (ต้องเป็นเพื่อน OA และยังไม่ได้บล็อก; นับโควตาข้อความของแผน OA) — ล้มเหลวแล้วไม่ทำให้การสั่งซื้อพัง คืน false ให้หน้าเว็บโชว์ปุ่มสำรอง
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
const coachCreatedText = (o) =>
  `🎓 NOVA Tennis — รับคำขอเรียนกับโค้ชแล้วค่ะ\n\n` +
  `คอร์ส: ${coachLabel(o)}\n` +
  `ยอดชำระ: ฿${Number(o.price).toLocaleString()}${o.people > 1 ? ` (฿${(o.price / o.people).toLocaleString()} × ${o.people} คน)` : ""}\n` +
  `รหัสคำสั่งซื้อ: C-${o.id}\n\n` +
  `👉 ชำระเงินและส่งสลิปในหน้าเว็บให้เรียบร้อย แล้วแอดมินจะนัดวัน-เวลาเรียนกับโค้ชในแชทนี้ค่ะ\n` +
  `ตอบกลับแชทนี้ได้เลย เช่น วัน-เวลาที่สะดวกเรียนค่ะ 🙏`;

async function getLinkedCustomer(sessionToken) {
  const userId = verifyLineSession(sessionToken);
  if (!userId) return { error: "line_required" };
  const { body } = await sb(`line_users?line_user_id=eq.${encodeURIComponent(userId)}&select=*`);
  const row = (body || [])[0];
  if (!row) return { error: "line_required" };
  if (!row.phone) return { error: "phone_not_linked" };
  // ชื่อในการจองมาจาก LINE เสมอ (ไม่เชื่อชื่อที่ส่งมาจากหน้าเว็บ) — ชื่อ LINE ล่าสุดที่บันทึกตอนล็อกอิน
  return { userId, phone: row.phone, name: toBookingName(row.display_name) || toBookingName(row.customer_name) || "ลูกค้า LINE" };
}

const FIRST_TIME_PROMO = { weekday: 450, weekend: 490, lastPlayDate: "2026-10-31" };
function getFirstTimePrice(bookingDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(bookingDate || "")) return null;
  if (bookingDate > FIRST_TIME_PROMO.lastPlayDate) return null; // เลยช่วงโปรโมชั่นแล้ว
  const day = new Date(bookingDate + "T00:00:00").getDay();
  return (day === 0 || day === 6) ? FIRST_TIME_PROMO.weekend : FIRST_TIME_PROMO.weekday;
}

// "เคยจองแล้ว" นับเฉพาะ: ยืนยันแล้ว / ส่งสลิปแล้ว (รอตรวจ) / รอชำระที่ยังไม่เกิน 5 นาที (กันเปิดจองซ้อนหลายรายการพร้อมกันแล้วได้โปรทุกรายการ)
// รายการที่กดจองแล้วทิ้งไว้จนหมดเวลา หรือถูกยกเลิก ไม่นับ — ลูกค้าจะไม่เสียสิทธิ์โปรไปโดยไม่เคยได้ใช้จริง
async function isFirstTimeCustomer(customerId) {
  const freshCutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { ok, body } = await sb(
    `bookings?customer_id=eq.${customerId}&or=(status.in.(confirmed,reviewing),and(status.eq.pending,created_time.gte.${freshCutoff}))&select=id&limit=1`
  );
  if (!ok) { console.error("isFirstTimeCustomer query failed"); return false; } // เช็คไม่ได้ → ไม่ให้โปร (ปลอดภัยฝั่งร้านไว้ก่อน)
  return !(body && body.length > 0);
}

async function getActiveIntervals(bookingDate, courtId) {
  const { body } = await sb(
    `bookings?booking_date=eq.${bookingDate}&court_id=eq.${courtId}&status=neq.cancelled&select=hour,start_minute,duration_minutes,status,created_time`
  );
  const now = Date.now();
  return (body || [])
    .filter((b) => {
      if (b.status === "pending") {
        const created = new Date(b.created_time).getTime();
        return now - created < 5 * 60 * 1000; // รอชำระเกิน 5 นาที ไม่นับว่าบล็อกอีกต่อไป
      }
      return true;
    })
    .map((b) => {
      const s = (b.hour || 0) * 60 + (b.start_minute || 0);
      const dur = b.duration_minutes || 60;
      return [s, s + dur];
    });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (!SUPABASE_URL || !SERVICE_KEY) {
    res.status(500).json({ error: "Server not configured" });
    return;
  }

  const { action, ...p } = req.body || {};

  try {
    switch (action) {
      case "coachCatalog": {
        // ราคาคอร์สเรียนกับโค้ชทั้งหมด (ข้อมูลสาธารณะ ไม่มีข้อมูลลูกค้า) — หน้าเว็บดึงจากที่นี่ จึงแก้ราคาที่เดียว
        const items = [];
        for (const audience of ["adult", "kid"]) for (const type of ["duo", "private"]) for (const s of COACH_SESSIONS) items.push(coachQuote(audience, type, s));
        res.status(200).json({ items });
        return;
      }

      case "createCoachOrder": {
        const who = await getLinkedCustomer(p.session);
        if (who.error) { res.status(403).json({ error: who.error }); return; }
        const q = coachQuote(p.audience, p.type, p.sessions);
        if (!q) { res.status(400).json({ error: "invalid_product" }); return; }
        const note = Array.from(String(p.learnerNote || "").trim()).slice(0, 120).join("");

        // กันซ้ำ/กันยิงรัว: คำสั่งซื้อเดิมที่ยังรอชำระของคอร์สเดียวกัน (ภายใน 1 ชม.) ใช้ใบเดิมต่อ ไม่สร้างใหม่/ไม่ส่งข้อความซ้ำ — และไม่เกิน 6 ใบต่อชั่วโมง
        const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const { body: recent } = await sb(`coach_orders?customer_id=eq.${who.phone}&created_time=gte.${since}&select=*`);
        const recentRows = Array.isArray(recent) ? recent : [];
        const same = recentRows.find((r) => r.status === "pending" && r.audience === q.audience && r.type === q.type && Number(r.sessions) === q.sessions);
        if (same) { res.status(200).json({ order: publicCoachOrder(same), linePushed: !!same.line_pushed, reused: true }); return; }
        if (recentRows.length >= 6) { res.status(429).json({ error: "too_many_orders" }); return; }

        const ins = await sb(`coach_orders`, {
          method: "POST", headers: { Prefer: "return=representation" },
          body: JSON.stringify({
            customer_id: who.phone, customer_name: who.name, line_user_id: who.userId,
            audience: q.audience, type: q.type, sessions: q.sessions, people: q.people, price: q.total,
            learner_note: note || null, status: "pending",
          }),
        });
        const order = Array.isArray(ins.body) ? ins.body[0] : null;
        if (!ins.ok || !order) { console.error("createCoachOrder insert failed:", ins.body); res.status(500).json({ error: "insert_failed" }); return; }

        // ส่งข้อความเข้า LINE OA ของลูกค้าทันที (ให้เกิดห้องแชทใน OA และแอดมินรู้ว่าลูกค้าคือใคร ทักกลับได้ แม้ลูกค้ายังไม่จ่ายเงิน)
        const pushed = await pushLine(who.userId, coachCreatedText(order));
        if (pushed) await sb(`coach_orders?id=eq.${order.id}`, { method: "PATCH", body: JSON.stringify({ line_pushed: true }) });
        await notifyTelegram(
          `🎓 <b>มีคำขอเรียนกับโค้ชใหม่ (ยังไม่ชำระ)</b>\n\n` +
          `👤 ${esc(who.name)} (LINE)\n📞 ${who.phone}\n` +
          `📚 ${esc(coachLabel(order))}\n💰 ฿${Number(order.price).toLocaleString()}\n` +
          (note ? `📝 ผู้เรียน: ${esc(note)}\n` : "") +
          `💬 ส่งข้อความเข้า LINE OA ของลูกค้า: ${pushed ? "สำเร็จ ✅" : "ไม่สำเร็จ ❌ (ลูกค้าอาจบล็อก OA / โควตาหมด / ยังไม่ได้ตั้งค่า token) — กรุณาติดต่อลูกค้าเอง"}`
        );
        res.status(200).json({ order: publicCoachOrder({ ...order, line_pushed: pushed }), linePushed: pushed });
        return;
      }

      case "updateCoachSlip": {
        const { orderId, slipUrl } = p;
        if (!orderId || !slipUrl) { res.status(400).json({ error: "missing params" }); return; }
        const who = await getLinkedCustomer(p.session);
        if (who.error) { res.status(403).json({ error: who.error }); return; }
        if (!isOwnSlipUrl(slipUrl, `coach_${orderId}`)) { res.status(400).json({ error: "invalid_slip_url" }); return; }
        const { ok, body } = await sb(`coach_orders?id=eq.${encodeURIComponent(orderId)}&customer_id=eq.${who.phone}&status=in.(pending,reviewing)`, {
          method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ slip_url: slipUrl, status: "reviewing" }),
        });
        const row = Array.isArray(body) ? body[0] : null;
        if (!ok || !row) { res.status(409).json({ error: "update_failed" }); return; }
        const sentAt = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().substr(11, 5);
        await notifyTelegram(
          `🔔 <b>มีลูกค้าส่งสลิปคอร์สเรียนกับโค้ช</b>\n\n` +
          `📚 ${esc(coachLabel(row))}\n💰 ฿${Number(row.price).toLocaleString()}\n` +
          `👤 ${esc(row.customer_name || "-")}\n📞 ${row.customer_id}\n` +
          (row.learner_note ? `📝 ผู้เรียน: ${esc(row.learner_note)}\n` : "") +
          `🕓 ส่งสลิปเมื่อเวลา: ${sentAt} น. (ไทย)\n\nกรุณาตรวจสอบและกดยืนยันที่แท็บ "🎓 โค้ช" ใน Admin Dashboard แล้วนัดวัน-เวลากับลูกค้าทาง LINE OA`
        );
        res.status(200).json({ order: publicCoachOrder(row) });
        return;
      }

      case "cancelCoachOrder": {
        // ลูกค้ายกเลิกได้เฉพาะคำสั่งซื้อที่ "ยังไม่ชำระ" ของตัวเอง
        const { orderId } = p;
        if (!orderId) { res.status(400).json({ error: "missing orderId" }); return; }
        const who = await getLinkedCustomer(p.session);
        if (who.error) { res.status(403).json({ error: who.error }); return; }
        const { ok, body } = await sb(`coach_orders?id=eq.${encodeURIComponent(orderId)}&customer_id=eq.${who.phone}&status=eq.pending`, {
          method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ status: "cancelled" }),
        });
        const row = Array.isArray(body) ? body[0] : null;
        if (ok && row) await notifyTelegram(`❌ <b>ลูกค้ายกเลิกคำสั่งซื้อคอร์สโค้ช (ยังไม่ชำระ)</b>\n\n📚 ${esc(coachLabel(row))}\n👤 ${esc(row.customer_name || "-")}\n📞 ${row.customer_id}`);
        res.status(200).json({ ok: !!(ok && row) });
        return;
      }

      case "myCoachOrders": {
        const who = await getLinkedCustomer(p.session);
        if (who.error === "phone_not_linked") { res.status(200).json({ orders: [] }); return; }
        if (who.error) { res.status(403).json({ error: who.error }); return; }
        const { body } = await sb(`coach_orders?customer_id=eq.${who.phone}&status=neq.cancelled&select=*&order=created_time.desc&limit=30`);
        res.status(200).json({ orders: (Array.isArray(body) ? body : []).map(publicCoachOrder) });
        return;
      }

      case "checkAvailability": {
        const { date, courtId } = p;
        if (!date || !courtId) { res.status(400).json({ error: "missing params" }); return; }
        const { body } = await sb(
          `bookings?booking_date=eq.${date}&court_id=eq.${courtId}&status=neq.cancelled&select=hour,start_minute,duration_minutes,status,created_time`
        );
        res.status(200).json({ bookings: body || [] });
        return;
      }

      case "getBooking": {
        const { id } = p;
        if (!id) { res.status(400).json({ error: "missing id" }); return; }
        const who = await getLinkedCustomer(p.session); // ดูได้เฉพาะการจองของตัวเอง (บัญชี LINE ที่ผูกเบอร์นั้น)
        if (who.error) { res.status(403).json({ error: who.error }); return; }
        const { body } = await sb(`bookings?id=eq.${encodeURIComponent(id)}&customer_id=eq.${who.phone}&select=*`);
        const booking = (Array.isArray(body) ? body[0] : null) || null;
        let group = null;
        if (booking?.group_id) {
          const { body: gRows } = await sb(`bookings?group_id=eq.${encodeURIComponent(booking.group_id)}&select=*&order=court_id.asc`);
          group = gRows || null;
        }
        res.status(200).json({ booking, group });
        return;
      }

      case "myBookings": {
        const { phone } = p;
        if (!/^[0-9]{10}$/.test(phone || "")) { res.status(400).json({ error: "invalid phone" }); return; }
        const me = await getSessionUser(p.session);
        if (me.error) { res.status(403).json({ error: me.error }); return; }
        if (!me.phone) { res.status(200).json({ bookings: [] }); return; } // ยังไม่ผูกเบอร์ = ยังไม่มีการจองของตัวเอง
        if (me.phone !== phone) { res.status(403).json({ error: "not_owner" }); return; } // ดูได้เฉพาะเบอร์ที่ผูกกับบัญชี LINE ของตัวเอง
        const { body } = await sb(`bookings?customer_id=eq.${phone}&select=*&order=booking_date.desc`);
        res.status(200).json({ bookings: body || [] });
        return;
      }

      case "checkDiscount": {
        const me = await getSessionUser(p.session);
        if (me.error) { res.status(403).json({ error: me.error }); return; }
        const { code } = p;
        if (!code) { res.status(200).json({ valid: false }); return; }
        const { body } = await sb(`discount_codes?code=eq.${encodeURIComponent(String(code).trim().toUpperCase())}&select=*`);
        const d = (body || [])[0];
        if (!d || !d.active) { res.status(200).json({ valid: false, reason: "invalid" }); return; }
        if (isDiscountExpired(d)) { res.status(200).json({ valid: false, reason: "expired", expires_at: d.expires_at }); return; }
        if (d.used_count >= d.max_uses) { res.status(200).json({ valid: false, reason: "used" }); return; }
        res.status(200).json({
          valid: true, id: d.id, code: d.code,
          discount_amount: d.discount_amount, discount_percent: d.discount_percent, expires_at: d.expires_at || null,
        });
        return;
      }

      case "createBooking": {
        const { courtId, bookingDate, hour, startMinute, durationMinutes, discountCodeId, packageId } = p;
        const who = await getLinkedCustomer(p.session);
        if (who.error) { res.status(403).json({ error: who.error }); return; }
        const customerId = who.phone; // เบอร์ที่ผูกกับบัญชี LINE เท่านั้น
        const customerName = who.name; // ชื่อจากบัญชี LINE เท่านั้น
        if (!courtId || !customerName || !bookingDate || hour == null || !durationMinutes) {
          res.status(400).json({ error: "missing params" }); return;
        }
        if (!/^[0-9]{10}$/.test(customerId)) { res.status(400).json({ error: "invalid phone" }); return; }
        if (String(customerName).trim().length < 1) {
          res.status(400).json({ error: "invalid name" }); return;
        }

        const startMin = hour * 60 + (startMinute || 0);
        const endMin = startMin + durationMinutes;

        // เช็คชนกับรายการที่ยัง active จริงอีกครั้งฝั่งเซิร์ฟเวอร์ (กัน race condition / กันแก้ไขจาก client)
        const activeIntervals = await getActiveIntervals(bookingDate, courtId);
        const overlap = activeIntervals.some(([s, e]) => startMin < e && endMin > s);
        if (overlap) { res.status(409).json({ error: "slot_taken" }); return; }

        const dateObj = new Date(bookingDate + "T00:00:00");
        const day = dateObj.getDay();
        const isWeekend = day === 0 || day === 6;
        const isPeak = isWeekend || hour >= 16;

        // ─── จองด้วยสิทธิ์แพ็คเกจ ──────────────────────────────────────────────────
        // ไม่ตัดสิทธิ์ทันที — สร้างเป็นสถานะ "รอการยืนยัน" ก่อน แจ้งเตือนแอดมินทันที
        // สิทธิ์จะถูกหักจริงก็ต่อเมื่อแอดมินกดยืนยัน (ป้องกันลูกค้ากดจองมั่ว/พลาด แล้วเสียสิทธิ์ฟรี)
        if (packageId) {
          // จองด้วยแพ็คเกจได้ 60 นาที (ตัด 1 ครั้ง) หรือ 120 นาที (ตัด 2 ครั้ง) เท่านั้น
          if (![60, 120].includes(durationMinutes)) { res.status(400).json({ error: "package_duration" }); return; }
          const units = durationMinutes / 60;
          const { body: pkgRows } = await sb(`packages?id=eq.${packageId}&customer_id=eq.${customerId}&select=*`);
          const pkg = (pkgRows || [])[0];
          if (!pkg || pkg.status !== "active") { res.status(400).json({ error: "package_not_active" }); return; }
          if (pkg.expiry_date && new Date(pkg.expiry_date + "T23:59:59") < new Date()) { res.status(400).json({ error: "package_expired" }); return; }
          // สิทธิ์ที่ใช้ได้จริง = คงเหลือ − สิทธิ์ที่จองค้างรอแอดมินยืนยันอยู่ (ยังไม่ถูกหัก) กันส่งหลายออเดอร์ซ้อนจนเล่นเกินสิทธิ์
          const reserved = await getReservedCredits(packageId);
          if (pkg.remaining_credits - reserved < units) { res.status(400).json({ error: "package_no_credits", available: Math.max(0, pkg.remaining_credits - reserved), needed: units }); return; }
          // แต่ละชั่วโมงที่จองต้องอยู่ในช่วงที่แพ็คครอบคลุม: แพ็ค Peak ใช้ได้ทุกชั่วโมง / แพ็ค Off Peak ใช้ได้เฉพาะชั่วโมงที่เป็น Off Peak (จ.–ศ. ก่อน 16:00)
          // เช่น แพ็ค Off Peak จอง 15:00–17:00 ไม่ได้ เพราะชั่วโมงหลังเป็น Peak
          const hourIsPeak = (h) => isWeekend || h >= 16;
          const allHoursOk = Array.from({ length: units }, (_, i) => hour + i).every((h) => pkg.tier === "peak" || !hourIsPeak(h));
          if (!allHoursOk) { res.status(400).json({ error: "package_wrong_tier" }); return; }

          await sb(`customers`, {
            method: "POST",
            headers: { Prefer: "resolution=ignore-duplicates" },
            body: JSON.stringify({ customer_id: customerId, customer_name: customerName }),
          });

          const pins = await insertBookingsAtomic([{
            court_id: courtId, customer_id: customerId, customer_name: customerName,
            booking_date: bookingDate, hour, start_minute: startMinute || 0, duration_minutes: durationMinutes,
            price: 0, package_id: packageId, status: "reviewing", // รอแอดมินกดยืนยันก่อนถึงจะหักสิทธิ์จริง
          }]);
          if (pins.error === "slot_taken") { res.status(409).json({ error: "slot_taken" }); return; }
          const bookingRow = (pins.rows || [])[0];
          if (!bookingRow) { res.status(500).json({ error: "insert_failed" }); return; }

          const nowBangkok = new Date(Date.now() + 7 * 60 * 60 * 1000);
          const timeStr = nowBangkok.toISOString().substr(11, 5);
          const text =
            `🎟 <b>มีการจองด้วยสิทธิ์แพ็คเกจ</b>\n` +
            `รอการยืนยันจากแอดมิน (จะหักสิทธิ์ก็ต่อเมื่อกดยืนยันแล้วเท่านั้น)\n\n` +
            `👤 ${esc(customerName)}\n` +
            `📞 ${customerId}\n` +
            `🎾 Court ${courtId}\n` +
            `📅 ${bookingDate}\n` +
            `🕐 ${minutesToLabel(startMin)}–${minutesToLabel(endMin)}\n` +
            `🎫 จองครั้งนี้ใช้ ${units} ครั้ง • สิทธิ์เหลือก่อนจอง: ${pkg.remaining_credits} / ${pkg.total_credits} ครั้ง\n` +
            `🕓 กดจองเมื่อเวลา ${timeStr} น. (ไทย)`;
          await notifyTelegram(text);

          res.status(200).json({ booking: bookingRow });
          return;
        }

        // ─── จองจ่ายเงินสดตามปกติ ────────────────────────────────────────────────
        let basePrice = getDurationPrice(hour, dateObj, durationMinutes);

        // โปรโมชั่นจองครั้งแรก — เฉพาะจอง 60 นาที และยังไม่เคยมีการจอง (ที่ไม่ถูกยกเลิก) มาก่อนเลยในระบบ
        // เช็คที่เซิร์ฟเวอร์เสมอ ไม่เชื่อ flag จาก client — ถ้าราคาปกติถูกกว่าอยู่แล้วก็ใช้ราคาปกติ (ลูกค้าได้ราคาที่ถูกที่สุดเสมอ)
        let isFirstTimePromo = false;
        const promoPrice = durationMinutes === 60 ? getFirstTimePrice(bookingDate) : null;
        if (promoPrice != null && basePrice > promoPrice) {
          const firstTime = await isFirstTimeCustomer(customerId);
          if (firstTime) { basePrice = promoPrice; isFirstTimePromo = true; }
        }

        let discountAmount = 0;
        let discountRow = null;
        if (discountCodeId && !isFirstTimePromo) { // โปรจองครั้งแรกไม่ร่วมกับโค้ดส่วนลด (โค้ดที่ส่งมาจะไม่ถูกใช้/ไม่ถูกตัดสิทธิ์)
          const claim = await claimDiscount(discountCodeId, basePrice);
          if (claim.error) { res.status(400).json({ error: "discount_invalid", reason: claim.error }); return; } // โค้ดหมดอายุ/ถูกใช้แล้ว/ใช้ไม่ได้ — ไม่แอบคิดราคาเต็มโดยลูกค้าไม่รู้
          discountAmount = claim.amount;
          discountRow = claim.row;
        }
        const finalPrice = Math.max(0, basePrice - discountAmount);
        // โค้ดครอบคลุมทั้งยอด (เหลือ 0 บาท) = ไม่มีอะไรให้โอน/แนบสลิป → ส่งเป็น "รอแอดมินยืนยัน" ตรงๆ เหมือนการจองด้วยแพ็คเกจ
        const isFree = finalPrice === 0 && !!discountRow;

        await sb(`customers`, {
          method: "POST",
          headers: { Prefer: "resolution=ignore-duplicates" },
          body: JSON.stringify({ customer_id: customerId, customer_name: customerName }),
        });

        const cins = await insertBookingsAtomic([{
          court_id: courtId, customer_id: customerId, customer_name: customerName,
          booking_date: bookingDate, hour, start_minute: startMinute || 0, duration_minutes: durationMinutes,
          price: finalPrice, discount_code: discountRow?.code || null, discount_amount: discountAmount,
          status: isFree ? "reviewing" : "pending",
        }]);
        const bookingRow = (cins.rows || [])[0];
        if (!bookingRow) {
          if (discountRow) await releaseDiscountById(discountRow.id); // สร้างการจองไม่สำเร็จ (หรือมีคนจองตัดหน้าพอดี) → คืนสิทธิ์โค้ด
          if (cins.error === "slot_taken") { res.status(409).json({ error: "slot_taken" }); return; }
          res.status(500).json({ error: "insert_failed" }); return;
        }

        if (isFree) {
          await notifyTelegram(
            `🎁 <b>มีการจองด้วยโค้ดส่วนลดเต็มจำนวน</b>\n` +
            `ไม่มียอดที่ต้องโอน — รอแอดมินยืนยัน\n\n` +
            `👤 ${esc(customerName)}\n📞 ${customerId}\n🎾 Court ${courtId}\n📅 ${bookingDate}\n` +
            `🕐 ${minutesToLabel(startMin)}–${minutesToLabel(endMin)}\n🏷 โค้ด ${esc(discountRow.code)} (฿${discountAmount})`
          );
        }
        res.status(200).json({ booking: bookingRow, isFirstTimePromo, free: isFree });
        return;
      }

      case "createBookingMulti": {
        // จอง 2 สนามช่วงเวลาเดียวกันในครั้งเดียว — สร้าง 2 แถวพร้อมกัน (all-or-nothing) ใช้ group_id เดียวกัน โอนทีเดียว
        // ข้อจำกัดโดยตั้งใจ: ราคาปกติเท่านั้น (ไม่ร่วมกับแพ็คเกจ/โค้ดส่วนลด/โปรจองครั้งแรก) เพื่อให้ยอดรวมชัดเจน ไม่สับสน
        const { courtIds, bookingDate, hour, startMinute, durationMinutes } = p;
        const who = await getLinkedCustomer(p.session);
        if (who.error) { res.status(403).json({ error: who.error }); return; }
        const customerId = who.phone;
        const customerName = who.name;
        const ids = Array.isArray(courtIds) ? [...new Set(courtIds.map(Number))].sort() : [];
        if (ids.length !== 2 || ids[0] !== 1 || ids[1] !== 2) { res.status(400).json({ error: "invalid courts" }); return; }
        if (!customerName || !bookingDate || hour == null || ![30, 60, 90, 120].includes(durationMinutes)) {
          res.status(400).json({ error: "missing params" }); return;
        }
        if (!/^[0-9]{10}$/.test(customerId)) { res.status(400).json({ error: "invalid phone" }); return; }
        if (String(customerName).trim().length < 1) { res.status(400).json({ error: "invalid name" }); return; }

        const startMin = hour * 60 + (startMinute || 0);
        const endMin = startMin + durationMinutes;
        for (const cid of ids) {
          const activeIntervals = await getActiveIntervals(bookingDate, cid);
          if (activeIntervals.some(([s, e]) => startMin < e && endMin > s)) { res.status(409).json({ error: "slot_taken" }); return; }
        }

        const dateObj = new Date(bookingDate + "T00:00:00");
        const unitPrice = getDurationPrice(hour, dateObj, durationMinutes);
        const groupId = crypto.randomUUID();

        await sb(`customers`, {
          method: "POST",
          headers: { Prefer: "resolution=ignore-duplicates" },
          body: JSON.stringify({ customer_id: customerId, customer_name: customerName }),
        });

        const rowsToInsert = ids.map(cid => ({
          court_id: cid, customer_id: customerId, customer_name: customerName,
          booking_date: bookingDate, hour, start_minute: startMinute || 0, duration_minutes: durationMinutes,
          price: unitPrice, discount_amount: 0, status: "pending", group_id: groupId,
        }));
        const mins = await insertBookingsAtomic(rowsToInsert);
        if (mins.error === "slot_taken") { res.status(409).json({ error: "slot_taken" }); return; }
        if (!mins.rows) { console.error("createBookingMulti insert failed"); res.status(500).json({ error: "insert_failed" }); return; }
        res.status(200).json({ bookings: mins.rows, groupId });
        return;
      }

      case "updateSlip": {
        const { bookingId, slipUrl } = p;
        if (!bookingId || !slipUrl) { res.status(400).json({ error: "missing params" }); return; }
        const who = await getLinkedCustomer(p.session);
        if (who.error) { res.status(403).json({ error: who.error }); return; }
        if (!isOwnSlipUrl(slipUrl, bookingId)) { res.status(400).json({ error: "invalid_slip_url" }); return; }

        // สลิปที่ส่ง "ช้า": รายการรอชำระที่หมดเวลา 5 นาทีไปแล้ว ช่วงเวลานั้นถูกปล่อยให้คนอื่นจองได้ จึงอาจมีคนจองต่อไปแล้ว
        // → รับสลิปได้ก็ต่อเมื่อช่วงเวลายังว่างอยู่จริง ถ้าไม่ว่าง: ไม่รับเป็นการจอง (กันจองซ้อน) แต่ลูกค้าอาจโอนเงินไปแล้ว
        //   จึงเก็บสลิปไว้ที่รายการ + แจ้ง Telegram แอดมินพร้อมลิงก์สลิป ให้ติดต่อคืนเงินหรือจัดเวลาใหม่ (ไม่ปล่อยให้เงียบ)
        const { body: curRows } = await sb(`bookings?id=eq.${encodeURIComponent(bookingId)}&customer_id=eq.${who.phone}&select=*`);
        const cur = Array.isArray(curRows) ? curRows[0] : null;
        if (cur && cur.status === "pending" && Date.now() - new Date(cur.created_time).getTime() >= 5 * 60 * 1000) {
          let mineRows = [cur];
          if (cur.group_id) {
            const { body: g } = await sb(`bookings?group_id=eq.${encodeURIComponent(cur.group_id)}&select=*&order=court_id.asc`);
            if (Array.isArray(g) && g.length) mineRows = g;
          }
          let clash = false;
          for (const r of mineRows) {
            const s0 = (r.hour || 0) * 60 + (r.start_minute || 0);
            const e0 = s0 + (r.duration_minutes || 60);
            const taken = await getActiveIntervals(r.booking_date, r.court_id); // รายการของเราเองหมดเวลาแล้วจึงไม่ถูกนับรวม
            if (taken.some(([a, b]) => s0 < b && e0 > a)) { clash = true; break; }
          }
          if (clash) {
            await sb(cur.group_id ? `bookings?group_id=eq.${encodeURIComponent(cur.group_id)}&status=eq.pending` : `bookings?id=eq.${encodeURIComponent(bookingId)}&status=eq.pending`, {
              method: "PATCH", body: JSON.stringify({ status: "cancelled", slip_url: slipUrl }),
            });
            if (cur.discount_code) await releaseDiscountByCode(cur.discount_code);
            const s1 = (cur.hour || 0) * 60 + (cur.start_minute || 0);
            await notifyTelegram(
              `⚠️ <b>ลูกค้าส่งสลิปช้า แต่ช่วงเวลานี้ถูกจองไปแล้ว</b>\n` +
              `ไม่ได้รับเป็นการจอง (ยกเลิกรายการแล้ว) — ลูกค้าอาจโอนเงินมาแล้ว กรุณาติดต่อเพื่อคืนเงินหรือจัดเวลาใหม่\n\n` +
              `👤 ${esc(cur.customer_name || "-")}\n📞 ${cur.customer_id}\n` +
              `🎾 ${mineRows.map((r) => `Court ${r.court_id}`).join(" + ")}\n📅 ${cur.booking_date}\n` +
              `🕐 ${minutesToLabel(s1)}–${minutesToLabel(s1 + (cur.duration_minutes || 60))}\n` +
              `💰 ฿${mineRows.reduce((t, r) => t + (r.price || 0), 0).toLocaleString()}\n` +
              `🧾 สลิป: ${esc(slipUrl)}`
            );
            res.status(409).json({ error: "slot_taken_late" });
            return;
          }
        }

        // เงื่อนไข: ต้องเป็นการจองของเบอร์ที่ผูกกับบัญชีนี้ + status=in.(pending,reviewing) (แก้ได้เฉพาะรายการที่ยังไม่ถูกยืนยัน/ยกเลิก)
        // (เผื่อกรณีลูกค้ากดส่งสลิปซ้ำ หรือกลับมาแนบสลิปใหม่หลัง resume session — ไม่ให้ค้างเหมือนก่อนหน้านี้)
        const { ok, body } = await sb(`bookings?id=eq.${encodeURIComponent(bookingId)}&customer_id=eq.${who.phone}&status=in.(pending,reviewing)`, {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({ slip_url: slipUrl, status: "reviewing" }),
        });
        const row = (body || [])[0] || null;
        if (!ok || !row) {
          console.error("updateSlip failed or matched no row:", bookingId, body);
          res.status(409).json({ error: "update_failed", detail: body });
          return;
        }
        // การจองคู่ (2 สนามพร้อมกัน) โอนทีเดียว — ใส่สลิปเดียวกันให้อีกแถวในกลุ่มด้วย
        if (row.group_id) {
          await sb(`bookings?group_id=eq.${encodeURIComponent(row.group_id)}&id=neq.${bookingId}&status=in.(pending,reviewing)`, {
            method: "PATCH",
            body: JSON.stringify({ slip_url: slipUrl, status: "reviewing" }),
          });
        }
        await notifySlipBooking(row);
        res.status(200).json({ booking: row });
        return;
      }

      case "cancelPending": {
        // ลูกค้ากดยกเลิกเองจากหน้าชำระเงิน (เช่นกดหมดเวลาแล้วไม่รอ) — ปล่อยช่วงเวลาคืนทันที + แจ้งเตือนแอดมิน
        const { bookingId } = p;
        if (!bookingId) { res.status(400).json({ error: "missing bookingId" }); return; }
        const who = await getLinkedCustomer(p.session);
        if (who.error) { res.status(403).json({ error: who.error }); return; }
        // ยกเลิกได้เฉพาะการจองของตัวเอง (เงื่อนไข customer_id) — ของคนอื่นจะไม่ตรงเงื่อนไข ไม่เกิดอะไรขึ้น
        const { ok, body } = await sb(`bookings?id=eq.${encodeURIComponent(bookingId)}&customer_id=eq.${who.phone}&status=in.(pending,reviewing)`, {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({ status: "cancelled" }),
        });
        const row = (body || [])[0] || null;
        if (ok && row) {
          if (row.discount_code) await releaseDiscountByCode(row.discount_code); // ยกเลิกรายการที่ยังไม่ได้ชำระ/ยังไม่ยืนยัน → คืนสิทธิ์ใช้โค้ด
          let courtLabel = `Court ${row.court_id}`;
          let totalPrice = row.price || 0;
          if (row.group_id) {
            const { body: others } = await sb(`bookings?group_id=eq.${encodeURIComponent(row.group_id)}&id=neq.${bookingId}&status=in.(pending,reviewing)`, {
              method: "PATCH",
              headers: { Prefer: "return=representation" },
              body: JSON.stringify({ status: "cancelled" }),
            });
            const ids = [row, ...(others || [])].map(r => r.court_id).sort();
            courtLabel = ids.map(c => `Court ${c}`).join(" + ");
            totalPrice += (others || []).reduce((s, r) => s + (r.price || 0), 0);
          }
          const startMin = (row.hour || 0) * 60 + (row.start_minute || 0);
          const dur = row.duration_minutes || 60;
          const text =
            `❌ <b>ลูกค้ายกเลิกการจองเอง</b>\n\n` +
            `👤 ${esc(row.customer_name || "-")}\n` +
            `📞 ${row.customer_id}\n` +
            `🎾 ${courtLabel}\n` +
            `📅 ${row.booking_date}\n` +
            `🕐 ${minutesToLabel(startMin)}–${minutesToLabel(startMin+dur)}\n` +
            `💰 ฿${totalPrice.toLocaleString()}`;
          await notifyTelegram(text);
        }
        res.status(200).json({ ok: true });
        return;
      }

      case "createPackage": {
        // ซื้อแพ็คเกจใหม่ — เซิร์ฟเวอร์เป็นคนตัดสินราคา/วันหมดอายุเองเสมอ ไม่เชื่อค่าจาก client
        const { tier, credits } = p;
        const who = await getLinkedCustomer(p.session);
        if (who.error) { res.status(403).json({ error: who.error }); return; }
        const customerId = who.phone;
        const customerName = who.name;
        if (!["offpeak", "peak"].includes(tier)) { res.status(400).json({ error: "invalid tier" }); return; }
        const def = PACKAGE_PRICES[tier]?.[credits];
        if (!def) { res.status(400).json({ error: "invalid credits" }); return; }
        if (!/^[0-9]{10}$/.test(customerId || "")) { res.status(400).json({ error: "invalid phone" }); return; }
        if (!customerName || String(customerName).trim().length < 1) {
          res.status(400).json({ error: "invalid name" }); return;
        }

        await sb(`customers`, {
          method: "POST",
          headers: { Prefer: "resolution=ignore-duplicates" },
          body: JSON.stringify({ customer_id: customerId, customer_name: customerName }),
        });

        const { body: created } = await sb(`packages`, {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({
            customer_id: customerId, customer_name: customerName, tier,
            total_credits: credits, remaining_credits: credits,
            price: def.price, expiry_days: def.days, status: "pending",
          }),
        });
        const pkgRow = (created || [])[0];
        if (!pkgRow) { res.status(500).json({ error: "insert_failed" }); return; }
        res.status(200).json({ package: pkgRow });
        return;
      }

      case "updatePackageSlip": {
        const { packageId, slipUrl } = p;
        if (!packageId || !slipUrl) { res.status(400).json({ error: "missing params" }); return; }
        const who = await getLinkedCustomer(p.session);
        if (who.error) { res.status(403).json({ error: who.error }); return; }
        if (!isOwnSlipUrl(slipUrl, `pkg_${packageId}`)) { res.status(400).json({ error: "invalid_slip_url" }); return; }
        const { ok, body } = await sb(`packages?id=eq.${encodeURIComponent(packageId)}&customer_id=eq.${who.phone}&status=in.(pending,reviewing)`, {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({ slip_url: slipUrl, status: "reviewing" }),
        });
        const row = (body || [])[0] || null;
        if (!ok || !row) { res.status(409).json({ error: "update_failed", detail: body }); return; }
        await notifySlipPackage(row);
        res.status(200).json({ package: row });
        return;
      }

      case "cancelPendingPackage": {
        const { packageId } = p;
        if (!packageId) { res.status(400).json({ error: "missing packageId" }); return; }
        const who = await getLinkedCustomer(p.session);
        if (who.error) { res.status(403).json({ error: who.error }); return; }
        const { ok, body } = await sb(`packages?id=eq.${encodeURIComponent(packageId)}&customer_id=eq.${who.phone}&status=in.(pending,reviewing)`, {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({ status: "cancelled" }),
        });
        const row = (body || [])[0] || null;
        if (ok && row) {
          const text =
            `❌ <b>ลูกค้ายกเลิกการซื้อแพ็คเกจเอง</b>\n\n` +
            `👤 ${esc(row.customer_name || "-")}\n` +
            `📞 ${row.customer_id}\n` +
            `🎟 ${row.tier === "peak" ? "Peak" : "Off Peak"} × ${row.total_credits} ครั้ง\n` +
            `💰 ฿${row.price?.toLocaleString?.() || row.price}`;
          await notifyTelegram(text);
        }
        res.status(200).json({ ok: true });
        return;
      }

      case "myPackages": {
        const { phone } = p;
        if (!/^[0-9]{10}$/.test(phone || "")) { res.status(400).json({ error: "invalid phone" }); return; }
        const me = await getSessionUser(p.session);
        if (me.error) { res.status(403).json({ error: me.error }); return; }
        if (me.phone && me.phone !== phone) { res.status(403).json({ error: "not_owner" }); return; }
        const { body } = await sb(`packages?customer_id=eq.${phone}&select=*&order=created_time.desc`);
        let pkgs = await Promise.all((Array.isArray(body) ? body : []).map(async (pk) => (pk.status === "active" ? { ...pk, reserved_credits: await getReservedCredits(pk.id) } : pk)));
        // ยังไม่ผูกเบอร์ (กำลังกรอกเบอร์เป็นครั้งแรกเพื่อให้ระบบหาสิทธิ์แพ็คเกจให้) → ส่งเฉพาะข้อมูลสิทธิ์ที่จำเป็น ไม่ส่งชื่อ/ราคา/สลิป
        if (!me.phone) pkgs = pkgs.map(({ id, tier, status, total_credits, remaining_credits, expiry_date, reserved_credits }) => ({ id, tier, status, total_credits, remaining_credits, expiry_date, reserved_credits }));
        res.status(200).json({ packages: pkgs });
        return;
      }

      case "lineLogin": {
        // แลก code จาก LINE เป็นข้อมูลโปรไฟล์ — ทำที่เซิร์ฟเวอร์ทั้งหมด secret ไม่หลุดไปที่เบราว์เซอร์
        const { code } = p;
        if (!LINE_LOGIN_CHANNEL_ID || !LINE_LOGIN_CHANNEL_SECRET) { res.status(500).json({ error: "line_not_configured" }); return; }
        if (!code || typeof code !== "string") { res.status(400).json({ error: "missing code" }); return; }

        const tokenRes = await fetch("https://api.line.me/oauth2/v2.1/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code", code, redirect_uri: LINE_REDIRECT_URI,
            client_id: LINE_LOGIN_CHANNEL_ID, client_secret: LINE_LOGIN_CHANNEL_SECRET,
          }).toString(),
        });
        const tokenJson = await tokenRes.json().catch(() => ({}));
        if (!tokenRes.ok || !tokenJson.access_token) {
          console.error("LINE token exchange failed:", tokenJson?.error, tokenJson?.error_description);
          res.status(400).json({ error: "line_token_failed" }); return;
        }
        const profRes = await fetch("https://api.line.me/v2/profile", {
          headers: { Authorization: `Bearer ${tokenJson.access_token}` },
        });
        const prof = await profRes.json().catch(() => ({}));
        if (!profRes.ok || !prof.userId) { res.status(400).json({ error: "line_profile_failed" }); return; }

        // เช็คว่าลูกค้าเป็นเพื่อนกับ LINE OA (ที่ผูกกับ Login Channel ไว้) แล้วหรือยัง
        // true = เป็นเพื่อนแล้ว / false = ยังไม่เป็น / null = เช็คไม่ได้ (เช่นยังไม่ได้ผูก OA หรือ LINE ขัดข้อง) → ฝั่งเว็บจะ "ไม่บล็อก" กันลูกค้าจองไม่ได้
        let isFriend = null;
        try {
          const frRes = await fetch("https://api.line.me/friendship/v1/status", {
            headers: { Authorization: `Bearer ${tokenJson.access_token}` },
          });
          if (frRes.ok) {
            const fr = await frRes.json().catch(() => ({}));
            if (typeof fr.friendFlag === "boolean") isFriend = fr.friendFlag;
          } else {
            console.error("LINE friendship status check failed:", frRes.status);
          }
        } catch (e) { console.error("LINE friendship status error:", e?.message); }

        // บันทึก/อัปเดตผู้ใช้ (merge เฉพาะคอลัมน์ที่ส่ง — เบอร์/ชื่อที่ผูกไว้เดิมไม่ถูกเขียนทับ)
        const upsertBody = { line_user_id: prof.userId, display_name: prof.displayName || null, last_login: new Date().toISOString() };
        if (isFriend !== null) upsertBody.is_friend = isFriend;
        const upsertRes = await sb(`line_users`, {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates" },
          body: JSON.stringify(upsertBody),
        });
        if (!upsertRes.ok && "is_friend" in upsertBody) {
          // คอลัมน์ is_friend ยังไม่ถูกสร้าง (ยังไม่ได้รัน SQL) — บันทึกส่วนอื่นให้ก่อน ล็อกอินจะได้ไม่พัง
          console.error("line_users upsert with is_friend failed — run add-line-friend-column.sql");
          delete upsertBody.is_friend;
          await sb(`line_users`, { method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: JSON.stringify(upsertBody) });
        }
        const { body: rows } = await sb(`line_users?line_user_id=eq.${encodeURIComponent(prof.userId)}&select=*`);
        const row = (rows || [])[0] || {};
        if (row.phone && prof.displayName) {
          const lineName = toBookingName(prof.displayName);
          if (lineName && lineName !== row.customer_name) {
            await sb(`line_users?line_user_id=eq.${encodeURIComponent(prof.userId)}`, { method: "PATCH", body: JSON.stringify({ customer_name: lineName }) });
            await sb(`customers?customer_id=eq.${row.phone}`, { method: "PATCH", body: JSON.stringify({ customer_name: lineName }) });
            await sb(`packages?customer_id=eq.${row.phone}`, { method: "PATCH", body: JSON.stringify({ customer_name: lineName }) });
            row.customer_name = lineName;
          }
        }
        res.status(200).json({
          session: signLineSession(prof.userId),
          profile: { displayName: prof.displayName || "", pictureUrl: prof.pictureUrl || "", name: row.customer_name || "", phone: row.phone || "", isFriend: isFriend ?? (typeof row.is_friend === "boolean" ? row.is_friend : null) },
        });
        return;
      }

      case "lineMe": {
        const userId = verifyLineSession(p.session);
        if (!userId) { res.status(401).json({ error: "invalid_session" }); return; }
        const { body: rows } = await sb(`line_users?line_user_id=eq.${encodeURIComponent(userId)}&select=*`);
        const row = (rows || [])[0];
        if (!row) { res.status(401).json({ error: "invalid_session" }); return; }
        res.status(200).json({ profile: { displayName: row.display_name || "", name: row.customer_name || "", phone: row.phone || "", isFriend: typeof row.is_friend === "boolean" ? row.is_friend : null } });
        return;
      }

      case "lineLinkPhone": {
        // ผูกเบอร์ + ชื่อกับบัญชี LINE นี้ "ครั้งแรกครั้งเดียว" แล้วล็อกถาวร
        //  - 1 เบอร์ผูกได้กับ 1 บัญชี LINE เท่านั้น / 1 บัญชี LINE มีได้ 1 เบอร์ (เปลี่ยนเบอร์ต้องให้แอดมินทำ)
        //  - ชื่อที่ส่งมา (ค่าตั้งต้น = ชื่อ LINE) จะแทนชื่อเดิมในข้อมูลลูกค้าของเบอร์นี้ (เช่นชื่อที่แอดมินใส่ตอนจองให้) เพื่อไม่ให้ข้อมูลซ้ำซ้อน
        //  - ถ้าเบอร์นี้มีประวัติเดิมอยู่ (เช่นแอดมินเคยจองให้) แจ้ง Telegram ให้แอดมินตรวจว่าเป็นเจ้าของเบอร์จริง
        const userId = verifyLineSession(p.session);
        if (!userId) { res.status(401).json({ error: "invalid_session" }); return; }
        const { phone } = p;
        if (!/^[0-9]{10}$/.test(phone || "")) { res.status(400).json({ error: "invalid phone" }); return; }

        const { body: meRows } = await sb(`line_users?line_user_id=eq.${encodeURIComponent(userId)}&select=*`);
        const me = (meRows || [])[0];
        // ชื่อ = ชื่อ LINE ของบัญชีนี้ (ถ้ายังไม่มีในฐานข้อมูลจริงๆ ใช้ชื่อที่หน้าเว็บส่งมาเป็นตัวสำรอง)
        const cleanName = toBookingName(me?.display_name) || toBookingName(p.name);
        if (cleanName.length < 1) { res.status(400).json({ error: "invalid name" }); return; }
        if (me?.phone) {
          // ผูกไว้แล้ว: เบอร์เดิมเท่านั้น (ส่งเบอร์เดิมซ้ำ = ไม่เป็นไร / ส่งเบอร์ใหม่ = ปฏิเสธ)
          if (me.phone === phone) { res.status(200).json({ ok: true, phone: me.phone, name: me.customer_name || cleanName, already: true }); return; }
          res.status(409).json({ error: "phone_locked", phone: me.phone }); return;
        }

        const { body: others } = await sb(`line_users?phone=eq.${phone}&line_user_id=neq.${encodeURIComponent(userId)}&select=line_user_id&limit=1`);
        if (others && others.length > 0) { res.status(409).json({ error: "phone_linked_elsewhere" }); return; }

        // ดูประวัติเดิมของเบอร์นี้ก่อนผูก (ไว้แจ้งแอดมิน)
        const { body: oldCust } = await sb(`customers?customer_id=eq.${phone}&select=customer_name`);
        const { body: oldBookings } = await sb(`bookings?customer_id=eq.${phone}&status=neq.cancelled&select=id,customer_name&limit=50`);
        const { body: oldPkgs } = await sb(`packages?customer_id=eq.${phone}&status=neq.cancelled&select=id&limit=50`);

        const link = await sb(`line_users`, {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates" },
          body: JSON.stringify({ line_user_id: userId, phone, customer_name: cleanName }),
        });
        if (!link.ok) { res.status(500).json({ error: "link_failed" }); return; }

        // ชื่อในข้อมูลลูกค้า = ชื่อที่ลงทะเบียนกับ LINE (แทนชื่อที่แอดมินใส่ครั้งแรก)
        await sb(`customers`, {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates" },
          body: JSON.stringify({ customer_id: phone, customer_name: cleanName }),
        });
        await sb(`packages?customer_id=eq.${phone}`, { method: "PATCH", body: JSON.stringify({ customer_name: cleanName }) });

        const hadHistory = (oldCust || []).length > 0 || (oldBookings || []).length > 0 || (oldPkgs || []).length > 0;
        if (hadHistory) {
          const oldName = (oldCust || [])[0]?.customer_name || (oldBookings || [])[0]?.customer_name || "-";
          await notifyTelegram(
            `🔗 <b>มีลูกค้าผูกเบอร์ที่มีประวัติเดิม</b>\n\n` +
            `📞 ${phone}\n` +
            `👤 ชื่อเดิมในระบบ: ${esc(oldName)} → ชื่อ LINE: ${esc(cleanName)}\n` +
            `📋 ประวัติเดิม: จอง ${(oldBookings || []).length} รายการ, แพ็คเกจ ${(oldPkgs || []).length} รายการ\n\n` +
            `กรุณาตรวจสอบว่าเป็นเจ้าของเบอร์จริง (เช่นทักถามผ่าน LINE) ถ้าไม่ใช่ ให้เปลี่ยนเบอร์ที่ผูกในหน้า Admin`
          );
        }
        res.status(200).json({ ok: true, phone, name: cleanName, hadHistory });
        return;
      }

      case "recordSource": {
        // บันทึกแหล่งที่มา (UTM จากโฆษณา) ติดกับการจอง/แพ็คเกจ — ทำแยกหลังสร้างรายการเสร็จ ถ้าล้มเหลว (เช่นยังไม่ได้รัน SQL) การจองหลักไม่กระทบ
        const { kind, id } = p;
        const who = await getLinkedCustomer(p.session);
        if (who.error) { res.status(200).json({ ok: false }); return; }
        const ALLOWED = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];
        const utm = {};
        if (p.utm && typeof p.utm === "object") {
          for (const k of ALLOWED) { const v = p.utm[k]; if (typeof v === "string" && v.trim()) utm[k] = v.trim().slice(0, 80); }
        }
        if (!id || !["booking", "package"].includes(kind) || Object.keys(utm).length === 0) { res.status(200).json({ ok: false }); return; }
        const table = kind === "package" ? "packages" : "bookings";
        // เขียนได้ครั้งเดียว (utm ต้องยังว่าง) — กันถูกเขียนทับภายหลัง
        const { ok, body } = await sb(`${table}?id=eq.${encodeURIComponent(id)}&customer_id=eq.${who.phone}&utm=is.null`, {
          method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ utm }),
        });
        if (ok && kind === "booking" && body?.[0]?.group_id) {
          await sb(`bookings?group_id=eq.${encodeURIComponent(body[0].group_id)}&utm=is.null`, { method: "PATCH", body: JSON.stringify({ utm }) });
        }
        res.status(200).json({ ok: !!ok });
        return;
      }

      case "checkFirstTime": {
        { const me = await getSessionUser(p.session); if (me.error) { res.status(403).json({ error: me.error }); return; } }
        const { phone, bookingDate } = p;
        if (!/^[0-9]{10}$/.test(phone || "")) { res.status(200).json({ eligible: false }); return; }
        const promoPrice = getFirstTimePrice(bookingDate); // null = วันที่เล่นนี้อยู่นอกช่วงโปรโมชั่น
        if (promoPrice == null) { res.status(200).json({ eligible: false }); return; }
        const eligible = await isFirstTimeCustomer(phone);
        res.status(200).json({ eligible, price: promoPrice });
        return;
      }

      default:
        res.status(400).json({ error: "unknown action" });
    }
  } catch (err) {
    console.error("booking-actions error:", err);
    res.status(500).json({ error: "internal error" });
  }
}

import { useState, useEffect, useRef, Fragment } from "react";

// ─── Supabase (เก็บไว้ใช้แค่สำหรับอัปโหลดสลิปขึ้น Storage เท่านั้น) ────────────
// ตาราง bookings / customers / discount_codes ทั้งหมดเข้าถึงผ่าน /api/booking-actions
// และ /api/admin-actions เท่านั้น ไม่มีการเรียก Supabase ตรงจากเบราว์เซอร์อีกต่อไป
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

async function callBookingAction(action, payload) {
  const res = await fetch("/api/booking-actions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...payload }),
  });
  return res.json();
}

const db = {
  // ดึงเวลาที่ถูกจองแล้ว ผ่านเซิร์ฟเวอร์ (ไม่เปิดตารางให้เบราว์เซอร์อ่านตรง)
  async getBookings(date, courtId) {
    const { bookings } = await callBookingAction("checkAvailability", { date, courtId });
    return bookings || [];
  },
  async getBookingById(id) {
    const { booking, group } = await callBookingAction("getBooking", { id });
    if (!booking) return null;
    return group && group.length > 1 ? { ...booking, _group: group } : booking;
  },
  // สร้างการจอง — เซิร์ฟเวอร์เป็นคนคำนวณราคาสุดท้ายเองทั้งหมด (กันการแก้ไขราคาจากฝั่ง client)
  async createBooking({ courtId, customerId, customerName, bookingDate, hour, startMinute, durationMinutes, discountCodeId }) {
    const { booking, error } = await callBookingAction("createBooking", {
      courtId, customerId, customerName, bookingDate, hour, startMinute, durationMinutes, discountCodeId,
    });
    if (error) return { error };
    return { booking };
  },
  async createBookingMulti({ courtIds, customerId, customerName, bookingDate, hour, startMinute, durationMinutes }) {
    const { bookings, error } = await callBookingAction("createBookingMulti", {
      courtIds, customerId, customerName, bookingDate, hour, startMinute, durationMinutes,
    });
    if (error || !bookings?.length) return { error: error || "insert_failed" };
    return { booking: bookings[0], bookings }; // booking = แถวแรก (ใช้ id นี้ส่งสลิป เซิร์ฟเวอร์จะครอบคลุมทั้งกลุ่มให้เอง)
  },
  async createBookingWithPackage({ courtId, customerId, customerName, bookingDate, hour, startMinute, packageId }) {
    const { booking, error } = await callBookingAction("createBooking", {
      courtId, customerId, customerName, bookingDate, hour, startMinute, durationMinutes: 60, packageId,
    });
    if (error) return { error };
    return { booking };
  },
  async createPackage({ tier, credits, customerId, customerName }) {
    const { package: pkg, error } = await callBookingAction("createPackage", { tier, credits, customerId, customerName });
    if (error) return { error };
    return { package: pkg };
  },
  async updatePackageSlip(id, slipUrl) {
    const result = await callBookingAction("updatePackageSlip", { packageId: id, slipUrl });
    return result?.package || null;
  },
  async cancelPendingPackage(id) {
    await callBookingAction("cancelPendingPackage", { packageId: id });
  },
  async myPackages(phone) {
    const { packages } = await callBookingAction("myPackages", { phone });
    return packages || [];
  },
  async lineLogin(code) { return callBookingAction("lineLogin", { code }); },
  async lineMe(session) { return callBookingAction("lineMe", { session }); },
  async lineLinkPhone(session, name, phone) { return callBookingAction("lineLinkPhone", { session, name, phone }); },
  async checkFirstTime(phone, bookingDate) {
    const result = await callBookingAction("checkFirstTime", { phone, bookingDate });
    return result?.eligible ? result.price : null; // null = ไม่เข้าเงื่อนไข
  },
  async updateSlip(id, slipUrl) {
    const result = await callBookingAction("updateSlip", { bookingId: id, slipUrl });
    return result?.booking || null; // null = อัปเดตไม่สำเร็จ (ไม่เจอแถวที่ตรงเงื่อนไข)
  },
  async cancelPending(id) {
    await callBookingAction("cancelPending", { bookingId: id });
  },
  async checkDiscount(code) {
    const result = await callBookingAction("checkDiscount", { code });
    if (!result.valid) return null;
    return result; // { id, code, discount_amount, discount_percent }
  },
  async myBookings(phone) {
    const { bookings } = await callBookingAction("myBookings", { phone });
    return bookings || [];
  },
  // อัปโหลดไฟล์สลิปขึ้น Supabase Storage โดยตรง (คนละระบบสิทธิ์กับตารางข้อมูล ไม่กระทบความปลอดภัยของข้อมูลลูกค้า)
  async uploadSlip(file, bookingId) {
    const ext = file.name.split(".").pop();
    const path = `slips/${bookingId}_${Date.now()}.${ext}`;
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/slips/${path}`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": file.type },
      body: file,
    });
    if (!res.ok) return null;
    return `${SUPABASE_URL}/storage/v1/object/public/slips/${path}`;
  },
};

// ─── Admin API helper ───────────────────────────────────────────────────────────
async function callAdminAction(action, token, payload) {
  const res = await fetch("/api/admin-actions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, token, ...payload }),
  });
  // token หมดอายุ/ไม่ถูกต้อง — ล้างค่าที่ค้างอยู่แล้วบังคับกลับไปหน้าใส่รหัสผ่านใหม่ทันที
  // กันปัญหาหน้า Admin ค้างโชว์อยู่แบบไม่มีข้อมูล เพราะเข้าใจผิดว่ายัง login อยู่ทั้งที่ session หมดอายุแล้ว
  if (res.status === 401) {
    try { sessionStorage.removeItem("nova_admin_token"); } catch { /* no-op */ }
    window.location.reload();
    return new Promise(() => {}); // ค้างไว้เฉยๆ ระหว่างรอ reload ไม่ต้องส่งค่าอะไรกลับไปต่อ
  }
  return res.json();
}

// ─── Constants ────────────────────────────────────────────────────────────────
const COURTS = [
  { courtId: 1, courtName: "Court 1", photo: "/court-1.png", descTh: "สนามในร่ม • ปรับอากาศ", descEn: "Indoor • Air-conditioned" },
  { courtId: 2, courtName: "Court 2", photo: "/court-2.png", descTh: "สนามในร่ม • ปรับอากาศ", descEn: "Indoor • Air-conditioned" },
];

// ─── ระยะเวลาการจอง ─────────────────────────────────────────────────────────────
const DURATION_OPTIONS = [30, 60, 90, 120]; // นาที
const DAY_START_MIN = 6 * 60;   // 06:00
const DAY_END_MIN = 23 * 60;    // 23:00 (เล่นได้ถึง 23:00 พอดี)
const START_STEP = 30;          // เลือกเวลาเริ่มได้ทุกครึ่งชั่วโมง

const minutesToLabel = (mins) => `${String(Math.floor(mins/60)).padStart(2,"0")}:${String(mins%60).padStart(2,"0")}`;
// Supabase/Postgres มักส่ง timestamp กลับมาแบบไม่มี "Z"/offset ต่อท้าย (เช่น "2026-09-24T10:15:23.456")
// ซึ่ง JS จะตีความว่าเป็นเวลาท้องถิ่นของเบราว์เซอร์แทนที่จะเป็น UTC ทำให้เวลานับถอยหลังคลาดเคลื่อนได้มาก
// (ประเทศไทย +7 ชม. ทำให้ดูเหมือนเวลาผ่านไปเยอะกว่าความจริง จนขึ้นว่า "หมดเวลา" ทันที) ฟังก์ชันนี้บังคับตีความเป็น UTC เสมอ
const parseUtc = (str) => {
  if (!str) return new Date(NaN);
  const hasTz = /Z$|[+-]\d{2}:?\d{2}$/.test(str);
  return new Date(hasTz ? str : `${str}Z`);
};

function getCandidateStarts(durationMinutes) {
  const starts = [];
  for (let m = DAY_START_MIN; m + durationMinutes <= DAY_END_MIN; m += START_STEP) starts.push(m);
  return starts;
}

// ─── โครงสร้างราคา ─────────────────────────────────────────────────────────────
// ราคาแยกตามระยะเวลาจริง ไม่ใช่การคูณ/หารเท่ากันทุกช่วง (30 นาทีตั้งราคาเองต่างหาก)
// 90 นาที = ราคา 60 นาที + ราคา 30 นาที, 120 นาที = ราคา 60 นาที x 2
const RATE_TABLE = {
  promo:  { offpeak: { 30: 300, 60: 450 }, peak: { 30: 325, 60: 490 } },
  normal: { offpeak: { 30: 350, 60: 490 }, peak: { 30: 375, 60: 590 } },
};
const PROMO_START = new Date(2026, 8, 1, 0, 0, 0);   // 1 ก.ย. 2569
const PROMO_END = new Date(2026, 8, 30, 23, 59, 59); // 30 ก.ย. 2569

function getDurationPrice(startHour, dateObj, durationMinutes) {
  const d = dateObj || new Date();
  const inPromo = d >= PROMO_START && d <= PROMO_END;
  const day = d.getDay(); // 0 = อาทิตย์, 6 = เสาร์
  const isWeekend = day === 0 || day === 6;
  // ระดับราคา (off-peak/peak) ตัดสินจาก "เวลาเริ่ม" ของการจอง — Peak = เสาร์-อาทิตย์ทั้งวัน หรือ จ.-ศ. ตั้งแต่ 16:00
  const isPeak = isWeekend || startHour >= 16;
  const tier = inPromo ? RATE_TABLE.promo : RATE_TABLE.normal;
  const rate = isPeak ? tier.peak : tier.offpeak;
  const numHours = Math.floor(durationMinutes / 60);
  const remainder = durationMinutes % 60; // 0 หรือ 30 เท่านั้นตามตัวเลือกที่มี
  const price = numHours * rate[60] + (remainder === 30 ? rate[30] : 0);
  return { price, peak: isPeak };
}
// สำหรับจุดที่ต้องการราคาอ้างอิงต่อชั่วโมง (เช่น สรุปราคาหน้าแรก)
function getSlotPrice(hour, dateObj) { return getDurationPrice(hour, dateObj, 60); }

// โปรโมชั่นจองครั้งแรก (แสดงผลเท่านั้น — เซิร์ฟเวอร์เป็นคนตัดสินราคาจริง ต้องแก้ให้ตรงกับ FIRST_TIME_PROMO ใน booking-actions.js ถ้าเปลี่ยน)
// ใช้ได้กับ "วันที่เล่น" ถึง lastPlayDate (รวมวันนั้น)
const FIRST_TIME_PROMO = { weekday: 450, weekend: 490, lastPlayDate: "2026-10-31", endTh: "31 ต.ค. 2569", endEn: "31 Oct 2026" };

// ราคาแพ็คเกจสำหรับแสดงผลเท่านั้น — เซิร์ฟเวอร์เป็นคนตัดสินราคาจริงเสมอ (ต้องแก้ให้ตรงกับ PACKAGE_PRICES ใน booking-actions.js ถ้าเปลี่ยนราคา)
const PACKAGE_TIERS = {
  offpeak: [ { credits: 2, price: 950, fullPrice: 980, days: 7 }, { credits: 5, price: 2350, fullPrice: 2450, days: 60 }, { credits: 10, price: 4600, fullPrice: 4900, days: 90 } ],
  peak:    [ { credits: 2, price: 1150, fullPrice: 1180, days: 7 }, { credits: 5, price: 2750, fullPrice: 2950, days: 60 }, { credits: 10, price: 5000, fullPrice: 5900, days: 90 } ],
};

// วันแรกที่เปิดให้จองได้ (ก่อนหน้านี้จองไม่ได้ แม้ปฏิทินจะเปิดดูได้)
const BOOKING_OPEN_DATE = new Date(2026, 8, 1, 0, 0, 0); // 1 ก.ย. 2569
// ช่วงที่ Court 2 ยังไม่เปิดให้บริการ (1–4 ก.ย. 2569 เปิดเฉพาะ Court 1)
const COURT2_OPEN_DATE = new Date(2026, 8, 5, 0, 0, 0); // Court 2 เริ่มเปิด 5 ก.ย. 2569
const isCourt2Restricted = (d) => d && d < COURT2_OPEN_DATE;

// ปิดสนามเฉพาะบางช่วงเวลาแบบกำหนดเอง (ไม่ได้มาจากยอดจองจริง เช่น ปิดซ่อมบำรุง)
// court: "both" = ปิดทั้ง 2 สนาม, หรือใส่ 1/2 เพื่อปิดเฉพาะสนามนั้น
// เพิ่ม/ลบรายการในลิสต์นี้ได้ตามต้องการ (บอกวันที่/เวลา/สนามมาได้เลย แล้วผมจะเพิ่มให้)
const MANUAL_CLOSURES = [
  { date: "2026-09-10", startMin: 10*60, endMin: 22*60, court: "both" }, // 10 ก.ย. 69, 10:00–22:00, ทั้ง 2 สนาม
  { date: "2026-09-11", startMin: DAY_START_MIN, endMin: DAY_END_MIN, court: "2" }, // 11 ก.ย. 69, Court 2 ปิดทั้งวัน
  { date: "2026-09-11", startMin: 11*60, endMin: DAY_END_MIN, court: "1" }, // 11 ก.ย. 69, Court 1 ปิดหลัง 11:00
  { date: "2026-09-12", startMin: 6*60, endMin: 16*60, court: "both" }, // 12 ก.ย. 69, 06:00–16:00, ทั้ง 2 สนาม
];
const isManuallyClosed = (dateObj, courtId, startMin, endMin) => {
  const iso = toIso(dateObj);
  return MANUAL_CLOSURES.some(c =>
    c.date === iso &&
    (c.court === "both" || Number(c.court) === Number(courtId)) &&
    startMin < c.endMin && endMin > c.startMin
  );
};

// วันที่เต็มทั้ง 2 สนามแบบกำหนดเอง — คำนวณอัตโนมัติจาก MANUAL_CLOSURES (เช็คว่าทั้งวันของทั้ง 2 สนามถูกปิดหมดหรือยัง)
// บวกกับลิสต์ FULLY_BOOKED_DATES เดิมไว้เผื่อใช้ระบุตรงๆ ก็ได้
const FULLY_BOOKED_DATES = ["2026-09-03"];
function isCourtFullyClosedForDate(dateObj, courtId) {
  const iso = toIso(dateObj);
  const intervals = MANUAL_CLOSURES
    .filter(c => c.date === iso && (c.court === "both" || Number(c.court) === Number(courtId)))
    .map(c => [c.startMin, c.endMin])
    .sort((a, b) => a[0] - b[0]);
  let cursor = DAY_START_MIN;
  for (const [s, e] of intervals) {
    if (s > cursor) return false; // มีช่วงที่ยังไม่ถูกปิด เหลือให้จองได้
    cursor = Math.max(cursor, e);
  }
  return cursor >= DAY_END_MIN;
}
const isFullyBookedDate = (d) => {
  if (!d) return false;
  if (FULLY_BOOKED_DATES.includes(toIso(d))) return true;
  return isCourtFullyClosedForDate(d, 1) && isCourtFullyClosedForDate(d, 2);
};

// ใช้วันที่ตามเวลาท้องถิ่น (ไม่ใช่ UTC) เพื่อไม่ให้วันที่คลาดเคลื่อนตอนใกล้เที่ยงคืน
// ─── LINE Login (ช่วยกรอกชื่อ/เบอร์อัตโนมัติ) ───────────────────────────────────────
// Channel ID เป็นข้อมูลสาธารณะ (โผล่ใน URL ตอนล็อกอินอยู่แล้ว) — ส่วน secret อยู่ฝั่งเซิร์ฟเวอร์เท่านั้น
const LINE_LOGIN_CHANNEL_ID = "2011856443";
const LINE_REDIRECT_URI = "https://nova-tennis.vercel.app/line-callback"; // ต้องตรงกับ Callback URL ใน LINE Developers
const LINE_SESSION_KEY = "nova_line_session";
// ชวนลูกค้าเพิ่มเพื่อน LINE OA ตอนล็อกอิน (ต้องผูก OA กับ LINE Login Channel ในหน้า LINE Developers ก่อน)
// "aggressive" = ขึ้นหน้าชวนเพิ่มเพื่อนแยกต่างหากหลังกดยอมรับ / "normal" = เป็นตัวเลือกเล็กๆ ในหน้ายอมรับ / "" = ไม่ชวน
const LINE_BOT_PROMPT = "aggressive";

// โหมดบังคับล็อกอิน LINE — เปลี่ยนแค่ค่านี้ค่าเดียวเพื่อสลับพฤติกรรม:
//   "gate"    = ต้องล็อกอินตั้งแต่เข้าเว็บ (ยังไม่ล็อกอิน = เห็นแต่หน้าล็อกอิน)
//   "booking" = ดูหน้าแรก/ราคาได้อิสระ แต่ต้องล็อกอินตอนจะเข้าหน้าจองสนาม/แพ็คเกจ
//   "prompt"  = ชวนล็อกอินตอนเข้าเว็บ แต่กดข้ามได้
//   "off"     = ไม่บังคับ (มีปุ่มให้ล็อกอินเฉยๆ)
const LINE_GATE_MODE = "booking";
const LINE_BYPASS_KEY = "nova_line_bypass";
// true = ในโหมด "booking" พอลูกค้ากด "จองสนาม"/"แพ็คเกจ" ตอนยังไม่ล็อกอิน ให้พาไปหน้า LINE Login ทันที (ข้ามหน้าแจ้งของเรา)
// false = แสดงหน้าแจ้ง "เข้าสู่ระบบด้วย LINE" ของเราก่อน แล้วค่อยกดไปล็อกอิน
const LINE_SKIP_INTRO = true;

const loadLineSession = () => {
  try { return JSON.parse(localStorage.getItem(LINE_SESSION_KEY) || "null"); } catch { return null; }
};
const saveLineSession = (s) => { try { localStorage.setItem(LINE_SESSION_KEY, JSON.stringify(s)); } catch { /* no-op */ } };
const clearLineSession = () => { try { localStorage.removeItem(LINE_SESSION_KEY); } catch { /* no-op */ } };

// ตัดชื่อให้ไม่เกิน 16 ตัวอักษร (ตามกฎของฟอร์ม) โดยไม่ตัดกลาง emoji
const toFormName = (s) => (s || "").slice(0, 16).replace(/[\uD800-\uDBFF]$/, "").trim();

// pendingCheckout = ข้อมูลที่ลูกค้าเลือกไว้ (วัน/สนาม/เวลา) เก็บไว้ก่อนเด้งไปหน้า LINE แล้วคืนให้ตอนกลับมา
function startLineLogin(returnTarget = "home", pendingCheckout = null) {
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  try { localStorage.setItem("nova_line_nonce", nonce); } catch { /* no-op */ }
  try {
    if (pendingCheckout) localStorage.setItem("nova_pending_checkout", JSON.stringify(pendingCheckout));
    else localStorage.removeItem("nova_pending_checkout");
  } catch { /* no-op */ }
  const state = `${returnTarget}.${nonce}`;
  const url = "https://access.line.me/oauth2/v2.1/authorize?response_type=code"
    + `&client_id=${LINE_LOGIN_CHANNEL_ID}`
    + `&redirect_uri=${encodeURIComponent(LINE_REDIRECT_URI)}`
    + `&state=${encodeURIComponent(state)}`
    + `&scope=${encodeURIComponent("profile")}`
    + (LINE_BOT_PROMPT ? `&bot_prompt=${LINE_BOT_PROMPT}` : "");
  window.location.href = url;
}

const toIso = (d) => {
  if (!d) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};
const fmtDate = (d, lang="th") => d ? d.toLocaleDateString(lang==="th"?"th-TH":"en-GB", { weekday: "short", year: "numeric", month: "short", day: "numeric" }) : "";

// ─── Payment info (ใช้ QR จริงของร้าน) ─────────────────────────────────────────
const PAYMENT_ACCOUNT_NAME = "นาง อภิระมณ เฉลิมวงศาเวช";
const PAYMENT_PHONE = "063-146-5997";
const LINE_OA_URL = "https://line.me/R/ti/p/@347mlhra";
const MAP_URL = "https://maps.app.goo.gl/wbDULbGf8VtaLbiW7";

// ─── Membership package (โครงไว้สำหรับอนาคต — ยังไม่เปิดใช้งาน) ────────────────
// eslint-disable-next-line no-unused-vars
const MEMBERSHIP_PACKAGE = { sessions: 10, price: null, active: false };

// ─── CSS ──────────────────────────────────────────────────────────────────────
const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Noto+Sans+Thai:wght@300;400;500;600;700&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --cr: #F9E8D4; --cr2: #EDD5B8; --or: #F47E1F; --or2: #FAA05A;
    --or-bg: rgba(244,126,31,0.10); --br: #663924; --bl: #8DB6C7;
    --bl-bg: rgba(141,182,199,0.13); --tx: #2e1a0e; --mu: #8a7060;
    --dv: rgba(102,57,36,0.14); --sh: 0 2px 16px rgba(102,57,36,0.09); --r: 14px;
  }
  html, body { background: var(--cr); font-family: 'Noto Sans Thai', sans-serif; color: var(--tx); }
  button, input { font-family: 'Noto Sans Thai', sans-serif; }
  a { color: inherit; }
  .bb { font-family: 'Bebas Neue', sans-serif; letter-spacing: .05em; }
  .btn-primary { width:100%; padding:15px; border-radius:var(--r); border:none; background:linear-gradient(90deg,var(--or),var(--or2)); color:#fff; font-weight:700; font-size:16px; cursor:pointer; box-shadow:0 4px 18px rgba(244,126,31,.30); font-family:'Noto Sans Thai',sans-serif; }
  .btn-primary:disabled { background:var(--cr2); color:var(--mu); box-shadow:none; cursor:not-allowed; }
  .card { background:#fff; border-radius:var(--r); border:1px solid var(--dv); box-shadow:var(--sh); overflow:hidden; }
  .card-header { background:var(--br); padding:11px 18px; }
  .card-header p { color:var(--or); font-size:13px; font-weight:600; }
  .card-body { padding:16px 18px; }
  @keyframes fu { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:translateY(0)} }
  .fu { animation:fu .3s ease both; }
  @keyframes fireGlow { 0%,100% { box-shadow:0 6px 22px rgba(232,66,15,.45), 0 0 0 rgba(255,154,31,0); } 50% { box-shadow:0 8px 30px rgba(255,90,20,.75), 0 0 26px rgba(255,170,40,.65); } }
  @keyframes flicker { 0%,100% { transform:translateY(0) scale(1) rotate(-3deg); opacity:.95; } 25% { transform:translateY(-3px) scale(1.12) rotate(3deg); opacity:1; } 50% { transform:translateY(-1px) scale(.95) rotate(-2deg); opacity:.85; } 75% { transform:translateY(-4px) scale(1.08) rotate(4deg); opacity:1; } }
  @keyframes shine { 0% { transform:translateX(-120%) skewX(-20deg); } 60%,100% { transform:translateX(220%) skewX(-20deg); } }
  @keyframes twinkle { 0%,100% { opacity:.25; transform:scale(.7) rotate(0deg); } 50% { opacity:1; transform:scale(1.15) rotate(20deg); } }
  @keyframes popPrice { 0%,100% { transform:scale(1); } 50% { transform:scale(1.06); } }
  @keyframes tagWiggle { 0%,100% { transform:rotate(-2deg); } 50% { transform:rotate(2deg); } }
  .promo-spark { position:absolute; animation:twinkle 1.8s ease-in-out infinite; pointer-events:none; }
  .promo-price { animation:popPrice 2s ease-in-out infinite; }
  .promo-tag { animation:tagWiggle 2.4s ease-in-out infinite; }
  .pkg-fire { animation:fireGlow 1.8s ease-in-out infinite; }
  .pkg-flame { position:absolute; animation:flicker 1.2s ease-in-out infinite; pointer-events:none; }
  .pkg-shine { position:absolute; top:0; bottom:0; width:60px; background:linear-gradient(90deg,transparent,rgba(255,255,255,.35),transparent); animation:shine 3.2s ease-in-out infinite; pointer-events:none; }
  @media (prefers-reduced-motion: reduce) { .pkg-fire, .pkg-flame, .pkg-shine, .promo-spark, .promo-price, .promo-tag { animation:none; } }
`;

// ─── Translations ─────────────────────────────────────────────────────────────
const T = {
  th: {
    bookNow: "จองสนามเลย →", home: "หน้าแรก", book: "จองสนาม", myBookings: "การจองของฉัน",
    selectDate: "เลือกวันที่", selectCourt: "เลือกสนาม", selectDuration: "เลือกระยะเวลา", selectTime: "เลือกช่วงเวลา",
    proceed: "ดำเนินการต่อ →", confirm: "ยืนยันการจอง", cancel: "ยกเลิก",
    name: "ชื่อ (ไม่เกิน 16 ตัว)", phone: "เบอร์โทรศัพท์",
    discount: "🏷 รหัสส่วนลด (ถ้ามี)", useCode: "ใช้โค้ด",
    payment: "ชำระเงิน", scanQR: "สแกน QR Code ชำระผ่าน PromptPay",
    transfer: "โอนให้ถูกต้อง", bookingDetail: "รายละเอียดการจอง",
    court: "สนาม", date: "วันที่", time: "เวลา", duration: "ระยะเวลา", price: "ยอดชำระ",
    total: "ยอดชำระ", payDone: "ชำระเงินแล้ว / กลับหน้าหลัก",
    uploadSlip: "📎 แนบสลิปการโอนเงิน", selectSlip: "📷 เลือกรูปสลิป",
    changeSlip: "🔄 เปลี่ยนรูปสลิป", sendSlip: "✅ ส่งสลิป",
    sending: "⏳ กำลังส่ง...", slipSent: "✅ ส่งสลิปเรียบร้อยแล้ว",
    slipSentDesc: "สถานะ: รอการยืนยัน — ทีมงานกำลังตรวจสอบสลิปของท่าน",
    noSlot: "😔 ไม่มีช่วงเวลาว่างในวันนี้",
    selectDateFirst: "กรุณาเลือกวันที่และสนามก่อน",
    selectDurationFirst: "กรุณาเลือกระยะเวลาก่อน",
    confirmBooking: "ยืนยัน ✓", morningPrice: "ช่วงเช้า", eveningPrice: "ช่วงบ่าย-เย็น",
    steps: "ขั้นตอนการชำระเงิน", contactUs: "ติดต่อเรา",
    rules: "กฎระเบียบสนาม", cancelPolicy: "นโยบายการยกเลิก",
    bookingCondition: "เงื่อนไขการจอง", priceTitle: "💰 ราคาค่าสนาม",
    indoor: "สนามในร่ม • ปรับอากาศ", saveDiscount: "ประหยัดไป",
    timeExpired: "หมดเวลา", payWithin: "กรุณาชำระภายใน",
    invalidCode: "❌ รหัสส่วนลดไม่ถูกต้องหรือหมดอายุแล้ว",
    contactLine: "กรุณาติดต่อยกเลิกผ่าน Line หรือโทรศัพท์",
    noWindow: "ไม่ติดหน้าต่าง", hasWindow: "ติดหน้าต่าง",
    summaryTitle: "สรุปรายการจอง", accountName: "ชื่อบัญชี", loading: "⏳ กำลังโหลด...",
    backHome: "กลับหน้าหลัก", checkMyBooking: "การจองของฉัน",
    searchPlaceholder: "กรอกเบอร์โทรของคุณ", searchBtn: "ค้นหา",
    notFound: "ไม่พบการจองสำหรับเบอร์นี้",
    statusPending: "รอชำระเงิน", statusReviewing: "รอการยืนยัน",
    statusConfirmed: "การจองสำเร็จ", statusCancelled: "การจองถูกยกเลิกแล้ว",
    rowPrice: "💰 ราคา",
    stepsList: ["โอนเงินผ่าน QR Code ด้านบน","ถ่ายภาพสลิปการโอนเงิน","กด 'เลือกรูปสลิป' แล้วอัพโหลดสลิป","กด 'ส่งสลิป' เพื่อยืนยัน","รอทีมงานตรวจสอบและยืนยันการจอง"],
    lineLabel: "Line", mapLabel: "แผนที่ / Map",
    minutesLabel: "นาที",
  },
  en: {
    bookNow: "Book Now →", home: "Home", book: "Book", myBookings: "My Bookings",
    selectDate: "Select Date", selectCourt: "Select Court", selectDuration: "Select Duration", selectTime: "Select Time Slot",
    proceed: "Continue →", confirm: "Confirm Booking", cancel: "Cancel",
    name: "Name (max 16 chars)", phone: "Phone Number",
    discount: "🏷 Discount Code (optional)", useCode: "Apply",
    payment: "Payment", scanQR: "Scan QR Code via PromptPay",
    transfer: "Transfer exact amount", bookingDetail: "Booking Details",
    court: "Court", date: "Date", time: "Time", duration: "Duration", price: "Total",
    total: "Total", payDone: "Payment Done / Back to Home",
    uploadSlip: "📎 Upload Payment Slip", selectSlip: "📷 Select Slip Image",
    changeSlip: "🔄 Change Slip", sendSlip: "✅ Send Slip",
    sending: "⏳ Sending...", slipSent: "✅ Slip Submitted Successfully",
    slipSentDesc: "Status: Awaiting confirmation — our team is verifying your slip",
    noSlot: "😔 No available slots today",
    selectDateFirst: "Please select a date and court first",
    selectDurationFirst: "Please select a duration first",
    confirmBooking: "Confirm ✓", morningPrice: "Morning", eveningPrice: "Afternoon-Evening",
    steps: "Payment Steps", contactUs: "Contact Us",
    rules: "Court Rules", cancelPolicy: "Cancellation Policy",
    bookingCondition: "Booking Conditions", priceTitle: "💰 Court Rates",
    indoor: "Indoor Court • Air-conditioned", saveDiscount: "You save",
    timeExpired: "Time Expired", payWithin: "Please pay within",
    invalidCode: "❌ Invalid or expired discount code",
    contactLine: "Please contact us via Line or Phone to cancel",
    noWindow: "No window", hasWindow: "Has window",
    summaryTitle: "Booking Summary", accountName: "Account Name", loading: "⏳ Loading...",
    backHome: "Back to Home", checkMyBooking: "My Bookings",
    searchPlaceholder: "Enter your phone number", searchBtn: "Search",
    notFound: "No bookings found for this number",
    statusPending: "Awaiting Payment", statusReviewing: "Awaiting Confirmation",
    statusConfirmed: "Booking Confirmed", statusCancelled: "Booking Cancelled",
    rowPrice: "💰 Price",
    stepsList: ["Transfer via the QR Code above","Take a photo of the transfer slip","Tap 'Select Slip Image' and upload it","Tap 'Send Slip' to confirm","Wait for our team to verify and confirm your booking"],
    lineLabel: "Line", mapLabel: "Map",
    minutesLabel: "min",
  }
};

function NovaLogo({ width }) {
  return <img src="/nova-logo.png" alt="NOVA Tennis" style={{ width, height: "auto", display: "block", margin: "0 auto" }} />;
}

// หน้า/การ์ดบอกให้ล็อกอินด้วย LINE — fullscreen (โหมด gate) หรือแทรกในหน้า (compact)
function LineLoginGate({ lang="th", setLang, onLogin, compact=false, onSkip }) {
  const body = (
    <div style={{width:"100%",maxWidth:380,background:"#fff",borderRadius:18,padding:"26px 22px",boxShadow:"0 10px 40px rgba(102,57,36,.15)",border:"1px solid var(--dv)",textAlign:"center"}}>
      {!compact && <NovaLogo width={130} />}
      <p style={{fontSize:18,fontWeight:800,color:"var(--br)",marginTop:compact?0:18}}>{lang==="th" ? "เข้าสู่ระบบด้วย LINE" : "Sign in with LINE"}</p>
      <p style={{fontSize:13,color:"var(--mu)",lineHeight:1.7,marginTop:8}}>
        {lang==="th"
          ? "เพื่อเริ่มใช้งานระบบจอง NOVA Tennis กรุณาเข้าสู่ระบบด้วยบัญชี LINE ของคุณ ระบบจะกรอกชื่อ-เบอร์ให้อัตโนมัติ และดูการจอง/แพ็คเกจของคุณได้ทันที"
          : "Please sign in with your LINE account to use NOVA Tennis booking. Your name and phone will be filled in automatically, and you can see your bookings and packages instantly."}
      </p>
      <button onClick={onLogin} style={{width:"100%",marginTop:18,padding:"14px",borderRadius:12,border:"none",background:"#06C755",color:"#fff",fontWeight:800,fontSize:16,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:10,fontFamily:"'Noto Sans Thai',sans-serif",boxShadow:"0 4px 14px rgba(6,199,85,.35)"}}>
        <span style={{background:"#fff",color:"#06C755",fontWeight:900,fontSize:11,padding:"3px 7px",borderRadius:6}}>LINE</span>
        {lang==="th" ? "เข้าสู่ระบบด้วย LINE" : "Sign in with LINE"}
      </button>
      {onSkip && (
        <button onClick={onSkip} style={{marginTop:12,background:"none",border:"none",color:"var(--mu)",fontSize:12.5,textDecoration:"underline",cursor:"pointer",fontFamily:"'Noto Sans Thai',sans-serif"}}>
          {lang==="th" ? "ข้ามไปก่อน" : "Skip for now"}
        </button>
      )}
      {(LINE_GATE_MODE === "gate" || LINE_GATE_MODE === "booking") && (
        <p style={{fontSize:12,color:"var(--br)",marginTop:14,lineHeight:1.6,background:"var(--or-bg)",borderRadius:10,padding:"8px 10px"}}>
          {lang==="th" ? "ระหว่างล็อกอิน LINE จะชวนให้เพิ่มเพื่อน LINE OA ของร้าน — ต้องเพิ่มเพื่อนด้วยจึงจะจองได้" : "During sign-in, LINE will ask you to add our LINE OA — adding it is required to book."}
        </p>
      )}
      <p style={{fontSize:11,color:"var(--mu)",marginTop:14,lineHeight:1.6}}>
        {lang==="th"
          ? "ระบบเก็บเฉพาะชื่อและรหัสผู้ใช้ LINE ของคุณ ไม่เห็นรหัสผ่านหรือข้อความแชทใดๆ"
          : "We only store your LINE display name and user ID. We cannot see your password or any chats."}
      </p>
    </div>
  );
  if (compact) return <div style={{padding:"28px 16px 100px",display:"flex",justifyContent:"center"}} className="fu">{body}</div>;
  return (
    <div style={{maxWidth:480,margin:"0 auto",minHeight:"100dvh",background:"var(--cr)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:20,gap:14}}>
      {setLang && (
        <div style={{display:"flex",gap:4}}>
          {["th","en"].map(l => (
            <button key={l} onClick={() => setLang(l)} style={{padding:"5px 10px",borderRadius:8,border:"1.5px solid var(--dv)",background:lang===l?"var(--br)":"#fff",color:lang===l?"var(--or)":"var(--mu)",fontWeight:lang===l?700:400,fontSize:12,cursor:"pointer",fontFamily:"'Noto Sans Thai',sans-serif"}}>
              {l==="th"?"🇹🇭 TH":"🇬🇧 EN"}
            </button>
          ))}
        </div>
      )}
      {body}
    </div>
  );
}

// ล็อกอิน LINE แล้ว แต่ยังไม่ได้เป็นเพื่อนกับ LINE OA ของร้าน → ต้องเพิ่มเพื่อนก่อนถึงจะจอง/ซื้อแพ็คเกจได้
function LineFriendGate({ lang="th", compact=false, onRecheck, name }) {
  const body = (
    <div style={{width:"100%",maxWidth:380,background:"#fff",borderRadius:18,padding:"26px 22px",boxShadow:"0 10px 40px rgba(102,57,36,.15)",border:"1px solid var(--dv)",textAlign:"center"}}>
      {!compact && <NovaLogo width={130} />}
      <p style={{fontSize:30,marginTop:compact?0:14}}>🎾</p>
      <p style={{fontSize:18,fontWeight:800,color:"var(--br)",marginTop:6}}>
        {lang==="th" ? "เพิ่มเพื่อน LINE OA ก่อนดำเนินการต่อ" : "Add our LINE OA to continue"}
      </p>
      <p style={{fontSize:13,color:"var(--mu)",lineHeight:1.7,marginTop:8}}>
        {lang==="th"
          ? `${name ? `สวัสดีคุณ ${name} ` : ""}ก่อนจองหรือซื้อแพ็คเกจ กรุณาเพิ่มเพื่อน LINE OA ของ NOVA Tennis เพื่อให้ทางร้านติดต่อคุณได้สะดวก และรับข่าวสาร/โปรโมชั่นของร้าน`
          : `${name ? `Hi ${name}. ` : ""}Before booking or buying a package, please add NOVA Tennis on LINE so we can reach you easily and share news and promotions.`}
      </p>
      <a href={LINE_OA_URL} target="_blank" rel="noreferrer"
        style={{display:"flex",alignItems:"center",justifyContent:"center",gap:10,width:"100%",marginTop:18,padding:"14px",borderRadius:12,background:"#06C755",color:"#fff",fontWeight:800,fontSize:16,textDecoration:"none",boxShadow:"0 4px 14px rgba(6,199,85,.35)",fontFamily:"'Noto Sans Thai',sans-serif"}}>
        <span style={{background:"#fff",color:"#06C755",fontWeight:900,fontSize:11,padding:"3px 7px",borderRadius:6}}>LINE</span>
        {lang==="th" ? "เพิ่มเพื่อน LINE OA" : "Add LINE OA"}
      </a>
      <button onClick={onRecheck} style={{width:"100%",marginTop:10,padding:"12px",borderRadius:12,border:"1.5px solid #06C755",background:"#fff",color:"#06A04A",fontWeight:700,fontSize:14,cursor:"pointer",fontFamily:"'Noto Sans Thai',sans-serif"}}>
        {lang==="th" ? "✓ เพิ่มเพื่อนแล้ว — ตรวจสอบอีกครั้ง" : "✓ I've added — check again"}
      </button>
      <p style={{fontSize:11,color:"var(--mu)",marginTop:12,lineHeight:1.6}}>
        {lang==="th" ? "หากเพิ่มเพื่อนแล้วแต่ยังขึ้นหน้านี้ กด \"ตรวจสอบอีกครั้ง\" ระบบจะพาไปยืนยันกับ LINE อีกรอบ" : "If you've already added us and still see this, tap \"check again\" to re-verify with LINE."}
      </p>
    </div>
  );
  if (compact) return <div style={{padding:"28px 16px 100px",display:"flex",justifyContent:"center"}} className="fu">{body}</div>;
  return (
    <div style={{maxWidth:480,margin:"0 auto",minHeight:"100dvh",background:"var(--cr)",display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
      {body}
    </div>
  );
}

function TabBar({ tab, setTab, lang="th" }) {
  const t = T[lang];
  return (
    <nav style={{position:"fixed",bottom:0,left:0,right:0,zIndex:200,backgroundColor:"#fff",borderTop:"1px solid var(--dv)",display:"flex",boxShadow:"0 -3px 16px rgba(102,57,36,0.07)"}}>
      {[["home","🏠",t.home],["book","📅",t.book],["package","🎟",lang==="th"?"แพ็คเกจ":"Packages"],["cancel","🔍",t.myBookings]].map(([id,icon,label]) => (
        <button key={id} onClick={() => setTab(id)} style={{flex:1,padding:"11px 0 8px",background:"none",border:"none",borderTop:tab===id?"2.5px solid var(--or)":"2.5px solid transparent",color:tab===id?"var(--or)":"var(--mu)",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:3}}>
          <span style={{fontSize:19}}>{icon}</span>
          <span style={{fontSize:10,fontWeight:tab===id?700:400}}>{label}</span>
        </button>
      ))}
    </nav>
  );
}

// แถบลอยแจ้งว่ายังมีการจองที่รอชำระเงินค้างอยู่ (เผื่อเผลอกดแท็บอื่นออกมา) พร้อมปุ่มกลับไปหน้าชำระเงินทันที
function PendingPaymentBanner({ createdAt, onResume, lang="th" }) {
  const [secs, setSecs] = useState(() => Math.max(0, 300 - Math.floor((Date.now() - parseUtc(createdAt).getTime())/1000)));
  useEffect(() => {
    const timer = setInterval(() => {
      setSecs(Math.max(0, 300 - Math.floor((Date.now() - parseUtc(createdAt).getTime())/1000)));
    }, 1000);
    return () => clearInterval(timer);
  }, [createdAt]);
  const expired = secs <= 0;
  const mm = String(Math.floor(secs/60)).padStart(2,"0");
  const ss = String(secs%60).padStart(2,"0");
  return (
    <div onClick={onResume} style={{position:"fixed",top:0,left:0,right:0,zIndex:250,maxWidth:480,margin:"0 auto",background:expired?"#c0392b":"var(--or)",color:"#fff",padding:"9px 16px",display:"flex",alignItems:"center",justifyContent:"space-between",cursor:"pointer",boxShadow:"0 3px 10px rgba(0,0,0,.15)"}}>
      <span style={{fontSize:12.5,fontWeight:600}}>
        {expired
          ? (lang==="th" ? "⏰ มีการจองที่ค้างอยู่ (หมดเวลาแล้ว)" : "⏰ You have a pending booking (expired)")
          : (lang==="th" ? `⏰ รอชำระเงินอยู่ — เหลือ ${mm}:${ss}` : `⏰ Payment pending — ${mm}:${ss} left`)}
      </span>
      <span style={{fontSize:12.5,fontWeight:700,textDecoration:"underline",whiteSpace:"nowrap",marginLeft:10}}>
        {lang==="th" ? "กลับไปชำระเงิน →" : "Resume →"}
      </span>
    </div>
  );
}

function HomePage({ goBook, goPackage, lang="th" }) {
  const t = T[lang];
  const now = new Date();
  const inPromo = now <= PROMO_END;
  const promoSampleWeekday = new Date(2026, 8, 2);
  const normalSampleWeekday = new Date(now);
  while (normalSampleWeekday.getDay() === 0 || normalSampleWeekday.getDay() === 6) normalSampleWeekday.setDate(normalSampleWeekday.getDate()+1);
  const priceSampleDate = inPromo ? promoSampleWeekday : normalSampleWeekday;
  const offPeak = getSlotPrice(10, priceSampleDate);
  const peak = getSlotPrice(18, priceSampleDate);

  // เงื่อนไขการจองอย่างเป็นทางการของร้าน (แสดงเป็นข้อ 1–7)
  const termsTitle = lang==="th" ? "เงื่อนไขการจองคอร์ท NOVA Tennis" : "NOVA Tennis Court Booking Conditions";
  const termsItems = lang==="th" ? [
    "ทางห้องซ้อมขออนุญาติสงวนสิทธิ์การเลื่อนจองทุกกรณี",
    "กรณีไม่สะดวกมาใช้บริการ ทางสนามขอสงวนสิทธิ์ ไม่คืนค่าบริการทุกกรณี",
    "กรุณามาถึงสนามก่อนเวลาใช้งานอย่างน้อย 10 นาที",
    "ห้องซ้อมเป็นระบบไร้พนักงาน เมื่อถึงเวลาที่จองไว้สามารถเข้าใช้บริการได้เลย หากถึงก่อนเวลาสามารถนั่งรอที่โซฟาได้เลยค่ะ",
    "สามารถดูวิธีการใช้เครื่องได้ที่ Manual ใน Line OA หรือภายในห้องซ้อม",
    "กรุณาตรวจสอบทรัพย์สินของท่านก่อนออกจากห้องซ้อม",
    "หากเกิดความเสียหายจากการใช้งานที่ไม่เหมาะสม ผู้ใช้บริการจะต้องรับผิดชอบค่าเสียหายตามมูลค่าความเสียหายที่เกิดขึ้นจริง",
  ] : [
    "The studio reserves the right not to reschedule bookings under any circumstances.",
    "If you are unable to attend, the studio reserves the right not to refund the service fee under any circumstances.",
    "Please arrive at least 10 minutes before your booking time.",
    "This is a staff-free (self-service) practice room. You may enter as soon as your booked time begins. If you arrive early, you are welcome to wait on the sofa.",
    "Instructions for using the machine are available in the Manual on our LINE OA or inside the practice room.",
    "Please check your belongings before leaving the practice room.",
    "If damage occurs from improper use, the user is responsible for the actual cost of the damage.",
  ];
  const termsFooter = lang==="th" ? "กรุณาปฏิบัติตามกฎและระเบียบของห้องซ้อมอย่างเคร่งครัด" : "Please strictly follow the rules and regulations of the practice room.";
  const termsAccept = lang==="th"
    ? "การกดยืนยันการจอง ถือว่าท่านรับทราบและยอมรับเงื่อนไขการใช้บริการทั้งหมดเรียบร้อยแล้ว"
    : "By confirming your booking, you acknowledge and accept all of the terms of service.";
  // ข้อมูลการจองออนไลน์ (ของเดิม เก็บไว้เป็นหมายเหตุเล็กๆ)
  const bookingConditionItems = lang==="th"
    ? ["จองล่วงหน้าได้สูงสุด 1 เดือน", "ชำระเงินภายใน 5 นาทีหลังยืนยัน", "เลือกระยะเวลาเล่นได้ 30 / 60 / 90 / 120 นาที"]
    : ["Book up to 1 month in advance", "Pay within 5 minutes after confirming", "Choose 30 / 60 / 90 / 120 minute sessions"];

  const ruleItems = lang==="th" ? [
    { icon:"⏰", text:"โปรดตรงต่อเวลา และเก็บลูกเทนนิสให้เรียบร้อยก่อนหมดเวลาการจองของท่านและออกจากห้องตรงเวลา เพื่อให้ลูกค้าในชั่วโมงถัดไปเข้ามาใช้บริการได้ทันที" },
    { icon:"👟", text:"กรุณาสวมรองเท้าเทนนิส รองเท้าวิ่งหรือรองเท้ายิมเท่านั้น ไม่อนุญาตรองเท้าแตะและรองเท้าที่ทำให้คอร์ตเสียหาย โปรดดูแลพื้นรองเท้าให้สะอาดก่อนเข้าใช้บริการ" },
    { icon:"🎾", text:"งดใช้กริ๊ปเสื่อมสภาพ เพื่อป้องกันเศษยางและคราบกาวร่วงติดพื้นสนาม" },
    { icon:"🚭", text:"งดสูบบุหรี่ และบุหรี่ไฟฟ้าทุกชนิด" },
    { icon:"🐾", text:"งดนำสัตว์เลี้ยงเข้ามาใช้บริการ" },
    { icon:"🍽️", text:"งดนำอาหารเข้ามาทานในคอร์ต (อนุญาตเฉพาะน้ำดื่มและเครื่องดื่มเท่านั้น)" },
    { icon:"👥", text:"เข้าใช้สนามได้สูงสุด 4 คน ต่อห้องเท่านั้น" },
  ] : [
    { icon:"⏰", text:"Please be punctual. Clear the court of all balls before your session ends and leave the room on time so the next customer can enter immediately." },
    { icon:"👟", text:"Please wear tennis, running, or gym shoes only. Sandals and shoes that may damage the court are not allowed. Please make sure your soles are clean before entering." },
    { icon:"🎾", text:"No deteriorated overgrip — prevent rubber debris and stains on the court." },
    { icon:"🚭", text:"No smoking or vaping allowed." },
    { icon:"🐾", text:"No pets allowed." },
    { icon:"🍽️", text:"No food allowed on the court. Water and beverages only." },
    { icon:"👥", text:"A maximum of 4 people per room." },
  ];

  return (
    <div style={{paddingBottom:90}}>
      <div style={{background:"linear-gradient(160deg,#fff 0%,var(--cr) 55%,var(--cr2) 100%)",padding:"36px 24px 0",textAlign:"center"}}>
        <NovaLogo width={180} />
        <p style={{color:"var(--mu)",fontSize:13.5,margin:"8px 0 16px"}}>{lang==="th"?"สนามออโต้เทนนิสในร่ม • ระบบปรับอากาศ • พร้อมรองรับทุกระดับ":"Indoor auto Tennis • Air Conditioned • All Levels Welcome"}</p>
        <img src="/court-photo.png" alt="NOVA Tennis Court" style={{width:"100%",maxWidth:520,borderRadius:16,boxShadow:"0 8px 30px rgba(102,57,36,.18)",display:"block",margin:"0 auto"}} />
        <div style={{height:16}} />
      </div>

      <div style={{padding:"18px 16px 0"}}>
        {inPromo && (
          <div style={{position:"relative",borderRadius:18,padding:"22px 20px",marginBottom:14,background:"linear-gradient(135deg,#663924 0%,#8a4a2a 55%,#F47E1F 130%)",boxShadow:"0 10px 34px rgba(102,57,36,.35)",overflow:"hidden",color:"#fff"}}>
            <div style={{position:"absolute",top:-30,right:-30,width:120,height:120,borderRadius:"50%",background:"rgba(255,255,255,.08)"}} />
            <div style={{position:"absolute",bottom:-40,left:-20,width:140,height:140,borderRadius:"50%",background:"rgba(255,255,255,.06)"}} />
            <div style={{display:"inline-flex",alignItems:"center",gap:6,background:"rgba(255,255,255,.18)",borderRadius:20,padding:"5px 12px",marginBottom:12}}>
              <span style={{fontSize:13}}>🔥</span>
              <span style={{fontSize:11.5,fontWeight:700,letterSpacing:.3}}>{lang==="th"?"โปรโมชั่นเปิดตัว · เดือนแรก":"Launch Promo · First Month"}</span>
            </div>
            <p style={{lineHeight:1.15,marginBottom:6}}>
              <span className="bb" style={{fontSize:30,letterSpacing:.3}}>Promotion Soft Opening</span>
              {lang==="th" && <span style={{fontSize:22,fontWeight:700,fontFamily:"'Noto Sans Thai',sans-serif",marginLeft:8}}>ราคาพิเศษ</span>}
              {lang!=="th" && <span className="bb" style={{fontSize:30,letterSpacing:.3}}> — Special Price</span>}
            </p>
            <p style={{fontSize:12.5,opacity:.85,marginBottom:16}}>{lang==="th"?"Soft Opening · 1 ก.ย. 2569 – 30 ก.ย. 2569 เท่านั้น":"Soft Opening · 1 Sep 2026 – 30 Sep 2026 only"}</p>
            <div style={{display:"flex",gap:10}}>
              <div style={{flex:1,background:"rgba(255,255,255,.14)",borderRadius:12,padding:"12px 10px",textAlign:"center"}}>
                <p style={{fontSize:10.5,opacity:.8,marginBottom:4}}>Off Peak</p>
                <p style={{fontSize:12,opacity:.65,textDecoration:"line-through"}}>฿490</p>
                <p className="bb" style={{fontSize:26,lineHeight:1}}>฿450</p>
              </div>
              <div style={{flex:1,background:"rgba(255,255,255,.14)",borderRadius:12,padding:"12px 10px",textAlign:"center"}}>
                <p style={{fontSize:10.5,opacity:.8,marginBottom:4}}>Peak</p>
                <p style={{fontSize:12,opacity:.65,textDecoration:"line-through"}}>฿590</p>
                <p className="bb" style={{fontSize:26,lineHeight:1}}>฿490</p>
              </div>
            </div>
            <p style={{fontSize:10.5,opacity:.7,marginTop:10}}>{lang==="th"?"ราคาต่อ 60 นาที — เลือกระยะเวลาอื่นได้ในหน้าจอง":"Price per 60 min — other durations available when booking"}</p>
          </div>
        )}
        <button className="btn-primary" onClick={goBook}>{t.bookNow}</button>
      </div>

      {/* แบนเนอร์คู่: โปรจองครั้งแรก + แพ็คเกจ — วางข้างกันให้เห็นพร้อมกันโดยไม่ต้องเลื่อนหน้า
          (โปรจองครั้งแรกหายเองหลังพ้นวันสุดท้าย เหลือแพ็คเกจเต็มความกว้าง) */}
      {(() => {
        const promoActive = toIso(new Date()) <= FIRST_TIME_PROMO.lastPlayDate;
        const th = lang === "th";
        const pill = (bg, color) => ({ display:"inline-block", alignSelf:"flex-start", background:bg, color, borderRadius:20, padding:"3px 10px", fontSize:11, fontWeight:800 });
        const cardBase = { position:"relative", overflow:"hidden", width:"100%", minHeight:232, padding:"14px 13px 13px", borderRadius:"var(--r)", border:"none", cursor:"pointer", textAlign:"left", color:"#fff", display:"flex", flexDirection:"column", justifyContent:"space-between", gap:6 };
        const cta = (color) => ({ display:"block", textAlign:"center", background:"#fff", color, fontWeight:800, fontSize:14, padding:"9px 6px", borderRadius:22, boxShadow:"0 3px 10px rgba(0,0,0,.22)" });
        return (
          <div style={{padding:"14px 16px 0"}}>
            <div style={{display:"grid",gridTemplateColumns:promoActive?"1fr 1fr":"1fr",gap:10,alignItems:"stretch"}}>

              {promoActive && (
                <button onClick={goBook} style={{...cardBase,background:"linear-gradient(160deg,#1E4E66 0%,#2F7A94 60%,#4BA3B8 100%)",boxShadow:"0 6px 20px rgba(47,122,148,.4)"}}>
                  <span className="promo-spark" style={{top:8,right:10,fontSize:18}}>✨</span>
                  <span className="promo-spark" style={{top:46,right:30,fontSize:12,animationDelay:".7s"}}>✨</span>
                  <span className="promo-tag" style={pill("#FFD54A","#5A3A00")}>🎁 {th?"ลูกค้าใหม่":"NEW CUSTOMER"}</span>
                  <div>
                    <p style={{fontSize:17,fontWeight:800,lineHeight:1.2}}>{th?"จองครั้งแรก":"First booking"}</p>
                    <p className="promo-price" style={{fontSize:40,fontWeight:900,lineHeight:1.05,color:"#FFD54A",marginTop:4,textShadow:"0 2px 8px rgba(0,0,0,.3)"}}>฿{FIRST_TIME_PROMO.weekday}<span style={{fontSize:13,fontWeight:700,color:"#fff"}}>/{th?"ชม.":"hr"}</span></p>
                    <p style={{fontSize:12.5,fontWeight:700,marginTop:1}}>{th?"จันทร์–ศุกร์":"Mon–Fri"}</p>
                    <p style={{fontSize:13,fontWeight:800,marginTop:6,background:"rgba(255,255,255,.2)",borderRadius:10,padding:"4px 8px",display:"inline-block"}}>฿{FIRST_TIME_PROMO.weekend} {th?"เสาร์–อาทิตย์":"Sat–Sun"}</p>
                    <p style={{fontSize:11.5,fontWeight:700,marginTop:7,opacity:.95}}>⏰ {th?`ถึง ${FIRST_TIME_PROMO.endTh}`:`Until ${FIRST_TIME_PROMO.endEn}`}</p>
                  </div>
                  <span style={cta("#1E4E66")}>{th?"จองเลย →":"Book now →"}</span>
                </button>
              )}

              <button onClick={goPackage} className="pkg-fire" style={{...cardBase,background:"linear-gradient(160deg,#9E1B0A 0%,#E8420F 55%,#FF9A1F 100%)"}}>
                <span className="pkg-shine" />
                <span className="pkg-flame" style={{top:6,right:8,fontSize:26}}>🔥</span>
                <span className="pkg-flame" style={{top:40,right:30,fontSize:16,animationDelay:".5s"}}>🔥</span>
                <span style={{...pill("rgba(255,255,255,.22)","#fff"),border:"1px solid rgba(255,255,255,.5)",position:"relative"}}>🔥 {th?"แพ็คเกจ":"PACKAGES"}</span>
                <div style={{position:"relative"}}>
                  <p style={{fontSize:17,fontWeight:800,lineHeight:1.2}}>{th?"ซื้อล่วงหน้า คุ้มกว่า":"Pre-pay, save more"}</p>
                  <p style={{fontSize:12.5,fontWeight:700,marginTop:6}}>{th?"ประหยัดสูงสุด":"Save up to"}</p>
                  <p style={{fontSize:40,fontWeight:900,lineHeight:1.05,color:"#FFE27A",textShadow:"0 2px 8px rgba(0,0,0,.3)"}}>฿900</p>
                  <p style={{fontSize:13,fontWeight:800,marginTop:6,background:"rgba(255,255,255,.2)",borderRadius:10,padding:"4px 8px",display:"inline-block"}}>{th?"10 ครั้ง เริ่ม ฿460/ชม.":"10 sessions from ฿460/hr"}</p>
                  <p style={{fontSize:11.5,fontWeight:700,marginTop:7,opacity:.95}}>{th?"แพ็ค 2 • 5 • 10 ครั้ง":"2 • 5 • 10 sessions"}</p>
                </div>
                <span style={{...cta("#C2330C"),position:"relative"}}>{th?"ดูแพ็คเกจ →":"View packages →"}</span>
              </button>
            </div>
            {promoActive && (
              <p style={{fontSize:10.5,color:"var(--mu)",marginTop:8,lineHeight:1.5}}>
                {th
                  ? `* โปรจองครั้งแรก: ลูกค้าใหม่ • จอง 60 นาที • 1 สนาม • วันเล่นถึง ${FIRST_TIME_PROMO.endTh} • ไม่ร่วมกับโค้ดส่วนลดหรือแพ็คเกจ`
                  : `* First-booking offer: new customers • 60 min • 1 court • play date up to ${FIRST_TIME_PROMO.endEn} • cannot combine with discount codes or packages`}
              </p>
            )}
          </div>
        );
      })()}

      <div style={{padding:"18px 16px 0",display:"flex",flexDirection:"column",gap:14}}>

        <div className="card">
          <div className="card-header"><p>{t.priceTitle}{lang==="th"?" (60 นาที)":" (60 min)"}</p></div>
          {inPromo && (
            <div style={{padding:"10px 18px",background:"var(--or-bg)",borderBottom:"1px solid var(--dv)",display:"flex",alignItems:"center",gap:8}}>
              <span style={{fontSize:14}}>🔥</span>
              <p style={{fontSize:12,color:"var(--br)",fontWeight:600}}>
                {lang==="th" ? "โปรโมชั่น Soft Opening 1 เดือน · 1 ก.ย. 2569 – 30 ก.ย. 2569" : "Soft Opening Promo (1 Month) · 1 Sep 2026 – 30 Sep 2026"}
              </p>
            </div>
          )}
          <div style={{display:"flex",padding:"16px 18px",gap:12}}>
            <div style={{flex:1,textAlign:"center"}}>
              <p style={{fontSize:10.5,color:"var(--mu)",marginBottom:5}}>Off Peak</p>
              {inPromo && <p style={{fontSize:13,color:"var(--mu)",textDecoration:"line-through"}}>฿490</p>}
              <p style={{fontSize:28,fontWeight:800,color:"var(--or)",lineHeight:1}}>฿{offPeak.price}</p>
              <p style={{fontSize:10.5,color:"var(--mu)",marginTop:5}}>{lang==="th"?"จ.-ศ. 06:00–15:00":"Mon-Fri 06:00–15:00"}</p>
            </div>
            <div style={{width:1,background:"var(--dv)"}} />
            <div style={{flex:1,textAlign:"center"}}>
              <p style={{fontSize:10.5,color:"var(--mu)",marginBottom:5}}>Peak</p>
              {inPromo && <p style={{fontSize:13,color:"var(--mu)",textDecoration:"line-through"}}>฿590</p>}
              <p style={{fontSize:28,fontWeight:800,color:"var(--bl)",lineHeight:1}}>฿{peak.price}</p>
              <p style={{fontSize:10.5,color:"var(--mu)",marginTop:5}}>{lang==="th"?"จ.-ศ. 16:00–22:00 / ส.-อา. ทั้งวัน":"Mon-Fri 16:00–22:00 / Sat-Sun all day"}</p>
            </div>
          </div>
        </div>

        <div className="card">
          <div style={{padding:"12px 18px",borderBottom:"1px solid var(--dv)",display:"flex",alignItems:"center",gap:8}}>
            <span style={{fontSize:17}}>📋</span>
            <span style={{fontWeight:700,color:"var(--br)",fontSize:14}}>{t.bookingCondition}</span>
          </div>
          <div style={{padding:"14px 18px",display:"flex",flexDirection:"column",gap:12}}>
            <p style={{fontSize:14,fontWeight:700,color:"var(--br)"}}>{termsTitle}</p>
            {termsItems.map((txt,i) => (
              <div key={i} style={{display:"flex",gap:12,alignItems:"flex-start"}}>
                <div style={{width:22,height:22,borderRadius:"50%",flexShrink:0,background:"var(--or-bg)",color:"var(--or)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:800}}>{i+1}</div>
                <p style={{fontSize:13.5,color:"var(--tx)",lineHeight:1.6}}>{txt}</p>
              </div>
            ))}
            <p style={{fontSize:13,color:"var(--mu)",lineHeight:1.6,marginTop:2}}>{termsFooter}</p>
            <div style={{background:"var(--or-bg)",border:"1px solid rgba(244,126,31,.25)",borderRadius:10,padding:"10px 12px"}}>
              <p style={{fontSize:13,fontWeight:700,color:"var(--br)",lineHeight:1.6}}>{termsAccept}</p>
            </div>
            <div style={{borderTop:"1px solid var(--dv)",paddingTop:10,display:"flex",flexDirection:"column",gap:4}}>
              {bookingConditionItems.map((txt,i) => (
                <p key={i} style={{fontSize:12,color:"var(--mu)",lineHeight:1.5}}>• {txt}</p>
              ))}
            </div>
          </div>
        </div>

        <div className="card">
          <div style={{padding:"12px 18px",borderBottom:"1px solid var(--dv)",display:"flex",alignItems:"center",gap:8}}>
            <span style={{fontSize:17}}>🎾</span>
            <span style={{fontWeight:700,color:"var(--br)",fontSize:14}}>{t.rules}</span>
          </div>
          <div style={{display:"flex",flexDirection:"column"}}>
            {ruleItems.map((r,i) => (
              <div key={i} style={{display:"flex",gap:12,alignItems:"flex-start",padding:"12px 18px",background:i%2===1?"rgba(102,57,36,.03)":"transparent",borderTop:i===0?"none":"1px solid rgba(102,57,36,.06)"}}>
                <span style={{fontSize:18,flexShrink:0,marginTop:1}}>{r.icon}</span>
                <p style={{fontSize:13,color:"var(--mu)",lineHeight:1.65}}>{r.text}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div style={{padding:"12px 18px",borderBottom:"1px solid var(--dv)",display:"flex",alignItems:"center",gap:8}}>
            <span style={{fontSize:17}}>📞</span>
            <span style={{fontWeight:700,color:"var(--br)",fontSize:14}}>{t.contactUs}</span>
          </div>
          <div style={{padding:"12px 18px",display:"flex",flexDirection:"column",gap:10}}>
            <div style={{display:"flex",gap:10,alignItems:"center"}}>
              <span style={{color:"var(--or)",fontSize:14}}>›</span>
              <a href="tel:0631465997" style={{fontSize:13.5,color:"var(--mu)",textDecoration:"none"}}>{lang==="th"?"โทร: 063-146-5997":"Call: 063-146-5997"}</a>
            </div>
            <div style={{display:"flex",gap:10,alignItems:"center"}}>
              <span style={{color:"var(--or)",fontSize:14}}>›</span>
              <a href={LINE_OA_URL} target="_blank" rel="noreferrer" style={{fontSize:13.5,color:"var(--mu)",textDecoration:"none",fontWeight:600}}>💬 {t.lineLabel}: @347mlhra</a>
            </div>
            <div style={{display:"flex",gap:10,alignItems:"center"}}>
              <span style={{color:"var(--or)",fontSize:14}}>›</span>
              <a href={MAP_URL} target="_blank" rel="noreferrer" style={{fontSize:13.5,color:"var(--mu)",textDecoration:"none",fontWeight:600}}>📍 {t.mapLabel}</a>
            </div>
            <div style={{display:"flex",gap:10,alignItems:"flex-start"}}>
              <span style={{color:"var(--or)",fontSize:14,lineHeight:1.5}}>›</span>
              <span style={{fontSize:13.5,color:"var(--mu)",lineHeight:1.65}}>{lang==="th"?"เปิดทำการ 06:00–23:00 น. ทุกวัน":"Open daily 06:00–23:00"}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Calendar({ selected, onSelect, lang="th" }) {
  const today = new Date(); today.setHours(0,0,0,0);
  const minDate = today > BOOKING_OPEN_DATE ? today : BOOKING_OPEN_DATE;
  const maxDate = new Date(minDate); maxDate.setDate(maxDate.getDate()+30);
  const [view, setView] = useState(new Date(minDate.getFullYear(), minDate.getMonth(), 1));
  const y = view.getFullYear(), m = view.getMonth();
  const firstDay = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m+1, 0).getDate();
  const selIso = toIso(selected);
  const cells = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(y, m, d));
  const dowLabels = lang==="th" ? ["อา","จ","อ","พ","พฤ","ศ","ส"] : ["Su","Mo","Tu","We","Th","Fr","Sa"];
  return (
    <div className="card">
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 16px",background:"var(--br)"}}>
        <button onClick={() => setView(new Date(y,m-1,1))} style={{background:"none",border:"none",color:"rgba(255,255,255,.75)",fontSize:22,cursor:"pointer"}}>‹</button>
        <span style={{fontWeight:700,color:"#fff",fontSize:15}}>{view.toLocaleDateString(lang==="th"?"th-TH":"en-GB",{month:"long",year:"numeric"})}</span>
        <button onClick={() => setView(new Date(y,m+1,1))} style={{background:"none",border:"none",color:"rgba(255,255,255,.75)",fontSize:22,cursor:"pointer"}}>›</button>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",padding:"10px 10px 0",gap:2}}>
        {dowLabels.map(d => (
          <div key={d} style={{textAlign:"center",fontSize:11,color:"var(--mu)",fontWeight:600,paddingBottom:6}}>{d}</div>
        ))}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",padding:"2px 10px 12px",gap:3}}>
        {cells.map((d,i) => {
          if (!d) return <div key={i} />;
          const iso = toIso(d);
          const isToday = iso === toIso(today);
          const isSel = iso === selIso;
          const full = isFullyBookedDate(d);
          const disabled = d < minDate || d > maxDate || full;
          return (
            <button key={i} disabled={disabled} onClick={() => onSelect(new Date(d))} style={{position:"relative",aspectRatio:"1",borderRadius:8,border:"none",cursor:disabled?"default":"pointer",background:isSel?"var(--or)":isToday?"var(--or-bg)":full?"rgba(192,57,43,.07)":"transparent",color:disabled?"#ccc":isSel?"#fff":isToday?"var(--or)":"var(--tx)",fontWeight:(isSel||isToday)?700:400,fontSize:13,outline:(isToday&&!isSel)?"1.5px solid var(--or)":"none",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:1}}>
              <span>{d.getDate()}</span>
              {full && <span style={{fontSize:8,fontWeight:700,color:"#c0392b",lineHeight:1}}>{lang==="th"?"เต็ม":"Full"}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function BookingPage({ onProceed, lang="th" }) {
  const t = T[lang];
  const [date, setDate] = useState(null);
  const [courts, setCourts] = useState([]); // เลือกได้ 1 หรือ 2 สนาม (2 สนาม = จองพร้อมกัน โอนครั้งเดียว)
  const [duration, setDuration] = useState(null);
  const [slot, setSlot] = useState(null);
  const [bookedByCourt, setBookedByCourt] = useState({}); // { courtId: [[start,end],...] }
  const [loading, setLoading] = useState(false);
  const isGroup = courts.length > 1;
  const ready = date && courts.length > 0 && duration && slot;
  const selKey = courts.map(c => c.courtId).sort().join(",");

  const toggleCourt = (c) => {
    setCourts(prev => prev.some(x => x.courtId === c.courtId) ? prev.filter(x => x.courtId !== c.courtId) : [...prev, c]);
    setSlot(null);
  };

  useEffect(() => {
    if (!date || courts.length === 0) return;
    let cancelled = false;
    setLoading(true);
    const toIntervals = (data) => {
      const now = Date.now();
      return (data || [])
        .filter(b => {
          // "รอชำระ" ที่ค้างเกิน 5 นาทีแล้ว ไม่นับว่าบล็อกช่วงเวลาอีกต่อไป (ปล่อยให้จองใหม่ได้)
          if (b.status === "pending") return (now - parseUtc(b.created_time).getTime()) < 5 * 60 * 1000;
          return true;
        })
        .map(b => {
          const startMin = (b.hour || 0) * 60 + (b.start_minute || 0);
          return [startMin, startMin + (b.duration_minutes || 60)];
        });
    };
    Promise.all(courts.map(c => db.getBookings(toIso(date), c.courtId).then(data => [c.courtId, toIntervals(data)])))
      .then(entries => { if (!cancelled) { setBookedByCourt(Object.fromEntries(entries)); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, selKey]);

  const isToday = date && toIso(date) === toIso(new Date());
  const nowMinutes = new Date().getHours()*60 + new Date().getMinutes();
  const court2NotYetOpen = courts.some(c => c.courtId === 2) && isCourt2Restricted(date);
  const forcedFull = court2NotYetOpen || isFullyBookedDate(date);

  // ช่วงเวลาที่เลือกได้ = ว่างครบ "ทุกสนามที่เลือก" พร้อมกัน
  const availableSlots = (!duration || forcedFull || courts.length === 0) ? [] : getCandidateStarts(duration)
    .filter(startMin => {
      if (isToday && startMin <= nowMinutes) return false;
      const endMin = startMin + duration;
      return courts.every(c =>
        !isManuallyClosed(date, c.courtId, startMin, endMin) &&
        !(bookedByCourt[c.courtId] || []).some(([s,e]) => startMin < e && endMin > s)
      );
    })
    .map(startMin => {
      const startHour = Math.floor(startMin/60);
      const { price: unit, peak } = getDurationPrice(startHour, date || new Date(), duration);
      return {
        startMin, durationMinutes: duration,
        hour: startHour, startMinute: startMin % 60,
        label: `${minutesToLabel(startMin)} – ${minutesToLabel(startMin+duration)}`,
        price: unit * Math.max(1, courts.length), // ราคารวมทุกสนามที่เลือก
        unitPrice: unit, peak,
      };
    });

  return (
    <div style={{padding:"20px 16px 100px",display:"flex",flexDirection:"column",gap:22}} className="fu">
      <section>
        <StepHead n="1" label={t.selectDate} />
        <Calendar selected={date} onSelect={d => { setDate(d); setSlot(null); }} lang={lang} />
        {date && (
          <div style={{marginTop:10,background:"var(--or-bg)",borderRadius:10,padding:"9px 14px",border:"1px solid rgba(244,126,31,.2)"}}>
            <p style={{fontSize:13,color:"var(--br)",fontWeight:600}}>📅 {fmtDate(date, lang)}</p>
          </div>
        )}
      </section>
      <section>
        <StepHead n="2" label={t.selectCourt} />
        <p style={{fontSize:12,color:"var(--mu)",marginBottom:10}}>
          {lang==="th" ? "แตะเลือกได้ทั้ง 2 สนาม เพื่อจองช่วงเวลาเดียวกันพร้อมกัน โอนเงินครั้งเดียว" : "Tap both courts to book the same time slot on both — one payment."}
        </p>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
          {COURTS.map(c => {
            const sel = courts.some(x => x.courtId === c.courtId);
            return (
              <button key={c.courtId} onClick={() => toggleCourt(c)} style={{position:"relative",padding:0,borderRadius:"var(--r)",border:`2px solid ${sel?"var(--or)":"var(--dv)"}`,background:"#fff",cursor:"pointer",textAlign:"center",boxShadow:sel?"0 2px 12px rgba(244,126,31,.18)":"var(--sh)",overflow:"hidden"}}>
                {sel && <span style={{position:"absolute",top:6,right:6,zIndex:1,width:22,height:22,borderRadius:"50%",background:"var(--or)",color:"#fff",fontSize:13,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center"}}>✓</span>}
                <img src={c.photo} alt={c.courtName} style={{width:"100%",height:90,objectFit:"cover",display:"block"}} />
                <div style={{padding:"10px 8px 12px"}}>
                  <p style={{fontWeight:700,color:sel?"var(--or)":"var(--br)",fontSize:15}}>{c.courtName}</p>
                  <p style={{fontSize:11,color:"var(--mu)",marginTop:4}}>{lang==="th"?c.descTh:c.descEn}</p>
                </div>
              </button>
            );
          })}
        </div>
        <button onClick={() => { setCourts(isGroup ? [] : [...COURTS]); setSlot(null); }}
          style={{width:"100%",marginTop:10,padding:"10px",borderRadius:10,border:`1.5px dashed ${isGroup?"var(--or)":"var(--dv)"}`,background:isGroup?"var(--or-bg)":"#fff",color:isGroup?"var(--or)":"var(--br)",fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:"'Noto Sans Thai',sans-serif"}}>
          {isGroup ? (lang==="th"?"✓ จองทั้ง 2 สนามพร้อมกัน (แตะเพื่อยกเลิก)":"✓ Booking both courts (tap to undo)") : (lang==="th"?"+ จองทั้ง 2 สนามพร้อมกัน":"+ Book both courts at once")}
        </button>
        {isGroup && (
          <p style={{fontSize:11.5,color:"var(--mu)",marginTop:8,lineHeight:1.6}}>
            {lang==="th" ? "* การจอง 2 สนามพร้อมกันใช้ราคาปกติ (ราคาต่อสนาม × 2) ไม่ร่วมกับแพ็คเกจ โค้ดส่วนลด หรือโปรจองครั้งแรก" : "* Booking both courts uses regular pricing (per-court price × 2). Packages, discount codes and the first-booking promo don't apply."}
          </p>
        )}
      </section>
      <section>
        <StepHead n="3" label={t.selectDuration} />
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>
          {DURATION_OPTIONS.map(min => {
            const sel = duration === min;
            return (
              <button key={min} onClick={() => { setDuration(min); setSlot(null); }} style={{padding:"14px 6px",borderRadius:10,border:`2px solid ${sel?"var(--or)":"var(--dv)"}`,background:sel?"var(--or-bg)":"#fff",cursor:"pointer",textAlign:"center"}}>
                <p className="bb" style={{fontSize:22,color:sel?"var(--or)":"var(--br)",lineHeight:1}}>{min}</p>
                <p style={{fontSize:10.5,color:"var(--mu)",marginTop:3}}>{t.minutesLabel}</p>
              </button>
            );
          })}
        </div>
      </section>
      <section>
        <StepHead n="4" label={t.selectTime} />
        {(!date||courts.length===0) ? (
          <div style={{background:"#fff",borderRadius:"var(--r)",padding:"22px",textAlign:"center",border:"1px solid var(--dv)"}}>
            <p style={{color:"var(--mu)",fontSize:14}}>{t.selectDateFirst}</p>
          </div>
        ) : !duration ? (
          <div style={{background:"#fff",borderRadius:"var(--r)",padding:"22px",textAlign:"center",border:"1px solid var(--dv)"}}>
            <p style={{color:"var(--mu)",fontSize:14}}>{t.selectDurationFirst}</p>
          </div>
        ) : loading ? (
          <div style={{background:"#fff",borderRadius:"var(--r)",padding:"22px",textAlign:"center",border:"1px solid var(--dv)"}}>
            <p style={{color:"var(--mu)",fontSize:14}}>{t.loading}</p>
          </div>
        ) : availableSlots.length === 0 ? (
          <div style={{background:"#fff",borderRadius:"var(--r)",padding:"22px",textAlign:"center",border:"1px solid var(--dv)"}}>
            <p style={{color:"var(--mu)",fontSize:14}}>{t.noSlot}</p>
          </div>
        ) : (
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            <div style={{display:"flex",gap:14,marginBottom:8,flexWrap:"wrap"}}>
              <Dot color="var(--or)" label={`฿${availableSlots.find(s=>!s.peak)?.price ?? "-"} · Off Peak${isGroup?(lang==="th"?" (รวม 2 สนาม)":" (both courts)"):""}`} />
              <Dot color="var(--bl)" label={`฿${availableSlots.find(s=>s.peak)?.price ?? "-"} · Peak${isGroup?(lang==="th"?" (รวม 2 สนาม)":" (both courts)"):""}`} />
            </div>
            {availableSlots.map(ts => {
              const isSel = slot?.startMin === ts.startMin;
              return (
                <button key={ts.startMin} onClick={() => setSlot(ts)} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"13px 16px",borderRadius:10,border:`1.5px solid ${isSel?"var(--or)":"var(--dv)"}`,background:isSel?"var(--or-bg)":"#fff",cursor:"pointer",boxShadow:isSel?"0 2px 10px rgba(244,126,31,.15)":"none"}}>
                  <div style={{display:"flex",alignItems:"center",gap:10}}>
                    <div style={{width:8,height:8,borderRadius:"50%",background:ts.peak?"var(--bl)":"var(--or)"}} />
                    <span style={{fontSize:14}}>{ts.label}</span>
                  </div>
                  <span style={{fontSize:14,fontWeight:700,color:ts.peak?"var(--bl)":"var(--or)"}}>฿{ts.price.toLocaleString()}</span>
                </button>
              );
            })}
          </div>
        )}
      </section>
      <button className="btn-primary" disabled={!ready} onClick={() => onProceed({date, court: courts[0], courts: isGroup ? courts : null, slot})}>
        {t.proceed}
      </button>
    </div>
  );
}

function CheckoutPage({ booking, onCancel, onConfirm, onConfirmWithPackage, lineSession, onLineLogin, onLinePhoneLinked, lang="th" }) {
  const t = T[lang];
  const { date, court, slot } = booking;
  const courts = booking.courts; // มี 2 สนามเมื่อเป็นการจองพร้อมกัน (โอนครั้งเดียว)
  const isGroup = !!(courts && courts.length > 1);
  // ถ้าล็อกอิน LINE อยู่ กรอกชื่อ/เบอร์ให้อัตโนมัติ (แก้ไขเองได้เสมอ)
  const [name, setName] = useState(() => toFormName(lineSession?.name || lineSession?.displayName));
  const [phone, setPhone] = useState(() => lineSession?.phone || "");
  const [discountCode, setDiscountCode] = useState("");
  const [discount, setDiscount] = useState(null);
  const [discountMsg, setDiscountMsg] = useState("");
  const [checkingCode, setCheckingCode] = useState(false);
  const nameOk = name.trim().length >= 1 && name.length <= 16;
  const phoneOk = /^[0-9]{10}$/.test(phone);
  const ok = nameOk && phoneOk;

  // เช็คว่ามีสิทธิ์แพ็คเกจที่ใช้กับช่วงเวลานี้ได้ไหม (ต้องจอง 60 นาทีพอดี + tier ตรงกัน + ยังไม่หมดอายุ)
  const [matchedPkg, setMatchedPkg] = useState(null);
  const [useCredit, setUseCredit] = useState(false);
  const [checkingPkg, setCheckingPkg] = useState(false);
  useEffect(() => {
    setMatchedPkg(null); setUseCredit(false);
    if (!phoneOk || slot.durationMinutes !== 60 || isGroup) return;
    setCheckingPkg(true);
    db.myPackages(phone).then(rows => {
      const today = toIso(new Date());
      const slotTier = slot.peak ? "peak" : "offpeak";
      // แพ็ค Peak ใช้ได้ทั้ง Peak และ Off Peak — แพ็ค Off Peak ใช้ได้เฉพาะช่วง Off Peak
      const usable = (rows || []).filter(p => p.status === "active" && p.remaining_credits > 0 && (!p.expiry_date || p.expiry_date >= today) && (p.tier === "peak" || p.tier === slotTier));
      // ใช้แพ็คที่ตรงช่วงเวลาก่อน (เก็บแพ็ค Peak ไว้ใช้ช่วงที่จำเป็น) แล้วเรียงตามวันหมดอายุใกล้สุดก่อน
      usable.sort((x, y) => ((x.tier === slotTier ? 0 : 1) - (y.tier === slotTier ? 0 : 1)) || String(x.expiry_date || "").localeCompare(String(y.expiry_date || "")));
      setMatchedPkg(usable[0] || null);
      setCheckingPkg(false);
    }).catch(() => setCheckingPkg(false));
  }, [phone, phoneOk, slot.durationMinutes, slot.peak, isGroup]);

  // โปรโมชั่นจองครั้งแรก — เฉพาะ 60 นาที และยังไม่เคยจองที่ไม่ถูกยกเลิกมาก่อนเลย (เซิร์ฟเวอร์เป็นคนชี้ขาดตอนยืนยันจริงอีกชั้น)
  const [firstTimePrice, setFirstTimePrice] = useState(null);
  useEffect(() => {
    setFirstTimePrice(null);
    if (!phoneOk || slot.durationMinutes !== 60 || isGroup) return;
    db.checkFirstTime(phone, toIso(date)).then(price => setFirstTimePrice(price)).catch(() => {});
  }, [phone, phoneOk, slot.durationMinutes, isGroup, date]);
  const firstTimeEligible = !isGroup && firstTimePrice != null && firstTimePrice < slot.price && !matchedPkg;

  const basePrice = (firstTimeEligible) ? Math.min(slot.price, firstTimePrice) : slot.price;
  const calcDiscount = (d) => {
    if (!d) return 0;
    if (d.discount_amount > 0) return d.discount_amount;
    return Math.round(basePrice * d.discount_percent / 100);
  };
  const discountAmount = (firstTimeEligible || isGroup) ? 0 : calcDiscount(discount); // โปรจองครั้งแรก ไม่ซ้อนกับโค้ดส่วนลดอื่น เพื่อความง่าย ไม่สับสน
  const finalPrice = Math.max(0, basePrice - discountAmount);

  const handleCheckCode = async () => {
    if (!discountCode.trim()) return;
    setCheckingCode(true);
    setDiscountMsg("");
    const result = await db.checkDiscount(discountCode.trim());
    if (result) {
      setDiscount(result);
      const saved = result.discount_amount > 0 ? result.discount_amount : Math.round(slot.price * result.discount_percent / 100);
      const label = result.discount_amount > 0
        ? (lang==="th" ? `ส่วนลด ฿${result.discount_amount}` : `฿${result.discount_amount} off`)
        : (lang==="th" ? `ส่วนลด ${result.discount_percent}%` : `${result.discount_percent}% off`);
      setDiscountMsg(`✅ ${label} — ${t.saveDiscount} ฿${saved}`);
    } else {
      setDiscount(null);
      setDiscountMsg(t.invalidCode);
    }
    setCheckingCode(false);
  };

  return (
    <div style={{padding:"20px 16px 100px"}} className="fu">
      <h2 className="bb" style={{fontSize:28,color:"var(--br)",marginBottom:20}}>{t.confirm}</h2>
      <div className="card" style={{marginBottom:20}}>
        <div className="card-header"><p>{t.summaryTitle}</p></div>
        <div className="card-body">
          <Row label={`🎾 ${t.court}`} val={isGroup ? courts.map(c => c.courtName).join(" + ") : court.courtName} />
          <Row label={`📅 ${t.date}`} val={fmtDate(date, lang)} />
          <Row label={`🕐 ${t.time}`} val={slot.label} />
          <Row label={`⏱ ${t.duration}`} val={`${slot.durationMinutes} ${t.minutesLabel}`} />
          {isGroup && <Row label={lang==="th"?"ราคาต่อสนาม":"Per court"} val={`฿${(slot.unitPrice ?? slot.price/courts.length).toLocaleString()} × ${courts.length}`} />}
          {firstTimeEligible && !useCredit && <Row label="🎉" val={lang==="th"?"ราคาพิเศษจองครั้งแรก":"First booking promo"} />}
          {discount && !useCredit && !firstTimeEligible && !isGroup && <Row label="🏷" val={`-฿${discountAmount.toLocaleString()}`} />}
          <div style={{borderTop:"1px solid var(--dv)",margin:"12px 0"}} />
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <span style={{fontWeight:700,color:"var(--br)",fontSize:15}}>{t.total}</span>
            <div style={{textAlign:"right"}}>
              {useCredit ? (
                <>
                  <p style={{fontSize:13,color:"var(--mu)",textDecoration:"line-through"}}>฿{slot.price.toLocaleString()}</p>
                  <span style={{fontSize:30,fontWeight:800,color:"#2d7a4f"}}>{lang==="th"?"ใช้สิทธิ์":"Credit"}</span>
                </>
              ) : (
                <>
                  {(discount || firstTimeEligible) && <p style={{fontSize:13,color:"var(--mu)",textDecoration:"line-through"}}>฿{slot.price.toLocaleString()}</p>}
                  <span style={{fontSize:30,fontWeight:800,color:"var(--or)"}}>฿{finalPrice.toLocaleString()}</span>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      <div style={{display:"flex",flexDirection:"column",gap:15,marginBottom:26}}>
        {!lineSession ? (
          <button onClick={() => onLineLogin({ dateIso: toIso(date), courtId: court.courtId, courtIds: isGroup ? courts.map(c => c.courtId) : null, slot })}
            style={{display:"flex",alignItems:"center",gap:12,padding:"13px 14px",borderRadius:10,border:"1.5px solid #06C755",background:"rgba(6,199,85,.07)",cursor:"pointer",textAlign:"left"}}>
            <span style={{background:"#06C755",color:"#fff",fontWeight:800,fontSize:11,padding:"6px 8px",borderRadius:8,flexShrink:0}}>LINE</span>
            <span>
              <span style={{display:"block",fontSize:13.5,fontWeight:700,color:"var(--br)"}}>{lang==="th"?"เข้าสู่ระบบด้วย LINE":"Sign in with LINE"}</span>
              <span style={{display:"block",fontSize:11.5,color:"var(--mu)",marginTop:2}}>{lang==="th"?"กรอกชื่อ-เบอร์ให้อัตโนมัติ ไม่ต้องพิมพ์ซ้ำทุกครั้ง":"Auto-fill your name and phone — no retyping"}</span>
            </span>
          </button>
        ) : (
          <p style={{fontSize:12,color:"#06A04A",fontWeight:600}}>✅ {lang==="th"?"เข้าสู่ระบบด้วย LINE แล้ว":"Signed in with LINE"}: {toFormName(lineSession.displayName)}</p>
        )}
        <div>
          <label style={{fontSize:13,fontWeight:600,color:"var(--br)",marginBottom:7,display:"block"}}>{t.name}</label>
          <input value={name} onChange={e => setName(e.target.value)} maxLength={16} placeholder={lang==="th"?"กรอกชื่อของท่าน":"Enter your name"}
            style={{width:"100%",padding:"13px 14px",borderRadius:10,fontSize:15,background:"#fff",border:`1.5px solid ${name&&!nameOk?"#c0392b":"var(--dv)"}`,color:"var(--tx)",outline:"none"}} />
          <p style={{fontSize:11,color:"var(--mu)",marginTop:5,textAlign:"right"}}>{name.length}/16</p>
        </div>
        <div>
          <label style={{fontSize:13,fontWeight:600,color:"var(--br)",marginBottom:7,display:"block"}}>{t.phone}</label>
          <input value={phone} onChange={e => setPhone(e.target.value.replace(/\D/g,"").slice(0,10))} placeholder="0812345678" inputMode="numeric"
            style={{width:"100%",padding:"13px 14px",borderRadius:10,fontSize:15,background:"#fff",border:`1.5px solid ${phone&&!phoneOk?"#c0392b":"var(--dv)"}`,color:"var(--tx)",outline:"none"}} />
        </div>
        {matchedPkg && (
          <div onClick={() => setUseCredit(v => !v)} style={{display:"flex",gap:10,alignItems:"flex-start",padding:"13px 14px",borderRadius:10,border:`1.5px solid ${useCredit?"var(--or)":"var(--dv)"}`,background:useCredit?"var(--or-bg)":"#fff",cursor:"pointer"}}>
            <div style={{width:20,height:20,borderRadius:6,flexShrink:0,marginTop:1,border:`2px solid ${useCredit?"var(--or)":"var(--dv)"}`,background:useCredit?"var(--or)":"#fff",display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontSize:13,fontWeight:800}}>{useCredit?"✓":""}</div>
            <div>
              <p style={{fontSize:13.5,fontWeight:700,color:"var(--br)"}}>🎟 {lang==="th"?"ใช้สิทธิ์จากแพ็คเกจ":"Use package credit"}</p>
              <p style={{fontSize:12,color:"var(--mu)",marginTop:2}}>{lang==="th"?`เหลือ ${matchedPkg.remaining_credits} ครั้ง — ไม่ต้องชำระเงินเพิ่ม`:`${matchedPkg.remaining_credits} sessions left — no extra payment needed`}</p>
              <p style={{fontSize:11,color:"var(--mu)",marginTop:3}}>{lang==="th"?"* รอแอดมินยืนยันก่อน ถึงจะหักสิทธิ์จริง (เหมือนการจองปกติ)":"* Admin confirmation required before a credit is actually deducted"}</p>
            </div>
          </div>
        )}
        {!useCredit && firstTimeEligible && (
          <div style={{display:"flex",gap:10,alignItems:"flex-start",padding:"13px 14px",borderRadius:10,border:"1.5px solid #2d7a4f",background:"rgba(45,122,79,.08)"}}>
            <span style={{fontSize:20,flexShrink:0}}>🎉</span>
            <div>
              <p style={{fontSize:13.5,fontWeight:700,color:"#2d7a4f"}}>{lang==="th"?"ยินดีต้อนรับ! ราคาพิเศษสำหรับการจองครั้งแรก":"Welcome! Special first-booking price"}</p>
              <p style={{fontSize:12,color:"var(--mu)",marginTop:2}}>{lang==="th"?`เหลือจ่ายแค่ ฿${firstTimePrice} (จากปกติ ฿${slot.price}) — ใช้ได้กับการจอง 60 นาทีครั้งแรกเท่านั้น สำหรับวันเล่นถึง ${FIRST_TIME_PROMO.endTh}`:`Only ฿${firstTimePrice} (normally ฿${slot.price}) — first 60-minute booking only, for play dates up to ${FIRST_TIME_PROMO.endEn}`}</p>
            </div>
          </div>
        )}
        {!useCredit && !firstTimeEligible && !isGroup && (
          <div>
            <label style={{fontSize:13,fontWeight:600,color:"var(--br)",marginBottom:7,display:"block"}}>{t.discount}</label>
            <div style={{display:"flex",gap:8}}>
              <input value={discountCode} onChange={e => setDiscountCode(e.target.value.toUpperCase())} placeholder="เช่น NOVA10"
                style={{flex:1,padding:"13px 14px",borderRadius:10,fontSize:15,background:"#fff",border:"1.5px solid var(--dv)",color:"var(--tx)",outline:"none"}} />
              <button onClick={handleCheckCode} disabled={checkingCode || !discountCode.trim()} style={{padding:"0 16px",borderRadius:10,border:"none",background:"var(--br)",color:"#fff",fontWeight:700,fontSize:14,cursor:"pointer",whiteSpace:"nowrap",fontFamily:"'Noto Sans Thai',sans-serif"}}>
                {checkingCode ? "..." : t.useCode}
              </button>
            </div>
            {discountMsg && <p style={{fontSize:12,marginTop:6,color:discount?"#2d7a4f":"#c0392b"}}>{discountMsg}</p>}
          </div>
        )}
      </div>

      <div style={{display:"flex",gap:12}}>
        <button onClick={onCancel} style={{flex:1,padding:"14px",borderRadius:"var(--r)",border:"1.5px solid var(--dv)",background:"#fff",color:"var(--mu)",fontSize:15,cursor:"pointer"}}>{t.cancel}</button>
        <button disabled={!ok} onClick={() => {
          if (lineSession && (lineSession.phone !== phone || lineSession.name !== name.trim())) onLinePhoneLinked?.(name.trim(), phone);
          if (useCredit && matchedPkg) {
            onConfirmWithPackage({ name: name.trim(), phone, packageId: matchedPkg.id });
            return;
          }
          if (discount) {
            const confirmed = window.confirm(lang==="th" ? "การใช้โค้ดส่วนลด หากกดดำเนินการต่อแล้วจะไม่สามารถใช้โค้ดนี้ซ้ำได้อีก" : "Once you proceed, this discount code cannot be used again.");
            if (!confirmed) return;
          }
          onConfirm({name:name.trim(),phone,discount,finalPrice,discountAmount});
        }} style={{flex:2,padding:"14px",borderRadius:"var(--r)",border:"none",background:ok?"linear-gradient(90deg,var(--or),var(--or2))":"var(--cr2)",color:ok?"#fff":"var(--mu)",fontWeight:700,fontSize:15,cursor:ok?"pointer":"not-allowed"}}>{useCredit?(lang==="th"?"ยืนยันการจอง (ใช้สิทธิ์) ✓":"Confirm Booking (Use Credit) ✓"):t.confirmBooking}</button>
      </div>
    </div>
  );
}

// resumeBooking (ถ้ามี) = { id, createdAt } ใช้ตอนกลับมาหน้านี้หลัง reload โดยไม่ต้องสร้างการจองใหม่ซ้ำ
function PaymentPage({ booking, customer, onDone, lang="th", resumeBooking, onCreated, onStartOver }) {
  const t = T[lang];
  const { date, court, slot } = booking;
  const courts = booking.courts;
  const isGroup = !!(courts && courts.length > 1);
  const courtLabel = isGroup ? courts.map(c => c.courtName).join(" + ") : court.courtName;
  const { finalPrice, discountAmount, discount } = customer;
  const initialSecs = resumeBooking
    ? Math.max(0, 300 - Math.floor((Date.now() - parseUtc(resumeBooking.createdAt).getTime())/1000))
    : 300;
  const [secs, setSecs] = useState(initialSecs);
  const [expired, setExpired] = useState(initialSecs <= 0);
  const [slip, setSlip] = useState(null);
  const [slipPreview, setSlipPreview] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploaded, setUploaded] = useState(false);
  const [bookingId, setBookingId] = useState(resumeBooking?.id || null);
  const fileRef = useRef();
  const savedRef = useRef(!!resumeBooking);

  useEffect(() => {
    const save = async () => {
      if (savedRef.current) return;
      savedRef.current = true;
      // สร้างการจอง — เซิร์ฟเวอร์เป็นคนตรวจสอบช่วงเวลาว่างและคำนวณราคาสุดท้ายเองทั้งหมด
      // จอง 2 สนามพร้อมกัน → สร้าง 2 แถวในครั้งเดียว (ไม่ใช้โค้ดส่วนลด) / จอง 1 สนามตามปกติ
      const { booking: b, error } = isGroup
        ? await db.createBookingMulti({
            courtIds: courts.map(c => c.courtId),
            customerId: customer.phone,
            customerName: customer.name,
            bookingDate: toIso(date),
            hour: slot.hour,
            startMinute: slot.startMinute || 0,
            durationMinutes: slot.durationMinutes || 60,
          })
        : await db.createBooking({
            courtId: court.courtId,
            customerId: customer.phone,
            customerName: customer.name,
            bookingDate: toIso(date),
            hour: slot.hour,
            startMinute: slot.startMinute || 0,
            durationMinutes: slot.durationMinutes || 60,
            discountCodeId: discount?.id || null,
          });
      if (error) {
        // ช่วงเวลานี้เพิ่งถูกจองไปโดยคนอื่นพอดี (แข่งกันจองพร้อมกัน) — แจ้งแล้วพากลับหน้าจอง
        alert(lang==="th" ? "ขออภัย ช่วงเวลานี้เพิ่งถูกจองไปแล้ว กรุณาเลือกช่วงเวลาใหม่" : "Sorry, this time slot was just booked. Please choose another time.");
        onDone(customer.phone);
        return;
      }
      if (b) {
        setBookingId(b.id);
        // เก็บ bookingId ไว้ทั้งใน URL และ localStorage — ถ้าเบราว์เซอร์รีโหลดตอนออกไปสแกนจ่ายเงินแล้วกลับมา
        // (โดยเฉพาะ in-app browser บางตัวที่อาจล้าง query string ตอนโหลดใหม่)
        // ระบบจะดึงการจองนี้กลับมาที่หน้าแนบสลิปได้ทันที ไม่หลุดกลับไปหน้าแรก
        try {
          const url = new URL(window.location.href);
          url.searchParams.set("booking", b.id);
          window.history.replaceState(null, "", url.toString());
        } catch { /* no-op */ }
        try {
          localStorage.setItem("nova_pending_booking", JSON.stringify({ id: b.id, createdAt: b.created_time }));
        } catch { /* no-op */ }
        // แจ้งขึ้นไปให้ AppV2 รู้จักการจองนี้ด้วย (แม้เป็นการจองใหม่ ไม่ใช่ resume) — เพื่อให้แถบ
        // "กลับไปชำระเงิน" คำนวณเวลาที่เหลือได้ถูกต้อง ไม่ว่าจะออกจากหน้านี้ไปทางไหนก็ตาม
        onCreated?.(b.id, b.created_time);
      }
    };
    save();
  }, []);

  useEffect(() => {
    if (secs <= 0) { setExpired(true); return; }
    const timer = setTimeout(() => setSecs(s => s-1), 1000);
    return () => clearTimeout(timer);
  }, [secs]);

  const mm = String(Math.floor(Math.max(secs,0)/60)).padStart(2,"0");
  const ss = String(Math.max(secs,0)%60).padStart(2,"0");
  const pct = (Math.max(secs,0)/300)*100;
  const urgent = secs <= 60 && !expired;

  const handleSlipChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setSlip(file);
    setSlipPreview(URL.createObjectURL(file));
  };

  const handleUpload = async () => {
    if (!slip || !bookingId) return;
    setUploading(true);
    const url = await db.uploadSlip(slip, bookingId);
    if (url) {
      const updated = await db.updateSlip(bookingId, url);
      if (!updated) {
        // อัปเดตสถานะไม่สำเร็จจริง — ไม่ถือว่าส่งสลิปสำเร็จ ไม่แจ้งเตือนแอดมิน ให้ลูกค้าลองใหม่
        setUploading(false);
        alert(lang==="th" ? "ส่งสลิปไม่สำเร็จ กรุณาลองใหม่อีกครั้ง หรือติดต่อร้านโดยตรง" : "Failed to submit slip. Please try again or contact us directly.");
        return;
      }
      setUploaded(true);
      fetch("/api/notify-admin-telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          courtName: courtLabel,
          date: fmtDate(date, lang),
          time: slot.label,
          price: finalPrice,
          name: customer.name,
          phone: customer.phone,
        }),
      }).catch(() => {});
    }
    setUploading(false);
  };

  return (
    <div style={{padding:"20px 16px 90px"}} className="fu">
      <h2 className="bb" style={{fontSize:28,color:"var(--br)",marginBottom:18}}>{t.payment}</h2>

      <div style={{background:"#fff",borderRadius:"var(--r)",marginBottom:16,border:`1.5px solid ${expired?"#c0392b":urgent?"#e67e22":"var(--dv)"}`,padding:"16px 20px",textAlign:"center",boxShadow:"var(--sh)"}}>
        <p style={{fontSize:12,color:"var(--mu)",marginBottom:3}}>{expired?t.timeExpired:t.payWithin}</p>
        <p className="bb" style={{fontSize:54,lineHeight:1,color:expired?"#c0392b":urgent?"#e67e22":"var(--br)"}}>{mm}:{ss}</p>
        <div style={{height:4,background:"var(--cr2)",borderRadius:4,marginTop:12,overflow:"hidden"}}>
          <div style={{height:"100%",borderRadius:4,width:`${pct}%`,background:expired?"#c0392b":urgent?"#e67e22":"var(--or)",transition:"width 1s linear"}} />
        </div>
        {expired && onStartOver && !uploaded && (
          <button onClick={onStartOver} style={{marginTop:12,background:"none",border:"none",color:"#c0392b",fontSize:12.5,textDecoration:"underline",cursor:"pointer",fontFamily:"'Noto Sans Thai',sans-serif"}}>
            {lang==="th" ? "ยกเลิกรายการนี้ แล้วเริ่มจองใหม่" : "Cancel this and start a new booking"}
          </button>
        )}
      </div>

      <div style={{background:"#fff",borderRadius:"var(--r)",padding:"20px",textAlign:"center",boxShadow:"0 4px 24px rgba(102,57,36,.12)",marginBottom:16,border:"1px solid var(--dv)"}}>
        <p style={{fontSize:13,color:"var(--mu)",marginBottom:12}}>{t.scanQR}</p>
        <img src="/qr-payment.png" alt="PromptPay QR" style={{width:200,height:200,objectFit:"contain",borderRadius:10,border:"1px solid var(--dv)",background:"#fff"}} />
        <div style={{marginTop:14,display:"inline-flex",alignItems:"center",gap:8,background:"var(--or-bg)",borderRadius:20,padding:"8px 18px"}}>
          <span style={{fontSize:24,fontWeight:800,color:"var(--or)"}}>฿{finalPrice.toLocaleString()}</span>
          <span style={{fontSize:12,color:"var(--mu)"}}>{t.transfer}</span>
        </div>
        <div style={{marginTop:12,padding:"10px 14px",background:"var(--cr)",borderRadius:10}}>
          <p style={{fontSize:11,color:"var(--mu)"}}>{t.accountName}</p>
          <p style={{fontSize:14,fontWeight:700,color:"var(--br)"}}>{PAYMENT_ACCOUNT_NAME}</p>
          <p style={{fontSize:12,color:"var(--mu)",marginTop:2}}>{PAYMENT_PHONE} (PromptPay)</p>
        </div>
        {discountAmount > 0 && (
          <p style={{fontSize:12,color:"#2d7a4f",marginTop:8}}>🏷 {t.saveDiscount} ฿{discountAmount.toLocaleString()}</p>
        )}
      </div>

      <div className="card" style={{marginBottom:16}}>
        <div className="card-header"><p>{t.bookingDetail}</p></div>
        <div className="card-body">
          <Row label="👤" val={customer.name} />
          <Row label="📞" val={customer.phone} />
          <Row label={`🎾 ${t.court}`} val={courtLabel} />
          <Row label={`📅 ${t.date}`} val={fmtDate(date, lang)} />
          <Row label={`🕐 ${t.time}`} val={slot.label} />
        </div>
      </div>

      <div className="card" style={{marginBottom:16}}>
        <div className="card-header"><p>{t.uploadSlip}</p></div>
        <div className="card-body">
          {uploaded ? (
            <div style={{textAlign:"center",padding:"10px 0"}}>
              <p style={{color:"#2d7a4f",fontWeight:700,fontSize:15}}>{t.slipSent}</p>
              <p style={{color:"var(--mu)",fontSize:13,marginTop:4}}>{t.slipSentDesc}</p>
            </div>
          ) : (
            <>
              {slipPreview && (
                <img src={slipPreview} alt="slip" style={{width:"100%",borderRadius:10,marginBottom:12,maxHeight:200,objectFit:"cover"}} />
              )}
              <input ref={fileRef} type="file" accept="image/*" onChange={handleSlipChange} style={{display:"none"}} />
              <button onClick={() => fileRef.current.click()} style={{width:"100%",padding:"12px",borderRadius:10,border:"1.5px dashed var(--or)",background:"var(--or-bg)",color:"var(--or)",fontWeight:600,fontSize:14,cursor:"pointer",fontFamily:"'Noto Sans Thai',sans-serif"}}>
                {slip ? t.changeSlip : t.selectSlip}
              </button>
              {!slip && <p style={{fontSize:12,color:"var(--mu)",marginTop:8,textAlign:"center"}}>{lang==="th"?`กรุณาเลือกรูปสลิปก่อนกดปุ่ม "ส่งสลิป" ด้านล่าง`:`Please select a slip image before pressing "Send Slip" below`}</p>}
            </>
          )}
        </div>
      </div>

      <div className="card" style={{marginBottom:24}}>
        <div style={{padding:"11px 18px",borderBottom:"1px solid var(--dv)",background:"var(--bl-bg)"}}>
          <p style={{fontWeight:700,color:"var(--br)",fontSize:14}}>{t.steps}</p>
        </div>
        <div style={{padding:"14px 18px",display:"flex",flexDirection:"column",gap:12}}>
          {t.stepsList.map((s,i) => (
            <div key={i} style={{display:"flex",gap:12,alignItems:"flex-start"}}>
              <div style={{width:24,height:24,borderRadius:"50%",flexShrink:0,background:"var(--br)",color:"var(--or)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:800,marginTop:1}}>{i+1}</div>
              <p style={{fontSize:13.5,color:"var(--mu)",lineHeight:1.65}}>{s}</p>
            </div>
          ))}
        </div>
      </div>

      {uploaded ? (
        <button className="btn-primary" onClick={() => onDone(customer.phone)}>{t.checkMyBooking} →</button>
      ) : (
        <button className="btn-primary" disabled={!slip || uploading} onClick={handleUpload} style={{opacity:(!slip||uploading)?0.6:1,cursor:(!slip||uploading)?"not-allowed":"pointer"}}>
          {uploading ? t.sending : t.sendSlip}
        </button>
      )}

      {/* popup แจ้งข้อควรเตรียมก่อนเข้าสนาม — ขึ้นหลังแนบสลิปสำเร็จ */}
      {uploaded && (
        <div style={{position:"fixed",inset:0,zIndex:400,background:"rgba(46,26,14,.55)",display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div className="fu" style={{background:"#fff",borderRadius:18,padding:"24px 22px",maxWidth:360,width:"100%",maxHeight:"85vh",overflowY:"auto",boxShadow:"0 20px 60px rgba(0,0,0,.35)"}}>
            <p style={{fontSize:17,fontWeight:800,color:"var(--br)",marginBottom:6}}>{lang==="th" ? "✅ ส่งสลิปเรียบร้อยแล้ว" : "✅ Slip submitted"}</p>
            <p style={{fontSize:12.5,color:"var(--mu)",marginBottom:16}}>{lang==="th" ? "สถานะ: รอการยืนยัน — ทีมงานกำลังตรวจสอบ" : "Status: awaiting confirmation"}</p>
            <div style={{background:"var(--or-bg)",border:"1px solid rgba(244,126,31,.25)",borderRadius:12,padding:"14px 14px",marginBottom:12}}>
              <p style={{fontSize:14,fontWeight:700,color:"var(--br)",lineHeight:1.7}}>
                {lang==="th"
                  ? "กรุณาเตรียมรองเท้ากีฬา รองเท้าเทนนิส รองเท้าวิ่ง หรือรองเท้ายิม มาให้เรียบร้อย รองเท้าประเภทอื่นไม่อนุญาตให้เดินในสนามทุกกรณี"
                  : "Please bring your sports shoes — tennis, running, or gym shoes. Other types of footwear are not allowed on the court under any circumstances."}
              </p>
            </div>
            <p style={{fontSize:13,color:"var(--tx)",lineHeight:1.7,marginBottom:6}}>
              {lang==="th" ? "* หากต้องการเดินสามารถถอดรองเท้าเดินได้เลยค่ะ" : "* If you prefer, you may take your shoes off and walk on the court without them."}
            </p>
            <p style={{fontSize:13,fontWeight:700,color:"var(--br)",lineHeight:1.7,marginBottom:18}}>
              {lang==="th" ? "** เข้าใช้สนามได้สูงสุด 4 คนต่อห้องเท่านั้น" : "** A maximum of 4 people per room."}
            </p>
            <button className="btn-primary" onClick={() => onDone(customer.phone)}>{lang==="th" ? "รับทราบ" : "Got it"}</button>
          </div>
        </div>
      )}
    </div>
  );
}

function StepHead({ n, label }) {
  return (
    <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:13}}>
      <div style={{width:28,height:28,borderRadius:"50%",background:"var(--br)",color:"var(--or)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,fontWeight:800}}>{n}</div>
      <span style={{fontWeight:700,fontSize:16,color:"var(--br)"}}>{label}</span>
    </div>
  );
}

function Row({ label, val }) {
  return (
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:9,gap:12}}>
      <span style={{color:"var(--mu)",fontSize:13,flexShrink:0}}>{label}</span>
      <span style={{fontWeight:600,fontSize:13,color:"var(--tx)",textAlign:"right"}}>{val}</span>
    </div>
  );
}

function Dot({ color, label }) {
  return (
    <div style={{display:"flex",alignItems:"center",gap:6}}>
      <div style={{width:9,height:9,borderRadius:"50%",background:color,flexShrink:0}} />
      <span style={{fontSize:12,color:"var(--mu)"}}>{label}</span>
    </div>
  );
}

// ─── Package (แพ็คเกจสมาชิก) ──────────────────────────────────────────────────
function PackagePage({ lang="th", lineSession, onLineLogin, onLinePhoneLinked }) {
  const t = T[lang];
  const [selected, setSelected] = useState(null); // { tier, credits, price, days }
  const [name, setName] = useState(() => toFormName(lineSession?.name || lineSession?.displayName));
  const [phone, setPhone] = useState(() => lineSession?.phone || "");
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState("");
  const [pkg, setPkg] = useState(null); // แพ็คเกจที่สร้างแล้ว รอชำระเงิน

  const [lookupPhone, setLookupPhone] = useState(() => lineSession?.phone || "");
  const [myPkgs, setMyPkgs] = useState([]);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  // ล็อกอิน LINE แล้วและมีเบอร์ที่ผูกไว้ → แสดงแพ็คเกจของฉันให้เลย ไม่ต้องกดค้นหา
  useEffect(() => {
    const ph = lineSession?.phone;
    if (!ph || !/^[0-9]{10}$/.test(ph)) return;
    setLookupLoading(true);
    db.myPackages(ph).then(rows => { setMyPkgs(rows || []); setSearched(true); }).catch(() => {}).finally(() => setLookupLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineSession?.phone]);

  const nameOk = name.trim().length >= 1 && name.length <= 16;
  const phoneOk = /^[0-9]{10}$/.test(phone);

  const handleLookup = async () => {
    if (!/^[0-9]{10}$/.test(lookupPhone)) return;
    setLookupLoading(true); setSearched(false);
    const rows = await db.myPackages(lookupPhone);
    setMyPkgs(rows || []); setLookupLoading(false); setSearched(true);
  };

  const handleBuy = async () => {
    if (!selected || !nameOk || !phoneOk || creating) return;
    if (lineSession && (lineSession.phone !== phone || lineSession.name !== name.trim())) onLinePhoneLinked?.(name.trim(), phone);
    setCreating(true); setCreateErr("");
    const { package: pkgRow, error } = await db.createPackage({
      tier: selected.tier, credits: selected.credits, customerId: phone, customerName: name.trim(),
    });
    setCreating(false);
    if (error || !pkgRow) { setCreateErr(lang==="th" ? "สร้างรายการไม่สำเร็จ ลองใหม่อีกครั้ง" : "Failed to create order, please try again"); return; }
    setPkg(pkgRow);
  };

  if (pkg) {
    return <PackagePaymentView pkg={pkg} lang={lang} onDone={() => { setPkg(null); setSelected(null); setName(""); setPhone(""); }} />;
  }

  const pkgStatusInfo = (s) => {
    if (s === "active") return { text: lang==="th"?"ใช้งานได้":"Active", color: "#2d7a4f" };
    if (s === "reviewing") return { text: lang==="th"?"รอการยืนยัน":"Awaiting confirmation", color: "#e67e22" };
    if (s === "cancelled") return { text: lang==="th"?"ยกเลิกแล้ว":"Cancelled", color: "#c0392b" };
    return { text: lang==="th"?"รอชำระเงิน":"Awaiting payment", color: "var(--mu)" };
  };

  return (
    <div style={{padding:"20px 16px 100px",display:"flex",flexDirection:"column",gap:22}} className="fu">
      <section>
        <h2 className="bb" style={{fontSize:26,color:"var(--br)",marginBottom:4}}>{lang==="th"?"แพ็คเกจสมาชิก":"Membership Packages"}</h2>
        <p style={{fontSize:12.5,color:"var(--mu)"}}>{lang==="th"?"ซื้อจำนวนครั้งล่วงหน้า ถูกกว่าจ่ายเดี่ยว ใช้จองได้ภายในระยะเวลาที่กำหนด (จองได้ครั้งละ 60 นาทีเท่านั้น)":"Buy sessions in advance, cheaper than paying per visit. Each credit books a 60-minute session."}</p>
      </section>

      <section>
        <div style={{background:"var(--bl-bg)",border:"1px solid rgba(141,182,199,.4)",borderRadius:12,padding:"14px 16px"}}>
          <p style={{fontSize:13,fontWeight:700,color:"var(--br)",marginBottom:8}}>{lang==="th"?"📌 วิธีใช้สิทธิ์แพ็คเกจ":"📌 How to use your package"}</p>
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            {(lang==="th" ? [
              "เลือกและซื้อแพ็คเกจด้านล่าง แล้วโอนเงิน + แนบสลิป",
              "รอแอดมินตรวจสอบและกดยืนยัน (แพ็คเกจจะเริ่มนับอายุการใช้งานตั้งแต่ตอนนั้น)",
              "ไปที่แท็บ \"จองสนาม\" ตามปกติ — แพ็ค Peak จองได้ทุกช่วงเวลา (ทั้ง Peak และ Off Peak) ส่วนแพ็ค Off Peak จองได้เฉพาะช่วง Off Peak",
              "ตอนกรอกชื่อ-เบอร์โทร ถ้ามีสิทธิ์คงเหลือ ระบบจะโชว์ตัวเลือก \"ใช้สิทธิ์จากแพ็คเกจ\" ให้กดเลือกแทนการโอนเงิน",
              "แอดมินจะกดยืนยันการจองนี้อีกครั้ง (เหมือนการจองปกติ) ถึงจะหักสิทธิ์จริง",
            ] : [
              "Choose and buy a package below, then transfer and upload your payment slip",
              "Wait for admin to verify and confirm (the package's validity period starts from then)",
              "Go to the \"Book\" tab as usual — a Peak package works for any time (Peak and Off Peak); an Off Peak package works for Off Peak times only",
              "When entering your name/phone, if you have credits left, you'll see an option to \"Use package credit\" instead of paying",
              "Admin will confirm this booking (same as a normal booking) — only then is a credit actually deducted",
            ]).map((txt,i) => (
              <div key={i} style={{display:"flex",gap:8,alignItems:"flex-start"}}>
                <span style={{fontSize:11.5,fontWeight:800,color:"var(--br)",flexShrink:0}}>{i+1}.</span>
                <p style={{fontSize:12,color:"var(--tx)",lineHeight:1.6}}>{txt}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ค้นหาแพ็คเกจของฉัน */}
      <section>
        <StepHead n="🔍" label={lang==="th"?"แพ็คเกจของฉัน":"My Packages"} />
        <div style={{display:"flex",gap:8,marginBottom:12}}>
          <input value={lookupPhone} onChange={e => setLookupPhone(e.target.value.replace(/\D/g,"").slice(0,10))}
            placeholder={t.searchPlaceholder} inputMode="numeric"
            style={{flex:1,padding:"13px 14px",borderRadius:10,fontSize:15,background:"#fff",border:"1.5px solid var(--dv)",color:"var(--tx)",outline:"none"}} />
          <button onClick={handleLookup} disabled={lookupLoading || lookupPhone.length < 10} style={{padding:"0 18px",borderRadius:10,border:"none",background:"var(--br)",color:"var(--or)",fontWeight:700,fontSize:14,cursor:"pointer",fontFamily:"'Noto Sans Thai',sans-serif",whiteSpace:"nowrap"}}>
            {lookupLoading ? "..." : t.searchBtn}
          </button>
        </div>
        {searched && myPkgs.length === 0 && (
          <div style={{background:"#fff",borderRadius:"var(--r)",padding:"20px",textAlign:"center",border:"1px solid var(--dv)"}}>
            <p style={{color:"var(--mu)",fontSize:13.5}}>{lang==="th"?"ไม่พบแพ็คเกจสำหรับเบอร์นี้":"No packages found for this number"}</p>
          </div>
        )}
        {myPkgs.length > 0 && (
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {myPkgs.map(p => {
              const st = pkgStatusInfo(p.status);
              const expired = p.status==="active" && p.expiry_date && new Date(p.expiry_date+"T23:59:59") < new Date();
              return (
                <div key={p.id} className="card">
                  <div style={{padding:"13px 16px"}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                      <span style={{fontWeight:700,color:"var(--br)",fontSize:14}}>{p.tier==="peak"?"Peak":"Off Peak"} × {p.total_credits} {lang==="th"?"ครั้ง":"sessions"}</span>
                      <span style={{fontSize:11.5,fontWeight:600,color:expired?"#c0392b":st.color,background:`${expired?"#c0392b":st.color}18`,padding:"3px 9px",borderRadius:20}}>
                        {expired ? (lang==="th"?"หมดอายุแล้ว":"Expired") : st.text}
                      </span>
                    </div>
                    {p.status==="active" && !expired && (
                      <>
                        <Row label={lang==="th"?"เหลือ":"Remaining"} val={`${p.remaining_credits} / ${p.total_credits} ${lang==="th"?"ครั้ง":"sessions"}`} />
                        <Row label={lang==="th"?"หมดอายุ":"Expires"} val={new Date(p.expiry_date).toLocaleDateString(lang==="th"?"th-TH":"en-GB",{year:"numeric",month:"short",day:"numeric"})} />
                      </>
                    )}
                    {(p.status==="pending" || p.status==="reviewing") && (
                      <Row label={lang==="th"?"อายุการใช้งาน":"Valid for"} val={lang==="th"?`${p.expiry_days} วัน นับจากวันที่ยืนยัน`:`${p.expiry_days} days from confirmation`} />
                    )}
                    <Row label={t.rowPrice} val={`฿${p.price?.toLocaleString()}`} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* เลือกซื้อแพ็คเกจใหม่ */}
      <section>
        <StepHead n="🎟" label={lang==="th"?"ซื้อแพ็คเกจใหม่":"Buy a New Package"} />
        {["offpeak","peak"].map(tier => (
          <div key={tier} style={{marginBottom:14}}>
            <p style={{fontSize:13,fontWeight:700,color:"var(--br)",marginBottom:8}}>
              {tier==="peak" ? "Peak" : "Off Peak"}
              <span style={{fontWeight:400,color:"var(--mu)",fontSize:11.5,marginLeft:6}}>
                {tier==="peak" ? (lang==="th"?"(ใช้ได้ทุกช่วงเวลา: Peak + Off Peak)":"(valid for all times: Peak + Off Peak)") : (lang==="th"?"(เฉพาะ จ.-ศ. 06:00–16:00)":"(Mon-Fri 06:00–16:00 only)")}
              </span>
            </p>
            <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>
              {PACKAGE_TIERS[tier].map(opt => {
                const sel = selected?.tier===tier && selected?.credits===opt.credits;
                return (
                  <button key={opt.credits} onClick={() => setSelected({ tier, ...opt })}
                    style={{padding:"12px 6px",borderRadius:10,border:`2px solid ${sel?"var(--or)":"var(--dv)"}`,background:sel?"var(--or-bg)":"#fff",cursor:"pointer",textAlign:"center"}}>
                    <p className="bb" style={{fontSize:20,color:sel?"var(--or)":"var(--br)",lineHeight:1}}>{opt.credits}</p>
                    <p style={{fontSize:10,color:"var(--mu)",marginTop:2}}>{lang==="th"?"ครั้ง":"sessions"}</p>
                    <p style={{fontSize:10.5,color:"var(--mu)",textDecoration:"line-through",marginTop:4}}>฿{opt.fullPrice.toLocaleString()}</p>
                    <p style={{fontSize:14,fontWeight:800,color:sel?"var(--or)":"var(--br)"}}>฿{opt.price.toLocaleString()}</p>
                    <p style={{fontSize:9.5,color:"var(--mu)",marginTop:2}}>{lang==="th"?`อายุการใช้งาน ${opt.days} วัน`:`Valid ${opt.days} days`}</p>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </section>

      {selected && (
        <section>
          <StepHead n="📝" label={lang==="th"?"กรอกข้อมูลผู้ซื้อ":"Buyer Info"} />
          <div className="card" style={{marginBottom:14}}>
            <div className="card-body">
              <Row label={lang==="th"?"แพ็คเกจที่เลือก":"Selected package"} val={`${selected.tier==="peak"?"Peak":"Off Peak"} × ${selected.credits} ${lang==="th"?"ครั้ง":"sessions"}`} />
              <Row label={t.total} val={`฿${selected.price.toLocaleString()}`} />
            </div>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:15,marginBottom:16}}>
            {!lineSession ? (
              <button onClick={() => onLineLogin(null)}
                style={{display:"flex",alignItems:"center",gap:12,padding:"13px 14px",borderRadius:10,border:"1.5px solid #06C755",background:"rgba(6,199,85,.07)",cursor:"pointer",textAlign:"left"}}>
                <span style={{background:"#06C755",color:"#fff",fontWeight:800,fontSize:11,padding:"6px 8px",borderRadius:8,flexShrink:0}}>LINE</span>
                <span>
                  <span style={{display:"block",fontSize:13.5,fontWeight:700,color:"var(--br)"}}>{lang==="th"?"เข้าสู่ระบบด้วย LINE":"Sign in with LINE"}</span>
                  <span style={{display:"block",fontSize:11.5,color:"var(--mu)",marginTop:2}}>{lang==="th"?"กรอกชื่อ-เบอร์ให้อัตโนมัติ และดูแพ็คเกจของคุณได้ทันที":"Auto-fill your details and see your packages instantly"}</span>
                </span>
              </button>
            ) : (
              <p style={{fontSize:12,color:"#06A04A",fontWeight:600}}>✅ {lang==="th"?"เข้าสู่ระบบด้วย LINE แล้ว":"Signed in with LINE"}: {toFormName(lineSession.displayName)}</p>
            )}
            <div>
              <label style={{fontSize:13,fontWeight:600,color:"var(--br)",marginBottom:7,display:"block"}}>{t.name}</label>
              <input value={name} onChange={e => setName(e.target.value)} maxLength={16} placeholder={lang==="th"?"กรอกชื่อของท่าน":"Enter your name"}
                style={{width:"100%",padding:"13px 14px",borderRadius:10,fontSize:15,background:"#fff",border:`1.5px solid ${name&&!nameOk?"#c0392b":"var(--dv)"}`,color:"var(--tx)",outline:"none"}} />
            </div>
            <div>
              <label style={{fontSize:13,fontWeight:600,color:"var(--br)",marginBottom:7,display:"block"}}>{t.phone}</label>
              <input value={phone} onChange={e => setPhone(e.target.value.replace(/\D/g,"").slice(0,10))} placeholder="0812345678" inputMode="numeric"
                style={{width:"100%",padding:"13px 14px",borderRadius:10,fontSize:15,background:"#fff",border:`1.5px solid ${phone&&!phoneOk?"#c0392b":"var(--dv)"}`,color:"var(--tx)",outline:"none"}} />
            </div>
          </div>
          {createErr && <p style={{fontSize:12,color:"#c0392b",marginBottom:10}}>{createErr}</p>}
          <button className="btn-primary" disabled={!nameOk || !phoneOk || creating} onClick={handleBuy} style={{opacity:(!nameOk||!phoneOk||creating)?0.6:1,cursor:(!nameOk||!phoneOk||creating)?"not-allowed":"pointer"}}>
            {creating ? "..." : (lang==="th" ? "ดำเนินการชำระเงิน →" : "Proceed to Payment →")}
          </button>
        </section>
      )}
    </div>
  );
}

// หน้าชำระเงินสำหรับแพ็คเกจ (QR + แนบสลิป) — คล้ายหน้าชำระเงินจองสนาม แต่เรียบง่ายกว่า
function PackagePaymentView({ pkg, lang="th", onDone }) {
  const t = T[lang];
  const [secs, setSecs] = useState(300);
  const [expired, setExpired] = useState(false);
  const [slip, setSlip] = useState(null);
  const [slipPreview, setSlipPreview] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploaded, setUploaded] = useState(false);
  const fileRef = useRef();

  useEffect(() => {
    if (secs <= 0) { setExpired(true); return; }
    const timer = setTimeout(() => setSecs(s => s-1), 1000);
    return () => clearTimeout(timer);
  }, [secs]);

  const mm = String(Math.floor(Math.max(secs,0)/60)).padStart(2,"0");
  const ss = String(Math.max(secs,0)%60).padStart(2,"0");

  const handleSlipChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setSlip(file);
    setSlipPreview(URL.createObjectURL(file));
  };

  const handleUpload = async () => {
    if (!slip) return;
    setUploading(true);
    const url = await db.uploadSlip(slip, `pkg_${pkg.id}`);
    if (url) {
      const updated = await db.updatePackageSlip(pkg.id, url);
      if (!updated) {
        setUploading(false);
        alert(lang==="th" ? "ส่งสลิปไม่สำเร็จ กรุณาลองใหม่อีกครั้ง หรือติดต่อร้านโดยตรง" : "Failed to submit slip. Please try again or contact us directly.");
        return;
      }
      setUploaded(true);
      fetch("/api/notify-admin-telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          courtName: `🎟 แพ็คเกจ ${pkg.tier==="peak"?"Peak":"Off Peak"} × ${pkg.total_credits} ครั้ง`,
          date: "-", time: "-", price: pkg.price, name: pkg.customer_name, phone: pkg.customer_id,
        }),
      }).catch(() => {});
    }
    setUploading(false);
  };

  const handleStartOver = () => {
    if (!expired) return;
    db.cancelPendingPackage(pkg.id).catch(() => {});
    onDone();
  };

  return (
    <div style={{padding:"20px 16px 90px"}} className="fu">
      <h2 className="bb" style={{fontSize:28,color:"var(--br)",marginBottom:18}}>{t.payment}</h2>

      <div style={{background:"#fff",borderRadius:"var(--r)",marginBottom:16,border:`1.5px solid ${expired?"#c0392b":"var(--dv)"}`,padding:"16px 20px",textAlign:"center",boxShadow:"var(--sh)"}}>
        <p style={{fontSize:12,color:"var(--mu)",marginBottom:3}}>{expired?t.timeExpired:t.payWithin}</p>
        <p className="bb" style={{fontSize:54,lineHeight:1,color:expired?"#c0392b":"var(--br)"}}>{mm}:{ss}</p>
        {expired && !uploaded && (
          <button onClick={handleStartOver} style={{marginTop:12,background:"none",border:"none",color:"#c0392b",fontSize:12.5,textDecoration:"underline",cursor:"pointer",fontFamily:"'Noto Sans Thai',sans-serif"}}>
            {lang==="th" ? "ยกเลิกรายการนี้" : "Cancel this order"}
          </button>
        )}
      </div>

      <div style={{background:"#fff",borderRadius:"var(--r)",padding:"20px",textAlign:"center",boxShadow:"0 4px 24px rgba(102,57,36,.12)",marginBottom:16,border:"1px solid var(--dv)"}}>
        <p style={{fontSize:13,color:"var(--mu)",marginBottom:12}}>{t.scanQR}</p>
        <img src="/qr-package.png" alt="Package payment QR" style={{width:200,height:200,objectFit:"contain",borderRadius:10,border:"1px solid var(--dv)",background:"#fff"}} />
        <div style={{marginTop:14,display:"inline-flex",alignItems:"center",gap:8,background:"var(--or-bg)",borderRadius:20,padding:"8px 18px"}}>
          <span style={{fontSize:24,fontWeight:800,color:"var(--or)"}}>฿{pkg.price.toLocaleString()}</span>
        </div>
        <div style={{marginTop:12,padding:"10px 14px",background:"var(--cr)",borderRadius:10}}>
          <p style={{fontSize:11,color:"var(--mu)"}}>{t.accountName}</p>
          <p style={{fontSize:14,fontWeight:700,color:"var(--br)"}}>{PAYMENT_ACCOUNT_NAME}</p>
          <p style={{fontSize:12,color:"var(--mu)",marginTop:2}}>{lang==="th"?"บัญชี":"Account"} xxx-x-x0085-x</p>
          <p style={{fontSize:11,color:"var(--mu)",marginTop:2}}>{lang==="th"?"รับโอนได้จากทุกธนาคาร":"Accepts all banks"}</p>
        </div>
      </div>

      <div className="card" style={{marginBottom:16}}>
        <div className="card-header"><p>{t.bookingDetail}</p></div>
        <div className="card-body">
          <Row label="👤" val={pkg.customer_name} />
          <Row label="📞" val={pkg.customer_id} />
          <Row label="🎟" val={`${pkg.tier==="peak"?"Peak":"Off Peak"} × ${pkg.total_credits} ${lang==="th"?"ครั้ง":"sessions"}`} />
        </div>
      </div>

      <div className="card" style={{marginBottom:24}}>
        <div className="card-header"><p>{t.uploadSlip}</p></div>
        <div className="card-body">
          {uploaded ? (
            <div style={{textAlign:"center",padding:"10px 0"}}>
              <p style={{color:"#2d7a4f",fontWeight:700,fontSize:15}}>{t.slipSent}</p>
              <p style={{color:"var(--mu)",fontSize:13,marginTop:4}}>{lang==="th"?"ทีมงานจะตรวจสอบและเปิดใช้งานแพ็คเกจให้ภายในไม่นาน":"Our team will verify and activate your package shortly."}</p>
            </div>
          ) : (
            <>
              {slipPreview && <img src={slipPreview} alt="slip" style={{width:"100%",borderRadius:10,marginBottom:12,maxHeight:200,objectFit:"cover"}} />}
              <input ref={fileRef} type="file" accept="image/*" onChange={handleSlipChange} style={{display:"none"}} />
              <button onClick={() => fileRef.current.click()} style={{width:"100%",padding:"12px",borderRadius:10,border:"1.5px dashed var(--or)",background:"var(--or-bg)",color:"var(--or)",fontWeight:600,fontSize:14,cursor:"pointer",fontFamily:"'Noto Sans Thai',sans-serif"}}>
                {slip ? t.changeSlip : t.selectSlip}
              </button>
            </>
          )}
        </div>
      </div>

      {uploaded ? (
        <button className="btn-primary" onClick={onDone}>{lang==="th"?"เสร็จสิ้น":"Done"}</button>
      ) : (
        <button className="btn-primary" disabled={!slip || uploading} onClick={handleUpload} style={{opacity:(!slip||uploading)?0.6:1,cursor:(!slip||uploading)?"not-allowed":"pointer"}}>
          {uploading ? t.sending : t.sendSlip}
        </button>
      )}
    </div>
  );
}

// ─── Cancel / Check Booking Page ─────────────────────────────────────────────
function CancelPage({ lang="th", initialPhone="" }) {
  const t = T[lang];
  const [phone, setPhone] = useState(initialPhone);
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const handleSearch = async (phoneToSearch) => {
    const p = phoneToSearch || phone;
    if (!/^[0-9]{10}$/.test(p)) return;
    setLoading(true); setSearched(false); setBookings([]);
    const data = await db.myBookings(p);
    setBookings(data || []);
    setLoading(false); setSearched(true);
  };

  useEffect(() => {
    if (initialPhone && /^[0-9]{10}$/.test(initialPhone)) {
      handleSearch(initialPhone);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPhone]);

  const statusLabel = (s) => {
    if (s === "cancelled") return { text: t.statusCancelled, color: "#c0392b" };
    if (s === "reviewing") return { text: t.statusReviewing, color: "#e67e22" };
    if (s === "confirmed") return { text: t.statusConfirmed, color: "#2d7a4f" };
    return { text: t.statusPending, color: "var(--mu)" };
  };

  return (
    <div style={{padding:"20px 16px 100px"}} className="fu">
      <h2 className="bb" style={{fontSize:28,color:"var(--br)",marginBottom:20}}>{t.myBookings}</h2>
      <div style={{display:"flex",gap:8,marginBottom:20}}>
        <input value={phone} onChange={e => setPhone(e.target.value.replace(/\D/g,"").slice(0,10))}
          placeholder={t.searchPlaceholder} inputMode="numeric"
          style={{flex:1,padding:"13px 14px",borderRadius:10,fontSize:15,background:"#fff",border:"1.5px solid var(--dv)",color:"var(--tx)",outline:"none"}} />
        <button onClick={() => handleSearch()} disabled={loading || phone.length < 10} style={{padding:"0 18px",borderRadius:10,border:"none",background:"var(--br)",color:"var(--or)",fontWeight:700,fontSize:14,cursor:"pointer",fontFamily:"'Noto Sans Thai',sans-serif",whiteSpace:"nowrap"}}>
          {loading ? "..." : t.searchBtn}
        </button>
      </div>

      {searched && bookings.length === 0 && (
        <div style={{background:"#fff",borderRadius:"var(--r)",padding:"24px",textAlign:"center",border:"1px solid var(--dv)"}}>
          <p style={{color:"var(--mu)"}}>{t.notFound}</p>
        </div>
      )}

      <div style={{display:"flex",flexDirection:"column",gap:12}}>
        {bookings.map(b => {
          const st = statusLabel(b.status);
          const startMin = (b.hour||0)*60 + (b.start_minute||0);
          const dur = b.duration_minutes || 60;
          return (
            <div key={b.id} className="card">
              <div style={{padding:"14px 16px"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                  <span style={{fontWeight:700,color:"var(--br)",fontSize:15}}>Court {b.court_id}</span>
                  <span style={{fontSize:12,fontWeight:600,color:st.color,background:`${st.color}18`,padding:"3px 10px",borderRadius:20}}>{st.text}</span>
                </div>
                <Row label={`📅 ${t.date}`} val={new Date(b.booking_date).toLocaleDateString(lang==="th"?"th-TH":"en-GB",{year:"numeric",month:"long",day:"numeric"})} />
                <Row label={`🕐 ${t.time}`} val={`${minutesToLabel(startMin)} – ${minutesToLabel(startMin+dur)}`} />
                <Row label={t.rowPrice} val={`฿${b.price?.toLocaleString()}`} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── App V2 with Cancel Tab + Admin ──────────────────────────────────────────
export default function AppV2() {
  const [tab, setTab] = useState("home");
  const [page, setPage] = useState("booking");
  const [booking, setBooking] = useState(null);
  const [customer, setCustomer] = useState(null);
  const [resumeBooking, setResumeBooking] = useState(null);
  const [adminToken, setAdminToken] = useState(() => {
    try { return sessionStorage.getItem("nova_admin_token") || null; } catch { return null; }
  });
  const [adminMode, setAdminMode] = useState(() => {
    try { return window.location.pathname.replace(/\/$/, "") === "/admin"; } catch { return false; }
  });
  const [adminPw, setAdminPw] = useState("");
  const [adminErr, setAdminErr] = useState(false);
  const [adminChecking, setAdminChecking] = useState(false);
  const [logoTaps, setLogoTaps] = useState(0);
  const [lang, setLang] = useState("th");
  const [prefillPhone, setPrefillPhone] = useState("");

  // ── LINE Login ──
  const isLineCallbackPath = () => { try { return window.location.pathname.replace(/\/$/, "") === "/line-callback"; } catch { return false; } };
  const [lineSession, setLineSession] = useState(() => loadLineSession());
  const [lineCbStatus, setLineCbStatus] = useState(() => (isLineCallbackPath() ? "processing" : null));
  const lineCbStarted = useRef(false);
  // ข้ามล็อกอินได้ชั่วคราว (เฉพาะเมื่อล็อกอินล้มเหลว หรือโหมด prompt) — ใช้ได้แค่ในเบราว์เซอร์/เซสชันนี้
  const [lineBypass, setLineBypass] = useState(() => { try { return sessionStorage.getItem(LINE_BYPASS_KEY) === "1"; } catch { return false; } });
  const doBypass = () => { try { sessionStorage.setItem(LINE_BYPASS_KEY, "1"); } catch { /* no-op */ } setLineBypass(true); };

  const clearResumeParam = () => {
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("booking");
      window.history.replaceState(null, "", url.toString());
    } catch { /* no-op */ }
    try { localStorage.removeItem("nova_pending_booking"); } catch { /* no-op */ }
  };

  // เปลี่ยนแท็บ/หน้าไหนก็ตาม ให้เลื่อนขึ้นบนสุดเสมอ — กันปัญหาเข้าหน้าจองแล้วหน้าเด้งไปอยู่ตรงกลาง
  // (ค่าตำแหน่งเลื่อนของหน้าแรกที่ยาวๆ ค้างมา) จนลูกค้าข้ามขั้น "เลือกวันที่" ไป
  useEffect(() => {
    try { window.scrollTo(0, 0); } catch { /* no-op */ }
    try { document.documentElement.scrollTop = 0; document.body.scrollTop = 0; } catch { /* no-op */ }
  }, [tab, page]);

  const goTab = (id) => {
    // ตัดสินใจตอน "กด" (ไม่ใช่ตอนแสดงผล) — กด Back จากหน้า LINE แล้วกลับมาหน้าแรกได้ปกติ ไม่วนลูปเด้งไปล็อกอินซ้ำ
    if (LINE_SKIP_INTRO && LINE_GATE_MODE === "booking" && (id === "book" || id === "package") && !lineSession && !lineBypass) {
      startLineLogin(id, null); // กลับมาแล้วจะเข้าหน้าที่กดไว้
      return;
    }
    if (id === "book") {
      // ถ้ามีการจองที่ยังค้างชำระเงินอยู่ (ยังไม่จบ ไม่ว่าจะสำเร็จหรือหมดเวลา) ให้กลับไปหน้าชำระเงินเดิมเลย
      // แทนที่จะเริ่มจองใหม่ทับ — กันปัญหาเผลอกดแท็บอื่นแล้วหากลับไม่เจอ
      setPage(booking && customer ? "payment" : "booking");
    }
    setTab(id);
    // ไม่ล้าง resume state ที่นี่ — จะล้างจริงๆ แค่ตอนจ่ายเงินสำเร็จ (handlePaymentDone) เท่านั้น
    // เพื่อให้เผลอกดแท็บอื่นแล้วยังกลับมาจ่ายเงินต่อได้เสมอ
  };

  useEffect(() => {
    if (isLineCallbackPath()) return; // กำลังกลับจากหน้าล็อกอิน LINE — ไม่ต้องพาไปหน้าชำระเงินค้าง
    // เช็คก่อนจาก URL (?booking=...) ถ้าไม่มีค่อยเช็คจาก localStorage เป็นสำรอง
    // (เผื่อ in-app browser บางตัวรีโหลดแล้วล้าง query string ทิ้ง)
    let bId = new URLSearchParams(window.location.search).get("booking");
    if (!bId) {
      try {
        const saved = JSON.parse(localStorage.getItem("nova_pending_booking") || "null");
        if (saved?.id) bId = saved.id;
      } catch { /* no-op */ }
    }
    if (!bId) return;
    db.getBookingById(bId).then(b => {
      if (!b || b.status === "cancelled") { clearResumeParam(); return; }
      if (b.status !== "pending") { clearResumeParam(); return; }
      const courtObj = COURTS.find(c => c.courtId === b.court_id);
      if (!courtObj) { clearResumeParam(); return; }
      const dateObj = new Date(b.booking_date + "T00:00:00");
      const dur = b.duration_minutes || 60;
      const startMin = (b.hour || 0) * 60 + (b.start_minute || 0);
      const groupCourts = b._group ? b._group.map(r => COURTS.find(c => c.courtId === r.court_id)).filter(Boolean) : null;
      const isGroupBooking = !!(groupCourts && groupCourts.length > 1);
      const totalPrice = isGroupBooking ? b._group.reduce((s, r) => s + (r.price || 0), 0) : b.price;
      const restoredSlot = {
        startMin, durationMinutes: dur, hour: b.hour, startMinute: b.start_minute || 0,
        label: `${minutesToLabel(startMin)} – ${minutesToLabel(startMin+dur)}`,
        price: totalPrice, unitPrice: b.price, peak: false,
      };
      setBooking({ date: dateObj, court: courtObj, courts: isGroupBooking ? groupCourts : null, slot: restoredSlot });
      setCustomer({ name: b.customer_name, phone: b.customer_id, finalPrice: totalPrice, discountAmount: b.discount_amount || 0, discount: null });
      setResumeBooking({ id: b.id, createdAt: b.created_time });
      setTab("book"); setPage("payment");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // จัดการตอน LINE ส่งลูกค้ากลับมาที่ /line-callback — แลก code ที่เซิร์ฟเวอร์ แล้วพากลับไปหน้าเดิม
  useEffect(() => {
    if (lineCbStatus !== "processing" || lineCbStarted.current) return;
    lineCbStarted.current = true;
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state") || "";
    const [returnTarget, nonce] = state.split(".");
    let storedNonce = null;
    try { storedNonce = localStorage.getItem("nova_line_nonce"); } catch { /* no-op */ }
    if (params.get("error") || !code) { setLineCbStatus("error"); return; }
    // ถ้าเบราว์เซอร์นี้เป็นตัวที่เริ่มล็อกอินและค่าไม่ตรง = ปฏิเสธ (กันถูกหลอกให้ล็อกอินด้วยลิงก์ของคนอื่น)
    if (storedNonce && nonce && storedNonce !== nonce) { setLineCbStatus("error"); return; }
    db.lineLogin(code).then(result => {
      if (!result || result.error || !result.session) { setLineCbStatus("error"); return; }
      const p = result.profile || {};
      const sess = {
        token: result.session, displayName: p.displayName || "", pictureUrl: p.pictureUrl || "",
        name: p.name || toFormName(p.displayName), phone: p.phone || "",
        isFriend: typeof p.isFriend === "boolean" ? p.isFriend : null, // null = เช็คไม่ได้ → ไม่บล็อกลูกค้า
      };
      saveLineSession(sess); setLineSession(sess);
      try { localStorage.removeItem("nova_line_nonce"); } catch { /* no-op */ }
      window.history.replaceState(null, "", "/");
      let restored = false;
      try {
        const pc = JSON.parse(localStorage.getItem("nova_pending_checkout") || "null");
        localStorage.removeItem("nova_pending_checkout");
        const courtObj = pc && COURTS.find(c => c.courtId === pc.courtId);
        if (pc && pc.dateIso && pc.slot && courtObj) {
          const groupCourts = Array.isArray(pc.courtIds) ? pc.courtIds.map(id => COURTS.find(c => c.courtId === id)).filter(Boolean) : null;
          setBooking({ date: new Date(pc.dateIso + "T00:00:00"), court: courtObj, courts: groupCourts && groupCourts.length > 1 ? groupCourts : null, slot: pc.slot });
          setCustomer(null); setPage("checkout"); setTab("book"); restored = true;
        }
      } catch { /* no-op */ }
      if (!restored) {
        setPage("booking");
        setTab(["home", "book", "package", "cancel"].includes(returnTarget) ? returnTarget : "home");
      }
      setLineCbStatus(null);
    }).catch(() => setLineCbStatus("error"));
  }, [lineCbStatus]);

  // ตอนเปิดเว็บ เช็คว่า session LINE เดิมยังใช้ได้ไหม (และดึงชื่อ/เบอร์ที่ผูกไว้ล่าสุดมาอัปเดต)
  useEffect(() => {
    const s = loadLineSession();
    if (!s?.token || isLineCallbackPath()) return;
    db.lineMe(s.token).then(r => {
      if (r?.error === "invalid_session") { clearLineSession(); setLineSession(null); return; }
      if (r?.profile) {
        const next = { ...s, displayName: r.profile.displayName || s.displayName, name: r.profile.name || s.name, phone: r.profile.phone || s.phone,
          isFriend: typeof r.profile.isFriend === "boolean" ? r.profile.isFriend : (s.isFriend ?? null) };
        saveLineSession(next); setLineSession(next);
      }
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleLineLogin = (pendingCheckout = null) => startLineLogin(tab, pendingCheckout);
  const handleLineLogout = () => {
    if (!window.confirm(lang === "th" ? "ออกจากระบบ LINE ใช่หรือไม่?" : "Log out of LINE?")) return;
    clearLineSession(); setLineSession(null);
  };
  // ผูกชื่อ+เบอร์ที่กรอกล่าสุดไว้กับบัญชี LINE — ครั้งหน้ากรอกให้อัตโนมัติ (ทำเบื้องหลัง ไม่ให้ลูกค้ารอ)
  const handleLinePhoneLinked = (name, phone) => {
    if (!lineSession?.token) return;
    db.lineLinkPhone(lineSession.token, name, phone).then(r => {
      if (r?.ok) { const next = { ...lineSession, name, phone }; saveLineSession(next); setLineSession(next); }
    }).catch(() => {});
  };

  const handleLogoTap = () => {
    const next = logoTaps + 1;
    setLogoTaps(next);
    if (next >= 5) { setAdminMode(true); setLogoTaps(0); }
    setTimeout(() => setLogoTaps(0), 3000);
  };

  const handlePaymentDone = (phone) => {
    setBooking(null); setCustomer(null); setResumeBooking(null); setPage("booking");
    setPrefillPhone(phone || "");
    setTab("cancel");
    clearResumeParam();
  };

  // จองด้วยสิทธิ์แพ็คเกจ — จ่ายไว้ล่วงหน้าแล้ว ยืนยันทันทีไม่ต้องผ่านหน้า QR/แนบสลิปอีก
  const [pkgBookingBusy, setPkgBookingBusy] = useState(false);
  const handleConfirmWithPackage = async ({ name, phone, packageId }) => {
    if (!booking || pkgBookingBusy) return;
    setPkgBookingBusy(true);
    const { slot, court, date } = booking;
    const { error } = await db.createBookingWithPackage({
      courtId: court.courtId, customerId: phone, customerName: name,
      bookingDate: toIso(date), hour: slot.hour, startMinute: slot.startMinute, packageId,
    });
    setPkgBookingBusy(false);
    if (error) {
      const msg = {
        slot_taken: lang==="th" ? "ช่วงเวลานี้เพิ่งถูกจองไปก่อนหน้าแล้ว กรุณาเลือกช่วงเวลาใหม่" : "This slot was just booked by someone else. Please choose another time.",
        package_no_credits: lang==="th" ? "สิทธิ์ในแพ็คเกจหมดแล้ว" : "No credits left in this package",
        package_expired: lang==="th" ? "แพ็คเกจหมดอายุแล้ว" : "This package has expired",
        package_wrong_tier: lang==="th" ? "แพ็คเกจนี้ใช้กับช่วงเวลานี้ไม่ได้" : "This package cannot be used for this time slot",
      }[error] || (lang==="th" ? "จองไม่สำเร็จ กรุณาลองใหม่อีกครั้ง" : "Booking failed, please try again");
      alert(msg);
      return;
    }
    alert(lang==="th" ? "✅ ส่งคำขอจองแล้ว! รอแอดมินยืนยันก่อนถึงจะหักสิทธิ์และถือว่าจองสำเร็จ" : "✅ Booking request sent! Awaiting admin confirmation before the credit is deducted.");
    setBooking(null); setCustomer(null); setResumeBooking(null); setPage("booking");
    setPrefillPhone(phone || "");
    setTab("cancel");
    clearResumeParam();
  };

  // ให้ลูกค้ายกเลิกการจองที่ค้าง (เช่นหมดเวลาแล้ว) แล้วเริ่มจองใหม่ได้เอง โดยไม่ต้องรอ/ติดอยู่ที่เดิม
  const resetBookingFlow = () => {
    // แจ้งเตือนแอดมินและยกเลิกรายการนี้ในฐานข้อมูลจริงด้วย (ไม่ใช่แค่เคลียร์หน้าจอฝั่งลูกค้า)
    // ทำแบบ fire-and-forget เพื่อไม่ให้ลูกค้าต้องรอ แต่ยังยิงคำขอไปแน่นอน
    if (resumeBooking?.id) {
      db.cancelPending(resumeBooking.id).catch(() => {});
    }
    setBooking(null); setCustomer(null); setResumeBooking(null); setPage("booking");
    clearResumeParam();
  };

  // ตรวจรหัสผ่าน Admin ที่เซิร์ฟเวอร์เสมอ (ไม่มีการเก็บ/เทียบรหัสผ่านในโค้ดฝั่งเว็บอีกต่อไป)
  const handleAdminLogin = async () => {
    if (!adminPw.trim() || adminChecking) return;
    setAdminChecking(true);
    setAdminErr(false);
    try {
      const res = await fetch("/api/admin-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "login", password: adminPw }),
      });
      const data = await res.json();
      if (data.ok && data.token) {
        setAdminToken(data.token);
        try { sessionStorage.setItem("nova_admin_token", data.token); } catch { /* no-op */ }
      } else {
        setAdminErr(true);
        setTimeout(() => setAdminErr(false), 2000);
      }
    } catch {
      setAdminErr(true);
      setTimeout(() => setAdminErr(false), 2000);
    }
    setAdminChecking(false);
  };

  const handleAdminLogout = () => {
    setAdminToken(null);
    setAdminMode(false);
    setAdminPw("");
    try { sessionStorage.removeItem("nova_admin_token"); } catch { /* no-op */ }
  };

  if (lineCbStatus) return (
    <>
      <style>{CSS}</style>
      <div style={{maxWidth:480,margin:"0 auto",minHeight:"100dvh",background:"var(--cr)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:16,padding:24,textAlign:"center"}}>
        <NovaLogo width={120} />
        {lineCbStatus === "processing" ? (
          <p style={{fontSize:15,color:"var(--br)",fontWeight:600}}>{lang==="th" ? "กำลังเข้าสู่ระบบด้วย LINE..." : "Signing in with LINE..."}</p>
        ) : (
          <>
            <p style={{fontSize:15,color:"#c0392b",fontWeight:700}}>{lang==="th" ? "เข้าสู่ระบบด้วย LINE ไม่สำเร็จ" : "LINE sign-in failed"}</p>
            <p style={{fontSize:13,color:"var(--mu)"}}>{lang==="th" ? "กรุณาลองใหม่อีกครั้ง หรือกรอกชื่อ-เบอร์โทรเองได้ตามปกติ" : "Please try again, or enter your name and phone manually."}</p>
            <button className="btn-primary" style={{maxWidth:260}} onClick={() => { window.history.replaceState(null, "", "/"); setLineCbStatus(null); setTab("home"); }}>
              {lang==="th" ? (LINE_GATE_MODE==="gate" || LINE_GATE_MODE==="booking" ? "ลองใหม่อีกครั้ง" : "กลับหน้าแรก") : (LINE_GATE_MODE==="gate" || LINE_GATE_MODE==="booking" ? "Try again" : "Back to Home")}
            </button>
            {(LINE_GATE_MODE === "gate" || LINE_GATE_MODE === "booking") && (
              <button onClick={() => { doBypass(); window.history.replaceState(null, "", "/"); setLineCbStatus(null); setTab("home"); }}
                style={{background:"none",border:"none",color:"var(--mu)",fontSize:12.5,textDecoration:"underline",cursor:"pointer",fontFamily:"'Noto Sans Thai',sans-serif"}}>
                {lang==="th" ? "เข้าใช้งานโดยไม่ใช้ LINE (กรอกชื่อ-เบอร์เอง)" : "Continue without LINE (enter details manually)"}
              </button>
            )}
          </>
        )}
      </div>
    </>
  );

  if (adminMode && !adminToken) return (
    <>
      <style>{CSS}</style>
      <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"linear-gradient(135deg,#663924,#3a1a0a)"}}>
        <div style={{background:"#fff",borderRadius:20,padding:"40px 32px",width:300,textAlign:"center",boxShadow:"0 20px 60px rgba(0,0,0,.3)"}}>
          <NovaLogo width={140} />
          <p style={{fontSize:13,color:"var(--mu)",margin:"12px 0 28px"}}>Admin Dashboard</p>
          <input type="password" value={adminPw} onChange={e=>setAdminPw(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&handleAdminLogin()}
            placeholder="รหัสผ่าน"
            style={{width:"100%",padding:"12px 14px",borderRadius:10,border:`1.5px solid ${adminErr?"#c0392b":"var(--dv)"}`,fontSize:15,marginBottom:12,outline:"none"}} />
          {adminErr && <p style={{color:"#c0392b",fontSize:12,marginBottom:8}}>รหัสผ่านไม่ถูกต้อง</p>}
          <button onClick={handleAdminLogin} disabled={adminChecking}
            style={{width:"100%",padding:"13px",borderRadius:10,border:"none",background:"#663924",color:"#F47E1F",fontWeight:700,fontSize:15,cursor:adminChecking?"not-allowed":"pointer",fontFamily:"'Noto Sans Thai',sans-serif",opacity:adminChecking?0.7:1}}>
            {adminChecking ? "⏳ กำลังตรวจสอบ..." : "เข้าสู่ระบบ"}
          </button>
          <button onClick={()=>{setAdminMode(false);setAdminPw("");}}
            style={{marginTop:10,background:"none",border:"none",color:"var(--mu)",fontSize:13,cursor:"pointer",fontFamily:"'Noto Sans Thai',sans-serif"}}>
            ยกเลิก
          </button>
        </div>
      </div>
    </>
  );

  if (adminMode && adminToken) return (
    <>
      <style>{CSS}</style>
      <AdminDashboard token={adminToken} onLogout={handleAdminLogout} />
    </>
  );

  const needLogin = !lineSession && !lineBypass;
  // ล็อกอินแล้วแต่ LINE ยืนยันว่ายังไม่เป็นเพื่อนกับ OA (false เท่านั้น — ถ้าเช็คไม่ได้เป็น null จะไม่บล็อก กันลูกค้าจองไม่ได้เพราะระบบเรา/LINE ขัดข้อง)
  const needFriend = (LINE_GATE_MODE === "gate" || LINE_GATE_MODE === "booking") && !!lineSession && lineSession.isFriend === false && !lineBypass;
  // กลับไปล็อกอินใหม่เพื่อตรวจสถานะเพื่อน โดยจำรายการที่เลือกไว้ (ถ้ามี) ให้กลับมาต่อได้
  const recheckFriend = () => handleLineLogin(
    booking && booking.slot && booking.court
      ? { dateIso: toIso(booking.date), courtId: booking.court.courtId, courtIds: booking.courts ? booking.courts.map(c => c.courtId) : null, slot: booking.slot }
      : null
  );
  if (LINE_GATE_MODE === "gate" && (needLogin || needFriend)) return (
    <>
      <style>{CSS}</style>
      {needLogin
        ? <LineLoginGate lang={lang} setLang={setLang} onLogin={() => handleLineLogin(null)} />
        : <LineFriendGate lang={lang} name={toFormName(lineSession?.displayName)} onRecheck={recheckFriend} />}
    </>
  );
  // โหมด booking: กั้นเฉพาะหน้าจองสนาม/แพ็คเกจ (หน้าแรก ราคา แบนเนอร์ ดูได้อิสระ)
  const blockedByLine = LINE_GATE_MODE === "booking" && (needLogin || needFriend) && (tab === "book" || tab === "package");

  return (
    <>
      <style>{CSS}</style>
      <div style={{maxWidth:480,margin:"0 auto",minHeight:"100dvh",background:"var(--cr)"}}>
        {!(tab==="book" && page==="payment") && booking && customer && resumeBooking && (
          <PendingPaymentBanner createdAt={resumeBooking.createdAt} lang={lang} onResume={() => { setTab("book"); setPage("payment"); }} />
        )}
        <header style={{position:"sticky",top:0,zIndex:100,backgroundColor:"rgba(249,232,212,0.93)",backdropFilter:"blur(10px)",borderBottom:"1px solid var(--dv)",padding:"8px 20px",display:"flex",alignItems:"center",justifyContent:"space-between",cursor:"pointer"}} onClick={handleLogoTap}>
          <NovaLogo width={90} />
          <div onClick={e=>e.stopPropagation()} style={{display:"flex",gap:4,alignItems:"center"}}>
            {lineSession ? (
              <button onClick={handleLineLogout} title={lang==="th"?"ออกจากระบบ LINE":"Log out"} style={{padding:"5px 9px",borderRadius:8,border:"1.5px solid #06C755",background:"#fff",color:"#06A04A",fontWeight:700,fontSize:11.5,cursor:"pointer",fontFamily:"'Noto Sans Thai',sans-serif",maxWidth:110,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                👤 {toFormName(lineSession.displayName).slice(0,8) || "LINE"}
              </button>
            ) : (
              <button onClick={() => handleLineLogin(null)} style={{padding:"5px 10px",borderRadius:8,border:"none",background:"#06C755",color:"#fff",fontWeight:700,fontSize:11.5,cursor:"pointer",fontFamily:"'Noto Sans Thai',sans-serif",whiteSpace:"nowrap"}}>
                LINE Login
              </button>
            )}
            {["th","en"].map(l => (
              <button key={l} onClick={()=>setLang(l)} style={{padding:"5px 10px",borderRadius:8,border:"1.5px solid var(--dv)",background:lang===l?"var(--br)":"#fff",color:lang===l?"var(--or)":"var(--mu)",fontWeight:lang===l?700:400,fontSize:12,cursor:"pointer",fontFamily:"'Noto Sans Thai',sans-serif"}}>
                {l==="th"?"🇹🇭 TH":"🇬🇧 EN"}
              </button>
            ))}
          </div>
        </header>
        {LINE_GATE_MODE === "prompt" && needLogin && tab === "home" && (
          <div style={{position:"fixed",inset:0,zIndex:300,background:"rgba(46,26,14,.55)",display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
            <LineLoginGate lang={lang} compact onLogin={() => handleLineLogin(null)} onSkip={doBypass} />
          </div>
        )}
        <main>
          {blockedByLine && (needLogin
            ? <LineLoginGate lang={lang} compact onLogin={() => handleLineLogin(null)} />
            : <LineFriendGate lang={lang} compact name={toFormName(lineSession?.displayName)} onRecheck={recheckFriend} />)}
          {tab==="home" && <HomePage goBook={() => goTab("book")} goPackage={() => goTab("package")} lang={lang} />}
          {!blockedByLine && tab==="book" && page==="booking" && <BookingPage onProceed={b => { setBooking(b); setPage("checkout"); }} lang={lang} />}
          {!blockedByLine && tab==="book" && page==="checkout" && booking && (
            <CheckoutPage booking={booking} onCancel={() => setPage("booking")} onConfirm={c => { setCustomer(c); setPage("payment"); }} onConfirmWithPackage={handleConfirmWithPackage} lineSession={lineSession} onLineLogin={handleLineLogin} onLinePhoneLinked={handleLinePhoneLinked} lang={lang} />
          )}
          {!blockedByLine && tab==="book" && page==="payment" && booking && customer && (
            <PaymentPage booking={booking} customer={customer} onDone={handlePaymentDone} lang={lang} resumeBooking={resumeBooking} onCreated={(id, createdAt) => setResumeBooking({ id, createdAt })} onStartOver={resetBookingFlow} />
          )}
          {!blockedByLine && tab==="package" && <PackagePage lang={lang} lineSession={lineSession} onLineLogin={handleLineLogin} onLinePhoneLinked={handleLinePhoneLinked} />}
          {tab==="cancel" && <CancelPage lang={lang} initialPhone={prefillPhone || lineSession?.phone || ""} />}
        </main>
        <TabBar tab={tab} setTab={goTab} lang={lang} />
      </div>
    </>
  );
}

// ─── Admin Dashboard (inline) ─────────────────────────────────────────────────
function AdminDashboard({ token, onLogout }) {
  const [tab, setTab] = useState("bookings");
  const [bookings, setBookings] = useState([]);
  const [discounts, setDiscounts] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [date, setDate] = useState(toIso(new Date()));
  const [newCode, setNewCode] = useState("");
  const [newAmt, setNewAmt] = useState("50");
  const [newMax, setNewMax] = useState("1");

  const [queue, setQueue] = useState([]);
  const [queueLoading, setQueueLoading] = useState(true);

  const [reportFrom, setReportFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate()-6);
    return toIso(d);
  });
  const [reportTo, setReportTo] = useState(toIso(new Date()));
  const [reportRows, setReportRows] = useState([]);
  const [reportLoading, setReportLoading] = useState(false);
  // รายละเอียดของวันที่ admin กดดูเพิ่ม (ใครจอง จองวันไหน เวลาไหน โอนตอนกี่โมง)
  const [expandedDay, setExpandedDay] = useState(null);
  const [dayDetail, setDayDetail] = useState([]);
  const [dayDetailLoading, setDayDetailLoading] = useState(false);

  // ปิดสนาม — เลือกวันที่/สนาม/ช่วงเวลาแล้วอัปเดตทีเดียว
  const [blocks, setBlocks] = useState([]);
  const [blocksLoading, setBlocksLoading] = useState(true);
  const [closeDate, setCloseDate] = useState(toIso(new Date()));
  const [closeCourt, setCloseCourt] = useState("both"); // "1" | "2" | "both"
  const [closeStart, setCloseStart] = useState("06:00");
  const [closeEnd, setCloseEnd] = useState("07:00");
  const [closeReason, setCloseReason] = useState("");
  const [closing, setClosing] = useState(false);
  const CLOSE_TIME_OPTIONS = (() => {
    const opts = [];
    for (let m = 6*60; m <= 23*60; m += 30) opts.push(`${String(Math.floor(m/60)).padStart(2,"0")}:${String(m%60).padStart(2,"0")}`);
    return opts;
  })();

  // แพ็คเกจสมาชิก
  // กดที่ชื่อลูกค้าในตารางว่าง → ไปแท็บ "การจอง" (วันเดียวกัน) แล้วเลื่อน/ไฮไลต์แถวของการจองนั้นให้
  const [highlightId, setHighlightId] = useState(null);
  const goToBooking = (b) => { setHighlightId(b.id); setTab("bookings"); };
  useEffect(() => {
    if (tab !== "bookings" || !highlightId) return;
    const t1 = setTimeout(() => document.getElementById(`bk-${highlightId}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 250);
    const t2 = setTimeout(() => setHighlightId(null), 6000);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [tab, highlightId, bookings]);

  const [pkgQueue, setPkgQueue] = useState([]);
  const [pkgQueueLoading, setPkgQueueLoading] = useState(true);
  const [allPkgs, setAllPkgs] = useState([]);
  const [allPkgsLoading, setAllPkgsLoading] = useState(true);
  const loadPkgQueue = async () => {
    setPkgQueueLoading(true);
    const { packages: rows } = await callAdminAction("packagesQueue", token, {});
    setPkgQueue(rows || []);
    setPkgQueueLoading(false);
  };
  const loadAllPkgs = async () => {
    setAllPkgsLoading(true);
    const { packages: rows } = await callAdminAction("allPackages", token, {});
    setAllPkgs(rows || []);
    setAllPkgsLoading(false);
  };
  const confirmPackage = async (id) => {
    if (!window.confirm("ยืนยันการซื้อแพ็คเกจนี้ใช่หรือไม่? จะเริ่มนับวันหมดอายุตั้งแต่ตอนนี้")) return;
    await callAdminAction("confirmPackage", token, { id });
    setPkgQueue(prev => prev.filter(p => p.id !== id));
    loadAllPkgs();
  };
  const cancelPackage = async (id) => {
    if (!window.confirm("ยกเลิกรายการซื้อแพ็คเกจนี้ใช่หรือไม่?")) return;
    await callAdminAction("cancelPackage", token, { id });
    setPkgQueue(prev => prev.filter(p => p.id !== id));
    loadAllPkgs();
  };

  const loadQueue = async () => {
    setQueueLoading(true);
    const { bookings: rows } = await callAdminAction("queue", token, {});
    setQueue(rows || []);
    setQueueLoading(false);
  };

  const loadBookings = async () => {
    setLoading(true);
    const { bookings: rows } = await callAdminAction("byDate", token, { date });
    setBookings(rows || []); setLoading(false);
  };
  const loadDiscounts = async () => {
    const { discounts: rows } = await callAdminAction("listDiscounts", token, {});
    setDiscounts(rows || []);
  };
  const loadCustomers = async () => {
    const { customers: rows } = await callAdminAction("customers", token, {});
    setCustomers(rows || []);
  };

  const loadReport = async () => {
    setReportLoading(true);
    setExpandedDay(null);
    const { bookings: data } = await callAdminAction("report", token, { from: reportFrom, to: reportTo });
    const map = {};
    (data || []).forEach(b => {
      const day = (b.created_time || "").split("T")[0];
      if (!day) return;
      if (!map[day]) map[day] = { day, confirmedCount: 0, confirmedTotal: 0, otherCount: 0 };
      if (b.status === "confirmed") { map[day].confirmedCount++; map[day].confirmedTotal += (b.price||0); }
      else map[day].otherCount++;
    });
    setReportRows(Object.values(map).sort((a,b)=>a.day.localeCompare(b.day)));
    setReportLoading(false);
  };

  // ดูรายละเอียดว่าวันนั้น "ใครจอง จองวันไหน เวลาไหน โอนเงินตอนกี่โมง"
  const toggleDayDetail = async (day) => {
    if (expandedDay === day) { setExpandedDay(null); return; }
    setExpandedDay(day);
    setDayDetailLoading(true);
    const { bookings: rows } = await callAdminAction("reportDetail", token, { day });
    setDayDetail(rows || []);
    setDayDetailLoading(false);
  };

  const loadBlocks = async () => {
    setBlocksLoading(true);
    const { blocks: rows } = await callAdminAction("listBlocks", token, {});
    setBlocks(rows || []);
    setBlocksLoading(false);
  };

  const timeToParts = (hhmm) => {
    const [h, m] = hhmm.split(":").map(Number);
    return { hour: h, minute: m };
  };

  const handleCloseCourt = async () => {
    if (closing) return;
    const start = timeToParts(closeStart);
    const end = timeToParts(closeEnd);
    const startTotal = start.hour*60 + start.minute;
    const endTotal = end.hour*60 + end.minute;
    if (endTotal <= startTotal) {
      alert("เวลาสิ้นสุดต้องหลังเวลาเริ่มต้น");
      return;
    }
    const durationMinutes = endTotal - startTotal;
    const courtIds = closeCourt === "both" ? [1, 2] : [Number(closeCourt)];
    const confirmed = window.confirm(
      `ยืนยันปิดสนาม ${closeCourt === "both" ? "Court 1 และ Court 2" : `Court ${closeCourt}`}\nวันที่ ${closeDate} เวลา ${closeStart}–${closeEnd}\nลูกค้าจะจองช่วงเวลานี้ไม่ได้จนกว่าจะเปิดใช้งานอีกครั้ง`
    );
    if (!confirmed) return;
    setClosing(true);
    const errors = [];
    for (const courtId of courtIds) {
      const result = await callAdminAction("blockCourt", token, {
        date: closeDate, courtId, hour: start.hour, startMinute: start.minute, durationMinutes, reason: closeReason.trim() || null,
      });
      if (result?.error) errors.push(`Court ${courtId}: ${result.error}${result.detail ? " — " + JSON.stringify(result.detail) : ""}`);
    }
    setClosing(false);
    if (errors.length > 0) {
      alert("ปิดสนามไม่สำเร็จบางส่วน:\n" + errors.join("\n"));
    } else {
      setCloseReason("");
    }
    loadBlocks();
  };

  const handleUnblock = async (id) => {
    const confirmed = window.confirm("เปิดใช้งานช่วงเวลานี้อีกครั้งใช่หรือไม่? ลูกค้าจะกลับมาจองได้ตามปกติ");
    if (!confirmed) return;
    await callAdminAction("unblockCourt", token, { id });
    setBlocks(prev => prev.filter(b => b.id !== id));
  };

  useEffect(() => { loadQueue(); }, []);
  useEffect(() => { loadBookings(); }, [date]);
  useEffect(() => { if(tab==="discounts") loadDiscounts(); if(tab==="customers") loadCustomers(); if(tab==="report") loadReport(); if(tab==="closures") loadBlocks(); if(tab==="packages") { loadPkgQueue(); loadAllPkgs(); } }, [tab]);

  const updateStatus = async (id, status, packageId, groupId) => {
    const msg = status === "confirmed"
      ? "ยืนยันการจองนี้ใช่หรือไม่? สถานะจะเปลี่ยนเป็น \"การจองสำเร็จ\""
      : "ยกเลิกการจองนี้ใช่หรือไม่? การกระทำนี้ไม่สามารถย้อนกลับได้ และช่วงเวลานี้จะกลับมาให้ลูกค้าจองได้ใหม่";
    const confirmed = window.confirm(groupId ? msg + "\n\n(เป็นการจอง 2 สนามพร้อมกัน — จะเปลี่ยนสถานะทั้งคู่)" : msg);
    if (!confirmed) return;
    let refundCredit = false;
    if (status === "cancelled" && packageId) {
      refundCredit = window.confirm("การจองนี้จ่ายด้วยสิทธิ์แพ็คเกจ\n\nกด OK = คืนสิทธิ์ให้ลูกค้า (ปัญหาจากทางสนาม)\nกด Cancel = ไม่คืนสิทธิ์ (ลูกค้ายกเลิกเอง)");
    }
    await callAdminAction("updateStatus", token, { id, status, refundCredit });
    if (groupId) { loadQueue(); loadBookings(); return; } // การจองคู่เปลี่ยนทั้ง 2 แถว — โหลดใหม่ให้ตรงกับเซิร์ฟเวอร์
    setBookings(prev => prev.map(b => b.id === id ? { ...b, status } : b));
    setQueue(prev => prev.filter(b => b.id !== id));
  };

  const createCode = async () => {
    if (!newCode.trim()) return;
    await callAdminAction("createDiscount", token, { code: newCode, amount: newAmt, maxUses: newMax });
    setNewCode(""); loadDiscounts();
  };

  const genCode = () => {
    const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    setNewCode(Array.from({length:8}, () => c[Math.floor(Math.random()*c.length)]).join(""));
  };

  const toggleDiscount = async (id, active) => {
    await callAdminAction("toggleDiscount", token, { id, active });
    loadDiscounts();
  };

  const stInfo = (s) => {
    if(s==="confirmed") return {text:"✅ การจองสำเร็จ", color:"#2d7a4f"};
    if(s==="cancelled") return {text:"❌ การจองถูกยกเลิกแล้ว", color:"#c0392b"};
    if(s==="reviewing") return {text:"🔍 รอการยืนยัน", color:"#e67e22"};
    if(s==="blocked") return {text:"🚫 ปิดสนาม", color:"#663924"};
    return {text:"⏳ รอชำระ", color:"var(--mu)"};
  };

  const fmtTime = (b) => {
    const startMin = (b.hour||0)*60 + (b.start_minute||0);
    const dur = b.duration_minutes || 60;
    return `${minutesToLabel(startMin)}–${minutesToLabel(startMin+dur)}`;
  };
  const fmtCreatedTime = (iso) => {
    if (!iso) return "-";
    const d = parseUtc(iso);
    return d.toLocaleTimeString("th-TH",{hour:"2-digit",minute:"2-digit",timeZone:"Asia/Bangkok"});
  };

  const revenue = bookings.filter(b=>b.status==="confirmed").reduce((s,b)=>s+(b.price||0),0);
  const statusPriority = { pending: 0, reviewing: 0, confirmed: 1, cancelled: 2, blocked: 3 };
  const sortedBookings = [...bookings].sort((a, b) => {
    const pa = statusPriority[a.status] ?? 0;
    const pb = statusPriority[b.status] ?? 0;
    if (pa !== pb) return pa - pb;
    return a.hour - b.hour;
  });
  const reportGrandTotal = reportRows.reduce((s,r)=>s+r.confirmedTotal,0);
  const reportGrandCount = reportRows.reduce((s,r)=>s+r.confirmedCount,0);

  const adminCSS = `
    .adm-table { width:100%; border-collapse:collapse; font-size:13px; }
    .adm-table th { background:#663924; color:#F47E1F; padding:9px 12px; text-align:left; }
    .adm-table td { padding:9px 12px; border-bottom:1px solid rgba(102,57,36,.1); }
    .adm-table tr:hover td { background:rgba(244,126,31,.04); }
    .adm-table-sub th { background:#8a7060; }
  `;

  return (
    <>
      <style>{adminCSS}</style>
      <div style={{minHeight:"100vh",background:"#f5f5f5"}}>
        <header style={{background:"var(--br)",padding:"12px 20px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div>
            <p className="bb" style={{fontSize:22,color:"var(--or)",lineHeight:1}}>NOVA TENNIS</p>
            <p style={{fontSize:11,color:"rgba(255,255,255,.5)"}}>Admin Dashboard</p>
          </div>
          <button onClick={onLogout} style={{background:"rgba(255,255,255,.1)",border:"none",color:"rgba(255,255,255,.7)",padding:"7px 14px",borderRadius:8,fontSize:13,cursor:"pointer",fontFamily:"'Noto Sans Thai',sans-serif"}}>
            ออกจากระบบ
          </button>
        </header>

        <div style={{background:"#fff",borderBottom:"1px solid var(--dv)",display:"flex",padding:"0 20px",overflowX:"auto"}}>
          {[["availability","🟢 ตารางว่าง"],["bookings","📋 การจอง"],["packages","🎟 แพ็คเกจ"],["closures","🚫 ปิดสนาม"],["report","📊 รายงาน"],["discounts","🏷 ส่วนลด"],["customers","👥 ลูกค้า"]].map(([id,label]) => (
            <button key={id} onClick={() => setTab(id)} style={{padding:"13px 16px",background:"none",border:"none",borderBottom:tab===id?"2.5px solid var(--or)":"2.5px solid transparent",color:tab===id?"var(--or)":"var(--mu)",fontWeight:tab===id?700:400,fontSize:14,cursor:"pointer",fontFamily:"'Noto Sans Thai',sans-serif",whiteSpace:"nowrap"}}>
              {label}
            </button>
          ))}
        </div>

        <div style={{padding:"20px",maxWidth:1000,margin:"0 auto"}}>
          {tab==="availability" && (
            <div>
              <div style={{display:"flex",gap:10,marginBottom:6,alignItems:"center",flexWrap:"wrap"}}>
                <input type="date" value={date} onChange={e=>setDate(e.target.value)}
                  style={{padding:"9px 12px",borderRadius:8,border:"1.5px solid var(--dv)",fontSize:14,outline:"none"}} />
                <button onClick={loadBookings} style={{padding:"9px 16px",borderRadius:8,border:"none",background:"var(--br)",color:"var(--or)",fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:"'Noto Sans Thai',sans-serif"}}>🔄 รีเฟรช</button>
                <span style={{fontSize:12,color:"var(--mu)"}}>ดูภาพรวมว่าช่วงเวลาไหนว่าง/ไม่ว่างในวันที่เลือก อัปเดตตามข้อมูลจริงล่าสุด</span>
              </div>
              <div style={{display:"flex",gap:16,margin:"10px 0 14px",fontSize:12,color:"var(--mu)"}}>
                <Dot color="#2d7a4f" label="ว่าง" />
                <Dot color="#c0392b" label="ไม่ว่าง / มีคนจอง" />
                <Dot color="#663924" label="ปิดสนาม" />
              </div>
              <p style={{fontSize:11.5,color:"var(--mu)",margin:"-6px 0 12px"}}>👆 กดที่ช่องที่มีชื่อลูกค้า เพื่อไปดูรายละเอียดการจองนั้นในแท็บ "การจอง" (สีแดง = ยืนยันแล้ว / ส้ม = รอตรวจสอบ / เหลือง = รอชำระ)</p>
              <div style={{background:"#fff",borderRadius:12,border:"1px solid var(--dv)",padding:0,boxShadow:"var(--sh)",overflow:"auto",maxHeight:640}}>
                {loading ? <p style={{padding:24,textAlign:"center",color:"var(--mu)"}}>⏳ กำลังโหลด...</p> : (() => {
                  const dateObj = new Date(date+"T00:00:00");
                  const now = Date.now();
                  const activeBookings = bookings.filter(b => {
                    if (b.status === "cancelled" || b.status === "blocked") return false;
                    if (b.status === "pending") {
                      const created = parseUtc(b.created_time).getTime();
                      return (now - created) < 5*60*1000;
                    }
                    return true;
                  });
                  const slots = [];
                  for (let m = DAY_START_MIN; m < DAY_END_MIN; m += 30) slots.push(m);
                  return (
                    <table className="adm-table" style={{tableLayout:"fixed",width:"100%"}}>
                      <thead><tr><th style={{width:90}}>เวลา</th><th>Court 1</th><th>Court 2</th></tr></thead>
                      <tbody>
                        {(() => {
                          const skip = {}; // ช่องที่ถูกรวมไปกับการจองด้านบนแล้ว (rowSpan) ไม่ต้องวาดซ้ำ
                          const stLabel = { confirmed: "✅ ยืนยันแล้ว", reviewing: "🔍 รอตรวจสอบ", pending: "⏳ รอชำระ" };
                          const stBg = { confirmed: "rgba(192,57,43,.12)", reviewing: "rgba(230,126,34,.16)", pending: "rgba(241,196,15,.2)" };
                          return slots.map(startMin => {
                            const endMin = startMin + 30;
                            return (
                              <tr key={startMin}>
                                <td style={{fontWeight:600,verticalAlign:"top"}}>{minutesToLabel(startMin)}–{minutesToLabel(endMin)}</td>
                                {[1,2].map(courtId => {
                                  if (skip[`${courtId}:${startMin}`]) return null;
                                  const bk = activeBookings.find(x => {
                                    if (x.court_id !== courtId) return false;
                                    const s = (x.hour||0)*60 + (x.start_minute||0);
                                    const e = s + (x.duration_minutes||60);
                                    return startMin < e && endMin > s;
                                  });
                                  if (bk) {
                                    const bs = (bk.hour||0)*60 + (bk.start_minute||0);
                                    const be = bs + (bk.duration_minutes||60);
                                    const span = Math.max(1, Math.ceil((Math.min(be, DAY_END_MIN) - startMin) / 30));
                                    for (let k = 1; k < span; k++) skip[`${courtId}:${startMin + 30*k}`] = true;
                                    return (
                                      <td key={courtId} rowSpan={span} onClick={() => goToBooking(bk)} title="กดเพื่อดูรายละเอียดการจอง"
                                        style={{verticalAlign:"top",textAlign:"left",background:stBg[bk.status] || "rgba(192,57,43,.12)",borderLeft:"3px solid #c0392b",cursor:"pointer",padding:"7px 9px"}}>
                                        <div style={{fontWeight:800,fontSize:13,color:"#8b1e12",lineHeight:1.3}}>
                                          {bk.customer_name || "-"}
                                          {bk.group_id && <span style={{marginLeft:5,fontSize:10,fontWeight:700,color:"var(--bl)",background:"var(--bl-bg)",padding:"1px 5px",borderRadius:8}}>🔗 คู่</span>}
                                          {bk.package_id && <span style={{marginLeft:5,fontSize:10,fontWeight:700,color:"#7a4a00",background:"rgba(255,213,74,.5)",padding:"1px 5px",borderRadius:8}}>🎟</span>}
                                        </div>
                                        <div style={{fontSize:12.5,fontWeight:600,color:"var(--br)",marginTop:2}}>📞 {bk.customer_id}</div>
                                        <div style={{fontSize:10.5,color:"var(--mu)",marginTop:2}}>{stLabel[bk.status] || bk.status} · {minutesToLabel(bs)}–{minutesToLabel(be)}</div>
                                      </td>
                                    );
                                  }
                                  if (isFullyBookedDate(dateObj) || isManuallyClosed(dateObj, courtId, startMin, endMin)) {
                                    return <td key={courtId} style={{textAlign:"center",background:"rgba(102,57,36,.08)",color:"#663924",fontWeight:700,fontSize:12.5,verticalAlign:"middle"}}>ปิด</td>;
                                  }
                                  return <td key={courtId} style={{textAlign:"center",background:"rgba(45,122,79,.08)",color:"#2d7a4f",fontWeight:700,fontSize:12.5,verticalAlign:"middle"}}>ว่าง</td>;
                                })}
                              </tr>
                            );
                          });
                        })()}
                      </tbody>
                    </table>
                  );
                })()}
              </div>
            </div>
          )}

          {tab==="bookings" && (
            <div>
              <div style={{marginBottom:24}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
                  <p style={{fontWeight:700,color:"var(--br)",fontSize:15}}>🔔 รายการที่ต้องตรวจสอบ/ยืนยัน {queue.length > 0 && `(${queue.length})`}</p>
                  <button onClick={loadQueue} style={{padding:"6px 12px",borderRadius:8,border:"1.5px solid var(--dv)",background:"#fff",color:"var(--mu)",fontWeight:600,fontSize:12,cursor:"pointer",fontFamily:"'Noto Sans Thai',sans-serif"}}>🔄 รีเฟรช</button>
                </div>
                <div style={{background:"#fff",borderRadius:12,border:"1.5px solid #e67e22",overflow:"auto",boxShadow:"var(--sh)"}}>
                  {queueLoading ? <p style={{padding:24,textAlign:"center",color:"var(--mu)"}}>⏳ กำลังโหลด...</p> :
                  queue.length === 0 ? <p style={{padding:24,textAlign:"center",color:"var(--mu)"}}>✅ ไม่มีรายการค้างตรวจสอบ</p> : (
                    <table className="adm-table">
                      <thead><tr><th>วันที่</th><th>สนาม</th><th>เวลา</th><th>ชื่อลูกค้า</th><th>เบอร์</th><th>ราคา</th><th>สลิป</th><th>สถานะ</th><th>จัดการ</th></tr></thead>
                      <tbody>
                        {queue.map(b => {
                          const st = stInfo(b.status);
                          return (
                            <tr key={b.id}>
                              <td>{new Date(b.booking_date).toLocaleDateString("th-TH",{day:"2-digit",month:"short"})}</td>
                              <td style={{fontWeight:700}}>Court {b.court_id}{b.group_id && <span title="จอง 2 สนามพร้อมกัน โอนครั้งเดียว" style={{marginLeft:6,fontSize:10.5,fontWeight:700,color:"var(--bl)",background:"var(--bl-bg)",padding:"2px 6px",borderRadius:10}}>🔗 คู่</span>}</td>
                              <td>{fmtTime(b)}</td>
                              <td style={{fontWeight:600}}>{b.customer_name || "-"}</td>
                              <td>{b.customer_id}</td>
                              <td style={{fontWeight:700,color:"var(--or)"}}>{b.package_id ? "🎟 แพ็คเกจ" : `฿${b.price?.toLocaleString()}`}</td>
                              <td>{b.slip_url ? <a href={b.slip_url} target="_blank" rel="noreferrer" style={{color:"var(--bl)",fontWeight:600}}>ดูสลิป 🔗</a> : <span style={{color:"var(--mu)"}}>-</span>}</td>
                              <td><span style={{fontSize:12,fontWeight:600,color:st.color,background:`${st.color}18`,padding:"3px 8px",borderRadius:20}}>{st.text}</span></td>
                              <td>
                                <div style={{display:"flex",gap:6}}>
                                  <button onClick={()=>updateStatus(b.id,"confirmed",null,b.group_id)} style={{padding:"5px 10px",borderRadius:6,border:"none",background:"rgba(45,122,79,.15)",color:"#2d7a4f",fontWeight:700,fontSize:12,cursor:"pointer"}}>✅</button>
                                  <button onClick={()=>updateStatus(b.id,"cancelled",b.package_id,b.group_id)} style={{padding:"5px 10px",borderRadius:6,border:"none",background:"rgba(192,57,43,.1)",color:"#c0392b",fontWeight:700,fontSize:12,cursor:"pointer"}}>❌</button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>

              <p style={{fontWeight:700,color:"var(--br)",fontSize:15,marginBottom:10}}>📅 ดูตามวันที่</p>
              <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:20}}>
                {[
                  {label:"ทั้งหมด",val:bookings.filter(b=>b.status!=="blocked").length,color:"var(--br)"},
                  {label:"การจองสำเร็จ",val:bookings.filter(b=>b.status==="confirmed").length,color:"#2d7a4f"},
                  {label:"รอดำเนินการ",val:bookings.filter(b=>b.status==="reviewing"||b.status==="pending").length,color:"#e67e22"},
                  {label:"รายได้วันนี้",val:`฿${revenue.toLocaleString()}`,color:"var(--or)"},
                ].map(({label,val,color}) => (
                  <div key={label} style={{background:"#fff",borderRadius:12,padding:"14px",textAlign:"center",border:"1px solid var(--dv)",boxShadow:"var(--sh)"}}>
                    <p style={{fontSize:11,color:"var(--mu)",marginBottom:4}}>{label}</p>
                    <p style={{fontSize:20,fontWeight:800,color}}>{val}</p>
                  </div>
                ))}
              </div>
              <div style={{display:"flex",gap:10,marginBottom:16}}>
                <input type="date" value={date} onChange={e=>setDate(e.target.value)}
                  style={{padding:"9px 12px",borderRadius:8,border:"1.5px solid var(--dv)",fontSize:14,outline:"none"}} />
                <button onClick={loadBookings} style={{padding:"9px 16px",borderRadius:8,border:"none",background:"var(--br)",color:"var(--or)",fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:"'Noto Sans Thai',sans-serif"}}>🔄 รีเฟรช</button>
              </div>
              <div style={{background:"#fff",borderRadius:12,border:"1px solid var(--dv)",overflow:"auto",boxShadow:"var(--sh)"}}>
                {loading ? <p style={{padding:24,textAlign:"center",color:"var(--mu)"}}>⏳ กำลังโหลด...</p> :
                bookings.length === 0 ? <p style={{padding:24,textAlign:"center",color:"var(--mu)"}}>ไม่มีการจองในวันนี้</p> : (
                  <table className="adm-table">
                    <thead><tr><th>สนาม</th><th>เวลา</th><th>ชื่อลูกค้า</th><th>เบอร์</th><th>ราคา</th><th>สลิป</th><th>สถานะ</th><th>จัดการ</th></tr></thead>
                    <tbody>
                      {sortedBookings.map(b => {
                        const st = stInfo(b.status);
                        return (
                          <tr key={b.id} id={`bk-${b.id}`} style={highlightId === b.id ? {background:"rgba(255,213,74,.4)",outline:"2px solid #E8A200"} : undefined}>
                            <td style={{fontWeight:700}}>Court {b.court_id}{b.group_id && <span title="จอง 2 สนามพร้อมกัน โอนครั้งเดียว" style={{marginLeft:6,fontSize:10.5,fontWeight:700,color:"var(--bl)",background:"var(--bl-bg)",padding:"2px 6px",borderRadius:10}}>🔗 คู่</span>}</td>
                            <td>{fmtTime(b)}</td>
                            <td style={{fontWeight:600}}>{b.customer_name || "-"}</td>
                            <td>{b.customer_id}</td>
                            <td style={{fontWeight:700,color:"var(--or)"}}>{b.package_id ? "🎟 แพ็คเกจ" : `฿${b.price?.toLocaleString()}`}</td>
                            <td>{b.slip_url ? <a href={b.slip_url} target="_blank" rel="noreferrer" style={{color:"var(--bl)",fontWeight:600}}>ดูสลิป 🔗</a> : <span style={{color:"var(--mu)"}}>-</span>}</td>
                            <td><span style={{fontSize:12,fontWeight:600,color:st.color,background:`${st.color}18`,padding:"3px 8px",borderRadius:20}}>{st.text}</span></td>
                            <td>
                              {b.status!=="cancelled" && b.status!=="blocked" && (
                                <div style={{display:"flex",gap:6}}>
                                  {b.status!=="confirmed" && <button onClick={()=>updateStatus(b.id,"confirmed",null,b.group_id)} style={{padding:"5px 10px",borderRadius:6,border:"none",background:"rgba(45,122,79,.15)",color:"#2d7a4f",fontWeight:700,fontSize:12,cursor:"pointer"}}>✅</button>}
                                  <button onClick={()=>updateStatus(b.id,"cancelled",b.package_id,b.group_id)} style={{padding:"5px 10px",borderRadius:6,border:"none",background:"rgba(192,57,43,.1)",color:"#c0392b",fontWeight:700,fontSize:12,cursor:"pointer"}}>❌</button>
                                </div>
                              )}
                              {b.status==="blocked" && <span style={{fontSize:11,color:"var(--mu)"}}>จัดการที่แท็บ "ปิดสนาม"</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}

          {tab==="packages" && (
            <div>
              <p style={{fontWeight:700,color:"var(--br)",fontSize:15,marginBottom:10}}>🔔 รายการรอตรวจสอบ/ยืนยัน {pkgQueue.length > 0 && `(${pkgQueue.length})`}</p>
              <div style={{background:"#fff",borderRadius:12,border:"1.5px solid #e67e22",overflow:"auto",boxShadow:"var(--sh)",marginBottom:24}}>
                {pkgQueueLoading ? <p style={{padding:24,textAlign:"center",color:"var(--mu)"}}>⏳ กำลังโหลด...</p> :
                pkgQueue.length === 0 ? <p style={{padding:24,textAlign:"center",color:"var(--mu)"}}>✅ ไม่มีรายการค้างตรวจสอบ</p> : (
                  <table className="adm-table">
                    <thead><tr><th>ชื่อลูกค้า</th><th>เบอร์</th><th>แพ็คเกจ</th><th>ราคา</th><th>สลิป</th><th>สถานะ</th><th>จัดการ</th></tr></thead>
                    <tbody>
                      {pkgQueue.map(pk => (
                        <tr key={pk.id}>
                          <td style={{fontWeight:600}}>{pk.customer_name || "-"}</td>
                          <td>{pk.customer_id}</td>
                          <td>{pk.tier==="peak"?"Peak":"Off Peak"} × {pk.total_credits} ครั้ง</td>
                          <td style={{fontWeight:700,color:"var(--or)"}}>฿{pk.price?.toLocaleString()}</td>
                          <td>{pk.slip_url ? <a href={pk.slip_url} target="_blank" rel="noreferrer" style={{color:"var(--bl)",fontWeight:600}}>ดูสลิป 🔗</a> : <span style={{color:"var(--mu)"}}>-</span>}</td>
                          <td><span style={{fontSize:12,fontWeight:600,color:pk.status==="reviewing"?"#e67e22":"var(--mu)"}}>{pk.status==="reviewing"?"🔍 รอการยืนยัน":"⏳ รอชำระ"}</span></td>
                          <td>
                            <div style={{display:"flex",gap:6}}>
                              <button onClick={()=>confirmPackage(pk.id)} style={{padding:"5px 10px",borderRadius:6,border:"none",background:"rgba(45,122,79,.15)",color:"#2d7a4f",fontWeight:700,fontSize:12,cursor:"pointer"}}>✅</button>
                              <button onClick={()=>cancelPackage(pk.id)} style={{padding:"5px 10px",borderRadius:6,border:"none",background:"rgba(192,57,43,.1)",color:"#c0392b",fontWeight:700,fontSize:12,cursor:"pointer"}}>❌</button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
                <p style={{fontWeight:700,color:"var(--br)",fontSize:15}}>📋 แพ็คเกจทั้งหมด (ล่าสุด 200 รายการ)</p>
                <button onClick={loadAllPkgs} style={{padding:"6px 12px",borderRadius:8,border:"1.5px solid var(--dv)",background:"#fff",color:"var(--mu)",fontWeight:600,fontSize:12,cursor:"pointer",fontFamily:"'Noto Sans Thai',sans-serif"}}>🔄 รีเฟรช</button>
              </div>
              <div style={{background:"#fff",borderRadius:12,border:"1px solid var(--dv)",overflow:"auto",boxShadow:"var(--sh)"}}>
                {allPkgsLoading ? <p style={{padding:24,textAlign:"center",color:"var(--mu)"}}>⏳ กำลังโหลด...</p> :
                allPkgs.length === 0 ? <p style={{padding:24,textAlign:"center",color:"var(--mu)"}}>ยังไม่มีแพ็คเกจ</p> : (
                  <table className="adm-table">
                    <thead><tr><th>ชื่อลูกค้า</th><th>เบอร์</th><th>แพ็คเกจ</th><th>ใช้ไป</th><th>คงเหลือ</th><th>ซื้อสำเร็จเมื่อ</th><th>หมดอายุ</th><th>สถานะ</th></tr></thead>
                    <tbody>
                      {allPkgs.map(pk => {
                        const expired = pk.status==="active" && pk.expiry_date && new Date(pk.expiry_date+"T23:59:59") < new Date();
                        const used = pk.status==="active" || pk.status==="cancelled" ? (pk.total_credits - pk.remaining_credits) : null;
                        return (
                          <tr key={pk.id}>
                            <td style={{fontWeight:600}}>{pk.customer_name || "-"}</td>
                            <td>{pk.customer_id}</td>
                            <td>{pk.tier==="peak"?"Peak":"Off Peak"} × {pk.total_credits}</td>
                            <td>{used!=null ? `${used} ครั้ง` : "-"}</td>
                            <td>{pk.status==="active" ? `${pk.remaining_credits} / ${pk.total_credits}` : "-"}</td>
                            <td>{pk.activated_at ? parseUtc(pk.activated_at).toLocaleDateString("th-TH",{day:"2-digit",month:"short",year:"numeric",timeZone:"Asia/Bangkok"}) : "-"}</td>
                            <td>{pk.expiry_date ? new Date(pk.expiry_date).toLocaleDateString("th-TH",{day:"2-digit",month:"short",year:"numeric"}) : "-"}</td>
                            <td>
                              <span style={{fontSize:11.5,fontWeight:600,color:expired?"#c0392b":pk.status==="active"?"#2d7a4f":pk.status==="cancelled"?"#c0392b":"var(--mu)"}}>
                                {expired ? "หมดอายุแล้ว" : pk.status==="active" ? "ใช้งานได้" : pk.status==="cancelled" ? "ยกเลิกแล้ว" : pk.status==="reviewing" ? "รอการยืนยัน" : "รอชำระ"}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}

          {tab==="closures" && (
            <div>
              <div style={{background:"#fff",borderRadius:12,padding:20,marginBottom:20,border:"1px solid var(--dv)",boxShadow:"var(--sh)"}}>
                <p style={{fontWeight:700,color:"var(--br)",marginBottom:6}}>🚫 ปิดสนาม</p>
                <p style={{fontSize:12,color:"var(--mu)",marginBottom:16}}>เลือกวันที่ สนาม และช่วงเวลาที่ต้องการปิด (เช่น ปิดซ่อมบำรุง) ลูกค้าจะไม่สามารถจองช่วงเวลานี้ได้จนกว่าจะกดเปิดใช้งานอีกครั้ง</p>
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:10,marginBottom:14}}>
                  <div>
                    <label style={{fontSize:12,color:"var(--mu)",display:"block",marginBottom:5}}>วันที่</label>
                    <input type="date" value={closeDate} onChange={e=>setCloseDate(e.target.value)}
                      style={{width:"100%",padding:"9px 10px",borderRadius:8,border:"1.5px solid var(--dv)",fontSize:14,outline:"none"}} />
                  </div>
                  <div>
                    <label style={{fontSize:12,color:"var(--mu)",display:"block",marginBottom:5}}>สนาม</label>
                    <select value={closeCourt} onChange={e=>setCloseCourt(e.target.value)}
                      style={{width:"100%",padding:"9px 10px",borderRadius:8,border:"1.5px solid var(--dv)",fontSize:14,outline:"none",background:"#fff"}}>
                      <option value="both">Court 1 และ 2</option>
                      <option value="1">Court 1</option>
                      <option value="2">Court 2</option>
                    </select>
                  </div>
                  <div>
                    <label style={{fontSize:12,color:"var(--mu)",display:"block",marginBottom:5}}>เวลาเริ่ม</label>
                    <select value={closeStart} onChange={e=>setCloseStart(e.target.value)}
                      style={{width:"100%",padding:"9px 10px",borderRadius:8,border:"1.5px solid var(--dv)",fontSize:14,outline:"none",background:"#fff"}}>
                      {CLOSE_TIME_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={{fontSize:12,color:"var(--mu)",display:"block",marginBottom:5}}>เวลาสิ้นสุด</label>
                    <select value={closeEnd} onChange={e=>setCloseEnd(e.target.value)}
                      style={{width:"100%",padding:"9px 10px",borderRadius:8,border:"1.5px solid var(--dv)",fontSize:14,outline:"none",background:"#fff"}}>
                      {CLOSE_TIME_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                </div>
                <div style={{marginBottom:14}}>
                  <label style={{fontSize:12,color:"var(--mu)",display:"block",marginBottom:5}}>เหตุผล (ไม่บังคับ)</label>
                  <input value={closeReason} onChange={e=>setCloseReason(e.target.value)} placeholder="เช่น ซ่อมบำรุง, ทำความสะอาด"
                    style={{width:"100%",padding:"10px 12px",borderRadius:8,border:"1.5px solid var(--dv)",fontSize:14,outline:"none"}} />
                </div>
                <button onClick={handleCloseCourt} disabled={closing} style={{padding:"11px 20px",borderRadius:8,border:"none",background:"#c0392b",color:"#fff",fontWeight:700,fontSize:14,cursor:closing?"not-allowed":"pointer",opacity:closing?0.7:1,fontFamily:"'Noto Sans Thai',sans-serif"}}>
                  {closing ? "⏳ กำลังปิด..." : "🚫 ปิดสนามตามที่เลือก"}
                </button>
              </div>

              <p style={{fontWeight:700,color:"var(--br)",fontSize:15,marginBottom:10}}>รายการที่ปิดอยู่ตอนนี้ (จากวันนี้เป็นต้นไป)</p>
              <div style={{background:"#fff",borderRadius:12,border:"1px solid var(--dv)",overflow:"auto",boxShadow:"var(--sh)"}}>
                {blocksLoading ? <p style={{padding:24,textAlign:"center",color:"var(--mu)"}}>⏳ กำลังโหลด...</p> :
                blocks.length === 0 ? <p style={{padding:24,textAlign:"center",color:"var(--mu)"}}>ไม่มีรายการปิดสนามที่กำลังจะมาถึง</p> : (
                  <table className="adm-table">
                    <thead><tr><th>วันที่</th><th>สนาม</th><th>เวลา</th><th>เหตุผล</th><th>จัดการ</th></tr></thead>
                    <tbody>
                      {blocks.map(b => (
                        <tr key={b.id}>
                          <td>{new Date(b.booking_date).toLocaleDateString("th-TH",{day:"2-digit",month:"short",year:"numeric"})}</td>
                          <td style={{fontWeight:700}}>Court {b.court_id}{b.group_id && <span title="จอง 2 สนามพร้อมกัน โอนครั้งเดียว" style={{marginLeft:6,fontSize:10.5,fontWeight:700,color:"var(--bl)",background:"var(--bl-bg)",padding:"2px 6px",borderRadius:10}}>🔗 คู่</span>}</td>
                          <td>{fmtTime(b)}</td>
                          <td style={{color:"var(--mu)"}}>{(b.customer_name||"").replace("🚫 ปิดสนาม","").replace(/[()]/g,"").trim() || "-"}</td>
                          <td>
                            <button onClick={()=>handleUnblock(b.id)} style={{padding:"5px 10px",borderRadius:6,border:"none",background:"rgba(45,122,79,.15)",color:"#2d7a4f",fontWeight:700,fontSize:12,cursor:"pointer"}}>
                              เปิดใช้งาน
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}

          {tab==="report" && (
            <div>
              <div style={{background:"#fff",borderRadius:12,padding:20,marginBottom:20,border:"1px solid var(--dv)",boxShadow:"var(--sh)"}}>
                <p style={{fontWeight:700,color:"var(--br)",marginBottom:6}}>📊 รายงานสรุปรายรับต่อวัน</p>
                <p style={{fontSize:12,color:"var(--mu)",marginBottom:14}}>นับตามวันที่ลูกค้าทำรายการโอนเงินจริง (ไม่ใช่วันที่จองล่วงหน้า) — กดที่แถววันที่เพื่อดูรายละเอียดว่าใครจองบ้าง</p>
                <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
                  <div>
                    <label style={{fontSize:12,color:"var(--mu)",display:"block",marginBottom:4}}>จากวันที่</label>
                    <input type="date" value={reportFrom} onChange={e=>setReportFrom(e.target.value)}
                      style={{padding:"9px 12px",borderRadius:8,border:"1.5px solid var(--dv)",fontSize:14,outline:"none"}} />
                  </div>
                  <div>
                    <label style={{fontSize:12,color:"var(--mu)",display:"block",marginBottom:4}}>ถึงวันที่</label>
                    <input type="date" value={reportTo} onChange={e=>setReportTo(e.target.value)}
                      style={{padding:"9px 12px",borderRadius:8,border:"1.5px solid var(--dv)",fontSize:14,outline:"none"}} />
                  </div>
                  <button onClick={loadReport} style={{marginTop:18,padding:"9px 16px",borderRadius:8,border:"none",background:"var(--br)",color:"var(--or)",fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:"'Noto Sans Thai',sans-serif"}}>🔄 ดึงรายงาน</button>
                </div>
              </div>

              <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:12,marginBottom:20}}>
                <div style={{background:"#fff",borderRadius:12,padding:"14px",textAlign:"center",border:"1px solid var(--dv)",boxShadow:"var(--sh)"}}>
                  <p style={{fontSize:11,color:"var(--mu)",marginBottom:4}}>จำนวนรายการที่สำเร็จ (ช่วงที่เลือก)</p>
                  <p style={{fontSize:22,fontWeight:800,color:"var(--br)"}}>{reportGrandCount}</p>
                </div>
                <div style={{background:"#fff",borderRadius:12,padding:"14px",textAlign:"center",border:"1px solid var(--dv)",boxShadow:"var(--sh)"}}>
                  <p style={{fontSize:11,color:"var(--mu)",marginBottom:4}}>รายรับรวม (ช่วงที่เลือก)</p>
                  <p style={{fontSize:22,fontWeight:800,color:"var(--or)"}}>฿{reportGrandTotal.toLocaleString()}</p>
                </div>
              </div>

              <div style={{background:"#fff",borderRadius:12,border:"1px solid var(--dv)",overflow:"auto",boxShadow:"var(--sh)"}}>
                {reportLoading ? <p style={{padding:24,textAlign:"center",color:"var(--mu)"}}>⏳ กำลังโหลด...</p> :
                reportRows.length === 0 ? <p style={{padding:24,textAlign:"center",color:"var(--mu)"}}>ไม่มีข้อมูลในช่วงวันที่เลือก</p> : (
                  <table className="adm-table">
                    <thead><tr><th></th><th>วันที่</th><th>รายการสำเร็จ</th><th>รายรับ</th><th>รายการอื่นๆ (รอ/ยกเลิก)</th></tr></thead>
                    <tbody>
                      {reportRows.map(r => (
                        <Fragment key={r.day}>
                          <tr onClick={()=>toggleDayDetail(r.day)} style={{cursor:"pointer"}}>
                            <td style={{width:20,color:"var(--mu)"}}>{expandedDay===r.day?"▾":"▸"}</td>
                            <td style={{fontWeight:700}}>{new Date(r.day).toLocaleDateString("th-TH",{year:"numeric",month:"short",day:"numeric"})}</td>
                            <td>{r.confirmedCount}</td>
                            <td style={{fontWeight:700,color:"var(--or)"}}>฿{r.confirmedTotal.toLocaleString()}</td>
                            <td style={{color:"var(--mu)"}}>{r.otherCount}</td>
                          </tr>
                          {expandedDay===r.day && (
                            <tr>
                              <td colSpan={5} style={{padding:0,background:"#faf7f2"}}>
                                {dayDetailLoading ? (
                                  <p style={{padding:16,textAlign:"center",color:"var(--mu)"}}>⏳ กำลังโหลด...</p>
                                ) : (
                                  <table className="adm-table adm-table-sub" style={{margin:"8px 12px",width:"calc(100% - 24px)"}}>
                                    <thead><tr><th>โอนเงินตอน</th><th>ชื่อลูกค้า</th><th>สนาม</th><th>วันที่จอง</th><th>เวลาที่จอง</th><th>สถานะ</th></tr></thead>
                                    <tbody>
                                      {dayDetail.map(b => {
                                        const st = stInfo(b.status);
                                        return (
                                          <tr key={b.id}>
                                            <td>{fmtCreatedTime(b.created_time)}</td>
                                            <td style={{fontWeight:600}}>{b.customer_name || "-"}</td>
                                            <td>Court {b.court_id}</td>
                                            <td>{new Date(b.booking_date).toLocaleDateString("th-TH",{day:"2-digit",month:"short"})}</td>
                                            <td>{fmtTime(b)}</td>
                                            <td><span style={{fontSize:11,fontWeight:600,color:st.color}}>{st.text}</span></td>
                                          </tr>
                                        );
                                      })}
                                    </tbody>
                                  </table>
                                )}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}

          {tab==="discounts" && (
            <div>
              <div style={{background:"#fff",borderRadius:12,padding:20,marginBottom:20,border:"1px solid var(--dv)",boxShadow:"var(--sh)"}}>
                <p style={{fontWeight:700,color:"var(--br)",marginBottom:14}}>➕ สร้างรหัสส่วนลดใหม่</p>
                <div style={{display:"grid",gridTemplateColumns:"1fr auto",gap:8,marginBottom:10}}>
                  <input value={newCode} onChange={e=>setNewCode(e.target.value.toUpperCase())} placeholder="รหัส เช่น NOVA50"
                    style={{padding:"10px 12px",borderRadius:8,border:"1.5px solid var(--dv)",fontSize:14,outline:"none"}} />
                  <button onClick={genCode} style={{padding:"0 14px",borderRadius:8,border:"1.5px solid var(--dv)",background:"#fff",color:"var(--mu)",fontSize:13,cursor:"pointer"}}>🎲 สุ่ม</button>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:14}}>
                  <div>
                    <label style={{fontSize:12,color:"var(--mu)",display:"block",marginBottom:5}}>ส่วนลด (บาท)</label>
                    <input type="number" value={newAmt} onChange={e=>setNewAmt(e.target.value)} min="1"
                      style={{width:"100%",padding:"10px 12px",borderRadius:8,border:"1.5px solid var(--dv)",fontSize:14,outline:"none"}} />
                  </div>
                  <div>
                    <label style={{fontSize:12,color:"var(--mu)",display:"block",marginBottom:5}}>ใช้ได้กี่ครั้ง</label>
                    <input type="number" value={newMax} onChange={e=>setNewMax(e.target.value)} min="1"
                      style={{width:"100%",padding:"10px 12px",borderRadius:8,border:"1.5px solid var(--dv)",fontSize:14,outline:"none"}} />
                  </div>
                </div>
                <button onClick={createCode} disabled={!newCode.trim()} style={{width:"100%",padding:"12px",borderRadius:8,border:"none",background:"var(--br)",color:"var(--or)",fontWeight:700,fontSize:14,cursor:"pointer",fontFamily:"'Noto Sans Thai',sans-serif"}}>
                  สร้างรหัส
                </button>
              </div>
              <div style={{background:"#fff",borderRadius:12,border:"1px solid var(--dv)",overflow:"auto",boxShadow:"var(--sh)"}}>
                <table className="adm-table">
                  <thead><tr><th>รหัส</th><th>ส่วนลด</th><th>ใช้แล้ว/ทั้งหมด</th><th>สถานะ</th><th>จัดการ</th></tr></thead>
                  <tbody>
                    {discounts.map(c => (
                      <tr key={c.id}>
                        <td style={{fontWeight:700,fontFamily:"monospace"}}>{c.code}</td>
                        <td style={{fontWeight:700,color:"var(--or)"}}>฿{c.discount_amount||`${c.discount_percent}%`}</td>
                        <td>{c.used_count}/{c.max_uses}</td>
                        <td><span style={{fontSize:12,fontWeight:600,color:c.active?"#2d7a4f":"#c0392b",background:c.active?"rgba(45,122,79,.1)":"rgba(192,57,43,.1)",padding:"3px 8px",borderRadius:20}}>{c.active?"ใช้งานได้":"ปิดใช้งาน"}</span></td>
                        <td><button onClick={()=>toggleDiscount(c.id,!c.active)} style={{padding:"5px 10px",borderRadius:6,border:"none",background:c.active?"rgba(192,57,43,.1)":"rgba(45,122,79,.1)",color:c.active?"#c0392b":"#2d7a4f",fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:"'Noto Sans Thai',sans-serif"}}>{c.active?"ปิด":"เปิด"}</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {tab==="customers" && (
            <div style={{background:"#fff",borderRadius:12,border:"1px solid var(--dv)",overflow:"auto",boxShadow:"var(--sh)"}}>
              <table className="adm-table">
                <thead><tr><th>#</th><th>ชื่อ</th><th>เบอร์โทร</th></tr></thead>
                <tbody>
                  {customers.map((c,i) => (
                    <tr key={c.customer_id}>
                      <td style={{color:"var(--mu)"}}>{i+1}</td>
                      <td style={{fontWeight:600}}>{c.customer_name}</td>
                      <td style={{fontFamily:"monospace"}}>{c.customer_id}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

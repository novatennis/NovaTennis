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

const FIRST_TIME_PRICE = 450; // โปรโมชั่นจองครั้งแรก — ชั่วโมงละ 450 บาท ไม่ว่าช่วง Off Peak/Peak

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
        const { body } = await sb(`bookings?id=eq.${id}&select=*`);
        const booking = (body || [])[0] || null;
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
        const { body } = await sb(`bookings?customer_id=eq.${phone}&select=*&order=booking_date.desc`);
        res.status(200).json({ bookings: body || [] });
        return;
      }

      case "checkDiscount": {
        const { code } = p;
        if (!code) { res.status(200).json({ valid: false }); return; }
        const { body } = await sb(`discount_codes?code=eq.${String(code).toUpperCase()}&active=eq.true&select=*`);
        const d = (body || [])[0];
        if (!d || d.used_count >= d.max_uses) { res.status(200).json({ valid: false }); return; }
        res.status(200).json({
          valid: true, id: d.id, code: d.code,
          discount_amount: d.discount_amount, discount_percent: d.discount_percent,
        });
        return;
      }

      case "createBooking": {
        const { courtId, customerId, customerName, bookingDate, hour, startMinute, durationMinutes, discountCodeId, packageId } = p;
        if (!courtId || !customerId || !customerName || !bookingDate || hour == null || !durationMinutes) {
          res.status(400).json({ error: "missing params" }); return;
        }
        if (!/^[0-9]{10}$/.test(customerId)) { res.status(400).json({ error: "invalid phone" }); return; }
        if (String(customerName).trim().length < 1 || String(customerName).length > 16) {
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
          if (durationMinutes !== 60) { res.status(400).json({ error: "package_60min_only" }); return; }
          const { body: pkgRows } = await sb(`packages?id=eq.${packageId}&customer_id=eq.${customerId}&select=*`);
          const pkg = (pkgRows || [])[0];
          if (!pkg || pkg.status !== "active") { res.status(400).json({ error: "package_not_active" }); return; }
          if (pkg.remaining_credits <= 0) { res.status(400).json({ error: "package_no_credits" }); return; }
          if (pkg.expiry_date && new Date(pkg.expiry_date + "T23:59:59") < new Date()) { res.status(400).json({ error: "package_expired" }); return; }
          // แพ็ค Peak ใช้จองได้ทั้งช่วง Peak และ Off Peak — แพ็ค Off Peak ใช้ได้เฉพาะช่วง Off Peak เท่านั้น
          const slotTier = isPeak ? "peak" : "offpeak";
          if (!(pkg.tier === "peak" || pkg.tier === slotTier)) { res.status(400).json({ error: "package_wrong_tier" }); return; }

          await sb(`customers`, {
            method: "POST",
            headers: { Prefer: "resolution=merge-duplicates" },
            body: JSON.stringify({ customer_id: customerId, customer_name: customerName }),
          });

          const { body: created } = await sb(`bookings`, {
            method: "POST",
            headers: { Prefer: "return=representation" },
            body: JSON.stringify({
              court_id: courtId, customer_id: customerId, customer_name: customerName,
              booking_date: bookingDate, hour, start_minute: startMinute || 0, duration_minutes: 60,
              price: 0, package_id: packageId, status: "reviewing", // รอแอดมินกดยืนยันก่อนถึงจะหักสิทธิ์จริง
            }),
          });
          const bookingRow = (created || [])[0];
          if (!bookingRow) { res.status(500).json({ error: "insert_failed" }); return; }

          const nowBangkok = new Date(Date.now() + 7 * 60 * 60 * 1000);
          const timeStr = nowBangkok.toISOString().substr(11, 5);
          const text =
            `🎟 <b>มีการจองด้วยสิทธิ์แพ็คเกจ</b>\n` +
            `รอการยืนยันจากแอดมิน (จะหักสิทธิ์ก็ต่อเมื่อกดยืนยันแล้วเท่านั้น)\n\n` +
            `👤 ${customerName}\n` +
            `📞 ${customerId}\n` +
            `🎾 Court ${courtId}\n` +
            `📅 ${bookingDate}\n` +
            `🕐 ${minutesToLabel(startMin)}–${minutesToLabel(endMin)}\n` +
            `🎫 สิทธิ์เหลือก่อนจอง: ${pkg.remaining_credits} / ${pkg.total_credits} ครั้ง\n` +
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
        if (durationMinutes === 60 && basePrice > FIRST_TIME_PRICE) {
          const firstTime = await isFirstTimeCustomer(customerId);
          if (firstTime) { basePrice = FIRST_TIME_PRICE; isFirstTimePromo = true; }
        }

        let discountAmount = 0;
        let discountRow = null;
        if (discountCodeId) {
          const { body: discRows } = await sb(`discount_codes?id=eq.${discountCodeId}&active=eq.true&select=*`);
          const d = (discRows || [])[0];
          if (d && d.used_count < d.max_uses) {
            discountAmount = d.discount_amount > 0 ? d.discount_amount : Math.round(basePrice * d.discount_percent / 100);
            discountRow = d;
          }
        }
        const finalPrice = Math.max(0, basePrice - discountAmount);

        await sb(`customers`, {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates" },
          body: JSON.stringify({ customer_id: customerId, customer_name: customerName }),
        });

        const { body: created } = await sb(`bookings`, {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({
            court_id: courtId, customer_id: customerId, customer_name: customerName,
            booking_date: bookingDate, hour, start_minute: startMinute || 0, duration_minutes: durationMinutes,
            price: finalPrice, discount_code: discountRow?.code || null, discount_amount: discountAmount,
            status: "pending",
          }),
        });
        const bookingRow = (created || [])[0];
        if (!bookingRow) { res.status(500).json({ error: "insert_failed" }); return; }

        if (discountRow) {
          await sb(`discount_codes?id=eq.${discountRow.id}`, {
            method: "PATCH",
            body: JSON.stringify({ used_count: discountRow.used_count + 1 }),
          });
        }

        res.status(200).json({ booking: bookingRow, isFirstTimePromo });
        return;
      }

      case "createBookingMulti": {
        // จอง 2 สนามช่วงเวลาเดียวกันในครั้งเดียว — สร้าง 2 แถวพร้อมกัน (all-or-nothing) ใช้ group_id เดียวกัน โอนทีเดียว
        // ข้อจำกัดโดยตั้งใจ: ราคาปกติเท่านั้น (ไม่ร่วมกับแพ็คเกจ/โค้ดส่วนลด/โปรจองครั้งแรก) เพื่อให้ยอดรวมชัดเจน ไม่สับสน
        const { courtIds, customerId, customerName, bookingDate, hour, startMinute, durationMinutes } = p;
        const ids = Array.isArray(courtIds) ? [...new Set(courtIds.map(Number))].sort() : [];
        if (ids.length !== 2 || ids[0] !== 1 || ids[1] !== 2) { res.status(400).json({ error: "invalid courts" }); return; }
        if (!customerId || !customerName || !bookingDate || hour == null || ![30, 60, 90, 120].includes(durationMinutes)) {
          res.status(400).json({ error: "missing params" }); return;
        }
        if (!/^[0-9]{10}$/.test(customerId)) { res.status(400).json({ error: "invalid phone" }); return; }
        if (String(customerName).trim().length < 1 || String(customerName).length > 16) { res.status(400).json({ error: "invalid name" }); return; }

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
          headers: { Prefer: "resolution=merge-duplicates" },
          body: JSON.stringify({ customer_id: customerId, customer_name: customerName }),
        });

        const rowsToInsert = ids.map(cid => ({
          court_id: cid, customer_id: customerId, customer_name: customerName,
          booking_date: bookingDate, hour, start_minute: startMinute || 0, duration_minutes: durationMinutes,
          price: unitPrice, discount_amount: 0, status: "pending", group_id: groupId,
        }));
        const { ok, body: created } = await sb(`bookings`, {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify(rowsToInsert),
        });
        if (!ok || !Array.isArray(created) || created.length !== 2) {
          console.error("createBookingMulti insert failed:", created);
          res.status(500).json({ error: "insert_failed" }); return;
        }
        res.status(200).json({ bookings: created, groupId });
        return;
      }

      case "updateSlip": {
        const { bookingId, slipUrl } = p;
        if (!bookingId || !slipUrl) { res.status(400).json({ error: "missing params" }); return; }
        // เงื่อนไข status=in.(pending,reviewing) กันไว้อีกชั้น: แก้ได้เฉพาะรายการที่ยังไม่ถูกยืนยัน/ยกเลิกเท่านั้น
        // (เผื่อกรณีลูกค้ากดส่งสลิปซ้ำ หรือกลับมาแนบสลิปใหม่หลัง resume session — ไม่ให้ค้างเหมือนก่อนหน้านี้)
        const { ok, body } = await sb(`bookings?id=eq.${bookingId}&status=in.(pending,reviewing)`, {
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
        res.status(200).json({ booking: row });
        return;
      }

      case "cancelPending": {
        // ลูกค้ากดยกเลิกเองจากหน้าชำระเงิน (เช่นกดหมดเวลาแล้วไม่รอ) — ปล่อยช่วงเวลาคืนทันที + แจ้งเตือนแอดมิน
        const { bookingId } = p;
        if (!bookingId) { res.status(400).json({ error: "missing bookingId" }); return; }
        const { ok, body } = await sb(`bookings?id=eq.${bookingId}&status=in.(pending,reviewing)`, {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({ status: "cancelled" }),
        });
        const row = (body || [])[0] || null;
        if (ok && row) {
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
            `👤 ${row.customer_name || "-"}\n` +
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
        const { tier, credits, customerId, customerName } = p;
        if (!["offpeak", "peak"].includes(tier)) { res.status(400).json({ error: "invalid tier" }); return; }
        const def = PACKAGE_PRICES[tier]?.[credits];
        if (!def) { res.status(400).json({ error: "invalid credits" }); return; }
        if (!/^[0-9]{10}$/.test(customerId || "")) { res.status(400).json({ error: "invalid phone" }); return; }
        if (!customerName || String(customerName).trim().length < 1 || String(customerName).length > 16) {
          res.status(400).json({ error: "invalid name" }); return;
        }

        await sb(`customers`, {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates" },
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
        const { ok, body } = await sb(`packages?id=eq.${packageId}&status=in.(pending,reviewing)`, {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({ slip_url: slipUrl, status: "reviewing" }),
        });
        const row = (body || [])[0] || null;
        if (!ok || !row) { res.status(409).json({ error: "update_failed", detail: body }); return; }
        res.status(200).json({ package: row });
        return;
      }

      case "cancelPendingPackage": {
        const { packageId } = p;
        if (!packageId) { res.status(400).json({ error: "missing packageId" }); return; }
        const { ok, body } = await sb(`packages?id=eq.${packageId}&status=in.(pending,reviewing)`, {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({ status: "cancelled" }),
        });
        const row = (body || [])[0] || null;
        if (ok && row) {
          const text =
            `❌ <b>ลูกค้ายกเลิกการซื้อแพ็คเกจเอง</b>\n\n` +
            `👤 ${row.customer_name || "-"}\n` +
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
        const { body } = await sb(`packages?customer_id=eq.${phone}&select=*&order=created_time.desc`);
        res.status(200).json({ packages: body || [] });
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
        // ผูกชื่อ+เบอร์กับบัญชี LINE นี้ไว้ ครั้งต่อไปจะกรอกให้อัตโนมัติ
        const userId = verifyLineSession(p.session);
        if (!userId) { res.status(401).json({ error: "invalid_session" }); return; }
        const { name, phone } = p;
        if (!/^[0-9]{10}$/.test(phone || "")) { res.status(400).json({ error: "invalid phone" }); return; }
        if (!name || String(name).trim().length < 1 || String(name).length > 16) { res.status(400).json({ error: "invalid name" }); return; }
        await sb(`line_users?line_user_id=eq.${encodeURIComponent(userId)}`, {
          method: "PATCH",
          body: JSON.stringify({ customer_name: String(name).trim(), phone }),
        });
        res.status(200).json({ ok: true });
        return;
      }

      case "checkFirstTime": {
        const { phone } = p;
        if (!/^[0-9]{10}$/.test(phone || "")) { res.status(200).json({ eligible: false }); return; }
        const eligible = await isFirstTimeCustomer(phone);
        res.status(200).json({ eligible, price: FIRST_TIME_PRICE });
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

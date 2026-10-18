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
const minutesToLabel = (mins) => `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;

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

async function getActiveIntervals(bookingDate, courtId) {
  const { body } = await sb(
    `bookings?booking_date=eq.${bookingDate}&court_id=eq.${courtId}&status=neq.cancelled&select=hour,start_minute,duration_minutes,status,created_time`
  );
  const now = Date.now();
  return (body || [])
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

        // การจองคู่ (2 สนามโอนทีเดียว) — เปลี่ยนสถานะทั้งกลุ่มพร้อมกัน กันแอดมินยืนยันไปแค่สนามเดียว
        if (before?.group_id) {
          await sb(`bookings?group_id=eq.${encodeURIComponent(before.group_id)}`, { method: "PATCH", body: JSON.stringify({ status }) });
        } else {
          await sb(`bookings?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ status }) });
        }

        if (before?.package_id) {
          const wasConfirmed = before.status === "confirmed";
          // ยืนยันครั้งแรก (ยังไม่เคยเป็น confirmed มาก่อน) → หักสิทธิ์จริงตอนนี้
          if (status === "confirmed" && !wasConfirmed) {
            const { body: pkgRows } = await sb(`packages?id=eq.${before.package_id}&select=*`);
            const pkg = (pkgRows || [])[0];
            if (pkg && pkg.remaining_credits > 0) {
              await sb(`packages?id=eq.${before.package_id}&remaining_credits=eq.${pkg.remaining_credits}`, {
                method: "PATCH",
                body: JSON.stringify({ remaining_credits: pkg.remaining_credits - 1 }),
              });
            }
          }
          // ยกเลิกรายการที่ "เคยยืนยันแล้ว" (เคยหักสิทธิ์ไปจริง) + แอดมินเลือกคืนสิทธิ์ → บวกกลับ
          // (ถ้ายกเลิกจากสถานะ "รอการยืนยัน" ที่ยังไม่เคยหักสิทธิ์เลย จะไม่คืนให้ ไม่ว่า refundCredit จะเป็นอะไร กันการคืนสิทธิ์ที่ไม่เคยถูกหัก)
          if (status === "cancelled" && wasConfirmed && refundCredit) {
            const { body: pkgRows } = await sb(`packages?id=eq.${before.package_id}&select=*`);
            const pkg = (pkgRows || [])[0];
            if (pkg && pkg.remaining_credits < pkg.total_credits) {
              await sb(`packages?id=eq.${before.package_id}`, {
                method: "PATCH",
                body: JSON.stringify({ remaining_credits: pkg.remaining_credits + 1 }),
              });
            }
          }
        }
        res.status(200).json({ ok: true });
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
        res.status(200).json({
          name: (cust || [])[0]?.customer_name || null,
          linked: (line || []).length > 0,
          lineName: (line || [])[0]?.display_name || null,
          bookingsCount: (hist || []).length,
        });
        return;
      }
      case "createAdminBooking": {
        // แอดมินจองแทนลูกค้า (โทรมาจอง/ไม่มี LINE) — ไม่ต้องล็อกอิน LINE, ไม่มีโปรอัตโนมัติ, แอดมินกำหนดราคาต่อสนามเอง
        // ถ้าภายหลังลูกค้าล็อกอิน LINE แล้วผูกเบอร์นี้ ชื่อ LINE จะแทนชื่อที่แอดมินใส่ในข้อมูลลูกค้า (ดู lineLinkPhone)
        const { customerId, customerName, courtIds, bookingDate, hour, startMinute, durationMinutes, price, status } = p;
        if (!/^[0-9]{10}$/.test(customerId || "")) { res.status(400).json({ error: "invalid phone" }); return; }
        const name = String(customerName || "").trim();
        if (name.length < 1 || name.length > 40) { res.status(400).json({ error: "invalid name" }); return; }
        const ids = Array.isArray(courtIds) ? [...new Set(courtIds.map(Number))].sort() : [];
        if (ids.length < 1 || ids.length > 2 || ids.some(c => c !== 1 && c !== 2)) { res.status(400).json({ error: "invalid courts" }); return; }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(bookingDate || "")) { res.status(400).json({ error: "invalid date" }); return; }
        if (!Number.isInteger(hour) || hour < 0 || hour > 23 || ![0, 30].includes(startMinute || 0)) { res.status(400).json({ error: "invalid time" }); return; }
        if (![30, 60, 90, 120].includes(durationMinutes)) { res.status(400).json({ error: "invalid duration" }); return; }
        const unit = Number(price);
        if (!Number.isFinite(unit) || unit < 0 || unit > 20000) { res.status(400).json({ error: "invalid price" }); return; }
        if (!["confirmed", "reviewing"].includes(status)) { res.status(400).json({ error: "invalid status" }); return; }

        const startMin = hour * 60 + (startMinute || 0);
        const endMin = startMin + durationMinutes;
        for (const cid of ids) {
          const taken = await getActiveIntervals(bookingDate, cid);
          if (taken.some(([s, e]) => startMin < e && endMin > s)) { res.status(409).json({ error: "slot_taken", court: cid }); return; }
        }

        // ลูกค้าใหม่ → สร้างข้อมูลลูกค้าด้วยชื่อที่แอดมินใส่ / ลูกค้าเดิม → ไม่ทับชื่อเดิม
        await sb(`customers`, { method: "POST", headers: { Prefer: "resolution=ignore-duplicates" }, body: JSON.stringify({ customer_id: customerId, customer_name: name }) });

        const groupId = ids.length > 1 ? crypto.randomUUID() : null;
        const baseRow = (cid) => ({
          court_id: cid, customer_id: customerId, customer_name: name,
          booking_date: bookingDate, hour, start_minute: startMinute || 0, duration_minutes: durationMinutes,
          price: Math.round(unit), discount_amount: 0, status, ...(groupId ? { group_id: groupId } : {}),
        });
        let ins = await sb(`bookings`, { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(ids.map(c => ({ ...baseRow(c), booked_by: "admin" }))) });
        if (!ins.ok) {
          // คอลัมน์ booked_by ยังไม่ถูกสร้าง (ยังไม่ได้รัน SQL) — บันทึกการจองให้ก่อน ไม่ให้งานหลักพัง
          console.error("createAdminBooking: insert with booked_by failed — run add-booked-by-column.sql");
          ins = await sb(`bookings`, { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(ids.map(baseRow)) });
        }
        if (!ins.ok || !Array.isArray(ins.body) || ins.body.length !== ids.length) { res.status(500).json({ error: "insert_failed" }); return; }

        await notifyTelegram(
          `📞 <b>แอดมินจองให้ลูกค้า</b>\n\n` +
          `👤 ${name}\n📞 ${customerId}\n` +
          `🎾 ${ids.map(c => `Court ${c}`).join(" + ")}\n📅 ${bookingDate}\n` +
          `🕐 ${minutesToLabel(startMin)}–${minutesToLabel(endMin)}\n` +
          `💰 ฿${(Math.round(unit) * ids.length).toLocaleString()} (${status === "confirmed" ? "ชำระแล้ว" : "รอชำระ"})`
        );
        res.status(200).json({ ok: true, bookings: ins.body });
        return;
      }
      case "updateBookingName": {
        // แก้ชื่อที่พิมพ์ผิดในการจองที่มีอยู่ (การจองคู่แก้ทั้งคู่) — ไม่แตะเบอร์/ราคา/สถานะ
        const { id, name } = p;
        const clean = String(name || "").trim();
        if (!id || clean.length < 1 || clean.length > 40) { res.status(400).json({ error: "invalid" }); return; }
        const { body } = await sb(`bookings?id=eq.${id}&select=group_id`);
        const gid = (body || [])[0]?.group_id;
        await sb(gid ? `bookings?group_id=eq.${encodeURIComponent(gid)}` : `bookings?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ customer_name: clean }) });
        res.status(200).json({ ok: true });
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
        const now = new Date();
        const { body: pkgRows } = await sb(`packages?id=eq.${id}&select=*`);
        const pkg = (pkgRows || [])[0];
        if (!pkg) { res.status(404).json({ error: "not_found" }); return; }
        const expiry = new Date(now.getTime() + pkg.expiry_days * 24 * 60 * 60 * 1000);
        const expiryDateStr = expiry.toISOString().split("T")[0];
        await sb(`packages?id=eq.${id}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "active", activated_at: now.toISOString(), expiry_date: expiryDateStr }),
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
        const { code, amount, maxUses } = p;
        await sb(`discount_codes`, {
          method: "POST",
          body: JSON.stringify({ code: String(code).toUpperCase(), discount_amount: parseInt(amount), discount_percent: 0, max_uses: parseInt(maxUses), active: true }),
        });
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

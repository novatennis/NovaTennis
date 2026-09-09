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
    if (password === ADMIN_PASSWORD) {
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
        res.status(200).json({ customers: body || [] });
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
        const { id, status } = p;
        await sb(`bookings?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ status }) });
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
        const todayIso = new Date().toISOString().split("T")[0];
        const { body } = await sb(`bookings?status=eq.blocked&booking_date=gte.${todayIso}&select=*&order=booking_date.asc,hour.asc`);
        res.status(200).json({ blocks: body || [] });
        return;
      }
      case "blockCourt": {
        const { date, courtId, hour, startMinute, durationMinutes, reason } = p;
        if (!date || !courtId || hour == null || !durationMinutes) {
          res.status(400).json({ error: "missing params" }); return;
        }
        const { body } = await sb(`bookings`, {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({
            court_id: courtId, customer_id: "admin_block",
            customer_name: reason ? `🚫 ปิดสนาม (${reason})` : "🚫 ปิดสนาม",
            booking_date: date, hour, start_minute: startMinute || 0, duration_minutes: durationMinutes,
            price: 0, status: "blocked",
          }),
        });
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

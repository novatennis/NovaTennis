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
  if (!ins.ok || !Array.isArray(ins.body) || ins.body.length !== rows.length) return { error: "insert_failed" };
  return { rows: ins.body };
}

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

        if (status === "cancelled" && before?.discount_code && before.status !== "confirmed") {
          await releaseDiscountByCode(before.discount_code); // รายการที่ยังไม่เคยยืนยัน = ยังไม่ได้ใช้ส่วนลดจริง → คืนสิทธิ์ (ถ้ายืนยันไปแล้วไม่คืนอัตโนมัติ ใช้ปุ่ม "รีเซ็ต" ที่หน้า ส่วนลด)
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
        // แพ็คเกจของเบอร์นี้: ที่ใช้ได้ไปอยู่ใน packages / ที่ใช้ไม่ได้อธิบายเหตุผลไว้ใน packageIssues (ไม่ปล่อยให้หน้าเว็บเงียบโดยไม่รู้สาเหตุ)
        // ครอบด้วย try/catch: ถ้าดึงแพ็คเกจไม่สำเร็จ ยังส่งชื่อ/สถานะลูกค้ากลับไปได้ตามปกติ และบอกด้วย packagesError
        const packages = [];
        const packageIssues = [];
        let packagesError = false;
        try {
          const pq = await sb(`packages?customer_id=eq.${phone}&status=neq.cancelled&select=id,tier,status,total_credits,remaining_credits,expiry_date&order=created_time.asc`);
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
            packages.push({ id: x.id, tier: x.tier, total_credits: x.total_credits, remaining_credits: x.remaining_credits, expiry_date: x.expiry_date, reserved_credits: reserved, available: x.remaining_credits - reserved });
          }
        } catch (e) {
          console.error("lookupCustomer packages error:", e);
          packagesError = true;
        }
        res.status(200).json({
          name: Array.isArray(cust) ? (cust[0]?.customer_name || null) : null,
          linked: Array.isArray(line) && line.length > 0,
          lineName: Array.isArray(line) ? (line[0]?.display_name || null) : null,
          bookingsCount: Array.isArray(hist) ? hist.length : 0,
          packages,
          packageIssues,
          packagesError,
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
        const { customerId, customerName, courtIds, bookingDate, hour, startMinute, durationMinutes, packageId } = p;
        let { price, status } = p;
        if (!/^[0-9]{10}$/.test(customerId || "")) { res.status(400).json({ error: "invalid phone" }); return; }
        const name = String(customerName || "").trim();
        if (name.length < 1 || nameLen(name) > 40) { res.status(400).json({ error: "invalid name" }); return; }
        const ids = Array.isArray(courtIds) ? [...new Set(courtIds.map(Number))].sort() : [];
        if (ids.length < 1 || ids.length > 2 || ids.some(c => c !== 1 && c !== 2)) { res.status(400).json({ error: "invalid courts" }); return; }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(bookingDate || "")) { res.status(400).json({ error: "invalid date" }); return; }
        if (!Number.isInteger(hour) || hour < 0 || hour > 23 || ![0, 30].includes(startMinute || 0)) { res.status(400).json({ error: "invalid time" }); return; }
        if (![30, 60, 90, 120].includes(durationMinutes)) { res.status(400).json({ error: "invalid duration" }); return; }

        // ── ตัดสิทธิ์แพ็คเกจ (ถ้าเลือก): ราคา 0 / ยืนยันทันที / หักสิทธิ์ทันที (แอดมินเป็นคนยืนยันเอง) ──
        let pkg = null, units = 0;
        if (packageId) {
          if (ids.length !== 1) { res.status(400).json({ error: "package_one_court" }); return; }
          if (![60, 120].includes(durationMinutes)) { res.status(400).json({ error: "package_duration" }); return; }
          units = durationMinutes / 60; // 60 นาที = 1 ครั้ง, 120 นาที = 2 ครั้ง
          const { body: pkgRows } = await sb(`packages?id=eq.${encodeURIComponent(packageId)}&customer_id=eq.${customerId}&select=*`);
          pkg = (pkgRows || [])[0];
          if (!pkg || pkg.status !== "active") { res.status(400).json({ error: "package_not_active" }); return; }
          if (pkg.expiry_date && String(pkg.expiry_date).slice(0, 10) < todayBangkok()) { res.status(400).json({ error: "package_expired" }); return; }
          const reserved = await getReservedCredits(pkg.id);
          if (pkg.remaining_credits - reserved < units) { res.status(400).json({ error: "package_no_credits", available: Math.max(0, pkg.remaining_credits - reserved), needed: units }); return; }
          // ทุกชั่วโมงที่จองต้องอยู่ในช่วงที่แพ็คครอบคลุม: แพ็ค Peak ได้ทุกชั่วโมง / แพ็ค Off Peak เฉพาะ จ.–ศ. ก่อน 16:00
          const dow = new Date(bookingDate + "T00:00:00").getDay();
          const weekend = dow === 0 || dow === 6;
          const covered = Array.from({ length: units }, (_, i) => hour + i).every((h) => pkg.tier === "peak" || !(weekend || h >= 16));
          if (!covered) { res.status(400).json({ error: "package_wrong_tier" }); return; }
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

        let remainingAfter = null;
        if (pkg) {
          let claimed = false;
          for (let attempt = 0; attempt < 3 && !claimed; attempt++) {
            const { body: cur } = await sb(`packages?id=eq.${pkg.id}&select=remaining_credits`);
            const rem = (cur || [])[0]?.remaining_credits ?? 0;
            const reserved = await getReservedCredits(pkg.id);
            if (rem - reserved < units) { res.status(400).json({ error: "package_no_credits", available: Math.max(0, rem - reserved), needed: units }); return; }
            const upd = await sb(`packages?id=eq.${pkg.id}&remaining_credits=eq.${rem}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ remaining_credits: rem - units }) });
            if (upd.ok && upd.body && upd.body.length > 0) { claimed = true; remainingAfter = rem - units; }
          }
          if (!claimed) { res.status(409).json({ error: "package_busy" }); return; }
        }
        const restoreCredits = async () => {
          if (!pkg) return;
          const { body: cur } = await sb(`packages?id=eq.${pkg.id}&select=remaining_credits,total_credits`);
          const c = (cur || [])[0];
          if (c) await sb(`packages?id=eq.${pkg.id}`, { method: "PATCH", body: JSON.stringify({ remaining_credits: Math.min(c.total_credits, c.remaining_credits + units) }) });
        };

        // ลูกค้าใหม่ → สร้างข้อมูลลูกค้าด้วยชื่อที่แอดมินใส่ / ลูกค้าเดิม → ไม่ทับชื่อเดิม
        await sb(`customers`, { method: "POST", headers: { Prefer: "resolution=ignore-duplicates" }, body: JSON.stringify({ customer_id: customerId, customer_name: name }) });

        const groupId = ids.length > 1 ? crypto.randomUUID() : null;
        const baseRow = (cid) => ({
          court_id: cid, customer_id: customerId, customer_name: name,
          booking_date: bookingDate, hour, start_minute: startMinute || 0, duration_minutes: durationMinutes,
          price: Math.round(unit), discount_amount: 0, status, ...(groupId ? { group_id: groupId } : {}), ...(pkg ? { package_id: pkg.id } : {}),
        });
        let ins = await insertBookingsAtomic(ids.map(c => ({ ...baseRow(c), booked_by: "admin" })));
        if (ins.error && ins.error !== "slot_taken") {
          // คอลัมน์ booked_by ยังไม่ถูกสร้าง (ยังไม่ได้รัน SQL) — บันทึกการจองให้ก่อน ไม่ให้งานหลักพัง
          console.error("createAdminBooking: insert with booked_by failed — run add-booked-by-column.sql");
          ins = await insertBookingsAtomic(ids.map(baseRow));
        }
        if (ins.error === "slot_taken") { await restoreCredits(); res.status(409).json({ error: "slot_taken", court: ins.court || ids[0] }); return; } // มีคนจองตัดหน้าพอดี
        if (!ins.rows) { await restoreCredits(); res.status(500).json({ error: "insert_failed" }); return; }
        ins = { ok: true, body: ins.rows };

        await notifyTelegram(
          `📞 <b>แอดมินจองให้ลูกค้า</b>\n\n` +
          `👤 ${esc(name)}\n📞 ${customerId}\n` +
          `🎾 ${ids.map(c => `Court ${c}`).join(" + ")}\n📅 ${bookingDate}\n` +
          `🕐 ${minutesToLabel(startMin)}–${minutesToLabel(endMin)}\n` +
          (pkg
            ? `🎟 ตัดสิทธิ์แพ็คเกจ ${units} ครั้ง (เหลือ ${remainingAfter} / ${pkg.total_credits} ครั้ง) — ยืนยันแล้ว`
            : `💰 ฿${(Math.round(unit) * ids.length).toLocaleString()} (${status === "confirmed" ? "ชำระแล้ว" : "รอชำระ"})`)
        );
        res.status(200).json({ ok: true, bookings: ins.body, ...(pkg ? { creditsUsed: units, remaining: remainingAfter } : {}) });
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

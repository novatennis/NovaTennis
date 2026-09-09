// /api/booking-actions.js
// All public (non-admin) reads/writes to the bookings/customers/discount_codes
// tables go through this single endpoint, using the Supabase Service Role Key
// server-side. The browser's anon key no longer has any direct table access
// at all — this closes the hole where anyone could previously query the
// entire bookings table (every customer's name/phone/price) in one request,
// and prevents a customer from tampering with price or setting their own
// booking status straight to "confirmed".

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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
        res.status(200).json({ booking: (body || [])[0] || null });
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
        const { courtId, customerId, customerName, bookingDate, hour, startMinute, durationMinutes, discountCodeId } = p;
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

        // เซิร์ฟเวอร์คำนวณราคาเองเสมอ ไม่เชื่อค่าใดๆ จากฝั่ง client
        const dateObj = new Date(bookingDate + "T00:00:00");
        const basePrice = getDurationPrice(hour, dateObj, durationMinutes);

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

        res.status(200).json({ booking: bookingRow });
        return;
      }

      case "updateSlip": {
        const { bookingId, slipUrl } = p;
        if (!bookingId || !slipUrl) { res.status(400).json({ error: "missing params" }); return; }
        // เงื่อนไข status=eq.pending กันไว้อีกชั้น: แก้ได้เฉพาะรายการที่ยังรอชำระอยู่เท่านั้น
        const { body } = await sb(`bookings?id=eq.${bookingId}&status=eq.pending`, {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({ slip_url: slipUrl, status: "reviewing" }),
        });
        res.status(200).json({ booking: (body || [])[0] || null });
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

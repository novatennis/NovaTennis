// /api/check-expired-bookings.js
// Meant to be called every 1-2 minutes by an external scheduler (e.g. cron-job.org),
// since Vercel's free Cron plan only allows once-per-day jobs. Finds bookings that
// are still "pending" (never got a slip attached) more than 5 minutes after they
// were created, and sends a Telegram alert to admin with the customer's name,
// phone, court, date/time and the time they attempted the booking — so admin can
// follow up directly. Each row is only ever notified once (expiry_notified flag).

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_TELEGRAM_CHAT_IDS = process.env.ADMIN_TELEGRAM_CHAT_IDS; // comma-separated

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
  return { ok: res.ok, body };
}

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

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${cronSecret}`) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  }
  if (!SUPABASE_URL || !SERVICE_KEY) {
    res.status(500).json({ error: "Server not configured" });
    return;
  }

  try {
    const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    // ยังไม่เคยแจ้งเตือน (expiry_notified ไม่เป็น true) และรอชำระเกิน 5 นาทีแล้ว
    const { body: rows } = await sb(
      `bookings?status=eq.pending&expiry_notified=is.false&created_time=lte.${cutoff}&select=*`
    );

    const expired = rows || [];
    for (const b of expired) {
      const startMin = (b.hour || 0) * 60 + (b.start_minute || 0);
      const dur = b.duration_minutes || 60;
      const createdLocal = new Date(new Date(b.created_time).getTime() + 7*60*60*1000);
      const timeStr = createdLocal.toISOString().substr(11, 5);
      const text =
        `⏰ <b>ลูกค้าไม่ชำระเงินภายใน 5 นาที</b>\n` +
        `ช่วงเวลาถูกปล่อยกลับให้จองใหม่แล้ว — ลองติดต่อลูกค้าดูได้ครับ\n\n` +
        `👤 ${b.customer_name || "-"}\n` +
        `📞 ${b.customer_id}\n` +
        `🎾 Court ${b.court_id}\n` +
        `📅 ${b.booking_date}\n` +
        `🕐 ${minutesToLabel(startMin)}–${minutesToLabel(startMin+dur)}\n` +
        `💰 ฿${b.price?.toLocaleString?.() || b.price}\n` +
        `🕓 กดจองเมื่อเวลา ${timeStr} น. (ไทย)`;
      await notifyTelegram(text);
      await sb(`bookings?id=eq.${b.id}`, {
        method: "PATCH",
        body: JSON.stringify({ expiry_notified: true }),
      });
    }

    res.status(200).json({ ok: true, notified: expired.length });
  } catch (err) {
    console.error("check-expired-bookings error:", err);
    res.status(500).json({ error: "internal error" });
  }
}

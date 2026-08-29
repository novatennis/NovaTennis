// /api/notify-admin-telegram.js
// Called from the frontend right after a customer successfully uploads a
// payment slip. Sends a Telegram message to every admin listed in
// ADMIN_TELEGRAM_CHAT_IDS (comma-separated chat IDs). No monthly message
// limit on Telegram, unlike LINE's free tier.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const adminIds = (process.env.ADMIN_TELEGRAM_CHAT_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  if (!botToken || adminIds.length === 0) {
    console.error("Missing TELEGRAM_BOT_TOKEN or ADMIN_TELEGRAM_CHAT_IDS");
    res.status(200).json({ ok: false, skipped: true }); // don't break the booking flow
    return;
  }

  try {
    const { courtName, date, time, price, name, phone } = req.body || {};

    const text =
      `🔔 มีลูกค้าส่งสลิปใหม่\n\n` +
      `🎾 สนาม: ${courtName || "-"}\n` +
      `📅 วันที่: ${date || "-"}\n` +
      `🕐 เวลา: ${time || "-"}\n` +
      `💰 ยอด: ฿${price ?? "-"}\n` +
      `👤 ชื่อ: ${name || "-"}\n` +
      `📞 เบอร์: ${phone || "-"}\n\n` +
      `สถานะ: รอการตรวจสอบ\nกรุณาเข้าไปตรวจสอบและยืนยันที่หน้า Admin Dashboard`;

    await Promise.all(
      adminIds.map((chatId) =>
        fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text }),
        })
      )
    );

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Failed to notify admin via Telegram:", err);
    res.status(200).json({ ok: false }); // never block the booking flow
  }
}

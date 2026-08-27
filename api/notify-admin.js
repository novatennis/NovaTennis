// /api/notify-admin.js
// Vercel serverless function. Called from the frontend right after a customer
// successfully uploads a payment slip. Pushes a LINE message to every admin
// listed in ADMIN_LINE_USER_IDS (comma-separated User IDs).

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const adminIds = (process.env.ADMIN_LINE_USER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  if (!channelAccessToken || adminIds.length === 0) {
    console.error("Missing LINE_CHANNEL_ACCESS_TOKEN or ADMIN_LINE_USER_IDS");
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

    // Multicast sends the same message to every admin ID in one call
    // (works fine even with just 1 recipient)
    await fetch("https://api.line.me/v2/bot/message/multicast", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${channelAccessToken}`,
      },
      body: JSON.stringify({
        to: adminIds,
        messages: [{ type: "text", text }],
      }),
    });

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Failed to notify admin:", err);
    res.status(200).json({ ok: false }); // never block the booking flow
  }
}

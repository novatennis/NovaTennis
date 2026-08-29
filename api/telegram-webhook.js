// /api/telegram-webhook.js
// Telegram will POST here whenever someone messages the NOVA Tennis bot.
// We use this ONLY to capture the admin's Chat ID (by replying it back in
// chat) so it can be saved as an environment variable. No customer data
// is stored here.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(200).send("OK");
    return;
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const message = req.body?.message;
  const chatId = message?.chat?.id;

  console.log("Telegram message received. chatId:", chatId);

  if (chatId && botToken) {
    try {
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: `Chat ID ของคุณคือ:\n${chatId}\n\nนำไปตั้งค่าเป็น ADMIN_TELEGRAM_CHAT_IDS ใน Vercel Environment Variables ได้เลยครับ`,
        }),
      });
    } catch (err) {
      console.error("Failed to reply:", err);
    }
  }

  res.status(200).json({ ok: true });
}

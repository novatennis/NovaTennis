// /api/line-webhook.js
// Vercel serverless function. LINE will POST here whenever someone messages
// the NOVA Tennis LINE OA. We use this ONLY to capture the admin's User ID
// (by replying it back in chat) so it can be saved as an environment variable.
// No customer data is stored here.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(200).send("OK"); // LINE also pings with GET/other methods on verify
    return;
  }

  const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const events = req.body?.events || [];

  for (const event of events) {
    const userId = event?.source?.userId;
    console.log("LINE event received. userId:", userId, "type:", event.type);

    // Reply back with the user's own ID so it's easy to copy from the chat itself
    if (event.type === "message" && event.replyToken && userId && channelAccessToken) {
      try {
        await fetch("https://api.line.me/v2/bot/message/reply", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${channelAccessToken}`,
          },
          body: JSON.stringify({
            replyToken: event.replyToken,
            messages: [
              {
                type: "text",
                text: `User ID ของคุณคือ:\n${userId}\n\nนำไปตั้งค่าเป็น ADMIN_LINE_USER_IDS ใน Vercel Environment Variables ได้เลยครับ`,
              },
            ],
          }),
        });
      } catch (err) {
        console.error("Failed to reply:", err);
      }
    }
  }

  res.status(200).json({ ok: true });
}

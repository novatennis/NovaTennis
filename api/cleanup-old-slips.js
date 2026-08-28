// /api/cleanup-old-slips.js
// Runs automatically via Vercel Cron (see vercel.json). Deletes slip IMAGES
// for bookings where the COURT BOOKING DATE (booking_date) is more than
// SLIP_RETENTION_DAYS in the past — not the payment/upload date. Booking
// records themselves (name, phone, price, etc.) are kept — only the image
// file and its slip_url reference are removed.

const SLIP_RETENTION_DAYS = 30;

export default async function handler(req, res) {
  // Optional protection: if CRON_SECRET is set, only allow calls that include it.
  // Vercel automatically sends this header for its own Cron Jobs.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${cronSecret}`) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  }

  const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    res.status(500).json({ error: "Server not configured" });
    return;
  }

  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - SLIP_RETENTION_DAYS);
    const cutoffStr = cutoff.toISOString().split("T")[0];

    // 1. Find old bookings that still have a slip image
    const listRes = await fetch(
      `${SUPABASE_URL}/rest/v1/bookings?booking_date=lt.${cutoffStr}&slip_url=not.is.null&select=id,slip_url`,
      {
        headers: {
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        },
      }
    );
    const bookings = await listRes.json();

    let deleted = 0;
    let failed = 0;

    for (const b of bookings) {
      try {
        // slip_url looks like: {SUPABASE_URL}/storage/v1/object/public/slips/<path>
        const marker = "/storage/v1/object/public/slips/";
        const idx = b.slip_url.indexOf(marker);
        if (idx === -1) continue;
        const path = b.slip_url.slice(idx + marker.length);

        // 2. Delete the file from storage
        const delRes = await fetch(
          `${SUPABASE_URL}/storage/v1/object/slips/${path}`,
          {
            method: "DELETE",
            headers: {
              apikey: SERVICE_ROLE_KEY,
              Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
            },
          }
        );

        if (delRes.ok) {
          // 3. Clear the slip_url reference on the booking (keep the booking itself)
          await fetch(`${SUPABASE_URL}/rest/v1/bookings?id=eq.${b.id}`, {
            method: "PATCH",
            headers: {
              apikey: SERVICE_ROLE_KEY,
              Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ slip_url: null }),
          });
          deleted++;
        } else {
          failed++;
        }
      } catch (err) {
        console.error("Failed to delete slip for booking", b.id, err);
        failed++;
      }
    }

    console.log(`Slip cleanup done. Deleted: ${deleted}, Failed: ${failed}, Checked: ${bookings.length}`);
    res.status(200).json({ ok: true, checked: bookings.length, deleted, failed });
  } catch (err) {
    console.error("Cleanup job failed:", err);
    res.status(500).json({ error: "Cleanup failed" });
  }
}

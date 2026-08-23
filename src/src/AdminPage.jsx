import { useState, useEffect } from "react";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const ADMIN_PASSWORD = import.meta.env.VITE_ADMIN_PASSWORD || "nova2024";

const db = {
  async getBookings(date) {
    const query = date
      ? `booking_date=eq.${date}&`
      : "";
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/bookings?${query}select=*&order=booking_date.desc,hour.asc`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    return res.json();
  },
  async updateStatus(id, status) {
    await fetch(`${SUPABASE_URL}/rest/v1/bookings?id=eq.${id}`, {
      method: "PATCH",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
  },
  async getDiscounts() {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/discount_codes?select=*&order=created_at.desc`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    return res.json();
  },
  async createDiscount(code, amount, maxUses) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/discount_codes`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify({ code: code.toUpperCase(), discount_amount: amount, discount_percent: 0, max_uses: maxUses, active: true }),
    });
    return res.json();
  },
  async toggleDiscount(id, active) {
    await fetch(`${SUPABASE_URL}/rest/v1/discount_codes?id=eq.${id}`, {
      method: "PATCH",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ active }),
    });
  },
  async getCustomers() {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/customers?select=*&order=customer_id.asc`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    return res.json();
  },
};

const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+Thai:wght@300;400;500;600;700&family=Bebas+Neue&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --cr: #F9E8D4; --cr2: #EDD5B8; --or: #F47E1F; --or2: #FAA05A;
    --br: #663924; --bl: #8DB6C7; --tx: #2e1a0e; --mu: #8a7060;
    --dv: rgba(102,57,36,0.14); --sh: 0 2px 16px rgba(102,57,36,0.09); --r: 12px;
    --green: #2d7a4f; --red: #c0392b; --orange: #e67e22;
  }
  html, body { background: #f5f5f5; font-family: 'Noto Sans Thai', sans-serif; color: var(--tx); }
  button, input, select { font-family: 'Noto Sans Thai', sans-serif; }
  .bb { font-family: 'Bebas Neue', sans-serif; letter-spacing: .05em; }
  .card { background: #fff; border-radius: var(--r); border: 1px solid var(--dv); box-shadow: var(--sh); overflow: hidden; }
  @keyframes fu { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
  .fu { animation: fu .3s ease both; }
  table { width: 100%; border-collapse: collapse; }
  th { background: var(--br); color: var(--or); padding: 10px 14px; text-align: left; font-size: 13px; font-weight: 600; }
  td { padding: 10px 14px; border-bottom: 1px solid var(--dv); font-size: 13px; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: rgba(244,126,31,.04); }
`;

const statusInfo = (s) => {
  if (s === "confirmed") return { text: "✅ ยืนยันแล้ว", color: "#2d7a4f", bg: "rgba(45,122,79,.1)" };
  if (s === "cancelled") return { text: "❌ ยกเลิก", color: "#c0392b", bg: "rgba(192,57,43,.1)" };
  if (s === "reviewing") return { text: "🔍 รอตรวจสลิป", color: "#e67e22", bg: "rgba(230,126,34,.1)" };
  return { text: "⏳ รอชำระ", color: "var(--mu)", bg: "rgba(0,0,0,.06)" };
};

const fmtDate = (d) => d ? new Date(d).toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric" }) : "-";

// ─── Login ────────────────────────────────────────────────────────────────────
function Login({ onLogin }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState(false);
  const handle = () => {
    if (pw === ADMIN_PASSWORD) { onLogin(); }
    else { setErr(true); setTimeout(() => setErr(false), 2000); }
  };
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "linear-gradient(135deg,var(--br),#3a1a0a)" }}>
      <div style={{ background: "#fff", borderRadius: 20, padding: "40px 32px", width: 320, boxShadow: "0 20px 60px rgba(0,0,0,.3)", textAlign: "center" }}>
        <p className="bb" style={{ fontSize: 36, color: "var(--or)", marginBottom: 4 }}>NOVA</p>
        <p style={{ fontSize: 13, color: "var(--mu)", marginBottom: 28 }}>Admin Dashboard</p>
        <input type="password" value={pw} onChange={e => setPw(e.target.value)} onKeyDown={e => e.key === "Enter" && handle()}
          placeholder="รหัสผ่าน" style={{ width: "100%", padding: "12px 14px", borderRadius: 10, border: `1.5px solid ${err ? "var(--red)" : "var(--dv)"}`, fontSize: 15, marginBottom: 12, outline: "none" }} />
        {err && <p style={{ color: "var(--red)", fontSize: 12, marginBottom: 8 }}>รหัสผ่านไม่ถูกต้อง</p>}
        <button onClick={handle} style={{ width: "100%", padding: "13px", borderRadius: 10, border: "none", background: "var(--br)", color: "var(--or)", fontWeight: 700, fontSize: 15, cursor: "pointer" }}>
          เข้าสู่ระบบ
        </button>
      </div>
    </div>
  );
}

// ─── Bookings Tab ─────────────────────────────────────────────────────────────
function BookingsTab() {
  const today = new Date().toISOString().split("T")[0];
  const [date, setDate] = useState(today);
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(null);

  const load = async () => {
    setLoading(true);
    const data = await db.getBookings(date);
    setBookings(data || []);
    setLoading(false);
  };

  useEffect(() => { load(); }, [date]);

  const handleStatus = async (id, status) => {
    setUpdating(id);
    await db.updateStatus(id, status);
    setBookings(prev => prev.map(b => b.id === id ? { ...b, status } : b));
    setUpdating(null);
  };

  const summary = {
    total: bookings.length,
    confirmed: bookings.filter(b => b.status === "confirmed").length,
    pending: bookings.filter(b => b.status === "pending" || b.status === "reviewing").length,
    cancelled: bookings.filter(b => b.status === "cancelled").length,
    revenue: bookings.filter(b => b.status === "confirmed").reduce((s, b) => s + (b.price || 0), 0),
  };

  return (
    <div className="fu">
      {/* Summary */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 20 }}>
        {[
          { label: "ทั้งหมด", val: summary.total, color: "var(--br)" },
          { label: "ยืนยันแล้ว", val: summary.confirmed, color: "var(--green)" },
          { label: "รอดำเนินการ", val: summary.pending, color: "var(--orange)" },
          { label: "รายได้", val: `฿${summary.revenue.toLocaleString()}`, color: "var(--or)" },
        ].map(({ label, val, color }) => (
          <div key={label} className="card" style={{ padding: "14px 12px", textAlign: "center" }}>
            <p style={{ fontSize: 11, color: "var(--mu)", marginBottom: 4 }}>{label}</p>
            <p style={{ fontSize: 20, fontWeight: 800, color }}>{val}</p>
          </div>
        ))}
      </div>

      {/* Date filter */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <input type="date" value={date} onChange={e => setDate(e.target.value)}
          style={{ padding: "9px 12px", borderRadius: 8, border: "1.5px solid var(--dv)", fontSize: 14, color: "var(--tx)", background: "#fff", outline: "none" }} />
        <button onClick={load} style={{ padding: "9px 16px", borderRadius: 8, border: "none", background: "var(--br)", color: "var(--or)", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
          🔄 รีเฟรช
        </button>
      </div>

      {/* Table */}
      <div className="card" style={{ overflowX: "auto" }}>
        {loading ? (
          <p style={{ padding: 24, textAlign: "center", color: "var(--mu)" }}>⏳ กำลังโหลด...</p>
        ) : bookings.length === 0 ? (
          <p style={{ padding: 24, textAlign: "center", color: "var(--mu)" }}>ไม่มีการจองในวันนี้</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>สนาม</th>
                <th>เวลา</th>
                <th>ลูกค้า</th>
                <th>เบอร์</th>
                <th>ราคา</th>
                <th>สลิป</th>
                <th>สถานะ</th>
                <th>จัดการ</th>
              </tr>
            </thead>
            <tbody>
              {bookings.map(b => {
                const st = statusInfo(b.status);
                return (
                  <tr key={b.id}>
                    <td style={{ fontWeight: 700 }}>Court {b.court_id}</td>
                    <td>{String(b.hour).padStart(2,"0")}:00</td>
                    <td>{b.customer_id}</td>
                    <td>{b.customer_id}</td>
                    <td style={{ fontWeight: 700, color: "var(--or)" }}>฿{b.price?.toLocaleString()}</td>
                    <td>
                      {b.slip_url
                        ? <a href={b.slip_url} target="_blank" rel="noreferrer" style={{ color: "var(--bl)", fontWeight: 600, fontSize: 12 }}>ดูสลิป 🔗</a>
                        : <span style={{ color: "var(--mu)", fontSize: 12 }}>ยังไม่มี</span>}
                    </td>
                    <td>
                      <span style={{ fontSize: 12, fontWeight: 600, color: st.color, background: st.bg, padding: "3px 8px", borderRadius: 20, whiteSpace: "nowrap" }}>
                        {st.text}
                      </span>
                    </td>
                    <td>
                      {b.status !== "cancelled" && (
                        <div style={{ display: "flex", gap: 6 }}>
                          {b.status !== "confirmed" && (
                            <button onClick={() => handleStatus(b.id, "confirmed")} disabled={updating === b.id}
                              style={{ padding: "5px 10px", borderRadius: 6, border: "none", background: "rgba(45,122,79,.15)", color: "var(--green)", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>
                              ✅
                            </button>
                          )}
                          <button onClick={() => handleStatus(b.id, "cancelled")} disabled={updating === b.id}
                            style={{ padding: "5px 10px", borderRadius: 6, border: "none", background: "rgba(192,57,43,.1)", color: "var(--red)", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>
                            ❌
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ─── Discounts Tab ────────────────────────────────────────────────────────────
function DiscountsTab() {
  const [codes, setCodes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newCode, setNewCode] = useState("");
  const [newAmount, setNewAmount] = useState("50");
  const [newMax, setNewMax] = useState("1");
  const [creating, setCreating] = useState(false);

  const load = async () => {
    setLoading(true);
    const data = await db.getDiscounts();
    setCodes(data || []);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async () => {
    if (!newCode.trim()) return;
    setCreating(true);
    await db.createDiscount(newCode.trim(), parseInt(newAmount), parseInt(newMax));
    setNewCode(""); setNewAmount("50"); setNewMax("1");
    await load();
    setCreating(false);
  };

  const genCode = () => {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
    setNewCode(code);
  };

  return (
    <div className="fu">
      {/* Create new */}
      <div className="card" style={{ padding: 20, marginBottom: 20 }}>
        <p style={{ fontWeight: 700, color: "var(--br)", marginBottom: 14, fontSize: 15 }}>➕ สร้างรหัสส่วนลดใหม่</p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, marginBottom: 10 }}>
          <input value={newCode} onChange={e => setNewCode(e.target.value.toUpperCase())} placeholder="รหัส เช่น NOVA50"
            style={{ padding: "10px 12px", borderRadius: 8, border: "1.5px solid var(--dv)", fontSize: 14, outline: "none" }} />
          <button onClick={genCode} style={{ padding: "0 14px", borderRadius: 8, border: "1.5px solid var(--dv)", background: "#fff", color: "var(--mu)", fontSize: 13, cursor: "pointer" }}>
            🎲 สุ่ม
          </button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}>
          <div>
            <label style={{ fontSize: 12, color: "var(--mu)", display: "block", marginBottom: 5 }}>ส่วนลด (บาท)</label>
            <input type="number" value={newAmount} onChange={e => setNewAmount(e.target.value)} min="1"
              style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "1.5px solid var(--dv)", fontSize: 14, outline: "none" }} />
          </div>
          <div>
            <label style={{ fontSize: 12, color: "var(--mu)", display: "block", marginBottom: 5 }}>ใช้ได้กี่ครั้ง</label>
            <input type="number" value={newMax} onChange={e => setNewMax(e.target.value)} min="1"
              style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "1.5px solid var(--dv)", fontSize: 14, outline: "none" }} />
          </div>
        </div>
        <button onClick={handleCreate} disabled={creating || !newCode.trim()} style={{ width: "100%", padding: "12px", borderRadius: 8, border: "none", background: "var(--br)", color: "var(--or)", fontWeight: 700, fontSize: 14, cursor: "pointer" }}>
          {creating ? "⏳ กำลังสร้าง..." : "สร้างรหัส"}
        </button>
      </div>

      {/* List */}
      <div className="card" style={{ overflowX: "auto" }}>
        {loading ? (
          <p style={{ padding: 24, textAlign: "center", color: "var(--mu)" }}>⏳ กำลังโหลด...</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>รหัส</th>
                <th>ส่วนลด</th>
                <th>ใช้แล้ว/ทั้งหมด</th>
                <th>สถานะ</th>
                <th>จัดการ</th>
              </tr>
            </thead>
            <tbody>
              {codes.map(c => (
                <tr key={c.id}>
                  <td style={{ fontWeight: 700, fontFamily: "monospace", fontSize: 14 }}>{c.code}</td>
                  <td style={{ fontWeight: 700, color: "var(--or)" }}>฿{c.discount_amount || `${c.discount_percent}%`}</td>
                  <td>{c.used_count}/{c.max_uses}</td>
                  <td>
                    <span style={{ fontSize: 12, fontWeight: 600, color: c.active ? "var(--green)" : "var(--red)", background: c.active ? "rgba(45,122,79,.1)" : "rgba(192,57,43,.1)", padding: "3px 8px", borderRadius: 20 }}>
                      {c.active ? "ใช้งานได้" : "ปิดใช้งาน"}
                    </span>
                  </td>
                  <td>
                    <button onClick={async () => { await db.toggleDiscount(c.id, !c.active); load(); }}
                      style={{ padding: "5px 10px", borderRadius: 6, border: "none", background: c.active ? "rgba(192,57,43,.1)" : "rgba(45,122,79,.1)", color: c.active ? "var(--red)" : "var(--green)", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>
                      {c.active ? "ปิด" : "เปิด"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ─── Customers Tab ────────────────────────────────────────────────────────────
function CustomersTab() {
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(async () => {
    const data = await db.getCustomers();
    setCustomers(data || []);
    setLoading(false);
  }, []);

  return (
    <div className="fu">
      <div className="card" style={{ overflowX: "auto" }}>
        {loading ? (
          <p style={{ padding: 24, textAlign: "center", color: "var(--mu)" }}>⏳ กำลังโหลด...</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>ชื่อ</th>
                <th>เบอร์โทร</th>
              </tr>
            </thead>
            <tbody>
              {customers.map((c, i) => (
                <tr key={c.customer_id}>
                  <td style={{ color: "var(--mu)" }}>{i + 1}</td>
                  <td style={{ fontWeight: 600 }}>{c.customer_name}</td>
                  <td style={{ fontFamily: "monospace" }}>{c.customer_id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function AdminApp() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [tab, setTab] = useState("bookings");

  if (!loggedIn) return <Login onLogin={() => setLoggedIn(true)} />;

  const tabs = [
    { id: "bookings", label: "📋 การจอง" },
    { id: "discounts", label: "🏷 ส่วนลด" },
    { id: "customers", label: "👥 ลูกค้า" },
  ];

  return (
    <>
      <style>{CSS}</style>
      <div style={{ minHeight: "100vh", background: "#f5f5f5" }}>
        {/* Header */}
        <header style={{ background: "var(--br)", padding: "14px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", boxShadow: "0 2px 12px rgba(0,0,0,.2)" }}>
          <div>
            <p className="bb" style={{ fontSize: 24, color: "var(--or)", lineHeight: 1 }}>NOVA TENNIS</p>
            <p style={{ fontSize: 11, color: "rgba(255,255,255,.6)", marginTop: 2 }}>Admin Dashboard</p>
          </div>
          <button onClick={() => setLoggedIn(false)} style={{ background: "rgba(255,255,255,.1)", border: "none", color: "rgba(255,255,255,.7)", padding: "7px 14px", borderRadius: 8, fontSize: 13, cursor: "pointer" }}>
            ออกจากระบบ
          </button>
        </header>

        {/* Tabs */}
        <div style={{ background: "#fff", borderBottom: "1px solid var(--dv)", padding: "0 24px", display: "flex", gap: 0 }}>
          {tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              padding: "14px 20px", background: "none", border: "none",
              borderBottom: tab === t.id ? "2.5px solid var(--or)" : "2.5px solid transparent",
              color: tab === t.id ? "var(--or)" : "var(--mu)",
              fontWeight: tab === t.id ? 700 : 400, fontSize: 14, cursor: "pointer",
              fontFamily: "'Noto Sans Thai', sans-serif",
            }}>{t.label}</button>
          ))}
        </div>

        {/* Content */}
        <div style={{ padding: "24px", maxWidth: 1100, margin: "0 auto" }}>
          {tab === "bookings" && <BookingsTab />}
          {tab === "discounts" && <DiscountsTab />}
          {tab === "customers" && <CustomersTab />}
        </div>
      </div>
    </>
  );
}

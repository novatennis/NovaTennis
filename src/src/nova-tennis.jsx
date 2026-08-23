import { useState, useEffect } from "react";

// ─── Supabase ─────────────────────────────────────────────────────────────────
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

const supabase = {
  async getBookings(date, courtId) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/bookings?booking_date=eq.${date}&court_id=eq.${courtId}&select=hour`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    return res.json();
  },
  async addBooking(data) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/bookings`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(data),
    });
    return res.ok;
  },
  async upsertCustomer(customerId, customerName) {
    await fetch(`${SUPABASE_URL}/rest/v1/customers`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify({ customer_id: customerId, customer_name: customerName }),
    });
  },
};

// ─── Constants ────────────────────────────────────────────────────────────────
const COURTS = [
  { courtId: 1, courtName: "Court 1", desc: "สนามในร่ม • ปรับอากาศ" },
  { courtId: 2, courtName: "Court 2", desc: "สนามในร่ม • ปรับอากาศ" },
];

const TIME_SLOTS = Array.from({ length: 17 }, (_, i) => {
  const h = 6 + i;
  return {
    hour: h,
    label: `${String(h).padStart(2,"0")}:00 – ${String(h).padStart(2,"0")}:59`,
    price: h < 13 ? 490 : 590,
    peak: h >= 13,
  };
});

const toIso = (d) => d ? d.toISOString().split("T")[0] : "";
const fmtDate = (d) => d
  ? d.toLocaleDateString("th-TH", { weekday: "short", year: "numeric", month: "short", day: "numeric" })
  : "";

// ─── CSS ──────────────────────────────────────────────────────────────────────
const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Noto+Sans+Thai:wght@300;400;500;600;700&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --cr: #F9E8D4;
    --cr2: #EDD5B8;
    --or: #F47E1F;
    --or2: #FAA05A;
    --or-bg: rgba(244,126,31,0.10);
    --br: #663924;
    --bl: #8DB6C7;
    --bl-bg: rgba(141,182,199,0.13);
    --tx: #2e1a0e;
    --mu: #8a7060;
    --dv: rgba(102,57,36,0.14);
    --sh: 0 2px 16px rgba(102,57,36,0.09);
    --r: 14px;
  }
  html, body { background: var(--cr); font-family: 'Noto Sans Thai', sans-serif; color: var(--tx); }
  button, input { font-family: 'Noto Sans Thai', sans-serif; }
  .bb { font-family: 'Bebas Neue', sans-serif; letter-spacing: .05em; }
  .btn-primary {
    width: 100%; padding: 15px; border-radius: var(--r); border: none;
    background: linear-gradient(90deg, var(--or), var(--or2));
    color: #fff; font-weight: 700; font-size: 16px; cursor: pointer;
    box-shadow: 0 4px 18px rgba(244,126,31,.30);
    font-family: 'Noto Sans Thai', sans-serif;
  }
  .btn-primary:disabled { background: var(--cr2); color: var(--mu); box-shadow: none; cursor: not-allowed; }
  .card { background: #fff; border-radius: var(--r); border: 1px solid var(--dv); box-shadow: var(--sh); overflow: hidden; }
  .card-header { background: var(--br); padding: 11px 18px; }
  .card-header p { color: var(--or); font-size: 13px; font-weight: 600; }
  .card-body { padding: 16px 18px; }
  @keyframes fu { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }
  .fu { animation: fu .3s ease both; }
`;

// ─── Logo ─────────────────────────────────────────────────────────────────────
function NovaLogo({ width = 160 }) {
  return (
    <svg width={width} viewBox="0 0 320 100" fill="none" xmlns="http://www.w3.org/2000/svg">
      <line x1="170" y1="22" x2="210" y2="13" stroke="#F47E1F" strokeWidth="3" strokeLinecap="round"/>
      <line x1="174" y1="30" x2="218" y2="24" stroke="#F47E1F" strokeWidth="2.2" strokeLinecap="round"/>
      <line x1="179" y1="38" x2="224" y2="37" stroke="#F47E1F" strokeWidth="1.8" strokeLinecap="round"/>
      <circle cx="234" cy="30" r="16" stroke="#F47E1F" strokeWidth="2.5" fill="none"/>
      <path d="M220 25 Q234 35 248 25" stroke="#F47E1F" strokeWidth="1.8" fill="none"/>
      <path d="M220 35 Q234 45 248 35" stroke="#F47E1F" strokeWidth="1.8" fill="none"/>
      <text x="10" y="68" fontFamily="'Bebas Neue',sans-serif" fontSize="64" fill="#F47E1F" letterSpacing="3">NOVA</text>
      <text x="78" y="86" fontFamily="'Noto Sans Thai',sans-serif" fontSize="12" fill="#8DB6C7" letterSpacing="5" textAnchor="middle">• TENNIS •</text>
    </svg>
  );
}

function CourtLines() {
  return (
    <svg viewBox="0 0 400 150" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ width:"100%", display:"block", opacity:.15 }}>
      <rect x="30" y="8" width="340" height="134" stroke="#F47E1F" strokeWidth="2.5"/>
      <rect x="80" y="8" width="240" height="134" stroke="#F47E1F" strokeWidth="2"/>
      <line x1="200" y1="8" x2="200" y2="142" stroke="#F47E1F" strokeWidth="2"/>
      <line x1="80" y1="75" x2="320" y2="75" stroke="#F47E1F" strokeWidth="2"/>
    </svg>
  );
}

function TabBar({ tab, setTab }) {
  return (
    <nav style={{
      position:"fixed", bottom:0, left:0, right:0, zIndex:200,
      backgroundColor:"#fff", borderTop:"1px solid var(--dv)",
      display:"flex", boxShadow:"0 -3px 16px rgba(102,57,36,0.07)",
    }}>
      {[["home","🏠","หน้าแรก"],["book","📅","จองสนาม"]].map(([id, icon, label]) => (
        <button key={id} onClick={() => setTab(id)} style={{
          flex:1, padding:"11px 0 8px", background:"none", border:"none",
          borderTop: tab===id ? "2.5px solid var(--or)" : "2.5px solid transparent",
          color: tab===id ? "var(--or)" : "var(--mu)",
          cursor:"pointer", display:"flex", flexDirection:"column",
          alignItems:"center", gap:3,
        }}>
          <span style={{ fontSize:21 }}>{icon}</span>
          <span style={{ fontSize:11, fontWeight: tab===id ? 700 : 400 }}>{label}</span>
        </button>
      ))}
    </nav>
  );
}

function HomePage({ goBook }) {
  return (
    <div style={{ paddingBottom:90 }}>
      <div style={{ background:"linear-gradient(160deg,#fff 0%,var(--cr) 55%,var(--cr2) 100%)", padding:"36px 24px 0", textAlign:"center" }}>
        <NovaLogo width={180} />
        <p style={{ color:"var(--mu)", fontSize:13.5, margin:"8px 0 4px" }}>สนามเทนนิสในร่ม • ระบบปรับอากาศ • พร้อมรองรับทุกระดับ</p>
        <CourtLines />
      </div>
      <div style={{ padding:"0 16px", marginTop:-2 }}>
        <button className="btn-primary" onClick={goBook}>จองสนามเลย →</button>
      </div>
      <div style={{ padding:"18px 16px 0", display:"flex", flexDirection:"column", gap:14 }}>
        <div className="card">
          <div className="card-header"><p>💰 ราคาค่าสนาม</p></div>
          <div style={{ display:"flex", padding:"16px 18px", gap:12 }}>
            <div style={{ flex:1, textAlign:"center" }}>
              <p style={{ fontSize:10.5, color:"var(--mu)", marginBottom:5 }}>ช่วงเช้า</p>
              <p style={{ fontSize:28, fontWeight:800, color:"var(--or)", lineHeight:1 }}>฿490</p>
              <p style={{ fontSize:10.5, color:"var(--mu)", marginTop:5 }}>06:00–12:59</p>
            </div>
            <div style={{ width:1, background:"var(--dv)" }} />
            <div style={{ flex:1, textAlign:"center" }}>
              <p style={{ fontSize:10.5, color:"var(--mu)", marginBottom:5 }}>ช่วงบ่าย-เย็น</p>
              <p style={{ fontSize:28, fontWeight:800, color:"var(--bl)", lineHeight:1 }}>฿590</p>
              <p style={{ fontSize:10.5, color:"var(--mu)", marginTop:5 }}>13:00–22:59</p>
            </div>
          </div>
        </div>
        {[
          { icon:"📋", title:"เงื่อนไขการจอง", items:["จองล่วงหน้าได้สูงสุด 7 วัน","ชำระเงินภายใน 5 นาทีหลังยืนยัน","1 การจอง = 1 ช่วงเวลา (1 ชั่วโมง)"] },
          { icon:"❌", title:"นโยบายการยกเลิก", items:["ยกเลิกก่อน 24 ชม. — คืนเงินเต็มจำนวน","ยกเลิกภายใน 24 ชม. — หักค่าธรรมเนียม 50%","No-show — ไม่คืนเงิน"] },
          { icon:"🎾", title:"กฎระเบียบสนาม", items:["แต่งกายด้วยชุดกีฬาเท่านั้น","ห้ามนำอาหารและเครื่องดื่มเข้าสนาม","กรุณาตรงต่อเวลา ไม่สามารถขยายเวลาได้"] },
          { icon:"📞", title:"ติดต่อเรา", items:["โทร: 02-xxx-xxxx","Line: @novatenniscourt","เปิดทำการ 06:00–22:00 น. ทุกวัน"] },
        ].map(({ icon, title, items }) => (
          <div key={title} className="card">
            <div style={{ padding:"12px 18px", borderBottom:"1px solid var(--dv)", display:"flex", alignItems:"center", gap:8 }}>
              <span style={{ fontSize:17 }}>{icon}</span>
              <span style={{ fontWeight:700, color:"var(--br)", fontSize:14 }}>{title}</span>
            </div>
            <div style={{ padding:"12px 18px", display:"flex", flexDirection:"column", gap:7 }}>
              {items.map((it,i) => (
                <div key={i} style={{ display:"flex", gap:10, alignItems:"flex-start" }}>
                  <span style={{ color:"var(--or)", fontSize:14, lineHeight:1.5, flexShrink:0 }}>›</span>
                  <span style={{ fontSize:13.5, color:"var(--mu)", lineHeight:1.65 }}>{it}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Calendar({ selected, onSelect }) {
  const today = new Date(); today.setHours(0,0,0,0);
  const maxDate = new Date(today); maxDate.setDate(maxDate.getDate()+7);
  const [view, setView] = useState(new Date(today.getFullYear(), today.getMonth(), 1));
  const y = view.getFullYear(), m = view.getMonth();
  const firstDay = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m+1, 0).getDate();
  const selIso = toIso(selected);
  const cells = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(y, m, d));
  return (
    <div className="card">
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"12px 16px", background:"var(--br)" }}>
        <button onClick={() => setView(new Date(y, m-1, 1))} style={{ background:"none", border:"none", color:"rgba(255,255,255,.75)", fontSize:22, cursor:"pointer" }}>‹</button>
        <span style={{ fontWeight:700, color:"#fff", fontSize:15 }}>{view.toLocaleDateString("th-TH",{ month:"long", year:"numeric" })}</span>
        <button onClick={() => setView(new Date(y, m+1, 1))} style={{ background:"none", border:"none", color:"rgba(255,255,255,.75)", fontSize:22, cursor:"pointer" }}>›</button>
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", padding:"10px 10px 0", gap:2 }}>
        {["อา","จ","อ","พ","พฤ","ศ","ส"].map(d => (
          <div key={d} style={{ textAlign:"center", fontSize:11, color:"var(--mu)", fontWeight:600, paddingBottom:6 }}>{d}</div>
        ))}
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", padding:"2px 10px 12px", gap:3 }}>
        {cells.map((d, i) => {
          if (!d) return <div key={i} />;
          const iso = toIso(d);
          const isToday = iso === toIso(today);
          const isSel = iso === selIso;
          const disabled = d < today || d > maxDate;
          return (
            <button key={i} disabled={disabled} onClick={() => onSelect(new Date(d))} style={{
              aspectRatio:"1", borderRadius:8, border:"none",
              cursor: disabled ? "default" : "pointer",
              background: isSel ? "var(--or)" : isToday ? "var(--or-bg)" : "transparent",
              color: disabled ? "#ccc" : isSel ? "#fff" : isToday ? "var(--or)" : "var(--tx)",
              fontWeight: (isSel || isToday) ? 700 : 400, fontSize:13,
              outline: (isToday && !isSel) ? "1.5px solid var(--or)" : "none",
            }}>{d.getDate()}</button>
          );
        })}
      </div>
    </div>
  );
}

function BookingPage({ onProceed }) {
  const [date, setDate] = useState(null);
  const [court, setCourt] = useState(null);
  const [slot, setSlot] = useState(null);
  const [bookedHours, setBookedHours] = useState([]);
  const [loading, setLoading] = useState(false);
  const ready = date && court && slot;

  useEffect(() => {
    if (!date || !court) return;
    setLoading(true);
    supabase.getBookings(toIso(date), court.courtId).then(data => {
      setBookedHours((data || []).map(b => b.hour));
      setLoading(false);
    });
  }, [date, court]);

  return (
    <div style={{ padding:"20px 16px 100px", display:"flex", flexDirection:"column", gap:22 }} className="fu">
      <section>
        <StepHead n="1" label="เลือกวันที่" />
        <Calendar selected={date} onSelect={d => { setDate(d); setSlot(null); }} />
        {date && (
          <div style={{ marginTop:10, background:"var(--or-bg)", borderRadius:10, padding:"9px 14px", border:"1px solid rgba(244,126,31,.2)" }}>
            <p style={{ fontSize:13, color:"var(--br)", fontWeight:600 }}>📅 {fmtDate(date)}</p>
          </div>
        )}
      </section>
      <section>
        <StepHead n="2" label="เลือกสนาม" />
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
          {COURTS.map(c => {
            const sel = court?.courtId === c.courtId;
            return (
              <button key={c.courtId} onClick={() => { setCourt(c); setSlot(null); }} style={{
                padding:"20px 12px 16px", borderRadius:"var(--r)",
                border:`2px solid ${sel ? "var(--or)" : "var(--dv)"}`,
                background: sel ? "var(--or-bg)" : "#fff",
                cursor:"pointer", textAlign:"center",
                boxShadow: sel ? "0 2px 12px rgba(244,126,31,.18)" : "var(--sh)",
              }}>
                <div style={{ fontSize:30, marginBottom:7 }}>🎾</div>
                <p style={{ fontWeight:700, color: sel ? "var(--or)" : "var(--br)", fontSize:15 }}>{c.courtName}</p>
                <p style={{ fontSize:11, color:"var(--mu)", marginTop:4 }}>{c.desc}</p>
              </button>
            );
          })}
        </div>
      </section>
      <section>
        <StepHead n="3" label="เลือกช่วงเวลา" />
        {(!date || !court) ? (
          <div style={{ background:"#fff", borderRadius:"var(--r)", padding:"22px", textAlign:"center", border:"1px solid var(--dv)" }}>
            <p style={{ color:"var(--mu)", fontSize:14 }}>กรุณาเลือกวันที่และสนามก่อน</p>
          </div>
        ) : loading ? (
          <div style={{ background:"#fff", borderRadius:"var(--r)", padding:"22px", textAlign:"center", border:"1px solid var(--dv)" }}>
            <p style={{ color:"var(--mu)", fontSize:14 }}>⏳ กำลังโหลด...</p>
          </div>
        ) : (
          <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
            {TIME_SLOTS.map(ts => {
              const booked = bookedHours.includes(ts.hour);
              const isSel = slot?.hour === ts.hour;
              return (
                <button key={ts.hour} disabled={booked} onClick={() => setSlot(ts)} style={{
                  display:"flex", justifyContent:"space-between", alignItems:"center",
                  padding:"13px 16px", borderRadius:10,
                  border:`1.5px solid ${isSel ? "var(--or)" : booked ? "transparent" : "var(--dv)"}`,
                  background: isSel ? "var(--or-bg)" : booked ? "rgba(0,0,0,.03)" : "#fff",
                  cursor: booked ? "not-allowed" : "pointer", opacity: booked ? .5 : 1,
                }}>
                  <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                    <div style={{ width:8, height:8, borderRadius:"50%", background: booked ? "#ccc" : ts.peak ? "var(--bl)" : "var(--or)" }} />
                    <span style={{ fontSize:14, textDecoration: booked ? "line-through" : "none" }}>{ts.label}</span>
                  </div>
                  <span style={{ fontSize:14, fontWeight:700, color: booked ? "var(--mu)" : ts.peak ? "var(--bl)" : "var(--or)" }}>
                    {booked ? "เต็ม" : `฿${ts.price.toLocaleString()}`}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </section>
      <button className="btn-primary" disabled={!ready} onClick={() => onProceed({ date, court, slot })}>
        ดำเนินการต่อ →
      </button>
    </div>
  );
}

function CheckoutPage({ booking, onCancel, onConfirm }) {
  const { date, court, slot } = booking;
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const nameOk = name.trim().length >= 1 && name.length <= 16;
  const phoneOk = /^[0-9]{9,10}$/.test(phone);
  const ok = nameOk && phoneOk;
  return (
    <div style={{ padding:"20px 16px 100px" }} className="fu">
      <h2 className="bb" style={{ fontSize:28, color:"var(--br)", marginBottom:20 }}>ยืนยันการจอง</h2>
      <div className="card" style={{ marginBottom:20 }}>
        <div className="card-header"><p>สรุปรายการจอง</p></div>
        <div className="card-body">
          <Row label="🎾 สนาม" val={court.courtName} />
          <Row label="📅 วันที่" val={fmtDate(date)} />
          <Row label="🕐 เวลา" val={slot.label} />
          <div style={{ borderTop:"1px solid var(--dv)", margin:"12px 0" }} />
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <span style={{ fontWeight:700, color:"var(--br)", fontSize:15 }}>ยอดชำระ</span>
            <span style={{ fontSize:30, fontWeight:800, color:"var(--or)" }}>฿{slot.price.toLocaleString()}</span>
          </div>
        </div>
      </div>
      <div style={{ display:"flex", flexDirection:"column", gap:15, marginBottom:26 }}>
        <div>
          <label style={{ fontSize:13, fontWeight:600, color:"var(--br)", marginBottom:7, display:"block" }}>ชื่อ-นามสกุล (ไม่เกิน 16 ตัว)</label>
          <input value={name} onChange={e => setName(e.target.value)} maxLength={16} placeholder="กรอกชื่อของท่าน"
            style={{ width:"100%", padding:"13px 14px", borderRadius:10, fontSize:15, background:"#fff", border:`1.5px solid ${name && !nameOk ? "#c0392b" : "var(--dv)"}`, color:"var(--tx)", outline:"none" }} />
          <p style={{ fontSize:11, color:"var(--mu)", marginTop:5, textAlign:"right" }}>{name.length}/16</p>
        </div>
        <div>
          <label style={{ fontSize:13, fontWeight:600, color:"var(--br)", marginBottom:7, display:"block" }}>เบอร์โทรศัพท์</label>
          <input value={phone} onChange={e => setPhone(e.target.value.replace(/\D/g,"").slice(0,10))} placeholder="0812345678" inputMode="numeric"
            style={{ width:"100%", padding:"13px 14px", borderRadius:10, fontSize:15, background:"#fff", border:`1.5px solid ${phone && !phoneOk ? "#c0392b" : "var(--dv)"}`, color:"var(--tx)", outline:"none" }} />
        </div>
      </div>
      <div style={{ display:"flex", gap:12 }}>
        <button onClick={onCancel} style={{ flex:1, padding:"14px", borderRadius:"var(--r)", border:"1.5px solid var(--dv)", background:"#fff", color:"var(--mu)", fontSize:15, cursor:"pointer" }}>ยกเลิก</button>
        <button disabled={!ok} onClick={() => onConfirm({ name:name.trim(), phone })} style={{
          flex:2, padding:"14px", borderRadius:"var(--r)", border:"none",
          background: ok ? "linear-gradient(90deg,var(--or),var(--or2))" : "var(--cr2)",
          color: ok ? "#fff" : "var(--mu)", fontWeight:700, fontSize:15, cursor: ok ? "pointer" : "not-allowed",
        }}>ยืนยัน ✓</button>
      </div>
    </div>
  );
}

function PaymentPage({ booking, customer, onDone }) {
  const { date, court, slot } = booking;
  const [secs, setSecs] = useState(300);
  const expired = secs <= 0;
  const urgent = secs <= 60 && !expired;
  useEffect(() => {
    if (expired) return;
    const t = setTimeout(() => setSecs(s => s - 1), 1000);
    return () => clearTimeout(t);
  }, [secs, expired]);
  const mm = String(Math.floor(Math.max(secs,0)/60)).padStart(2,"0");
  const ss = String(Math.max(secs,0)%60).padStart(2,"0");
  const pct = (Math.max(secs,0)/300)*100;

  const handleDone = async () => {
    await supabase.upsertCustomer(customer.phone, customer.name);
    await supabase.addBooking({
      court_id: court.courtId,
      customer_id: customer.phone,
      booking_date: toIso(date),
      hour: slot.hour,
      price: slot.price,
    });
    onDone();
  };

  return (
    <div style={{ padding:"20px 16px 90px" }} className="fu">
      <h2 className="bb" style={{ fontSize:28, color:"var(--br)", marginBottom:18 }}>ชำระเงิน</h2>
      <div style={{ background:"#fff", borderRadius:"var(--r)", marginBottom:16, border:`1.5px solid ${expired ? "#c0392b" : urgent ? "#e67e22" : "var(--dv)"}`, padding:"16px 20px", textAlign:"center", boxShadow:"var(--sh)" }}>
        <p style={{ fontSize:12, color:"var(--mu)", marginBottom:3 }}>{expired ? "หมดเวลา" : "กรุณาชำระภายใน"}</p>
        <p className="bb" style={{ fontSize:54, lineHeight:1, color: expired ? "#c0392b" : urgent ? "#e67e22" : "var(--br)" }}>{mm}:{ss}</p>
        <div style={{ height:4, background:"var(--cr2)", borderRadius:4, marginTop:12, overflow:"hidden" }}>
          <div style={{ height:"100%", borderRadius:4, width:`${pct}%`, background: expired ? "#c0392b" : urgent ? "#e67e22" : "var(--or)", transition:"width 1s linear" }} />
        </div>
        {expired && <p style={{ color:"#c0392b", fontSize:13, marginTop:8, fontWeight:600 }}>⚠️ หมดเวลา — กรุณาเริ่มต้นใหม่</p>}
      </div>
      <div style={{ background:"#fff", borderRadius:"var(--r)", padding:"20px", textAlign:"center", boxShadow:"0 4px 24px rgba(102,57,36,.12)", marginBottom:16, border:"1px solid var(--dv)" }}>
        <p style={{ fontSize:13, color:"var(--mu)", marginBottom:12 }}>สแกน QR Code ชำระผ่าน PromptPay</p>
        <img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&color=663924&bgcolor=F9E8D4&data=PromptPay0812345678" alt="QR" style={{ width:200, height:200, borderRadius:10 }} />
        <div style={{ marginTop:14, display:"inline-flex", alignItems:"center", gap:8, background:"var(--or-bg)", borderRadius:20, padding:"8px 18px" }}>
          <span style={{ fontSize:24, fontWeight:800, color:"var(--or)" }}>฿{slot.price.toLocaleString()}</span>
          <span style={{ fontSize:12, color:"var(--mu)" }}>โอนให้ถูกต้อง</span>
        </div>
      </div>
      <div className="card" style={{ marginBottom:16 }}>
        <div className="card-header"><p>รายละเอียดการจอง</p></div>
        <div className="card-body">
          <Row label="👤 ชื่อ" val={customer.name} />
          <Row label="📞 เบอร์" val={customer.phone} />
          <Row label="🎾 สนาม" val={court.courtName} />
          <Row label="📅 วันที่" val={fmtDate(date)} />
          <Row label="🕐 เวลา" val={slot.label} />
        </div>
      </div>
      <div className="card" style={{ marginBottom:24 }}>
        <div style={{ padding:"11px 18px", borderBottom:"1px solid var(--dv)", background:"var(--bl-bg)" }}>
          <p style={{ fontWeight:700, color:"var(--br)", fontSize:14 }}>ขั้นตอนการชำระเงิน</p>
        </div>
        <div style={{ padding:"14px 18px", display:"flex", flexDirection:"column", gap:12 }}>
          {["บันทึกด้วยการถ่ายภาพหน้าจอ","เปิดแอปธนาคารที่พร้อมชำระเงินของคุณ","เลือกตัวเลือกเพื่อสแกนรหัส QR","ส่งไฟล์รหัส QR ที่คุณบันทึกไว้ก่อนหน้านี้","ทำธุรกรรมให้เสร็จสิ้น"].map((s,i) => (
            <div key={i} style={{ display:"flex", gap:12, alignItems:"flex-start" }}>
              <div style={{ width:24, height:24, borderRadius:"50%", flexShrink:0, background:"var(--br)", color:"var(--or)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, fontWeight:800, marginTop:1 }}>{i+1}</div>
              <p style={{ fontSize:13.5, color:"var(--mu)", lineHeight:1.65 }}>{s}</p>
            </div>
          ))}
        </div>
      </div>
      <button className="btn-primary" onClick={handleDone}>ชำระเงินแล้ว / กลับหน้าหลัก</button>
    </div>
  );
}

function StepHead({ n, label }) {
  return (
    <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:13 }}>
      <div style={{ width:28, height:28, borderRadius:"50%", background:"var(--br)", color:"var(--or)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:13, fontWeight:800 }}>{n}</div>
      <span style={{ fontWeight:700, fontSize:16, color:"var(--br)" }}>{label}</span>
    </div>
  );
}

function Row({ label, val }) {
  return (
    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:9, gap:12 }}>
      <span style={{ color:"var(--mu)", fontSize:13, flexShrink:0 }}>{label}</span>
      <span style={{ fontWeight:600, fontSize:13, color:"var(--tx)", textAlign:"right" }}>{val}</span>
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState("home");
  const [page, setPage] = useState("booking");
  const [booking, setBooking] = useState(null);
  const [customer, setCustomer] = useState(null);

  const goTab = (id) => { setTab(id); if (id === "book") setPage("booking"); };

  return (
    <>
      <style>{CSS}</style>
      <div style={{ maxWidth:480, margin:"0 auto", minHeight:"100dvh", background:"var(--cr)" }}>
        <header style={{ position:"sticky", top:0, zIndex:100, backgroundColor:"rgba(249,232,212,0.93)", backdropFilter:"blur(10px)", borderBottom:"1px solid var(--dv)", padding:"8px 20px" }}>
          <NovaLogo width={100} />
        </header>
        <main>
          {tab === "home" && <HomePage goBook={() => goTab("book")} />}
          {tab === "book" && page === "booking" && <BookingPage onProceed={b => { setBooking(b); setPage("checkout"); }} />}
          {tab === "book" && page === "checkout" && booking && (
            <CheckoutPage booking={booking} onCancel={() => setPage("booking")} onConfirm={c => { setCustomer(c); setPage("payment"); }} />
          )}
          {tab === "book" && page === "payment" && booking && customer && (
            <PaymentPage booking={booking} customer={customer} onDone={() => { setBooking(null); setCustomer(null); setPage("booking"); goTab("home"); }} />
          )}
        </main>
        <TabBar tab={tab} setTab={goTab} />
      </div>
    </>
  );
}

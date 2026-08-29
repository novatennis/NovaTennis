import { useState, useEffect, useRef } from "react";

// ─── Supabase ─────────────────────────────────────────────────────────────────
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

const db = {
  // ไม่นับช่วงเวลาของการจองที่ถูกยกเลิกแล้ว (status=cancelled) เพื่อให้ช่วงเวลานั้นกลับมาให้จองใหม่ได้
  async getBookings(date, courtId) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/bookings?booking_date=eq.${date}&court_id=eq.${courtId}&status=neq.cancelled&select=hour`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    return res.json();
  },
  async addBooking(data) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/bookings`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify(data),
    });
    const json = await res.json();
    return json[0];
  },
  async updateSlip(id, slipUrl) {
    await fetch(`${SUPABASE_URL}/rest/v1/bookings?id=eq.${id}`, {
      method: "PATCH",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ slip_url: slipUrl, status: "reviewing" }),
    });
  },
  async upsertCustomer(customerId, customerName) {
    await fetch(`${SUPABASE_URL}/rest/v1/customers`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ customer_id: customerId, customer_name: customerName }),
    });
  },
  async checkDiscount(code) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/discount_codes?code=eq.${code.toUpperCase()}&active=eq.true&select=*`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const data = await res.json();
    if (!data || data.length === 0) return null;
    const d = data[0];
    if (d.used_count >= d.max_uses) return null;
    return d;
  },
  async useDiscount(id, currentCount) {
    await fetch(`${SUPABASE_URL}/rest/v1/discount_codes?id=eq.${id}`, {
      method: "PATCH",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ used_count: currentCount + 1 }),
    });
  },
  async uploadSlip(file, bookingId) {
    const ext = file.name.split(".").pop();
    const path = `slips/${bookingId}_${Date.now()}.${ext}`;
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/slips/${path}`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": file.type },
      body: file,
    });
    if (!res.ok) return null;
    return `${SUPABASE_URL}/storage/v1/object/public/slips/${path}`;
  },
};

// ─── Constants ────────────────────────────────────────────────────────────────
// Court 1 = ไม่มีหน้าต่าง, Court 2 = มีหน้าต่าง (ตามภาพจริงของสนาม)
const COURTS = [
  { courtId: 1, courtName: "Court 1", icon: "🚪", descTh: "สนามในร่ม • ปรับอากาศ • ไม่มีหน้าต่าง", descEn: "Indoor • Air-conditioned • No window" },
  { courtId: 2, courtName: "Court 2", icon: "🪟", descTh: "สนามในร่ม • ปรับอากาศ • มีหน้าต่าง", descEn: "Indoor • Air-conditioned • Has window" },
];

const TIME_SLOTS = Array.from({ length: 17 }, (_, i) => {
  const h = 6 + i;
  return { hour: h, label: `${String(h).padStart(2,"0")}:00 – ${String(h).padStart(2,"0")}:59`, price: h < 13 ? 490 : 590, peak: h >= 13 };
});

// ใช้วันที่ตามเวลาท้องถิ่น (ไม่ใช่ UTC) เพื่อไม่ให้วันที่คลาดเคลื่อนตอนใกล้เที่ยงคืน
// (toISOString() แปลงเป็น UTC ก่อน ซึ่งประเทศไทย (+7) จะทำให้วันที่เพี้ยนไป 1 วันได้)
const toIso = (d) => {
  if (!d) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};
const fmtDate = (d, lang="th") => d ? d.toLocaleDateString(lang==="th"?"th-TH":"en-GB", { weekday: "short", year: "numeric", month: "short", day: "numeric" }) : "";

// ─── Payment info (ใช้ QR จริงของร้าน) ─────────────────────────────────────────
const PAYMENT_ACCOUNT_NAME = "นาง อภิระมณ เฉลิมวงศาเวช";
const PAYMENT_PHONE = "063-146-5997";
const LINE_OA_URL = "https://line.me/R/ti/p/@347mlhra";
const MAP_URL = "https://maps.app.goo.gl/wbDULbGf8VtaLbiW7";

// ─── Membership package (โครงไว้สำหรับอนาคต — ยังไม่เปิดใช้งาน) ────────────────
// TODO: เปิดใช้งานระบบสมาชิกแบบเหมาจ่ายในอนาคต เมื่อกำหนดราคาชัดเจนแล้ว
// eslint-disable-next-line no-unused-vars
const MEMBERSHIP_PACKAGE = { sessions: 10, price: null, active: false };

// ─── CSS ──────────────────────────────────────────────────────────────────────
const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Noto+Sans+Thai:wght@300;400;500;600;700&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --cr: #F9E8D4; --cr2: #EDD5B8; --or: #F47E1F; --or2: #FAA05A;
    --or-bg: rgba(244,126,31,0.10); --br: #663924; --bl: #8DB6C7;
    --bl-bg: rgba(141,182,199,0.13); --tx: #2e1a0e; --mu: #8a7060;
    --dv: rgba(102,57,36,0.14); --sh: 0 2px 16px rgba(102,57,36,0.09); --r: 14px;
  }
  html, body { background: var(--cr); font-family: 'Noto Sans Thai', sans-serif; color: var(--tx); }
  button, input { font-family: 'Noto Sans Thai', sans-serif; }
  a { color: inherit; }
  .bb { font-family: 'Bebas Neue', sans-serif; letter-spacing: .05em; }
  .btn-primary { width:100%; padding:15px; border-radius:var(--r); border:none; background:linear-gradient(90deg,var(--or),var(--or2)); color:#fff; font-weight:700; font-size:16px; cursor:pointer; box-shadow:0 4px 18px rgba(244,126,31,.30); font-family:'Noto Sans Thai',sans-serif; }
  .btn-primary:disabled { background:var(--cr2); color:var(--mu); box-shadow:none; cursor:not-allowed; }
  .card { background:#fff; border-radius:var(--r); border:1px solid var(--dv); box-shadow:var(--sh); overflow:hidden; }
  .card-header { background:var(--br); padding:11px 18px; }
  .card-header p { color:var(--or); font-size:13px; font-weight:600; }
  .card-body { padding:16px 18px; }
  @keyframes fu { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:translateY(0)} }
  .fu { animation:fu .3s ease both; }
`;

// ─── Translations ─────────────────────────────────────────────────────────────
const T = {
  th: {
    bookNow: "จองสนามเลย →", home: "หน้าแรก", book: "จองสนาม", myBookings: "การจองของฉัน",
    selectDate: "เลือกวันที่", selectCourt: "เลือกสนาม", selectTime: "เลือกช่วงเวลา",
    proceed: "ดำเนินการต่อ →", confirm: "ยืนยันการจอง", cancel: "ยกเลิก",
    name: "ชื่อ-นามสกุล (ไม่เกิน 16 ตัว)", phone: "เบอร์โทรศัพท์",
    discount: "🏷 รหัสส่วนลด (ถ้ามี)", useCode: "ใช้โค้ด",
    payment: "ชำระเงิน", scanQR: "สแกน QR Code ชำระผ่าน PromptPay",
    transfer: "โอนให้ถูกต้อง", bookingDetail: "รายละเอียดการจอง",
    court: "สนาม", date: "วันที่", time: "เวลา", price: "ยอดชำระ",
    total: "ยอดชำระ", payDone: "ชำระเงินแล้ว / กลับหน้าหลัก",
    uploadSlip: "📎 แนบสลิปการโอนเงิน", selectSlip: "📷 เลือกรูปสลิป",
    changeSlip: "🔄 เปลี่ยนรูปสลิป", sendSlip: "✅ ส่งสลิป",
    sending: "⏳ กำลังส่ง...", slipSent: "✅ ส่งสลิปเรียบร้อยแล้ว",
    slipSentDesc: "สถานะ: รอการยืนยัน — กำลังนำท่านไปหน้าตรวจสอบการจอง...",
    noSlot: "😔 ไม่มีช่วงเวลาว่างในวันนี้",
    selectDateFirst: "กรุณาเลือกวันที่และสนามก่อน",
    confirmBooking: "ยืนยัน ✓", morningPrice: "ช่วงเช้า", eveningPrice: "ช่วงบ่าย-เย็น",
    steps: "ขั้นตอนการชำระเงิน", contactUs: "ติดต่อเรา",
    rules: "กฎระเบียบสนาม", cancelPolicy: "นโยบายการยกเลิก",
    bookingCondition: "เงื่อนไขการจอง", priceTitle: "💰 ราคาค่าสนาม",
    indoor: "สนามในร่ม • ปรับอากาศ", saveDiscount: "ประหยัดไป",
    timeExpired: "หมดเวลา", payWithin: "กรุณาชำระภายใน",
    invalidCode: "❌ รหัสส่วนลดไม่ถูกต้องหรือหมดอายุแล้ว",
    contactLine: "กรุณาติดต่อยกเลิกผ่าน Line หรือโทรศัพท์",
    noWindow: "ไม่มีหน้าต่าง", hasWindow: "มีหน้าต่าง",
    summaryTitle: "สรุปรายการจอง", accountName: "ชื่อบัญชี", loading: "⏳ กำลังโหลด...",
    backHome: "กลับหน้าหลัก", checkMyBooking: "การจองของฉัน",
    searchPlaceholder: "กรอกเบอร์โทรของคุณ", searchBtn: "ค้นหา",
    notFound: "ไม่พบการจองสำหรับเบอร์นี้",
    statusPending: "รอชำระเงิน", statusReviewing: "รอการยืนยัน",
    statusConfirmed: "การจองสำเร็จ", statusCancelled: "การจองถูกยกเลิกแล้ว",
    cancelBookingBtn: "❌ ยกเลิกการจอง", cancellingBtn: "⏳ กำลังยกเลิก...",
    cannotCancelPast: "❌ ไม่สามารถยกเลิกได้ เนื่องจากเลยเวลาแล้ว",
    cannotCancel24h: "❌ ไม่สามารถยกเลิกได้ เนื่องจากเหลือเวลาน้อยกว่า 24 ชั่วโมง",
    confirmCancelPrompt: "ยืนยันการยกเลิก?\nคุณจะได้รับเงินคืนเต็มจำนวน",
    cancelSuccess: "✅ ยกเลิกการจองเรียบร้อยแล้ว",
    warning24h: "⚠️ ไม่สามารถยกเลิกได้ เนื่องจากเหลือเวลาน้อยกว่า 24 ชั่วโมง",
    rowPrice: "💰 ราคา",
    stepsList: ["โอนเงินผ่าน QR Code ด้านบน","ถ่ายภาพสลิปการโอนเงิน","กด 'เลือกรูปสลิป' แล้วอัพโหลดสลิป","กด 'ส่งสลิป' เพื่อยืนยัน","รอทีมงานตรวจสอบและยืนยันการจอง"],
    lineLabel: "Line", mapLabel: "แผนที่ / Map",
  },
  en: {
    bookNow: "Book Now →", home: "Home", book: "Book", myBookings: "My Bookings",
    selectDate: "Select Date", selectCourt: "Select Court", selectTime: "Select Time Slot",
    proceed: "Continue →", confirm: "Confirm Booking", cancel: "Cancel",
    name: "Full Name (max 16 chars)", phone: "Phone Number",
    discount: "🏷 Discount Code (optional)", useCode: "Apply",
    payment: "Payment", scanQR: "Scan QR Code via PromptPay",
    transfer: "Transfer exact amount", bookingDetail: "Booking Details",
    court: "Court", date: "Date", time: "Time", price: "Total",
    total: "Total", payDone: "Payment Done / Back to Home",
    uploadSlip: "📎 Upload Payment Slip", selectSlip: "📷 Select Slip Image",
    changeSlip: "🔄 Change Slip", sendSlip: "✅ Send Slip",
    sending: "⏳ Sending...", slipSent: "✅ Slip Submitted Successfully",
    slipSentDesc: "Status: Awaiting confirmation — taking you to your bookings...",
    noSlot: "😔 No available slots today",
    selectDateFirst: "Please select a date and court first",
    confirmBooking: "Confirm ✓", morningPrice: "Morning", eveningPrice: "Afternoon-Evening",
    steps: "Payment Steps", contactUs: "Contact Us",
    rules: "Court Rules", cancelPolicy: "Cancellation Policy",
    bookingCondition: "Booking Conditions", priceTitle: "💰 Court Rates",
    indoor: "Indoor Court • Air-conditioned", saveDiscount: "You save",
    timeExpired: "Time Expired", payWithin: "Please pay within",
    invalidCode: "❌ Invalid or expired discount code",
    contactLine: "Please contact us via Line or Phone to cancel",
    noWindow: "No window", hasWindow: "Has window",
    summaryTitle: "Booking Summary", accountName: "Account Name", loading: "⏳ Loading...",
    backHome: "Back to Home", checkMyBooking: "My Bookings",
    searchPlaceholder: "Enter your phone number", searchBtn: "Search",
    notFound: "No bookings found for this number",
    statusPending: "Awaiting Payment", statusReviewing: "Awaiting Confirmation",
    statusConfirmed: "Booking Confirmed", statusCancelled: "Booking Cancelled",
    cancelBookingBtn: "❌ Cancel Booking", cancellingBtn: "⏳ Cancelling...",
    cannotCancelPast: "❌ Cannot cancel — this time has already passed",
    cannotCancel24h: "❌ Cannot cancel — less than 24 hours remaining",
    confirmCancelPrompt: "Confirm cancellation?\nYou will receive a full refund",
    cancelSuccess: "✅ Booking cancelled successfully",
    warning24h: "⚠️ Cannot cancel — less than 24 hours remaining",
    rowPrice: "💰 Price",
    stepsList: ["Transfer via the QR Code above","Take a photo of the transfer slip","Tap 'Select Slip Image' and upload it","Tap 'Send Slip' to confirm","Wait for our team to verify and confirm your booking"],
    lineLabel: "Line", mapLabel: "Map",
  }
};

function NovaLogo({ width }) {
  return <img src="/nova-logo.png" alt="NOVA Tennis" style={{ width, height: "auto", display: "block", margin: "0 auto" }} />;
}

function TabBar({ tab, setTab, lang="th" }) {
  const t = T[lang];
  return (
    <nav style={{position:"fixed",bottom:0,left:0,right:0,zIndex:200,backgroundColor:"#fff",borderTop:"1px solid var(--dv)",display:"flex",boxShadow:"0 -3px 16px rgba(102,57,36,0.07)"}}>
      {[["home","🏠",t.home],["book","📅",t.book],["cancel","🔍",t.myBookings]].map(([id,icon,label]) => (
        <button key={id} onClick={() => setTab(id)} style={{flex:1,padding:"11px 0 8px",background:"none",border:"none",borderTop:tab===id?"2.5px solid var(--or)":"2.5px solid transparent",color:tab===id?"var(--or)":"var(--mu)",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:3}}>
          <span style={{fontSize:19}}>{icon}</span>
          <span style={{fontSize:10,fontWeight:tab===id?700:400}}>{label}</span>
        </button>
      ))}
    </nav>
  );
}

function HomePage({ goBook, lang="th" }) {
  const t = T[lang];
  const cards = [
    {icon:"📋",title:t.bookingCondition,items:lang==="th"?["จองล่วงหน้าได้สูงสุด 7 วัน","ชำระเงินภายใน 5 นาทีหลังยืนยัน","1 การจอง = 1 ช่วงเวลา (1 ชั่วโมง)"]:["Book up to 7 days in advance","Pay within 5 minutes after confirming","1 booking = 1 time slot (1 hour)"]},
    {icon:"❌",title:t.cancelPolicy,items:lang==="th"?["ยกเลิกผ่าน Line หรือโทรศัพท์เท่านั้น","ยกเลิกก่อน 24 ชม. — คืนเงินเต็มจำนวน","ยกเลิกภายใน 24 ชม. — หักค่าธรรมเนียม 50%"]:["Cancel via Line or Phone only","Cancel 24h+ before — Full refund","Cancel within 24h — 50% fee"]},
    {icon:"🎾",title:t.rules,items:lang==="th"?["แต่งกายด้วยชุดกีฬาเท่านั้น","ห้ามนำอาหารและเครื่องดื่มเข้าสนาม","กรุณาตรงต่อเวลา ไม่สามารถขยายเวลาได้"]:["Sportswear required","No food or drinks on court","Please be punctual, no time extension"]},
  ];
  return (
    <div style={{paddingBottom:90}}>
      <div style={{background:"linear-gradient(160deg,#fff 0%,var(--cr) 55%,var(--cr2) 100%)",padding:"36px 24px 0",textAlign:"center"}}>
        <NovaLogo width={180} />
        <p style={{color:"var(--mu)",fontSize:13.5,margin:"8px 0 16px"}}>{lang==="th"?"สนามเทนนิสในร่ม • ระบบปรับอากาศ • พร้อมรองรับทุกระดับ":"Indoor Tennis Court • Air Conditioned • All Levels Welcome"}</p>
        <img src="/court-photo.png" alt="NOVA Tennis Court" style={{width:"100%",maxWidth:520,borderRadius:16,boxShadow:"0 8px 30px rgba(102,57,36,.18)",display:"block",margin:"0 auto"}} />
        <div style={{height:16}} />
      </div>
      <div style={{padding:"0 16px",marginTop:-2}}>
        <button className="btn-primary" onClick={goBook}>{t.bookNow}</button>
      </div>
      <div style={{padding:"18px 16px 0",display:"flex",flexDirection:"column",gap:14}}>
        <div className="card">
          <div className="card-header"><p>{t.priceTitle}</p></div>
          <div style={{display:"flex",padding:"16px 18px",gap:12}}>
            <div style={{flex:1,textAlign:"center"}}>
              <p style={{fontSize:10.5,color:"var(--mu)",marginBottom:5}}>{t.morningPrice}</p>
              <p style={{fontSize:28,fontWeight:800,color:"var(--or)",lineHeight:1}}>฿490</p>
              <p style={{fontSize:10.5,color:"var(--mu)",marginTop:5}}>06:00–12:59</p>
            </div>
            <div style={{width:1,background:"var(--dv)"}} />
            <div style={{flex:1,textAlign:"center"}}>
              <p style={{fontSize:10.5,color:"var(--mu)",marginBottom:5}}>{t.eveningPrice}</p>
              <p style={{fontSize:28,fontWeight:800,color:"var(--bl)",lineHeight:1}}>฿590</p>
              <p style={{fontSize:10.5,color:"var(--mu)",marginTop:5}}>13:00–22:59</p>
            </div>
          </div>
        </div>
        {cards.map(({icon,title,items}) => (
          <div key={title} className="card">
            <div style={{padding:"12px 18px",borderBottom:"1px solid var(--dv)",display:"flex",alignItems:"center",gap:8}}>
              <span style={{fontSize:17}}>{icon}</span>
              <span style={{fontWeight:700,color:"var(--br)",fontSize:14}}>{title}</span>
            </div>
            <div style={{padding:"12px 18px",display:"flex",flexDirection:"column",gap:7}}>
              {items.map((it,i) => (
                <div key={i} style={{display:"flex",gap:10,alignItems:"flex-start"}}>
                  <span style={{color:"var(--or)",fontSize:14,lineHeight:1.5,flexShrink:0}}>›</span>
                  <span style={{fontSize:13.5,color:"var(--mu)",lineHeight:1.65}}>{it}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
        {/* ติดต่อเรา — โทร / Line / แผนที่ */}
        <div className="card">
          <div style={{padding:"12px 18px",borderBottom:"1px solid var(--dv)",display:"flex",alignItems:"center",gap:8}}>
            <span style={{fontSize:17}}>📞</span>
            <span style={{fontWeight:700,color:"var(--br)",fontSize:14}}>{t.contactUs}</span>
          </div>
          <div style={{padding:"12px 18px",display:"flex",flexDirection:"column",gap:10}}>
            <div style={{display:"flex",gap:10,alignItems:"center"}}>
              <span style={{color:"var(--or)",fontSize:14}}>›</span>
              <a href="tel:0631465997" style={{fontSize:13.5,color:"var(--mu)",textDecoration:"none"}}>{lang==="th"?"โทร: 063-146-5997":"Call: 063-146-5997"}</a>
            </div>
            <div style={{display:"flex",gap:10,alignItems:"center"}}>
              <span style={{color:"var(--or)",fontSize:14}}>›</span>
              <a href={LINE_OA_URL} target="_blank" rel="noreferrer" style={{fontSize:13.5,color:"var(--mu)",textDecoration:"none",fontWeight:600}}>💬 {t.lineLabel}: @347mlhra</a>
            </div>
            <div style={{display:"flex",gap:10,alignItems:"center"}}>
              <span style={{color:"var(--or)",fontSize:14}}>›</span>
              <a href={MAP_URL} target="_blank" rel="noreferrer" style={{fontSize:13.5,color:"var(--mu)",textDecoration:"none",fontWeight:600}}>📍 {t.mapLabel}</a>
            </div>
            <div style={{display:"flex",gap:10,alignItems:"flex-start"}}>
              <span style={{color:"var(--or)",fontSize:14,lineHeight:1.5}}>›</span>
              <span style={{fontSize:13.5,color:"var(--mu)",lineHeight:1.65}}>{lang==="th"?"เปิดทำการ 06:00–22:00 น. ทุกวัน":"Open daily 06:00–22:00"}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Calendar({ selected, onSelect, lang="th" }) {
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
  const dowLabels = lang==="th" ? ["อา","จ","อ","พ","พฤ","ศ","ส"] : ["Su","Mo","Tu","We","Th","Fr","Sa"];
  return (
    <div className="card">
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 16px",background:"var(--br)"}}>
        <button onClick={() => setView(new Date(y,m-1,1))} style={{background:"none",border:"none",color:"rgba(255,255,255,.75)",fontSize:22,cursor:"pointer"}}>‹</button>
        <span style={{fontWeight:700,color:"#fff",fontSize:15}}>{view.toLocaleDateString(lang==="th"?"th-TH":"en-GB",{month:"long",year:"numeric"})}</span>
        <button onClick={() => setView(new Date(y,m+1,1))} style={{background:"none",border:"none",color:"rgba(255,255,255,.75)",fontSize:22,cursor:"pointer"}}>›</button>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",padding:"10px 10px 0",gap:2}}>
        {dowLabels.map(d => (
          <div key={d} style={{textAlign:"center",fontSize:11,color:"var(--mu)",fontWeight:600,paddingBottom:6}}>{d}</div>
        ))}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",padding:"2px 10px 12px",gap:3}}>
        {cells.map((d,i) => {
          if (!d) return <div key={i} />;
          const iso = toIso(d);
          const isToday = iso === toIso(today);
          const isSel = iso === selIso;
          const disabled = d < today || d > maxDate;
          return (
            <button key={i} disabled={disabled} onClick={() => onSelect(new Date(d))} style={{aspectRatio:"1",borderRadius:8,border:"none",cursor:disabled?"default":"pointer",background:isSel?"var(--or)":isToday?"var(--or-bg)":"transparent",color:disabled?"#ccc":isSel?"#fff":isToday?"var(--or)":"var(--tx)",fontWeight:(isSel||isToday)?700:400,fontSize:13,outline:(isToday&&!isSel)?"1.5px solid var(--or)":"none"}}>{d.getDate()}</button>
          );
        })}
      </div>
    </div>
  );
}

function BookingPage({ onProceed, lang="th" }) {
  const t = T[lang];
  const [date, setDate] = useState(null);
  const [court, setCourt] = useState(null);
  const [slot, setSlot] = useState(null);
  const [bookedHours, setBookedHours] = useState([]);
  const [loading, setLoading] = useState(false);
  const ready = date && court && slot;

  useEffect(() => {
    if (!date || !court) return;
    setLoading(true);
    db.getBookings(toIso(date), court.courtId).then(data => {
      setBookedHours((data||[]).map(b => b.hour));
      setLoading(false);
    });
  }, [date, court]);

  // ตัดช่วงเวลาที่ถูกจองแล้วออก และตัดช่วงเวลาที่ผ่านไปแล้ว (ถ้าเป็นวันนี้)
  const isToday = date && toIso(date) === toIso(new Date());
  const currentHour = new Date().getHours();
  const availableSlots = TIME_SLOTS.filter(ts => {
    if (bookedHours.includes(ts.hour)) return false;
    if (isToday && ts.hour <= currentHour) return false;
    return true;
  });

  return (
    <div style={{padding:"20px 16px 100px",display:"flex",flexDirection:"column",gap:22}} className="fu">
      <section>
        <StepHead n="1" label={t.selectDate} />
        <Calendar selected={date} onSelect={d => { setDate(d); setSlot(null); }} lang={lang} />
        {date && (
          <div style={{marginTop:10,background:"var(--or-bg)",borderRadius:10,padding:"9px 14px",border:"1px solid rgba(244,126,31,.2)"}}>
            <p style={{fontSize:13,color:"var(--br)",fontWeight:600}}>📅 {fmtDate(date, lang)}</p>
          </div>
        )}
      </section>
      <section>
        <StepHead n="2" label={t.selectCourt} />
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
          {COURTS.map(c => {
            const sel = court?.courtId === c.courtId;
            return (
              <button key={c.courtId} onClick={() => { setCourt(c); setSlot(null); }} style={{padding:"20px 12px 16px",borderRadius:"var(--r)",border:`2px solid ${sel?"var(--or)":"var(--dv)"}`,background:sel?"var(--or-bg)":"#fff",cursor:"pointer",textAlign:"center",boxShadow:sel?"0 2px 12px rgba(244,126,31,.18)":"var(--sh)"}}>
                <div style={{fontSize:30,marginBottom:7}}>{c.icon}</div>
                <p style={{fontWeight:700,color:sel?"var(--or)":"var(--br)",fontSize:15}}>{c.courtName}</p>
                <p style={{fontSize:11,color:"var(--mu)",marginTop:4}}>{lang==="th"?c.descTh:c.descEn}</p>
              </button>
            );
          })}
        </div>
      </section>
      <section>
        <StepHead n="3" label={t.selectTime} />
        {(!date||!court) ? (
          <div style={{background:"#fff",borderRadius:"var(--r)",padding:"22px",textAlign:"center",border:"1px solid var(--dv)"}}>
            <p style={{color:"var(--mu)",fontSize:14}}>{t.selectDateFirst}</p>
          </div>
        ) : loading ? (
          <div style={{background:"#fff",borderRadius:"var(--r)",padding:"22px",textAlign:"center",border:"1px solid var(--dv)"}}>
            <p style={{color:"var(--mu)",fontSize:14}}>{t.loading}</p>
          </div>
        ) : availableSlots.length === 0 ? (
          <div style={{background:"#fff",borderRadius:"var(--r)",padding:"22px",textAlign:"center",border:"1px solid var(--dv)"}}>
            <p style={{color:"var(--mu)",fontSize:14}}>{t.noSlot}</p>
          </div>
        ) : (
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            <div style={{display:"flex",gap:14,marginBottom:8,flexWrap:"wrap"}}>
              <Dot color="var(--or)" label={lang==="th"?"490 ฿ · ช่วงเช้า":"490 ฿ · Morning"} />
              <Dot color="var(--bl)" label={lang==="th"?"590 ฿ · ช่วงบ่าย":"590 ฿ · Afternoon"} />
            </div>
            {availableSlots.map(ts => {
              const isSel = slot?.hour === ts.hour;
              return (
                <button key={ts.hour} onClick={() => setSlot(ts)} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"13px 16px",borderRadius:10,border:`1.5px solid ${isSel?"var(--or)":"var(--dv)"}`,background:isSel?"var(--or-bg)":"#fff",cursor:"pointer",boxShadow:isSel?"0 2px 10px rgba(244,126,31,.15)":"none"}}>
                  <div style={{display:"flex",alignItems:"center",gap:10}}>
                    <div style={{width:8,height:8,borderRadius:"50%",background:ts.peak?"var(--bl)":"var(--or)"}} />
                    <span style={{fontSize:14}}>{ts.label}</span>
                  </div>
                  <span style={{fontSize:14,fontWeight:700,color:ts.peak?"var(--bl)":"var(--or)"}}>฿{ts.price.toLocaleString()}</span>
                </button>
              );
            })}
          </div>
        )}
      </section>
      <button className="btn-primary" disabled={!ready} onClick={() => onProceed({date,court,slot})}>
        {t.proceed}
      </button>
    </div>
  );
}

function CheckoutPage({ booking, onCancel, onConfirm, lang="th" }) {
  const t = T[lang];
  const { date, court, slot } = booking;
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [discountCode, setDiscountCode] = useState("");
  const [discount, setDiscount] = useState(null);
  const [discountMsg, setDiscountMsg] = useState("");
  const [checkingCode, setCheckingCode] = useState(false);
  const nameOk = name.trim().length >= 1 && name.length <= 16;
  const phoneOk = /^[0-9]{9,10}$/.test(phone);
  const ok = nameOk && phoneOk;

  const calcDiscount = (d) => {
    if (!d) return 0;
    if (d.discount_amount > 0) return d.discount_amount;
    return Math.round(slot.price * d.discount_percent / 100);
  };
  const discountAmount = calcDiscount(discount);
  const finalPrice = Math.max(0, slot.price - discountAmount);

  const handleCheckCode = async () => {
    if (!discountCode.trim()) return;
    setCheckingCode(true);
    setDiscountMsg("");
    const result = await db.checkDiscount(discountCode.trim());
    if (result) {
      setDiscount(result);
      const saved = result.discount_amount > 0 ? result.discount_amount : Math.round(slot.price * result.discount_percent / 100);
      const label = result.discount_amount > 0
        ? (lang==="th" ? `ส่วนลด ฿${result.discount_amount}` : `฿${result.discount_amount} off`)
        : (lang==="th" ? `ส่วนลด ${result.discount_percent}%` : `${result.discount_percent}% off`);
      setDiscountMsg(`✅ ${label} — ${t.saveDiscount} ฿${saved}`);
    } else {
      setDiscount(null);
      setDiscountMsg(t.invalidCode);
    }
    setCheckingCode(false);
  };

  return (
    <div style={{padding:"20px 16px 100px"}} className="fu">
      <h2 className="bb" style={{fontSize:28,color:"var(--br)",marginBottom:20}}>{t.confirm}</h2>
      <div className="card" style={{marginBottom:20}}>
        <div className="card-header"><p>{t.summaryTitle}</p></div>
        <div className="card-body">
          <Row label={`🎾 ${t.court}`} val={court.courtName} />
          <Row label={`📅 ${t.date}`} val={fmtDate(date, lang)} />
          <Row label={`🕐 ${t.time}`} val={slot.label} />
          {discount && <Row label="🏷" val={`-฿${discountAmount.toLocaleString()}`} />}
          <div style={{borderTop:"1px solid var(--dv)",margin:"12px 0"}} />
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <span style={{fontWeight:700,color:"var(--br)",fontSize:15}}>{t.total}</span>
            <div style={{textAlign:"right"}}>
              {discount && <p style={{fontSize:13,color:"var(--mu)",textDecoration:"line-through"}}>฿{slot.price.toLocaleString()}</p>}
              <span style={{fontSize:30,fontWeight:800,color:"var(--or)"}}>฿{finalPrice.toLocaleString()}</span>
            </div>
          </div>
        </div>
      </div>

      <div style={{display:"flex",flexDirection:"column",gap:15,marginBottom:26}}>
        <div>
          <label style={{fontSize:13,fontWeight:600,color:"var(--br)",marginBottom:7,display:"block"}}>{t.name}</label>
          <input value={name} onChange={e => setName(e.target.value)} maxLength={16} placeholder={lang==="th"?"กรอกชื่อของท่าน":"Enter your name"}
            style={{width:"100%",padding:"13px 14px",borderRadius:10,fontSize:15,background:"#fff",border:`1.5px solid ${name&&!nameOk?"#c0392b":"var(--dv)"}`,color:"var(--tx)",outline:"none"}} />
          <p style={{fontSize:11,color:"var(--mu)",marginTop:5,textAlign:"right"}}>{name.length}/16</p>
        </div>
        <div>
          <label style={{fontSize:13,fontWeight:600,color:"var(--br)",marginBottom:7,display:"block"}}>{t.phone}</label>
          <input value={phone} onChange={e => setPhone(e.target.value.replace(/\D/g,"").slice(0,10))} placeholder="0812345678" inputMode="numeric"
            style={{width:"100%",padding:"13px 14px",borderRadius:10,fontSize:15,background:"#fff",border:`1.5px solid ${phone&&!phoneOk?"#c0392b":"var(--dv)"}`,color:"var(--tx)",outline:"none"}} />
        </div>
        <div>
          <label style={{fontSize:13,fontWeight:600,color:"var(--br)",marginBottom:7,display:"block"}}>{t.discount}</label>
          <div style={{display:"flex",gap:8}}>
            <input value={discountCode} onChange={e => setDiscountCode(e.target.value.toUpperCase())} placeholder="เช่น NOVA10"
              style={{flex:1,padding:"13px 14px",borderRadius:10,fontSize:15,background:"#fff",border:"1.5px solid var(--dv)",color:"var(--tx)",outline:"none"}} />
            <button onClick={handleCheckCode} disabled={checkingCode || !discountCode.trim()} style={{padding:"0 16px",borderRadius:10,border:"none",background:"var(--br)",color:"#fff",fontWeight:700,fontSize:14,cursor:"pointer",whiteSpace:"nowrap",fontFamily:"'Noto Sans Thai',sans-serif"}}>
              {checkingCode ? "..." : t.useCode}
            </button>
          </div>
          {discountMsg && <p style={{fontSize:12,marginTop:6,color:discount?"#2d7a4f":"#c0392b"}}>{discountMsg}</p>}
        </div>
      </div>

      <div style={{display:"flex",gap:12}}>
        <button onClick={onCancel} style={{flex:1,padding:"14px",borderRadius:"var(--r)",border:"1.5px solid var(--dv)",background:"#fff",color:"var(--mu)",fontSize:15,cursor:"pointer"}}>{t.cancel}</button>
        <button disabled={!ok} onClick={() => {
          if (discount) {
            const confirmed = window.confirm(lang==="th" ? "การใช้โค้ดส่วนลด หากกดดำเนินการต่อแล้วจะไม่สามารถใช้โค้ดนี้ซ้ำได้อีก" : "Once you proceed, this discount code cannot be used again.");
            if (!confirmed) return;
          }
          onConfirm({name:name.trim(),phone,discount,finalPrice,discountAmount});
        }} style={{flex:2,padding:"14px",borderRadius:"var(--r)",border:"none",background:ok?"linear-gradient(90deg,var(--or),var(--or2))":"var(--cr2)",color:ok?"#fff":"var(--mu)",fontWeight:700,fontSize:15,cursor:ok?"pointer":"not-allowed"}}>{t.confirmBooking}</button>
      </div>
    </div>
  );
}

function PaymentPage({ booking, customer, onDone, lang="th" }) {
  const t = T[lang];
  const { date, court, slot } = booking;
  const { finalPrice, discountAmount, discount } = customer;
  const [secs, setSecs] = useState(300);
  const [expired, setExpired] = useState(false);
  const [slip, setSlip] = useState(null);
  const [slipPreview, setSlipPreview] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploaded, setUploaded] = useState(false);
  const [bookingId, setBookingId] = useState(null);
  const fileRef = useRef();
  const savedRef = useRef(false);

  useEffect(() => {
    const save = async () => {
      if (savedRef.current) return;
      savedRef.current = true;
      await db.upsertCustomer(customer.phone, customer.name);
      const b = await db.addBooking({
        court_id: court.courtId,
        customer_id: customer.phone,
        booking_date: toIso(date),
        hour: slot.hour,
        price: finalPrice,
        discount_code: discount?.code || null,
        discount_amount: discountAmount || 0,
        status: "pending",
      });
      if (b) {
        setBookingId(b.id);
        if (discount) await db.useDiscount(discount.id, discount.used_count);
      }
    };
    save();
  }, []);

  useEffect(() => {
    if (secs <= 0) { setExpired(true); return; }
    const timer = setTimeout(() => setSecs(s => s-1), 1000);
    return () => clearTimeout(timer);
  }, [secs]);

  // หลังส่งสลิปสำเร็จ รอสักครู่แล้วพาไปหน้า "การจองของฉัน" อัตโนมัติ
  useEffect(() => {
    if (!uploaded) return;
    const timer = setTimeout(() => onDone(customer.phone), 1800);
    return () => clearTimeout(timer);
  }, [uploaded]);

  const mm = String(Math.floor(Math.max(secs,0)/60)).padStart(2,"0");
  const ss = String(Math.max(secs,0)%60).padStart(2,"0");
  const pct = (Math.max(secs,0)/300)*100;
  const urgent = secs <= 60 && !expired;

  const handleSlipChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setSlip(file);
    setSlipPreview(URL.createObjectURL(file));
  };

  const handleUpload = async () => {
    if (!slip || !bookingId) return;
    setUploading(true);
    const url = await db.uploadSlip(slip, bookingId);
    if (url) {
      await db.updateSlip(bookingId, url);
      setUploaded(true);
      // แจ้งเตือนแอดมินผ่าน Telegram (ไม่บล็อกการทำงานหลักถ้าแจ้งเตือนล้มเหลว)
      fetch("/api/notify-admin-telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          courtName: court.courtName,
          date: fmtDate(date, lang),
          time: slot.label,
          price: finalPrice,
          name: customer.name,
          phone: customer.phone,
        }),
      }).catch(() => {});
    }
    setUploading(false);
  };

  return (
    <div style={{padding:"20px 16px 90px"}} className="fu">
      <h2 className="bb" style={{fontSize:28,color:"var(--br)",marginBottom:18}}>{t.payment}</h2>

      {/* Countdown */}
      <div style={{background:"#fff",borderRadius:"var(--r)",marginBottom:16,border:`1.5px solid ${expired?"#c0392b":urgent?"#e67e22":"var(--dv)"}`,padding:"16px 20px",textAlign:"center",boxShadow:"var(--sh)"}}>
        <p style={{fontSize:12,color:"var(--mu)",marginBottom:3}}>{expired?t.timeExpired:t.payWithin}</p>
        <p className="bb" style={{fontSize:54,lineHeight:1,color:expired?"#c0392b":urgent?"#e67e22":"var(--br)"}}>{mm}:{ss}</p>
        <div style={{height:4,background:"var(--cr2)",borderRadius:4,marginTop:12,overflow:"hidden"}}>
          <div style={{height:"100%",borderRadius:4,width:`${pct}%`,background:expired?"#c0392b":urgent?"#e67e22":"var(--or)",transition:"width 1s linear"}} />
        </div>
      </div>

      {/* QR — ใช้ QR จริงของร้าน */}
      <div style={{background:"#fff",borderRadius:"var(--r)",padding:"20px",textAlign:"center",boxShadow:"0 4px 24px rgba(102,57,36,.12)",marginBottom:16,border:"1px solid var(--dv)"}}>
        <p style={{fontSize:13,color:"var(--mu)",marginBottom:12}}>{t.scanQR}</p>
        <img src="/qr-payment.png" alt="PromptPay QR" style={{width:200,height:200,borderRadius:10,border:"1px solid var(--dv)"}} />
        <div style={{marginTop:14,display:"inline-flex",alignItems:"center",gap:8,background:"var(--or-bg)",borderRadius:20,padding:"8px 18px"}}>
          <span style={{fontSize:24,fontWeight:800,color:"var(--or)"}}>฿{finalPrice.toLocaleString()}</span>
          <span style={{fontSize:12,color:"var(--mu)"}}>{t.transfer}</span>
        </div>
        <div style={{marginTop:12,padding:"10px 14px",background:"var(--cr)",borderRadius:10}}>
          <p style={{fontSize:11,color:"var(--mu)"}}>{t.accountName}</p>
          <p style={{fontSize:14,fontWeight:700,color:"var(--br)"}}>{PAYMENT_ACCOUNT_NAME}</p>
          <p style={{fontSize:12,color:"var(--mu)",marginTop:2}}>{PAYMENT_PHONE} (PromptPay)</p>
        </div>
        {discountAmount > 0 && (
          <p style={{fontSize:12,color:"#2d7a4f",marginTop:8}}>🏷 {t.saveDiscount} ฿{discountAmount.toLocaleString()}</p>
        )}
      </div>

      {/* Booking detail */}
      <div className="card" style={{marginBottom:16}}>
        <div className="card-header"><p>{t.bookingDetail}</p></div>
        <div className="card-body">
          <Row label="👤" val={customer.name} />
          <Row label="📞" val={customer.phone} />
          <Row label={`🎾 ${t.court}`} val={court.courtName} />
          <Row label={`📅 ${t.date}`} val={fmtDate(date, lang)} />
          <Row label={`🕐 ${t.time}`} val={slot.label} />
        </div>
      </div>

      {/* Upload slip */}
      <div className="card" style={{marginBottom:16}}>
        <div className="card-header"><p>{t.uploadSlip}</p></div>
        <div className="card-body">
          {uploaded ? (
            <div style={{textAlign:"center",padding:"10px 0"}}>
              <p style={{color:"#2d7a4f",fontWeight:700,fontSize:15}}>{t.slipSent}</p>
              <p style={{color:"var(--mu)",fontSize:13,marginTop:4}}>{t.slipSentDesc}</p>
            </div>
          ) : (
            <>
              {slipPreview && (
                <img src={slipPreview} alt="slip" style={{width:"100%",borderRadius:10,marginBottom:12,maxHeight:200,objectFit:"cover"}} />
              )}
              <input ref={fileRef} type="file" accept="image/*" onChange={handleSlipChange} style={{display:"none"}} />
              <button onClick={() => fileRef.current.click()} style={{width:"100%",padding:"12px",borderRadius:10,border:"1.5px dashed var(--or)",background:"var(--or-bg)",color:"var(--or)",fontWeight:600,fontSize:14,cursor:"pointer",fontFamily:"'Noto Sans Thai',sans-serif"}}>
                {slip ? t.changeSlip : t.selectSlip}
              </button>
              {!slip && <p style={{fontSize:12,color:"var(--mu)",marginTop:8,textAlign:"center"}}>{lang==="th"?`กรุณาเลือกรูปสลิปก่อนกดปุ่ม "ส่งสลิป" ด้านล่าง`:`Please select a slip image before pressing "Send Slip" below`}</p>}
            </>
          )}
        </div>
      </div>

      {/* Steps */}
      <div className="card" style={{marginBottom:24}}>
        <div style={{padding:"11px 18px",borderBottom:"1px solid var(--dv)",background:"var(--bl-bg)"}}>
          <p style={{fontWeight:700,color:"var(--br)",fontSize:14}}>{t.steps}</p>
        </div>
        <div style={{padding:"14px 18px",display:"flex",flexDirection:"column",gap:12}}>
          {t.stepsList.map((s,i) => (
            <div key={i} style={{display:"flex",gap:12,alignItems:"flex-start"}}>
              <div style={{width:24,height:24,borderRadius:"50%",flexShrink:0,background:"var(--br)",color:"var(--or)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:800,marginTop:1}}>{i+1}</div>
              <p style={{fontSize:13.5,color:"var(--mu)",lineHeight:1.65}}>{s}</p>
            </div>
          ))}
        </div>
      </div>

      {uploaded ? (
        <button className="btn-primary" onClick={() => onDone(customer.phone)}>{t.checkMyBooking} →</button>
      ) : (
        <button className="btn-primary" disabled={!slip || uploading} onClick={handleUpload} style={{opacity:(!slip||uploading)?0.6:1,cursor:(!slip||uploading)?"not-allowed":"pointer"}}>
          {uploading ? t.sending : t.sendSlip}
        </button>
      )}
    </div>
  );
}

function StepHead({ n, label }) {
  return (
    <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:13}}>
      <div style={{width:28,height:28,borderRadius:"50%",background:"var(--br)",color:"var(--or)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,fontWeight:800}}>{n}</div>
      <span style={{fontWeight:700,fontSize:16,color:"var(--br)"}}>{label}</span>
    </div>
  );
}

function Row({ label, val }) {
  return (
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:9,gap:12}}>
      <span style={{color:"var(--mu)",fontSize:13,flexShrink:0}}>{label}</span>
      <span style={{fontWeight:600,fontSize:13,color:"var(--tx)",textAlign:"right"}}>{val}</span>
    </div>
  );
}

function Dot({ color, label }) {
  return (
    <div style={{display:"flex",alignItems:"center",gap:6}}>
      <div style={{width:9,height:9,borderRadius:"50%",background:color,flexShrink:0}} />
      <span style={{fontSize:12,color:"var(--mu)"}}>{label}</span>
    </div>
  );
}

// ─── Cancel / Check Booking Page ─────────────────────────────────────────────
function CancelPage({ lang="th", initialPhone="" }) {
  const t = T[lang];
  const [phone, setPhone] = useState(initialPhone);
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [cancelling, setCancelling] = useState(null);
  const [msg, setMsg] = useState("");

  const handleSearch = async (phoneToSearch) => {
    const p = phoneToSearch || phone;
    if (!/^[0-9]{9,10}$/.test(p)) return;
    setLoading(true); setSearched(false); setMsg(""); setBookings([]);
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/bookings?customer_id=eq.${p}&select=*&order=booking_date.desc`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const data = await res.json();
    setBookings(data || []);
    setLoading(false); setSearched(true);
  };

  // ถ้ามาจากหน้าชำระเงินพร้อมเบอร์โทร ให้ค้นหาให้อัตโนมัติทันที
  useEffect(() => {
    if (initialPhone && /^[0-9]{9,10}$/.test(initialPhone)) {
      handleSearch(initialPhone);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPhone]);

  const handleCancel = async (b) => {
    const bookingDate = new Date(b.booking_date + "T" + String(b.hour).padStart(2,"0") + ":00:00");
    const now = new Date();
    const diffHours = (bookingDate - now) / (1000 * 60 * 60);
    if (diffHours < 0) { setMsg(t.cannotCancelPast); return; }
    if (diffHours < 24) { setMsg(t.cannotCancel24h); return; }
    const confirmed = window.confirm(t.confirmCancelPrompt);
    if (!confirmed) return;
    setCancelling(b.id);
    await fetch(`${SUPABASE_URL}/rest/v1/bookings?id=eq.${b.id}`, {
      method: "PATCH",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "cancelled" }),
    });
    setBookings(prev => prev.map(x => x.id === b.id ? { ...x, status: "cancelled" } : x));
    setCancelling(null);
    setMsg(t.cancelSuccess);
  };

  const statusLabel = (s) => {
    if (s === "cancelled") return { text: t.statusCancelled, color: "#c0392b" };
    if (s === "reviewing") return { text: t.statusReviewing, color: "#e67e22" };
    if (s === "confirmed") return { text: t.statusConfirmed, color: "#2d7a4f" };
    return { text: t.statusPending, color: "var(--mu)" };
  };

  return (
    <div style={{padding:"20px 16px 100px"}} className="fu">
      <h2 className="bb" style={{fontSize:28,color:"var(--br)",marginBottom:20}}>{t.myBookings}</h2>
      <div style={{display:"flex",gap:8,marginBottom:20}}>
        <input value={phone} onChange={e => setPhone(e.target.value.replace(/\D/g,"").slice(0,10))}
          placeholder={t.searchPlaceholder} inputMode="numeric"
          style={{flex:1,padding:"13px 14px",borderRadius:10,fontSize:15,background:"#fff",border:"1.5px solid var(--dv)",color:"var(--tx)",outline:"none"}} />
        <button onClick={() => handleSearch()} disabled={loading || phone.length < 9} style={{padding:"0 18px",borderRadius:10,border:"none",background:"var(--br)",color:"var(--or)",fontWeight:700,fontSize:14,cursor:"pointer",fontFamily:"'Noto Sans Thai',sans-serif",whiteSpace:"nowrap"}}>
          {loading ? "..." : t.searchBtn}
        </button>
      </div>

      {msg && (
        <div style={{background:msg.startsWith("✅")?"rgba(45,122,79,.1)":"rgba(192,57,43,.1)",borderRadius:10,padding:"10px 14px",marginBottom:16,border:`1px solid ${msg.startsWith("✅")?"#2d7a4f":"#c0392b"}`}}>
          <p style={{fontSize:13,color:msg.startsWith("✅")?"#2d7a4f":"#c0392b",fontWeight:600}}>{msg}</p>
        </div>
      )}

      {searched && bookings.length === 0 && (
        <div style={{background:"#fff",borderRadius:"var(--r)",padding:"24px",textAlign:"center",border:"1px solid var(--dv)"}}>
          <p style={{color:"var(--mu)"}}>{t.notFound}</p>
        </div>
      )}

      <div style={{display:"flex",flexDirection:"column",gap:12}}>
        {bookings.map(b => {
          const st = statusLabel(b.status);
          const bookingDate = new Date(b.booking_date + "T" + String(b.hour).padStart(2,"0") + ":00:00");
          const isPast = bookingDate < new Date();
          const diffHours = (bookingDate - new Date()) / (1000 * 60 * 60);
          const canCancel = b.status !== "cancelled" && !isPast && diffHours >= 24;
          return (
            <div key={b.id} className="card">
              <div style={{padding:"14px 16px"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                  <span style={{fontWeight:700,color:"var(--br)",fontSize:15}}>Court {b.court_id}</span>
                  <span style={{fontSize:12,fontWeight:600,color:st.color,background:`${st.color}18`,padding:"3px 10px",borderRadius:20}}>{st.text}</span>
                </div>
                <Row label={`📅 ${t.date}`} val={new Date(b.booking_date).toLocaleDateString(lang==="th"?"th-TH":"en-GB",{year:"numeric",month:"long",day:"numeric"})} />
                <Row label={`🕐 ${t.time}`} val={`${String(b.hour).padStart(2,"0")}:00 – ${String(b.hour).padStart(2,"0")}:59`} />
                <Row label={t.rowPrice} val={`฿${b.price?.toLocaleString()}`} />
                {canCancel && (
                  <button onClick={() => handleCancel(b)} disabled={cancelling===b.id} style={{width:"100%",marginTop:10,padding:"11px",borderRadius:10,border:"1.5px solid #c0392b",background:"rgba(192,57,43,.08)",color:"#c0392b",fontWeight:700,fontSize:14,cursor:"pointer",fontFamily:"'Noto Sans Thai',sans-serif"}}>
                    {cancelling===b.id ? t.cancellingBtn : t.cancelBookingBtn}
                  </button>
                )}
                {b.status !== "cancelled" && !isPast && diffHours < 24 && diffHours >= 0 && (
                  <div style={{marginTop:10,padding:"9px 12px",borderRadius:10,background:"rgba(230,126,34,.1)",border:"1px solid #e67e22"}}>
                    <p style={{fontSize:12,color:"#e67e22",fontWeight:600}}>{t.warning24h}</p>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── App V2 with Cancel Tab + Admin ──────────────────────────────────────────
export default function AppV2() {
  const [tab, setTab] = useState("home");
  const [page, setPage] = useState("booking");
  const [booking, setBooking] = useState(null);
  const [customer, setCustomer] = useState(null);
  const [adminLoggedIn, setAdminLoggedIn] = useState(false);
  const [adminMode, setAdminMode] = useState(false);
  const [adminPw, setAdminPw] = useState("");
  const [adminErr, setAdminErr] = useState(false);
  const [logoTaps, setLogoTaps] = useState(0);
  const [lang, setLang] = useState("th");
  const [prefillPhone, setPrefillPhone] = useState("");
  const ADMIN_PW = import.meta.env.VITE_ADMIN_PASSWORD || "nova2024";
  const goTab = (id) => { setTab(id); if(id==="book") setPage("booking"); };

  // กดโลโก้ 5 ครั้งเปิด Admin
  const handleLogoTap = () => {
    const next = logoTaps + 1;
    setLogoTaps(next);
    if (next >= 5) { setAdminMode(true); setLogoTaps(0); }
    setTimeout(() => setLogoTaps(0), 3000);
  };

  // หลังส่งสลิปสำเร็จ พาไปหน้า "การจองของฉัน" พร้อมค้นหาให้อัตโนมัติ
  const handlePaymentDone = (phone) => {
    setBooking(null); setCustomer(null); setPage("booking");
    setPrefillPhone(phone || "");
    setTab("cancel");
  };

  if (adminMode && !adminLoggedIn) return (
    <>
      <style>{CSS}</style>
      <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"linear-gradient(135deg,#663924,#3a1a0a)"}}>
        <div style={{background:"#fff",borderRadius:20,padding:"40px 32px",width:300,textAlign:"center",boxShadow:"0 20px 60px rgba(0,0,0,.3)"}}>
          <NovaLogo width={140} />
          <p style={{fontSize:13,color:"var(--mu)",margin:"12px 0 28px"}}>Admin Dashboard</p>
          <input type="password" value={adminPw} onChange={e=>setAdminPw(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&(adminPw===ADMIN_PW?setAdminLoggedIn(true):(setAdminErr(true),setTimeout(()=>setAdminErr(false),2000)))}
            placeholder="รหัสผ่าน"
            style={{width:"100%",padding:"12px 14px",borderRadius:10,border:`1.5px solid ${adminErr?"#c0392b":"var(--dv)"}`,fontSize:15,marginBottom:12,outline:"none"}} />
          {adminErr && <p style={{color:"#c0392b",fontSize:12,marginBottom:8}}>รหัสผ่านไม่ถูกต้อง</p>}
          <button onClick={()=>adminPw===ADMIN_PW?setAdminLoggedIn(true):(setAdminErr(true),setTimeout(()=>setAdminErr(false),2000))}
            style={{width:"100%",padding:"13px",borderRadius:10,border:"none",background:"#663924",color:"#F47E1F",fontWeight:700,fontSize:15,cursor:"pointer",fontFamily:"'Noto Sans Thai',sans-serif"}}>
            เข้าสู่ระบบ
          </button>
          <button onClick={()=>{setAdminMode(false);setAdminPw("");}}
            style={{marginTop:10,background:"none",border:"none",color:"var(--mu)",fontSize:13,cursor:"pointer",fontFamily:"'Noto Sans Thai',sans-serif"}}>
            ยกเลิก
          </button>
        </div>
      </div>
    </>
  );

  if (adminMode && adminLoggedIn) return (
    <>
      <style>{CSS}</style>
      <AdminDashboard onLogout={()=>{setAdminLoggedIn(false);setAdminMode(false);setAdminPw("");}} />
    </>
  );

  return (
    <>
      <style>{CSS}</style>
      <div style={{maxWidth:480,margin:"0 auto",minHeight:"100dvh",background:"var(--cr)"}}>
        <header style={{position:"sticky",top:0,zIndex:100,backgroundColor:"rgba(249,232,212,0.93)",backdropFilter:"blur(10px)",borderBottom:"1px solid var(--dv)",padding:"8px 20px",display:"flex",alignItems:"center",justifyContent:"space-between",cursor:"pointer"}} onClick={handleLogoTap}>
          <NovaLogo width={90} />
          <div onClick={e=>e.stopPropagation()} style={{display:"flex",gap:4}}>
            {["th","en"].map(l => (
              <button key={l} onClick={()=>setLang(l)} style={{padding:"5px 10px",borderRadius:8,border:"1.5px solid var(--dv)",background:lang===l?"var(--br)":"#fff",color:lang===l?"var(--or)":"var(--mu)",fontWeight:lang===l?700:400,fontSize:12,cursor:"pointer",fontFamily:"'Noto Sans Thai',sans-serif"}}>
                {l==="th"?"🇹🇭 TH":"🇬🇧 EN"}
              </button>
            ))}
          </div>
        </header>
        <main>
          {tab==="home" && <HomePage goBook={() => goTab("book")} lang={lang} />}
          {tab==="book" && page==="booking" && <BookingPage onProceed={b => { setBooking(b); setPage("checkout"); }} lang={lang} />}
          {tab==="book" && page==="checkout" && booking && (
            <CheckoutPage booking={booking} onCancel={() => setPage("booking")} onConfirm={c => { setCustomer(c); setPage("payment"); }} lang={lang} />
          )}
          {tab==="book" && page==="payment" && booking && customer && (
            <PaymentPage booking={booking} customer={customer} onDone={handlePaymentDone} lang={lang} />
          )}
          {tab==="cancel" && <CancelPage lang={lang} initialPhone={prefillPhone} />}
        </main>
        <TabBar tab={tab} setTab={goTab} lang={lang} />
      </div>
    </>
  );
}

// ─── Admin Dashboard (inline) ─────────────────────────────────────────────────
function AdminDashboard({ onLogout }) {
  const [tab, setTab] = useState("bookings");
  const [bookings, setBookings] = useState([]);
  const [discounts, setDiscounts] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [date, setDate] = useState(toIso(new Date()));
  const [newCode, setNewCode] = useState("");
  const [newAmt, setNewAmt] = useState("50");
  const [newMax, setNewMax] = useState("1");

  // รายงานสรุปยอด
  const [reportFrom, setReportFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate()-6);
    return toIso(d);
  });
  const [reportTo, setReportTo] = useState(toIso(new Date()));
  const [reportRows, setReportRows] = useState([]);
  const [reportLoading, setReportLoading] = useState(false);

  const loadBookings = async () => {
    setLoading(true);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/bookings?booking_date=eq.${date}&select=*&order=hour.asc`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
    setBookings(await res.json() || []); setLoading(false);
  };
  const loadDiscounts = async () => {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/discount_codes?select=*&order=created_at.desc`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
    setDiscounts(await res.json() || []);
  };
  const loadCustomers = async () => {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/customers?select=*`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
    setCustomers(await res.json() || []);
  };

  // สรุปยอดโอนเงินรายวัน — นับตามวันที่ "ทำรายการจอง/โอนเงินจริง" (created_time)
  // ไม่ใช่วันที่จองสนามล่วงหน้า (booking_date) เพราะจะทำให้ยอดรายรับต่อวันคลาดเคลื่อน
  const loadReport = async () => {
    setReportLoading(true);
    const fromIso = `${reportFrom}T00:00:00`;
    const toIso2 = `${reportTo}T23:59:59`;
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/bookings?created_time=gte.${fromIso}&created_time=lte.${toIso2}&select=created_time,price,status&order=created_time.asc`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const data = await res.json() || [];
    const map = {};
    data.forEach(b => {
      const day = (b.created_time || "").split("T")[0];
      if (!day) return;
      if (!map[day]) map[day] = { day, confirmedCount: 0, confirmedTotal: 0, otherCount: 0 };
      if (b.status === "confirmed") { map[day].confirmedCount++; map[day].confirmedTotal += (b.price||0); }
      else map[day].otherCount++;
    });
    setReportRows(Object.values(map).sort((a,b)=>a.day.localeCompare(b.day)));
    setReportLoading(false);
  };

  useEffect(() => { loadBookings(); }, [date]);
  useEffect(() => { if(tab==="discounts") loadDiscounts(); if(tab==="customers") loadCustomers(); if(tab==="report") loadReport(); }, [tab]);

  const updateStatus = async (id, status) => {
    const msg = status === "confirmed"
      ? "ยืนยันการจองนี้ใช่หรือไม่? สถานะจะเปลี่ยนเป็น \"การจองสำเร็จ\""
      : "ยกเลิกการจองนี้ใช่หรือไม่? การกระทำนี้ไม่สามารถย้อนกลับได้ และช่วงเวลานี้จะกลับมาให้ลูกค้าจองได้ใหม่";
    const confirmed = window.confirm(msg);
    if (!confirmed) return;
    await fetch(`${SUPABASE_URL}/rest/v1/bookings?id=eq.${id}`, {
      method: "PATCH",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    setBookings(prev => prev.map(b => b.id === id ? { ...b, status } : b));
  };

  const createCode = async () => {
    if (!newCode.trim()) return;
    await fetch(`${SUPABASE_URL}/rest/v1/discount_codes`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ code: newCode.toUpperCase(), discount_amount: parseInt(newAmt), discount_percent: 0, max_uses: parseInt(newMax), active: true }),
    });
    setNewCode(""); loadDiscounts();
  };

  const genCode = () => {
    const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    setNewCode(Array.from({length:8}, () => c[Math.floor(Math.random()*c.length)]).join(""));
  };

  const toggleDiscount = async (id, active) => {
    await fetch(`${SUPABASE_URL}/rest/v1/discount_codes?id=eq.${id}`, {
      method: "PATCH",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ active }),
    });
    loadDiscounts();
  };

  const stInfo = (s) => {
    if(s==="confirmed") return {text:"✅ การจองสำเร็จ", color:"#2d7a4f"};
    if(s==="cancelled") return {text:"❌ การจองถูกยกเลิกแล้ว", color:"#c0392b"};
    if(s==="reviewing") return {text:"🔍 รอการยืนยัน", color:"#e67e22"};
    return {text:"⏳ รอชำระ", color:"var(--mu)"};
  };

  const revenue = bookings.filter(b=>b.status==="confirmed").reduce((s,b)=>s+(b.price||0),0);
  const reportGrandTotal = reportRows.reduce((s,r)=>s+r.confirmedTotal,0);
  const reportGrandCount = reportRows.reduce((s,r)=>s+r.confirmedCount,0);

  const adminCSS = `
    .adm-table { width:100%; border-collapse:collapse; font-size:13px; }
    .adm-table th { background:#663924; color:#F47E1F; padding:9px 12px; text-align:left; }
    .adm-table td { padding:9px 12px; border-bottom:1px solid rgba(102,57,36,.1); }
    .adm-table tr:hover td { background:rgba(244,126,31,.04); }
  `;

  return (
    <>
      <style>{adminCSS}</style>
      <div style={{minHeight:"100vh",background:"#f5f5f5"}}>
        <header style={{background:"var(--br)",padding:"12px 20px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div>
            <p className="bb" style={{fontSize:22,color:"var(--or)",lineHeight:1}}>NOVA TENNIS</p>
            <p style={{fontSize:11,color:"rgba(255,255,255,.5)"}}>Admin Dashboard</p>
          </div>
          <button onClick={onLogout} style={{background:"rgba(255,255,255,.1)",border:"none",color:"rgba(255,255,255,.7)",padding:"7px 14px",borderRadius:8,fontSize:13,cursor:"pointer",fontFamily:"'Noto Sans Thai',sans-serif"}}>
            ออกจากระบบ
          </button>
        </header>

        <div style={{background:"#fff",borderBottom:"1px solid var(--dv)",display:"flex",padding:"0 20px",overflowX:"auto"}}>
          {[["bookings","📋 การจอง"],["report","📊 รายงาน"],["discounts","🏷 ส่วนลด"],["customers","👥 ลูกค้า"]].map(([id,label]) => (
            <button key={id} onClick={() => setTab(id)} style={{padding:"13px 16px",background:"none",border:"none",borderBottom:tab===id?"2.5px solid var(--or)":"2.5px solid transparent",color:tab===id?"var(--or)":"var(--mu)",fontWeight:tab===id?700:400,fontSize:14,cursor:"pointer",fontFamily:"'Noto Sans Thai',sans-serif",whiteSpace:"nowrap"}}>
              {label}
            </button>
          ))}
        </div>

        <div style={{padding:"20px",maxWidth:1000,margin:"0 auto"}}>
          {tab==="bookings" && (
            <div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:20}}>
                {[
                  {label:"ทั้งหมด",val:bookings.length,color:"var(--br)"},
                  {label:"การจองสำเร็จ",val:bookings.filter(b=>b.status==="confirmed").length,color:"#2d7a4f"},
                  {label:"รอดำเนินการ",val:bookings.filter(b=>b.status==="reviewing"||b.status==="pending").length,color:"#e67e22"},
                  {label:"รายได้วันนี้",val:`฿${revenue.toLocaleString()}`,color:"var(--or)"},
                ].map(({label,val,color}) => (
                  <div key={label} style={{background:"#fff",borderRadius:12,padding:"14px",textAlign:"center",border:"1px solid var(--dv)",boxShadow:"var(--sh)"}}>
                    <p style={{fontSize:11,color:"var(--mu)",marginBottom:4}}>{label}</p>
                    <p style={{fontSize:20,fontWeight:800,color}}>{val}</p>
                  </div>
                ))}
              </div>
              <div style={{display:"flex",gap:10,marginBottom:16}}>
                <input type="date" value={date} onChange={e=>setDate(e.target.value)}
                  style={{padding:"9px 12px",borderRadius:8,border:"1.5px solid var(--dv)",fontSize:14,outline:"none"}} />
                <button onClick={loadBookings} style={{padding:"9px 16px",borderRadius:8,border:"none",background:"var(--br)",color:"var(--or)",fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:"'Noto Sans Thai',sans-serif"}}>🔄 รีเฟรช</button>
              </div>
              <div style={{background:"#fff",borderRadius:12,border:"1px solid var(--dv)",overflow:"auto",boxShadow:"var(--sh)"}}>
                {loading ? <p style={{padding:24,textAlign:"center",color:"var(--mu)"}}>⏳ กำลังโหลด...</p> :
                bookings.length === 0 ? <p style={{padding:24,textAlign:"center",color:"var(--mu)"}}>ไม่มีการจองในวันนี้</p> : (
                  <table className="adm-table">
                    <thead><tr><th>สนาม</th><th>เวลา</th><th>เบอร์</th><th>ราคา</th><th>สลิป</th><th>สถานะ</th><th>จัดการ</th></tr></thead>
                    <tbody>
                      {bookings.map(b => {
                        const st = stInfo(b.status);
                        return (
                          <tr key={b.id}>
                            <td style={{fontWeight:700}}>Court {b.court_id}</td>
                            <td>{String(b.hour).padStart(2,"0")}:00</td>
                            <td>{b.customer_id}</td>
                            <td style={{fontWeight:700,color:"var(--or)"}}>฿{b.price?.toLocaleString()}</td>
                            <td>{b.slip_url ? <a href={b.slip_url} target="_blank" rel="noreferrer" style={{color:"var(--bl)",fontWeight:600}}>ดูสลิป 🔗</a> : <span style={{color:"var(--mu)"}}>-</span>}</td>
                            <td><span style={{fontSize:12,fontWeight:600,color:st.color,background:`${st.color}18`,padding:"3px 8px",borderRadius:20}}>{st.text}</span></td>
                            <td>
                              {b.status!=="cancelled" && (
                                <div style={{display:"flex",gap:6}}>
                                  {b.status!=="confirmed" && <button onClick={()=>updateStatus(b.id,"confirmed")} style={{padding:"5px 10px",borderRadius:6,border:"none",background:"rgba(45,122,79,.15)",color:"#2d7a4f",fontWeight:700,fontSize:12,cursor:"pointer"}}>✅</button>}
                                  <button onClick={()=>updateStatus(b.id,"cancelled")} style={{padding:"5px 10px",borderRadius:6,border:"none",background:"rgba(192,57,43,.1)",color:"#c0392b",fontWeight:700,fontSize:12,cursor:"pointer"}}>❌</button>
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
          )}

          {tab==="report" && (
            <div>
              <div style={{background:"#fff",borderRadius:12,padding:20,marginBottom:20,border:"1px solid var(--dv)",boxShadow:"var(--sh)"}}>
                <p style={{fontWeight:700,color:"var(--br)",marginBottom:6}}>📊 รายงานสรุปรายรับต่อวัน</p>
                <p style={{fontSize:12,color:"var(--mu)",marginBottom:14}}>นับตามวันที่ลูกค้าทำรายการโอนเงินจริง (ไม่ใช่วันที่จองล่วงหน้า) — รวมเฉพาะรายการที่สถานะ "การจองสำเร็จ"</p>
                <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
                  <div>
                    <label style={{fontSize:12,color:"var(--mu)",display:"block",marginBottom:4}}>จากวันที่</label>
                    <input type="date" value={reportFrom} onChange={e=>setReportFrom(e.target.value)}
                      style={{padding:"9px 12px",borderRadius:8,border:"1.5px solid var(--dv)",fontSize:14,outline:"none"}} />
                  </div>
                  <div>
                    <label style={{fontSize:12,color:"var(--mu)",display:"block",marginBottom:4}}>ถึงวันที่</label>
                    <input type="date" value={reportTo} onChange={e=>setReportTo(e.target.value)}
                      style={{padding:"9px 12px",borderRadius:8,border:"1.5px solid var(--dv)",fontSize:14,outline:"none"}} />
                  </div>
                  <button onClick={loadReport} style={{marginTop:18,padding:"9px 16px",borderRadius:8,border:"none",background:"var(--br)",color:"var(--or)",fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:"'Noto Sans Thai',sans-serif"}}>🔄 ดึงรายงาน</button>
                </div>
              </div>

              <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:12,marginBottom:20}}>
                <div style={{background:"#fff",borderRadius:12,padding:"14px",textAlign:"center",border:"1px solid var(--dv)",boxShadow:"var(--sh)"}}>
                  <p style={{fontSize:11,color:"var(--mu)",marginBottom:4}}>จำนวนรายการที่สำเร็จ (ช่วงที่เลือก)</p>
                  <p style={{fontSize:22,fontWeight:800,color:"var(--br)"}}>{reportGrandCount}</p>
                </div>
                <div style={{background:"#fff",borderRadius:12,padding:"14px",textAlign:"center",border:"1px solid var(--dv)",boxShadow:"var(--sh)"}}>
                  <p style={{fontSize:11,color:"var(--mu)",marginBottom:4}}>รายรับรวม (ช่วงที่เลือก)</p>
                  <p style={{fontSize:22,fontWeight:800,color:"var(--or)"}}>฿{reportGrandTotal.toLocaleString()}</p>
                </div>
              </div>

              <div style={{background:"#fff",borderRadius:12,border:"1px solid var(--dv)",overflow:"auto",boxShadow:"var(--sh)"}}>
                {reportLoading ? <p style={{padding:24,textAlign:"center",color:"var(--mu)"}}>⏳ กำลังโหลด...</p> :
                reportRows.length === 0 ? <p style={{padding:24,textAlign:"center",color:"var(--mu)"}}>ไม่มีข้อมูลในช่วงวันที่เลือก</p> : (
                  <table className="adm-table">
                    <thead><tr><th>วันที่</th><th>รายการสำเร็จ</th><th>รายรับ</th><th>รายการอื่นๆ (รอ/ยกเลิก)</th></tr></thead>
                    <tbody>
                      {reportRows.map(r => (
                        <tr key={r.day}>
                          <td style={{fontWeight:700}}>{new Date(r.day).toLocaleDateString("th-TH",{year:"numeric",month:"short",day:"numeric"})}</td>
                          <td>{r.confirmedCount}</td>
                          <td style={{fontWeight:700,color:"var(--or)"}}>฿{r.confirmedTotal.toLocaleString()}</td>
                          <td style={{color:"var(--mu)"}}>{r.otherCount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}

          {tab==="discounts" && (
            <div>
              <div style={{background:"#fff",borderRadius:12,padding:20,marginBottom:20,border:"1px solid var(--dv)",boxShadow:"var(--sh)"}}>
                <p style={{fontWeight:700,color:"var(--br)",marginBottom:14}}>➕ สร้างรหัสส่วนลดใหม่</p>
                <div style={{display:"grid",gridTemplateColumns:"1fr auto",gap:8,marginBottom:10}}>
                  <input value={newCode} onChange={e=>setNewCode(e.target.value.toUpperCase())} placeholder="รหัส เช่น NOVA50"
                    style={{padding:"10px 12px",borderRadius:8,border:"1.5px solid var(--dv)",fontSize:14,outline:"none"}} />
                  <button onClick={genCode} style={{padding:"0 14px",borderRadius:8,border:"1.5px solid var(--dv)",background:"#fff",color:"var(--mu)",fontSize:13,cursor:"pointer"}}>🎲 สุ่ม</button>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:14}}>
                  <div>
                    <label style={{fontSize:12,color:"var(--mu)",display:"block",marginBottom:5}}>ส่วนลด (บาท)</label>
                    <input type="number" value={newAmt} onChange={e=>setNewAmt(e.target.value)} min="1"
                      style={{width:"100%",padding:"10px 12px",borderRadius:8,border:"1.5px solid var(--dv)",fontSize:14,outline:"none"}} />
                  </div>
                  <div>
                    <label style={{fontSize:12,color:"var(--mu)",display:"block",marginBottom:5}}>ใช้ได้กี่ครั้ง</label>
                    <input type="number" value={newMax} onChange={e=>setNewMax(e.target.value)} min="1"
                      style={{width:"100%",padding:"10px 12px",borderRadius:8,border:"1.5px solid var(--dv)",fontSize:14,outline:"none"}} />
                  </div>
                </div>
                <button onClick={createCode} disabled={!newCode.trim()} style={{width:"100%",padding:"12px",borderRadius:8,border:"none",background:"var(--br)",color:"var(--or)",fontWeight:700,fontSize:14,cursor:"pointer",fontFamily:"'Noto Sans Thai',sans-serif"}}>
                  สร้างรหัส
                </button>
              </div>
              <div style={{background:"#fff",borderRadius:12,border:"1px solid var(--dv)",overflow:"auto",boxShadow:"var(--sh)"}}>
                <table className="adm-table">
                  <thead><tr><th>รหัส</th><th>ส่วนลด</th><th>ใช้แล้ว/ทั้งหมด</th><th>สถานะ</th><th>จัดการ</th></tr></thead>
                  <tbody>
                    {discounts.map(c => (
                      <tr key={c.id}>
                        <td style={{fontWeight:700,fontFamily:"monospace"}}>{c.code}</td>
                        <td style={{fontWeight:700,color:"var(--or)"}}>฿{c.discount_amount||`${c.discount_percent}%`}</td>
                        <td>{c.used_count}/{c.max_uses}</td>
                        <td><span style={{fontSize:12,fontWeight:600,color:c.active?"#2d7a4f":"#c0392b",background:c.active?"rgba(45,122,79,.1)":"rgba(192,57,43,.1)",padding:"3px 8px",borderRadius:20}}>{c.active?"ใช้งานได้":"ปิดใช้งาน"}</span></td>
                        <td><button onClick={()=>toggleDiscount(c.id,!c.active)} style={{padding:"5px 10px",borderRadius:6,border:"none",background:c.active?"rgba(192,57,43,.1)":"rgba(45,122,79,.1)",color:c.active?"#c0392b":"#2d7a4f",fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:"'Noto Sans Thai',sans-serif"}}>{c.active?"ปิด":"เปิด"}</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {tab==="customers" && (
            <div style={{background:"#fff",borderRadius:12,border:"1px solid var(--dv)",overflow:"auto",boxShadow:"var(--sh)"}}>
              <table className="adm-table">
                <thead><tr><th>#</th><th>ชื่อ</th><th>เบอร์โทร</th></tr></thead>
                <tbody>
                  {customers.map((c,i) => (
                    <tr key={c.customer_id}>
                      <td style={{color:"var(--mu)"}}>{i+1}</td>
                      <td style={{fontWeight:600}}>{c.customer_name}</td>
                      <td style={{fontFamily:"monospace"}}>{c.customer_id}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

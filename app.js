'use strict';
/* שעון עבודה — דיווח שעות לעובד שעתי. כל המידע נשמר מקומית בטלפון (localStorage). */

// ---------- State ----------
const KEY = 'wh.v1';
const DEF_SETTINGS = {
  rate: 60.89,          // ₪ לשעה
  maxDaily: 480,        // דקות (8 שעות)
  deadlineDay: 15,      // יום בחודש שעד אליו מדווחים
  workdays: [0, 1, 2, 3, 4], // א'-ה'
  defStart: '08:00',
  defEnd: '16:00',
  round: 5,             // יחידת עיגול בדקות לפיזור שעות
  theme: 'auto',
  vacQuota: 12,         // ימי חופש בשנה
  vacExtra: {},         // { 'YYYY': ימים } — יתרה שהועברה / תיקון ידני לשנה מסוימת
};
const TYPES = {
  work: { label: 'עבודה', icon: '💼' },
  vacation: { label: 'חופש', icon: '🏖️' },
  sick: { label: 'מחלה', icon: '🤒' },
  holiday: { label: 'חג', icon: '🕎' },
};
const WEEKDAYS = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
const MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

let S = load();
let undoSnap = null;
let viewMonth = null; // נקבע בהפעלה

function blank() { return { v: 1, settings: { ...DEF_SETTINGS }, days: {}, months: {}, active: null }; }
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && s.days) { s.settings = { ...DEF_SETTINGS, ...s.settings }; s.months = s.months || {}; return s; }
  } catch (e) { /* ignore */ }
  return blank();
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { toast('שגיאה בשמירה'); } }
function snapshot() { undoSnap = JSON.stringify(S); }
function undo() { if (!undoSnap) return; S = JSON.parse(undoSnap); undoSnap = null; save(); render(); toast('הפעולה בוטלה'); }

// ---------- Time helpers ----------
const pad = n => String(n).padStart(2, '0');
function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function todayKey() { return ymd(new Date()); }
function parseKey(k) { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); }
function monthKey(k) { return k.slice(0, 7); }
function addMonths(mk, n) { const [y, m] = mk.split('-').map(Number); const d = new Date(y, m - 1 + n, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; }
function monthDays(mk) {
  const [y, m] = mk.split('-').map(Number); const n = new Date(y, m, 0).getDate();
  return Array.from({ length: n }, (_, i) => `${mk}-${pad(i + 1)}`);
}
function monthLabel(mk) { const [y, m] = mk.split('-').map(Number); return `${MONTHS[m - 1]} ${y}`; }
function nowHM() { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function toMin(hm) { const [h, m] = hm.split(':').map(Number); return h * 60 + m; }
function fromMin(m) { m = ((Math.round(m) % 1440) + 1440) % 1440; return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; }
function dur(s, e) { return (toMin(e) - toMin(s) + 1440) % 1440; }
function fmtH(min, signed) {
  const sign = min < 0 ? '-' : (signed && min > 0 ? '+' : '');
  const a = Math.abs(Math.round(min));
  const v = `${sign}${Math.floor(a / 60)}:${pad(a % 60)}`;
  return sign ? `\u2066${v}\u2069` : v; // בידוד LTR כדי שהסימן יופיע במקום הנכון בעברית
}
const fmtMoney = n => '₪' + n.toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dec = min => Math.round(min / 60 * 100) / 100;
function dayLabel(k) { const d = parseKey(k); return `${WEEKDAYS[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1}`; }
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- Domain ----------
function newDay() { return { type: 'work', sessions: [], rep: null, repManual: false, shift: 0, note: '' }; }
function ensureDay(k) { return S.days[k] || (S.days[k] = newDay()); }
function monthMeta(mk) { return S.months[mk] || (S.months[mk] = { submittedAt: null, carryApplied: 0, openingAdj: 0 }); }
function isSubmitted(mk) { return !!(S.months[mk] && S.months[mk].submittedAt); }
function actualMin(d) { return d ? d.sessions.filter(s => s.out).reduce((a, s) => a + dur(s.in, s.out), 0) : 0; }
function repMin(d) { return d && d.rep ? dur(d.rep.s, d.rep.e) : 0; }
function liveMin(k) { return S.active && S.active.date === k ? dur(S.active.in, nowHM()) : 0; }

/**
 * הדיווח (rep) הוא טווח אחד התחלה–סוף שנשלח למערכת החיצונית.
 * כל עוד החודש לא "דווח" והיום לא נערך ידנית, הדיווח נגזר אוטומטית מהשעות בפועל
 * (+shift = דקות שהועברו אליו/ממנו בכוונה). אחרי הגשה הדיווח קפוא, וכל שינוי בפועל
 * מופיע כ"פער" (drift) שמועבר לחודש הבא.
 */
function sync(k) {
  const d = S.days[k]; if (!d) return;
  d.sessions.sort((a, b) => toMin(a.in) - toMin(b.in));
  if (d.repManual || isSubmitted(monthKey(k))) return;
  const done = d.sessions.filter(s => s.out);
  if (d.type === 'work' && done.length) {
    const start = done[0].in;
    d.rep = { s: start, e: fromMin(toMin(start) + actualMin(d) + (d.shift || 0)) };
  } else if (!d.shift) {
    d.rep = null;
  }
}

function applyDelta(k, delta) {
  const d = ensureDay(k);
  d.shift = (d.shift || 0) + delta;
  const done = d.sessions.filter(s => s.out);
  if (!d.repManual && done.length && !isSubmitted(monthKey(k))) { sync(k); return; }
  if (!d.rep) d.rep = { s: S.settings.defStart, e: S.settings.defStart };
  d.rep.e = fromMin(toMin(d.rep.e) + delta);
  d.repManual = true;
}

function dayInfo(k) {
  const t = todayKey(), d = S.days[k], dt = parseKey(k);
  const max = S.settings.maxDaily;
  const info = {
    k, d, today: k === t, future: k > t, past: k < t,
    isWorkday: S.settings.workdays.includes(dt.getDay()),
    actual: 0, rep: 0, drift: 0, flags: [], cls: 'empty', type: d ? d.type : null,
  };
  if (!d) { if (info.past && info.isWorkday) info.flags.push('missing'); return info; }
  const active = S.active && S.active.date === k;
  info.actual = actualMin(d); info.rep = repMin(d); info.live = liveMin(k);
  const settled = info.past || (info.today && !active && (d.sessions.length > 0 || d.type !== 'work'));
  if (settled) info.drift = info.actual + (d.shift || 0) - info.rep;
  if (active) info.flags.push('active');
  if (d.type !== 'work') info.flags.push(d.type);
  if (info.actual > max) info.flags.push('over');
  if (info.rep > max) info.flags.push('repOver');
  if (info.drift > 0) info.flags.push('surplus');
  if (info.drift < 0) info.flags.push('deficit');
  if (!settled && !active && info.rep > 0) info.flags.push('planned');
  if (d.shift > 0) info.flags.push('shiftIn');
  if (d.shift < 0) info.flags.push('shiftOut');
  const f = new Set(info.flags);
  info.cls = f.has('active') ? 'active' : f.has('repOver') ? 'warn' : f.has('deficit') ? 'deficit'
    : f.has('surplus') ? 'surplus' : d.type !== 'work' ? d.type : f.has('planned') ? 'planned'
    : (info.actual || info.rep) ? 'ok' : 'empty';
  return info;
}

// Vacation is paid at a regular day's length (settings start→end); sick days are counted but unpaid.
function vacDayMin() { return dur(S.settings.defStart, S.settings.defEnd); }
// Yearly vacation balance by calendar year. Future vacation days already marked count as used (planned leave).
function vacYear(y) {
  const used = Object.entries(S.days).filter(([k, d]) => k.startsWith(y + '-') && d.type === 'vacation').length;
  const total = (+S.settings.vacQuota || 0) + (+(S.settings.vacExtra || {})[y] || 0);
  return { y, used, total, left: total - used };
}

function monthStats(mk) {
  const st = { actual: 0, rep: 0, workDays: 0, repDays: 0, vacation: 0, sick: 0, holiday: 0, over: 0, repOver: 0,
    drift: 0, driftDays: 0, planned: 0, remainingWorkdays: 0, missing: 0, live: 0 };
  for (const k of monthDays(mk)) {
    const i = dayInfo(k);
    st.actual += i.actual; st.rep += i.rep; st.live += i.live || 0;
    if (i.actual > 0) st.workDays++;
    if (i.rep > 0) st.repDays++;
    if (i.type && i.type !== 'work') st[i.type]++;
    if (i.flags.includes('over')) st.over++;
    if (i.flags.includes('repOver')) st.repOver++;
    if (i.drift) { st.drift += i.drift; st.driftDays++; }
    if (i.flags.includes('planned')) st.planned += i.rep;
    if (i.flags.includes('missing')) st.missing++;
    if ((i.future || (i.today && !i.actual)) && i.isWorkday && (!i.type || i.type === 'work')) st.remainingWorkdays++;
  }
  st.vacPay = st.vacation * vacDayMin() / 60 * S.settings.rate;
  st.salaryActual = (st.actual + st.live) / 60 * S.settings.rate + st.vacPay;
  st.salaryRep = st.rep / 60 * S.settings.rate + st.vacPay;
  st.vacYear = vacYear(mk.slice(0, 4));
  st.avg = st.workDays ? st.actual / st.workDays : 0;
  st.carryIn = carryIn(mk);
  st.carryApplied = (S.months[mk] && S.months[mk].carryApplied) || 0;
  st.carryRemaining = st.carryIn - st.carryApplied;
  st.balance = st.drift + st.carryRemaining; // מה שיעבור לחודש הבא
  return st;
}

function earliestMonth() {
  const keys = Object.keys(S.days).map(monthKey).concat(Object.keys(S.months));
  return keys.length ? keys.sort()[0] : monthKey(todayKey());
}
/** יתרה שמגיעה לחודש mk מהחודש הקודם (חיובי = עבדת יותר ממה שדיווחת → להוסיף לדיווח). */
function carryIn(mk) {
  const adj = (S.months[mk] && S.months[mk].openingAdj) || 0;
  const prev = addMonths(mk, -1);
  if (prev < earliestMonth()) return adj;
  let drift = 0;
  for (const k of monthDays(prev)) drift += dayInfo(k).drift;
  const prevApplied = (S.months[prev] && S.months[prev].carryApplied) || 0;
  return adj + drift + (carryIn(prev) - prevApplied);
}

/** חלוקה יחסית של total בין יעדים לפי קיבולת, ביחידות של unit דקות. */
function allocate(total, targets, unit) {
  const out = {}; targets.forEach(t => out[t.k] = 0);
  const caps = targets.filter(t => t.cap > 0);
  const capSum = caps.reduce((a, t) => a + t.cap, 0);
  if (!capSum || total <= 0) return { alloc: out, left: Math.max(0, total) };
  const T = Math.min(total, capSum);
  const fr = [];
  let used = 0;
  for (const t of caps) {
    const raw = T * t.cap / capSum;
    let b = Math.floor(raw / unit) * unit;
    b = Math.min(b, Math.floor(t.cap / unit) * unit);
    out[t.k] = b; used += b; fr.push({ t, f: raw - b });
  }
  fr.sort((a, b) => b.f - a.f);
  let rem = T - used;
  for (let pass = 0; pass < 3 && rem > 0; pass++) {
    for (const { t } of fr) {
      if (rem <= 0) break;
      const step = Math.min(rem >= unit ? unit : rem, t.cap - out[t.k]);
      if (step > 0) { out[t.k] += step; rem -= step; }
    }
  }
  return { alloc: out, left: total - (T - rem) };
}

// ---------- Actions ----------
function clockIn() {
  if (S.active) return;
  snapshot();
  const k = todayKey(); const d = ensureDay(k);
  if (d.type !== 'work') d.type = 'work';
  S.active = { date: k, in: nowHM() };
  save(); render(); toast(`נרשמה הגעה ב-${S.active.in}`, true);
}
function clockOut(outTime) {
  if (!S.active) return;
  snapshot();
  const a = S.active; const d = ensureDay(a.date);
  const out = outTime || nowHM();
  if (dur(a.in, out) === 0) { S.active = null; save(); render(); toast('הכניסה בוטלה (לחיצה כפולה)'); return; }
  d.sessions.push({ in: a.in, out });
  S.active = null; sync(a.date); save(); render();
  toast(`נרשמה יציאה ב-${out} · ${fmtH(dur(a.in, out))} שעות`, true);
}
function setType(k, type) {
  snapshot();
  const d = ensureDay(k); d.type = type;
  if (S.active && S.active.date === k && type !== 'work') S.active = null;
  sync(k); save(); render(); toast(`${dayLabel(k)} סומן כ${TYPES[type].label}`, true);
}

// ---------- Rendering ----------
const $ = sel => document.querySelector(sel);
const view = () => $('#view');
let timerHandle = null;

function render() {
  const tab = (location.hash || '#home').slice(1).split('/')[0];
  document.querySelectorAll('.tabbar a').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
  const t = new Date();
  $('#topdate').textContent = `${WEEKDAYS[t.getDay()]}, ${t.getDate()} ב${MONTHS[t.getMonth()]}`;
  clearInterval(timerHandle);
  document.documentElement.dataset.theme = S.settings.theme === 'auto' ? '' : S.settings.theme;
  if (!document.documentElement.dataset.theme) delete document.documentElement.dataset.theme;
  ({ home: renderHome, sheet: renderSheet, finish: renderFinish, settings: renderSettings }[tab] || renderHome)();
}

function statsHTML(st, compact) {
  const items = [
    ['שעות בפועל', fmtH(st.actual + st.live)],
    ['ימי עבודה', st.workDays],
    ['שכר בפועל', fmtMoney(st.salaryActual)],
    [`יתרת חופש ${st.vacYear.y || ''}`.trim(), `${st.vacYear.left} מתוך ${st.vacYear.total}`, st.vacYear.left < 0 ? 'neg' : ''],
  ];
  if (!compact) items.push(
    ['שעות מדווחות', fmtH(st.rep)],
    ['שכר לפי דיווח', fmtMoney(st.salaryRep)],
    ['ממוצע ליום', fmtH(st.avg)],
    ['ימי חופש (בתשלום)', st.vacation],
    ['שכר חופשה', fmtMoney(st.vacPay)],
    ['ימי מחלה (ללא תשלום)', st.sick],
    ['ימים מעל ' + fmtH(S.settings.maxDaily), st.over],
    ['שעות עתידיות שדווחו', fmtH(st.planned)],
    ['ימי עבודה שנותרו', st.remainingWorkdays],
    ['פער בפועל↔דיווח', fmtH(st.drift, true), st.drift > 0 ? 'pos' : st.drift < 0 ? 'neg' : ''],
    ['יתרה מחודש קודם', fmtH(st.carryRemaining, true), st.carryRemaining > 0 ? 'pos' : st.carryRemaining < 0 ? 'neg' : ''],
  );
  return `<div class="stats">${items.map(([l, v, c]) => `<div class="stat ${c || ''}"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('')}</div>`;
}

function alertsHTML(mk) {
  const t = todayKey(); const out = [];
  if (S.active && S.active.date !== t) {
    out.push(`<div class="alert bad"><span>⏰</span><div class="grow">שכחת לסמן יציאה ב-${dayLabel(S.active.date)} (נכנסת ב-${S.active.in}).
      <div><button class="linkbtn" data-act="fix-forgot">הזן שעת יציאה</button></div></div></div>`);
  }
  const st = monthStats(mk);
  const dd = S.settings.deadlineDay; const todayD = parseKey(t).getDate();
  if (!isSubmitted(mk)) {
    const left = dd - todayD;
    if (left >= 0 && left <= 5) out.push(`<div class="alert warn"><span>📅</span><div class="grow">${left === 0 ? 'היום' : `בעוד ${left} ימים`} (${dd}/${parseKey(t).getMonth() + 1}) צריך להגיש את דוח השעות.
      <div><a class="linkbtn" href="#finish">לסיום דיווח ←</a></div></div></div>`);
    else if (left < 0) out.push(`<div class="alert bad"><span>📅</span><div class="grow">עבר מועד הדיווח (${dd} לחודש) והחודש עדיין לא סומן כ"דווח".
      <div><a class="linkbtn" href="#finish">לסיום דיווח ←</a></div></div></div>`);
  } else if (st.driftDays) {
    out.push(`<div class="alert info"><span>↕️</span><div class="grow">מאז ההגשה יש ${st.driftDays} ימים שבהם בפועל ≠ דיווח (סה״כ <b>${fmtH(st.drift, true)}</b>). זה יועבר לחודש הבא.
      <div><a class="linkbtn" href="#sheet">לגיליון ←</a></div></div></div>`);
  }
  if (st.carryRemaining) {
    out.push(`<div class="alert ${st.carryRemaining > 0 ? 'info' : 'bad'}"><span>↪️</span><div class="grow">יתרה מהחודש הקודם: <b>${fmtH(st.carryRemaining, true)}</b> —
      ${st.carryRemaining > 0 ? 'עבדת יותר ממה שדיווחת, צריך להוסיף לדיווח החודש.' : 'דיווחת יותר ממה שעבדת, צריך להשלים/להוריד החודש.'}
      <div><a class="linkbtn" href="#finish">לטיפול ←</a></div></div></div>`);
  }
  return out.join('');
}

function renderHome() {
  const k = todayKey(); const mk = monthKey(k);
  const d = S.days[k]; const info = dayInfo(k);
  const active = S.active && S.active.date === k;
  const st = monthStats(mk);
  const sess = d ? d.sessions : [];
  const offToday = d && d.type !== 'work';
  view().innerHTML = `
    ${alertsHTML(mk)}
    <div class="card">
      <div class="clock-wrap">
        ${offToday ? `<div class="alert good" style="width:100%"><span>${TYPES[d.type].icon}</span><div class="grow">היום מסומן כ<b>${TYPES[d.type].label}</b>
          <div><button class="linkbtn" data-act="type-work">בטל — חזרה ליום עבודה</button></div></div></div>` : ''}
        <button id="clockBtn" class="clock-btn ${active ? 'out' : ''}" data-act="${active ? 'out' : 'in'}">
          <span class="ico">${active ? '🏁' : '👋'}</span>
          ${active ? 'יצאתי מהעבודה' : 'הגעתי לעבודה'}
          <span class="sub">${active ? `מאז ${S.active.in}` : nowHM()}</span>
        </button>
        <div class="timer" id="timer"></div>
      </div>
      <div class="row spread small muted" style="margin-top:8px">
        <span>היום: ${sess.filter(s => s.out).map(s => `${s.in}–${s.out}`).join(', ') || 'אין רישומים'}</span>
        <span>סה״כ ${fmtH(info.actual + (info.live || 0))}</span>
      </div>
      ${info.rep && !active ? `<div class="small muted">דווח: ${d.rep.s}–${d.rep.e} (${fmtH(info.rep)})</div>` : ''}
    </div>

    <div class="quick" style="margin-bottom:12px">
      <button class="qbtn" data-act="vacation"><span>🏖️</span>יום חופש</button>
      <button class="qbtn" data-act="sick"><span>🤒</span>מחלה</button>
      <button class="qbtn" data-act="edit-today"><span>✏️</span>עריכת היום</button>
      <button class="qbtn" data-act="add-day"><span>➕</span>הוספת יום</button>
      <a class="qbtn" href="#finish" style="text-decoration:none;color:inherit"><span>✅</span>סיום דיווח</a>
      <button class="qbtn" data-act="undo" ${undoSnap ? '' : 'disabled'}><span>↩️</span>ביטול פעולה</button>
    </div>

    <div class="card">
      <div class="row spread"><h2>${monthLabel(mk)} עד כה</h2><a class="linkbtn" href="#sheet">לגיליון ←</a></div>
      ${statsHTML(st, true)}
      ${st.repOver ? `<div class="alert warn" style="margin:10px 0 0"><span>🔺</span><div class="grow">${st.repOver} ימים מדווחים מעל ${fmtH(S.settings.maxDaily)} — יש לפזר אותם בסיום הדיווח.</div></div>` : ''}
    </div>`;
  const tick = () => {
    const el = $('#timer'); if (!el) return;
    if (S.active && S.active.date === todayKey()) {
      const m = dur(S.active.in, nowHM());
      const left = S.settings.maxDaily - info.actual - m;
      el.innerHTML = `⏱️ ${fmtH(m)} בסשן הנוכחי · ${left > 0 ? `עוד ${fmtH(left)} עד ${fmtH(S.settings.maxDaily)}` : `<b style="color:var(--warn)">חרגת ב-${fmtH(-left)}</b>`}`;
    } else el.textContent = '';
  };
  tick(); timerHandle = setInterval(tick, 15000);
}

function badgesHTML(i) {
  const b = []; const f = new Set(i.flags); const d = i.d;
  if (f.has('active')) b.push(`<span class="badge b-active">⏳ בעבודה</span>`);
  if (f.has('vacation')) b.push(`<span class="badge b-off">🏖️ חופש</span>`);
  if (f.has('holiday')) b.push(`<span class="badge b-off">🕎 חג</span>`);
  if (f.has('sick')) b.push(`<span class="badge b-sick">🤒 מחלה</span>`);
  if (f.has('repOver')) b.push(`<span class="badge b-warn">🔺 דיווח מעל ${fmtH(S.settings.maxDaily)}</span>`);
  else if (f.has('over')) b.push(`<span class="badge b-warn">🔺 בפועל ${fmtH(i.actual)}</span>`);
  if (f.has('surplus')) b.push(`<span class="badge b-surplus">⬆️ עבדת ${fmtH(i.drift)} יותר מהדיווח</span>`);
  if (f.has('deficit')) b.push(`<span class="badge b-deficit">⬇️ חסר ${fmtH(-i.drift)} מול הדיווח</span>`);
  if (f.has('planned')) b.push(`<span class="badge b-planned">🕒 עתידי</span>`);
  if (f.has('shiftIn')) b.push(`<span class="badge b-shift">↪️ קיבל ${fmtH(d.shift)}</span>`);
  if (f.has('shiftOut')) b.push(`<span class="badge b-shift">↩️ הועברו ${fmtH(-d.shift)}</span>`);
  if (f.has('missing')) b.push(`<span class="badge b-planned">— לא הוזן</span>`);
  if (d && d.note) b.push(`<span class="badge b-planned">📝 ${esc(d.note)}</span>`);
  return b.length ? `<div class="badges">${b.join('')}</div>` : '';
}

function renderSheet() {
  const mk = viewMonth; const st = monthStats(mk); const t = todayKey();
  const meta = S.months[mk];
  const rows = monthDays(mk).map(k => {
    const i = dayInfo(k); const d = i.d; const dt = parseKey(k);
    const weekend = !i.isWorkday && !d;
    const done = d ? d.sessions.filter(s => s.out) : [];
    const lineA = done.length || (S.active && S.active.date === k)
      ? `בפועל: ${done.map(s => `${s.in}–${s.out}`).join(', ')}${S.active && S.active.date === k ? ` ${S.active.in}–…` : ''}` : '';
    const lineB = d && d.rep ? `דווח: ${d.rep.s}–${d.rep.e}` : '';
    return `<button class="day ${i.cls} ${weekend ? 'weekend' : ''} ${k === t ? 'today' : ''}" data-day="${k}">
      <div class="d"><b>${dt.getDate()}</b><small>${WEEKDAYS[dt.getDay()]}</small></div>
      <div class="t">${lineA ? `<div>${lineA}</div>` : ''}${lineB ? `<div class="muted">${lineB}</div>` : ''}
        ${!lineA && !lineB && !badgesHTML(i) ? `<div class="muted">${weekend ? 'סוף שבוע' : '—'}</div>` : ''}${badgesHTML(i)}</div>
      <div class="h">${i.actual || i.live ? fmtH(i.actual + (i.live || 0)) : ''}${i.rep && i.rep !== i.actual ? `<small class="muted">דווח ${fmtH(i.rep)}</small>` : ''}</div>
    </button>`;
  }).join('');
  view().innerHTML = `
    <div class="monthnav">
      <button data-act="month-next" aria-label="חודש הבא">›</button>
      <div style="text-align:center"><h2>${monthLabel(mk)}</h2>
        <div class="small ${meta && meta.submittedAt ? '' : 'muted'}">${meta && meta.submittedAt ? `✅ דווח ב-${new Date(meta.submittedAt).toLocaleDateString('he-IL')}` : 'טרם דווח'}</div></div>
      <button data-act="month-prev" aria-label="חודש קודם">‹</button>
    </div>
    <div class="card">${statsHTML(st)}</div>
    <div class="days">${rows}</div>
    <div class="card" style="margin-top:12px">
      <h2>מקרא</h2>
      <div class="legend">
        <div><span class="sw" style="background:var(--ok)"></span>בפועל = דיווח</div>
        <div><span class="sw" style="background:var(--warn)"></span>🔺 מעל ${fmtH(S.settings.maxDaily)} — לפיזור</div>
        <div><span class="sw" style="background:var(--surplus)"></span>⬆️ עבדת יותר מהדיווח</div>
        <div><span class="sw" style="background:var(--deficit)"></span>⬇️ עבדת פחות מהדיווח</div>
        <div><span class="sw" style="background:var(--planned)"></span>🕒 דיווח עתידי</div>
        <div><span class="sw" style="background:var(--shift)"></span>↪️ שעות שהועברו</div>
        <div><span class="sw" style="background:var(--off)"></span>🏖️ חופש / חג</div>
        <div><span class="sw" style="background:var(--sick)"></span>🤒 מחלה</div>
      </div>
    </div>
    <div class="row" style="margin-top:4px">
      <button class="btn sec grow" data-act="copy-month">📋 העתק כטקסט</button>
      <button class="btn sec grow" data-act="csv-month">⬇️ CSV</button>
    </div>`;
}

// ---------- Day editor ----------
function openDayEditor(k) {
  const d = S.days[k] ? JSON.parse(JSON.stringify(S.days[k])) : newDay();
  const isActiveDay = S.active && S.active.date === k;
  const submitted = isSubmitted(monthKey(k));
  const draw = () => {
    const i = { actual: actualMin(d), rep: repMin(d) };
    modal(`
      <h2>${dayLabel(k)} ${submitted ? '<span class="badge b-ok">החודש דווח</span>' : ''}</h2>
      <div class="seg">${Object.entries(TYPES).map(([t, v]) => `<button data-type="${t}" class="${d.type === t ? 'on' : ''}">${v.icon} ${v.label}</button>`).join('')}</div>
      <h3>שעות בפועל ${i.actual ? `(${fmtH(i.actual)})` : ''}</h3>
      <div id="sessList">${d.sessions.map((s, n) => `<div class="sess">
          <input class="inp" type="time" data-s="${n}" data-f="in" value="${s.in}">
          <input class="inp" type="time" data-s="${n}" data-f="out" value="${s.out || ''}">
          <button data-del="${n}" aria-label="מחק">🗑️</button></div>`).join('')}</div>
      ${isActiveDay ? `<div class="small muted">כרגע בעבודה מאז ${S.active.in}</div>` : ''}
      <button class="linkbtn" data-add-sess>+ הוסף טווח שעות</button>
      <h3>דיווח למערכת ${i.rep ? `(${fmtH(i.rep)})` : ''}</h3>
      <div class="grid2">
        <label class="f">התחלה<input type="time" id="repS" value="${d.rep ? d.rep.s : ''}"></label>
        <label class="f">סיום<input type="time" id="repE" value="${d.rep ? d.rep.e : ''}"></label>
      </div>
      <div class="small muted" style="margin-top:-4px;margin-bottom:8px">${d.repManual ? 'הדיווח נערך ידנית / עתידי.' : submitted ? 'החודש דווח — הדיווח קפוא.' : 'מתעדכן אוטומטית לפי השעות בפועל.'}
        ${d.shift ? ` · שעות שהועברו ליום: ${fmtH(d.shift, true)}` : ''}</div>
      <div class="row" style="margin-bottom:10px">
        <button class="btn sec" data-sync>🔄 דיווח = בפועל</button>
        <button class="btn sec" data-clear-rep>ללא דיווח</button>
      </div>
      <label class="f">הערה<input type="text" id="note" value="${esc(d.note)}" placeholder="למשל: קוד פרויקט, משמרת ערב…"></label>
      <div class="row">
        <button class="btn grow" data-save>שמור</button>
        <button class="btn sec" data-close>ביטול</button>
        ${S.days[k] ? '<button class="btn danger" data-delete>מחק יום</button>' : ''}
      </div>`);
    const body = $('#modal-body');
    const readSess = () => body.querySelectorAll('[data-s]').forEach(inp => { d.sessions[+inp.dataset.s][inp.dataset.f] = inp.value || null; });
    const readRep = () => {
      const s = $('#repS').value, e = $('#repE').value;
      const nr = s && e ? { s, e } : null;
      if (JSON.stringify(nr) !== JSON.stringify(d.rep)) { d.rep = nr; d.repManual = true; }
      d.note = $('#note').value.trim();
    };
    body.querySelectorAll('[data-type]').forEach(b => b.onclick = () => { readSess(); readRep(); d.type = b.dataset.type; draw(); });
    body.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { readSess(); readRep(); d.sessions.splice(+b.dataset.del, 1); draw(); });
    body.querySelector('[data-add-sess]').onclick = () => { readSess(); readRep(); d.sessions.push({ in: S.settings.defStart, out: S.settings.defEnd }); draw(); };
    body.querySelector('[data-sync]').onclick = () => {
      readSess(); readRep();
      const done = d.sessions.filter(s => s.in && s.out);
      if (!done.length) { d.rep = null; } else {
        const st = done.map(s => s.in).sort()[0];
        d.rep = { s: st, e: fromMin(toMin(st) + done.reduce((a, s) => a + dur(s.in, s.out), 0) + (d.shift || 0)) };
      }
      d.repManual = submitted; // אחרי הגשה זו החלטה מכוונת; לפני — חוזר לסנכרון אוטומטי
      draw();
    };
    body.querySelector('[data-clear-rep]').onclick = () => { readSess(); readRep(); d.rep = null; d.shift = 0; d.repManual = true; draw(); };
    body.querySelector('[data-close]').onclick = closeModal;
    const del = body.querySelector('[data-delete]');
    if (del) del.onclick = () => { snapshot(); delete S.days[k]; if (isActiveDay) S.active = null; save(); closeModal(); render(); toast('היום נמחק', true); };
    body.querySelector('[data-save]').onclick = () => {
      readSess(); readRep();
      d.sessions = d.sessions.filter(s => s.in && s.out);
      snapshot();
      S.days[k] = d;
      if (isActiveDay && d.type !== 'work') S.active = null;
      sync(k); save(); closeModal(); render(); toast('נשמר', true);
    };
  };
  draw();
}

function openAddDay() {
  modal(`<h2>הוספת / עריכת יום</h2>
    <label class="f">תאריך<input type="date" id="addDate" value="${todayKey()}"></label>
    <div class="row"><button class="btn grow" id="addGo">המשך</button><button class="btn sec" data-close>ביטול</button></div>`);
  $('#addGo').onclick = () => { const v = $('#addDate').value; if (v) { closeModal(); openDayEditor(v); } };
  $('#modal-body [data-close]').onclick = closeModal;
}

function openForgot() {
  const a = S.active;
  modal(`<h2>שעת יציאה ל-${dayLabel(a.date)}</h2>
    <p class="muted small">נכנסת ב-${a.in}. מתי יצאת?</p>
    <label class="f">שעת יציאה<input type="time" id="fOut" value="${S.settings.defEnd}"></label>
    <div class="row"><button class="btn grow" id="fGo">שמור</button><button class="btn sec" data-close>ביטול</button></div>`);
  $('#fGo').onclick = () => { const v = $('#fOut').value; if (v) { closeModal(); clockOut(v); } };
  $('#modal-body [data-close]').onclick = closeModal;
}

// ---------- Finish report wizard ----------
let finishSel = {}; // בחירות זמניות בשלבי האשף

function renderFinish() {
  const mk = viewMonth; const t = todayKey(); const st = monthStats(mk);
  const sub = isSubmitted(mk); const max = S.settings.maxDaily; const unit = S.settings.round;
  const days = monthDays(mk).map(dayInfo);

  // שלב 1: ימים עתידיים ריקים
  const futureEmpty = days.filter(i => (i.future || (i.today && !i.actual && !S.active)) && i.isWorkday && !i.d);
  // שלב 2: יתרה מחודש קודם
  const carry = st.carryRemaining;
  const carryTargets = days.filter(i => (i.type === 'work' || i.type === null) && i.rep > 0)
    .map(i => ({ k: i.k, cap: carry > 0 ? Math.max(0, max - i.rep) : i.rep, i }));
  // שלב 3: מעל 8 שעות
  const overDays = days.filter(i => i.rep > max);
  const excess = overDays.reduce((a, i) => a + (i.rep - max), 0);
  const overTargets = days.filter(i => i.rep > 0 && i.rep < max && (i.type === 'work')).map(i => ({ k: i.k, cap: max - i.rep, i }));

  const selFor = (group, list, defaultOn) => {
    finishSel[group] = finishSel[group] || {};
    list.forEach(x => { if (!(x.k in finishSel[group])) finishSel[group][x.k] = defaultOn(x); });
    return list.filter(x => finishSel[group][x.k]);
  };
  const futSel = selFor('fut', futureEmpty, () => true);
  const carrySel = selFor('carry', carryTargets, x => x.i.future || x.i.today);
  const overSel = selFor('over', overTargets, () => true);
  const carryPlan = carry > 0 ? allocate(carry, carrySel, unit) : allocate(-carry, carrySel, unit);
  const overPlan = allocate(excess, overSel, unit);

  const chk = (group, i, extra) => `<label class="chk"><input type="checkbox" data-g="${group}" data-k="${i.k}" ${finishSel[group][i.k] ? 'checked' : ''}>
    <span class="grow">${dayLabel(i.k)} ${i.future ? '<span class="badge b-planned">עתידי</span>' : ''}</span><span class="small muted">${extra || ''}</span></label>`;

  const reported = days.filter(i => i.d && i.d.rep);
  view().innerHTML = `
    <div class="monthnav">
      <button data-act="month-next" aria-label="חודש הבא">›</button>
      <div style="text-align:center"><h2>סיום דיווח · ${monthLabel(mk)}</h2>
      <div class="small muted">מועד הגשה: ${S.settings.deadlineDay}/${+mk.slice(5)}</div></div>
      <button data-act="month-prev" aria-label="חודש קודם">‹</button>
    </div>
    ${sub ? `<div class="alert good"><span>✅</span><div class="grow">החודש סומן כדווח ב-${new Date(S.months[mk].submittedAt).toLocaleString('he-IL')}.
      מעכשיו כל שינוי בשעות בפועל יסומן כפער ויועבר לחודש הבא. <div><button class="linkbtn" data-act="reopen">פתח מחדש לעריכה</button></div></div></div>` : ''}

    <div class="card ${futureEmpty.length ? '' : 'done-step'}">
      <h2><span class="step">1</span>דיווח שעות עתידיות</h2>
      ${futureEmpty.length ? `<p class="small muted">ימי עבודה שעוד לא הגיעו ואין להם דיווח. סמן אילו לדווח מראש:</p>
        <div class="grid2"><label class="f">התחלה<input type="time" id="futS" value="${S.settings.defStart}"></label>
        <label class="f">סיום<input type="time" id="futE" value="${S.settings.defEnd}"></label></div>
        ${futureEmpty.map(i => chk('fut', i)).join('')}
        <button class="btn block" data-act="fill-future" ${futSel.length ? '' : 'disabled'} style="margin-top:8px">מלא ${futSel.length} ימים</button>`
      : '<p class="small muted">✓ אין ימים עתידיים ללא דיווח.</p>'}
    </div>

    <div class="card ${carry ? '' : 'done-step'}">
      <h2><span class="step">2</span>יתרה מהחודש הקודם</h2>
      ${carry ? `<p class="small">${carry > 0 ? `עבדת בחודש הקודם <b>${fmtH(carry)}</b> יותר ממה שדיווחת. נוסיף אותן לימים שתבחר (עד ${fmtH(max)} ליום):`
        : `דיווחת בחודש הקודם <b>${fmtH(-carry)}</b> יותר ממה שעבדת. נוריד אותן מהימים שתבחר:`}</p>
        ${carryTargets.map(x => chk('carry', x.i, `${fmtH(x.i.rep)}${carryPlan.alloc[x.k] ? ` → <b>${fmtH(carry > 0 ? carryPlan.alloc[x.k] : -carryPlan.alloc[x.k], true)}</b>` : ''}`)).join('') || '<p class="small muted">אין ימים מדווחים החודש — מלא קודם ימים בשלב 1.</p>'}
        ${carryPlan.left ? `<div class="alert warn small"><span>⚠️</span><div>לא נמצא מקום ל-${fmtH(carryPlan.left)} — בחר עוד ימים או הוסף ימי עבודה.</div></div>` : ''}
        <button class="btn block" data-act="apply-carry" ${carrySel.length ? '' : 'disabled'} style="margin-top:8px">החל</button>
        <button class="linkbtn small" data-act="dismiss-carry">התעלם מהיתרה (טופלה מחוץ לאפליקציה)</button>`
      : '<p class="small muted">✓ אין יתרה פתוחה.</p>'}
    </div>

    <div class="card ${overDays.length ? '' : 'done-step'}">
      <h2><span class="step">3</span>פיזור שעות מעל ${fmtH(max)}</h2>
      ${overDays.length ? `<p class="small">${overDays.map(i => `<span class="badge b-warn">🔺 ${dayLabel(i.k)}: ${fmtH(i.rep)} (+${fmtH(i.rep - max)})</span>`).join(' ')}</p>
        <p class="small">סה״כ עודף: <b>${fmtH(excess)}</b>. בחר ימים שיקבלו את העודף (החלוקה יחסית למקום הפנוי בכל יום):</p>
        ${overTargets.map(x => chk('over', x.i, `${fmtH(x.i.rep)}${overPlan.alloc[x.k] ? ` → <b>+${fmtH(overPlan.alloc[x.k])}</b>` : ''}`)).join('') || '<p class="small muted">אין ימים עם מקום פנוי — מלא ימים עתידיים בשלב 1.</p>'}
        ${overPlan.left ? `<div class="alert warn small"><span>⚠️</span><div>לא נמצא מקום ל-${fmtH(overPlan.left)} — בחר עוד ימים, הקטן ימים עתידיים, או העבר את היתרה לחודש הבא.</div></div>` : ''}
        ${excess - overPlan.left > 0 ? `<button class="btn block" data-act="apply-over" style="margin-top:8px">פזר ${fmtH(excess - overPlan.left)}</button>` : ''}
        <button class="btn sec block" data-act="over-carry" style="margin-top:8px">${overPlan.left && excess - overPlan.left > 0 ? 'אחרי הפיזור: ' : ''}הגבל ל-${fmtH(max)} והעבר ${fmtH(overPlan.left || excess)} לחודש הבא</button>`
      : `<p class="small muted">✓ אין ימים מדווחים מעל ${fmtH(max)}.</p>`}
    </div>

    <div class="card">
      <h2><span class="step">4</span>סיכום והגשה</h2>
      ${st.missing ? `<div class="alert warn small"><span>❓</span><div>${st.missing} ימי עבודה שעברו בלי שום רישום (לא עבדת? סמן חופש/מחלה בגיליון).</div></div>` : ''}
      <table class="rep"><thead><tr><th>תאריך</th><th>כניסה</th><th>יציאה</th><th>שעות</th></tr></thead>
        <tbody>${reported.map(i => `<tr><td>${dayLabel(i.k)}${i.type !== 'work' ? ' ' + TYPES[i.type].icon : ''}</td><td>${i.d.rep.s}</td><td>${i.d.rep.e}</td><td>${fmtH(i.rep)}</td></tr>`).join('')}
          ${days.filter(i => i.type && i.type !== 'work' && !i.rep).map(i => `<tr><td>${dayLabel(i.k)}</td><td colspan="3">${TYPES[i.type].icon} ${TYPES[i.type].label}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td>סה״כ</td><td colspan="2">${st.repDays} ימים</td><td>${fmtH(st.rep)}</td></tr></tfoot></table>
      <p class="small">שכר צפוי לפי הדיווח: <b>${fmtMoney(st.salaryRep)}</b></p>
      <div class="row">
        <button class="btn sec grow" data-act="copy-month">📋 העתק</button>
        <button class="btn sec grow" data-act="json-month">🤖 קובץ להזנה אוטומטית</button>
      </div>
      ${sub ? '' : `<button class="btn block" data-act="submit" style="margin-top:10px" ${st.repOver ? 'disabled' : ''}>✅ סמן שהדוח הוגש</button>
      ${st.repOver ? '<p class="small muted">יש ימים מעל המקסימום — פזר אותם בשלב 3 לפני הגשה.</p>' : ''}`}
    </div>

    ${sub ? `<div class="card">
      <h2>↕️ פערים מאז ההגשה</h2>
      ${days.filter(i => i.drift).map(i => `<div class="chk"><span class="grow">${dayLabel(i.k)}</span>
        <span class="badge ${i.drift > 0 ? 'b-surplus' : 'b-deficit'}">${fmtH(i.drift, true)}</span>
        <button class="linkbtn small" data-day="${i.k}">עריכה</button></div>`).join('') || '<p class="small muted">אין פערים — הדיווח תואם את מה שעבדת.</p>'}
      ${st.drift ? `<p class="small">סה״כ <b>${fmtH(st.drift, true)}</b> יועבר אוטומטית ל${monthLabel(addMonths(mk, 1))} ויופיע שם בשלב 2.
        אם המערכת עדיין מאפשרת לתקן את החודש הזה, ערוך את היום ולחץ "דיווח = בפועל".</p>` : ''}
    </div>` : ''}`;

  view().querySelectorAll('input[data-g]').forEach(inp => inp.onchange = () => { finishSel[inp.dataset.g][inp.dataset.k] = inp.checked; renderFinish(); });
  view()._plans = { futSel, carrySel, carryPlan, carry, overDays, overPlan, max };
}

function finishAction(act) {
  const mk = viewMonth; const p = view()._plans;
  if (act === 'fill-future') {
    const s = $('#futS').value, e = $('#futE').value; if (!s || !e) return;
    snapshot();
    p.futSel.forEach(i => { const d = ensureDay(i.k); d.rep = { s, e }; d.repManual = true; });
    finishSel = {}; save(); render(); toast(`דווחו ${p.futSel.length} ימים עתידיים`, true);
  } else if (act === 'apply-carry') {
    snapshot();
    let total = 0;
    for (const [k, m] of Object.entries(p.carryPlan.alloc)) if (m) { const dl = p.carry > 0 ? m : -m; applyDelta(k, dl); total += dl; }
    monthMeta(mk).carryApplied += total;
    finishSel = {}; save(); render(); toast(`הוחלו ${fmtH(total, true)} מהחודש הקודם`, true);
  } else if (act === 'dismiss-carry') {
    snapshot(); monthMeta(mk).carryApplied += monthStats(mk).carryRemaining; save(); render(); toast('היתרה סומנה כמטופלת', true);
  } else if (act === 'apply-over') {
    snapshot();
    const moved = Object.values(p.overPlan.alloc).reduce((a, b) => a + b, 0);
    // מורידים מהימים העודפים לפי היחס של העודף שלהם
    const exc = p.overDays.map(i => ({ k: i.k, cap: i.rep - p.max }));
    const take = allocate(moved, exc, 1).alloc;
    for (const [k, m] of Object.entries(take)) if (m) applyDelta(k, -m);
    for (const [k, m] of Object.entries(p.overPlan.alloc)) if (m) applyDelta(k, m);
    finishSel = {}; save(); render(); toast(`פוזרו ${fmtH(moved)} שעות`, true);
  } else if (act === 'over-carry') {
    // מגבילים כל יום ל-max בלי "shift": ההפרש נשאר כפער חיובי ויעבור לחודש הבא
    snapshot();
    let n = 0;
    for (const i of p.overDays) {
      const d = S.days[i.k]; const cur = repMin(d); if (cur <= p.max) continue;
      d.rep.e = fromMin(toMin(d.rep.s) + p.max); d.repManual = true; n += cur - p.max;
    }
    finishSel = {}; save(); render(); toast(`${fmtH(n)} יועברו לחודש הבא`, true);
  } else if (act === 'submit') {
    snapshot();
    // מקבעים את כל הדיווחים כפי שהם ברגע ההגשה
    monthDays(mk).forEach(k => { if (S.days[k]) sync(k); });
    monthMeta(mk).submittedAt = new Date().toISOString();
    save(); render(); toast('החודש סומן כדווח 🎉', true);
  } else if (act === 'reopen') {
    snapshot(); monthMeta(mk).submittedAt = null; save(); render(); toast('החודש נפתח מחדש', true);
  }
}

// ---------- Export / import ----------
function monthRows(mk) {
  return monthDays(mk).map(k => ({ k, d: S.days[k] })).filter(x => x.d && (x.d.rep || x.d.type !== 'work'))
    .map(({ k, d }) => ({
      date: k, type: d.type, start: d.rep ? d.rep.s : null, end: d.rep ? d.rep.e : null,
      hours: dec(repMin(d)), actualHours: dec(actualMin(d)), note: d.note || '',
    }));
}
function monthText(mk) {
  const st = monthStats(mk);
  const lines = monthRows(mk).map(r => {
    const dt = parseKey(r.date); const dl = `${dt.getDate()}/${dt.getMonth() + 1}`;
    if (r.start) return `${dl} ${r.start}-${r.end}${r.type !== 'work' ? ' ' + TYPES[r.type].label : ''}${r.note ? ' (' + r.note + ')' : ''}`;
    return `${dl} ${TYPES[r.type].label}`;
  });
  return `דוח שעות ${monthLabel(mk)}\n${lines.join('\n')}\n\nסה"כ: ${fmtH(st.rep)} שעות (${dec(st.rep)}), ${st.repDays} ימים\nשכר: ${fmtMoney(st.salaryRep)}`;
}
function download(name, text, type) {
  const blob = new Blob([text], { type: type || 'application/octet-stream' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('הועתק ✓'); }
  catch (e) { modal(`<h2>העתקה</h2><pre class="out">${esc(text)}</pre><button class="btn block" data-close>סגור</button>`); $('#modal-body [data-close]').onclick = closeModal; }
}

/** ייבוא היסטוריה מהודעות וואטסאפ (העתקה או קובץ ייצוא צ'אט). */
function parseWhatsApp(text) {
  const out = []; const today = todayKey();
  const prefix = /^‎?\[?(\d{1,2})[./](\d{1,2})[./](\d{2,4}),?\s+\d{1,2}:\d{2}(?::\d{2})?\]?\s*(?:-\s*)?(?:[^:]{1,40}:\s*)?/;
  const dateRe = /(?:^|[^\d:])(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?![\d:])/;
  const rangeRe = /(\d{1,2})(?::(\d{2}))?\s*[-–—]\s*(\d{1,2})(?::(\d{2}))?/g;
  for (let raw of text.split(/\r?\n/)) {
    let line = raw.trim(); if (!line) continue;
    let msgDate = null;
    const pm = line.match(prefix);
    if (pm) { let y = +pm[3]; if (y < 100) y += 2000; msgDate = { d: +pm[1], m: +pm[2], y }; line = line.slice(pm[0].length); }
    const dm = line.match(dateRe);
    let D = null;
    if (dm) {
      let y = dm[3] ? +dm[3] : (msgDate ? msgDate.y : new Date().getFullYear()); if (y < 100) y += 2000;
      D = { d: +dm[1], m: +dm[2], y };
      if (!dm[3] && msgDate && D.m > msgDate.m + 1) D.y = msgDate.y - 1; // דיווח על דצמבר שנשלח בינואר
      line = line.replace(dm[0], ' ');
    } else if (msgDate) D = msgDate;
    if (!D || D.m < 1 || D.m > 12 || D.d < 1 || D.d > 31) continue;
    const sessions = [];
    let r; rangeRe.lastIndex = 0;
    while ((r = rangeRe.exec(line))) {
      const h1 = +r[1], m1 = +(r[2] || 0), h2 = +r[3], m2 = +(r[4] || 0);
      if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) continue;
      sessions.push({ in: `${pad(h1)}:${pad(m1)}`, out: `${pad(h2)}:${pad(m2)}` });
    }
    let type = 'work';
    if (/חופש|חופשה/.test(line)) type = 'vacation';
    else if (/מחלה|חולה/.test(line)) type = 'sick';
    else if (/חג/.test(line)) type = 'holiday';
    if (!sessions.length && type === 'work') continue;
    let k = `${D.y}-${pad(D.m)}-${pad(D.d)}`;
    if (dm && !dm[3] && !msgDate && k > today) k = `${D.y - 1}-${pad(D.m)}-${pad(D.d)}`; // בלי שנה ובלי תאריך הודעה
    out.push({ k, sessions, type });
  }
  // איחוד לפי תאריך (ההודעה האחרונה גוברת)
  const map = {}; out.forEach(x => map[x.k] = x);
  return Object.values(map).sort((a, b) => a.k < b.k ? -1 : 1);
}

function openWhatsAppImport() {
  modal(`<h2>ייבוא מוואטסאפ</h2>
    <p class="small muted">הדבק כאן את ההודעות שלך (או ייצוא צ'אט: ⋮ ← עוד ← ייצוא צ'אט ← ללא מדיה). מזהה שורות כמו <b>12/3 8:30-17:00</b>, <b>12.3 חופש</b>.</p>
    <textarea class="inp" id="waText" rows="8" placeholder="12/3 8:30-17:00"></textarea>
    <label class="chk"><input type="checkbox" id="waOver"> <span class="grow">דרוס ימים שכבר קיימים</span></label>
    <label class="chk"><input type="checkbox" id="waSub" checked> <span class="grow">סמן חודשים שעברו כ"דווחו"</span></label>
    <div id="waPrev" class="small muted"></div>
    <div class="row" style="margin-top:8px"><button class="btn sec grow" id="waParse">תצוגה מקדימה</button><button class="btn grow" id="waGo" disabled>ייבא</button><button class="btn sec" data-close>סגור</button></div>`);
  let parsed = [];
  $('#waParse').onclick = () => {
    parsed = parseWhatsApp($('#waText').value);
    $('#waPrev').innerHTML = parsed.length ? `נמצאו <b>${parsed.length}</b> ימים (${dayLabel(parsed[0].k)}/${parsed[0].k.slice(0, 4)} – ${dayLabel(parsed.at(-1).k)}/${parsed.at(-1).k.slice(0, 4)}):<pre class="out">${parsed.slice(0, 40).map(p => `${p.k}  ${p.type !== 'work' ? TYPES[p.type].label : p.sessions.map(s => s.in + '-' + s.out).join(', ')}`).join('\n')}${parsed.length > 40 ? '\n…' : ''}</pre>` : 'לא נמצאו שורות מתאימות.';
    $('#waGo').disabled = !parsed.length;
  };
  $('#waGo').onclick = () => {
    snapshot(); const over = $('#waOver').checked; let n = 0;
    const cur = monthKey(todayKey()); const months = new Set();
    for (const p of parsed) {
      if (S.days[p.k] && !over) continue;
      S.days[p.k] = { ...newDay(), type: p.type, sessions: p.sessions };
      months.add(monthKey(p.k)); n++;
    }
    // קודם מסנכרנים (דיווח = בפועל), ורק אחר כך מסמנים כדווח
    for (const p of parsed) if (S.days[p.k]) sync(p.k);
    if ($('#waSub').checked) months.forEach(mk => { if (mk < cur && !isSubmitted(mk)) monthMeta(mk).submittedAt = new Date().toISOString(); });
    save(); closeModal(); render(); toast(`יובאו ${n} ימים`, true);
  };
  $('#modal-body [data-close]').onclick = closeModal;
}

// ---------- Settings ----------
function renderSettings() {
  const s = S.settings;
  view().innerHTML = `
    <div class="card"><h2>שכר ושעות</h2>
      <div class="grid2">
        <label class="f">שכר לשעה (₪)<input type="number" step="0.01" id="sRate" value="${s.rate}"></label>
        <label class="f">מקסימום שעות ביום<input type="number" step="0.25" id="sMax" value="${s.maxDaily / 60}"></label>
        <label class="f">יום הגשת הדוח בחודש<input type="number" min="1" max="31" id="sDead" value="${s.deadlineDay}"></label>
        <label class="f">עיגול בפיזור (דקות)<select id="sRound">${[1, 5, 10, 15, 30].map(v => `<option ${v === s.round ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label class="f">שעת התחלה רגילה<input type="time" id="sStart" value="${s.defStart}"></label>
        <label class="f">שעת סיום רגילה<input type="time" id="sEnd" value="${s.defEnd}"></label>
      </div>
      <div class="small muted" style="margin-bottom:4px">ימי עבודה</div>
      <div class="wd">${WEEKDAYS.map((w, n) => `<label><input type="checkbox" data-wd="${n}" ${s.workdays.includes(n) ? 'checked' : ''}>${w}</label>`).join('')}</div>
      <label class="f" style="margin-top:10px">ערכת צבעים<select id="sTheme">
        <option value="auto" ${s.theme === 'auto' ? 'selected' : ''}>לפי המכשיר</option>
        <option value="light" ${s.theme === 'light' ? 'selected' : ''}>בהיר</option>
        <option value="dark" ${s.theme === 'dark' ? 'selected' : ''}>כהה</option></select></label>
      <div class="grid2" style="margin-top:10px">
        <label class="f">ימי חופש בשנה<input type="number" step="0.5" id="sVacQ" value="${s.vacQuota}"></label>
        <label class="f">יתרה / תיקון ל-${todayKey().slice(0, 4)} (ימים)<input type="number" step="0.5" id="sVacX" value="${(s.vacExtra || {})[todayKey().slice(0, 4)] || 0}"></label>
      </div>
      <p class="small muted" style="margin:0 0 8px">יום חופש משולם לפי שעות יום רגיל (${fmtH(vacDayMin())}). יום מחלה נספר בלי תשלום.</p>
      <label class="f">יתרת פתיחה לחודש ${monthLabel(viewMonth)} (שעות, + עבדתי יותר מדיווח / − פחות)
        <input type="number" step="0.25" id="sAdj" value="${((S.months[viewMonth] && S.months[viewMonth].openingAdj) || 0) / 60}"></label>
      <button class="btn block" data-act="save-settings">שמור הגדרות</button>
    </div>
    <div class="card"><h2>נתונים</h2>
      <p class="small muted">הכל נשמר רק בטלפון הזה. מומלץ לגבות מדי פעם.</p>
      <div class="row">
        <button class="btn sec grow" data-act="backup">💾 גיבוי</button>
        <label class="btn sec grow" style="text-align:center">📂 שחזור<input type="file" id="restore" accept="application/json" hidden></label>
      </div>
      <button class="btn sec block" data-act="wa-import" style="margin-top:8px">💬 ייבוא היסטוריה מוואטסאפ</button>
      <button class="btn danger block" data-act="wipe" style="margin-top:8px">מחיקת כל הנתונים</button>
    </div>
    <div class="card small muted">גרסה 1.0 · <a href="https://github.com" id="repoLink" target="_blank" rel="noopener">קוד המקור</a></div>`;
  $('#restore').onchange = ev => {
    const f = ev.target.files[0]; if (!f) return;
    f.text().then(t => {
      try { const n = JSON.parse(t); if (!n.days) throw 0; snapshot(); S = n; S.settings = { ...DEF_SETTINGS, ...S.settings }; S.months = S.months || {}; save(); render(); toast('שוחזר ✓', true); }
      catch (e) { toast('קובץ לא תקין'); }
    });
  };
}
function saveSettings() {
  snapshot();
  const s = S.settings;
  s.rate = +$('#sRate').value || s.rate;
  s.maxDaily = Math.round((+$('#sMax').value || 8) * 60);
  s.deadlineDay = Math.min(31, Math.max(1, +$('#sDead').value || 15));
  s.round = +$('#sRound').value;
  s.defStart = $('#sStart').value || s.defStart;
  s.defEnd = $('#sEnd').value || s.defEnd;
  s.workdays = [...document.querySelectorAll('[data-wd]')].filter(c => c.checked).map(c => +c.dataset.wd);
  s.theme = $('#sTheme').value;
  s.vacQuota = +$('#sVacQ').value || 0;
  s.vacExtra = { ...(s.vacExtra || {}), [todayKey().slice(0, 4)]: +$('#sVacX').value || 0 };
  monthMeta(viewMonth).openingAdj = Math.round((+$('#sAdj').value || 0) * 60);
  save(); render(); toast('ההגדרות נשמרו', true);
}

// ---------- Help ----------
// Help lives outside the main state (S) so wiping or restoring data doesn't re-trigger the first-run sheet.
const HELP_KEY = 'wh.helpSeen';
const HELP_SECTIONS = {
  home: ['🏠 בית — כל יום', `
    <ul>
      <li>מגיעים לעבודה ← לוחצים על הכפתור הגדול <b>"הגעתי לעבודה"</b>.</li>
      <li>יוצאים מהעבודה ← לוחצים עליו שוב, <b>"יצאתי מהעבודה"</b>.</li>
    </ul>
    <p class="small muted">זה כל מה שצריך ברוב הימים. הכפתורים הקטנים הם רק למקרים חריגים:</p>
    <ul>
      <li>🏖️ <b>יום חופש</b>: משולם ויורד מיתרת החופש השנתית.</li>
      <li>🤒 <b>מחלה</b>: נספר, בלי תשלום.</li>
      <li>✏️ <b>עריכת היום</b>: שכחת ללחוץ או לחצת בשעה לא נכונה.</li>
      <li>➕ <b>הוספת יום</b>: הוספה או תיקון של יום קודם.</li>
      <li>↩️ <b>ביטול פעולה</b>: לחצת בטעות.</li>
    </ul>
    <p class="small muted">אם שכחת לסמן יציאה, תופיע למעלה התראה עם כפתור "הזן שעת יציאה".</p>`],
  sheet: ['📋 גיליון — צפייה ותיקון', `
    <ul>
      <li>כל ימי החודש, כל יום עם צבע ואייקון. החצים ‹ › מעבירים בין חודשים.</li>
      <li>לחיצה על יום פותחת אותו לעריכה: שעות <b>בפועל</b> (מה שעבדת) ו<b>דיווח</b> (מה שנשלח לשכר).</li>
      <li>לא ברור מה אומר צבע או אייקון? למטה יש <b>מקרא</b>.</li>
    </ul>`],
  finish: ['✅ סיום דיווח — פעם בחודש', `
    <p class="small muted">כשמתקרב מועד ההגשה מופיעה התראה. עוברים מלמעלה למטה; שלב שלא רלוונטי פשוט לא מופיע או שמדלגים עליו.</p>
    <ol>
      <li><b>שעות עתידיות</b>: ממלאים את הימים שעוד לא קרו עד סוף החודש.</li>
      <li><b>יתרה מהחודש הקודם</b>: רק אם יש.</li>
      <li><b>פיזור שעות מעל 8</b>: רק אם היו ימים ארוכים.</li>
      <li><b>📋 העתק</b> ← מדביקים במערכת השכר ← <b>✅ סמן שהדוח הוגש</b>.</li>
    </ol>
    <p class="small muted">אחרי ההגשה ממשיכים ללחוץ "הגעתי"/"יצאתי" כרגיל. אם עבדת יותר או פחות ממה שדיווחת, זה יסומן ויעבור לחודש הבא.</p>`],
  settings: ['⚙️ הגדרות — פעם אחת בהתחלה', `
    <ul>
      <li>ממלאים <b>שכר לשעה</b>, <b>יום הגשת הדוח</b>, <b>שעות רגילות</b> ו<b>ימי חופש בשנה</b> ← "שמור הגדרות".</li>
      <li>השעות רשומות בוואטסאפ? <b>💬 ייבוא היסטוריה מוואטסאפ</b> ומדביקים את הצ'אט.</li>
      <li>המידע נשמר רק בטלפון. כדאי לעשות <b>💾 גיבוי</b> מדי פעם.</li>
    </ul>`],
};
function openHelp() {
  // Expand the section for the tab the user is on, so "?" answers "what is this screen".
  const tab = (location.hash || '#home').slice(1).split('/')[0];
  const cur = HELP_SECTIONS[tab] ? tab : 'home';
  modal(`<div class="help"><h2>איך משתמשים</h2>
    <div class="tldr"><b>בקיצור:</b> כל יום "הגעתי" ו"יצאתי". פעם בחודש "סיום דיווח". זהו.</div>
    ${Object.entries(HELP_SECTIONS).map(([id, [title, body]]) =>
      `<details ${id === cur ? 'open' : ''}><summary>${title}</summary>${body}</details>`).join('')}
    <button class="btn block" data-close style="margin-top:12px">הבנתי</button></div>`);
  $('#modal-body [data-close]').onclick = closeModal;
  try { localStorage.setItem(HELP_KEY, '1'); } catch (e) { /* private mode — just show again next time */ }
}

// ---------- Modal / toast ----------
function modal(html) { $('#modal-body').innerHTML = html; $('#modal').hidden = false; }
function closeModal() { $('#modal').hidden = true; $('#modal-body').innerHTML = ''; }
let toastT;
function toast(msg, withUndo) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>${withUndo && undoSnap ? '<button data-act="undo">ביטול</button>' : ''}`;
  el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => el.hidden = true, 4000);
}

// ---------- Events ----------
document.addEventListener('click', ev => {
  const dayBtn = ev.target.closest('[data-day]');
  if (dayBtn) { closeModal(); openDayEditor(dayBtn.dataset.day); return; }
  const el = ev.target.closest('[data-act]'); if (!el) return;
  const act = el.dataset.act; const k = todayKey();
  switch (act) {
    case 'in':
      if (S.active && S.active.date !== k) { openForgot(); break; }
      clockIn(); break;
    case 'out': clockOut(); break;
    case 'vacation': setType(k, 'vacation'); break;
    case 'sick': setType(k, 'sick'); break;
    case 'type-work': setType(k, 'work'); break;
    case 'edit-today': openDayEditor(k); break;
    case 'add-day': openAddDay(); break;
    case 'fix-forgot': openForgot(); break;
    case 'undo': undo(); document.getElementById('toast').hidden = true; break;
    case 'month-prev': viewMonth = addMonths(viewMonth, -1); finishSel = {}; render(); break;
    case 'month-next': viewMonth = addMonths(viewMonth, 1); finishSel = {}; render(); break;
    case 'copy-month': copyText(monthText(viewMonth)); break;
    case 'csv-month': {
      const rows = monthRows(viewMonth);
      const csv = '﻿תאריך,סוג,כניסה,יציאה,שעות מדווחות,שעות בפועל,הערה\n' + rows.map(r => [r.date, TYPES[r.type].label, r.start || '', r.end || '', r.hours, r.actualHours, `"${r.note.replace(/"/g, '""')}"`].join(',')).join('\n');
      download(`hours-${viewMonth}.csv`, csv, 'text/csv'); break;
    }
    case 'json-month': {
      const st = monthStats(viewMonth);
      download(`report-${viewMonth}.json`, JSON.stringify({ month: viewMonth, rate: S.settings.rate, totalHours: dec(st.rep), days: monthRows(viewMonth) }, null, 2), 'application/json'); break;
    }
    case 'save-settings': saveSettings(); break;
    case 'backup': download(`work-hours-backup-${todayKey()}.json`, JSON.stringify(S, null, 2), 'application/json'); break;
    case 'wa-import': openWhatsAppImport(); break;
    case 'help': openHelp(); break;
    case 'wipe':
      if (confirm('למחוק את כל הנתונים? מומלץ לגבות קודם.')) { snapshot(); S = blank(); save(); render(); toast('נמחק', true); }
      break;
    default: finishAction(act);
  }
});
$('#modal').addEventListener('click', ev => { if (ev.target.id === 'modal') closeModal(); });
window.addEventListener('hashchange', () => { if ((location.hash || '#home') === '#home') viewMonth = monthKey(todayKey()); render(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && $('#modal').hidden) render(); });

viewMonth = monthKey(todayKey());
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js');
render();
// First launch only: show the guide once. Users who imported/entered data before this feature existed skip it.
try { if (!localStorage.getItem(HELP_KEY) && !Object.keys(S.days).length) openHelp(); } catch (e) { /* ignore */ }

// לשימוש עתידי באוטומציה (למשל הזנה אוטומטית בדפדפן): window.WorkHours.report('2026-11')
window.WorkHours = { report: mk => ({ month: mk, days: monthRows(mk) }), state: () => S };

/**
 * Bebek Takip — ortak hesaplama mantığı.
 * Hem uygulama (tarayıcı) hem sunucu fonksiyonları bu dosyayı kullanır.
 * Kayıt biçimi (Firestore "records" belgesi): tarihler milisaniye (number), boş alanlar ''.
 */

export const TZ = 'Europe/Istanbul';
const TZ_OFFSET_MS = 3 * 3600 * 1000;   // Türkiye 2016'dan beri sabit UTC+3 (yaz saati yok)
export const MIN_BREAST_MIN = 15;
export const DIAPER_STATES = ['Kuru', 'Sadece çiş', 'Sadece kaka', 'Çiş + kaka'];
export const ALARM_COLORS = ['Beyaz/gri/soluk', 'Kırmızı/kanlı'];

/* ---------------- tarih yardımcıları (İstanbul saati) ---------------- */

const p2 = (n) => String(n).padStart(2, '0');

function parts(ms) {
  const d = new Date(Number(ms) + TZ_OFFSET_MS);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
}

/** pattern: 'dd.MM.yyyy HH:mm' | 'dd.MM.yyyy' | 'yyyy-MM-dd' | 'HH:mm' | 'H' */
export function fmt(ms, pattern) {
  const t = parts(ms);
  return pattern
    .replace('yyyy', t.y).replace('MM', p2(t.mo)).replace('dd', p2(t.d))
    .replace('HH', p2(t.h)).replace('mm', p2(t.mi)).replace(/^H$/, String(t.h));
}

/** 'yyyy-MM-ddTHH:mm' veya 'yyyy-MM-dd HH:mm' (İstanbul) -> ms */
export function parseLocal(str) {
  const m = String(str || '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/);
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - TZ_OFFSET_MS;
}

export function minuteOfDay(ms) { const t = parts(ms); return t.h * 60 + t.mi; }

export function agoText(pastMs, nowMs) {
  const mins = Math.max(0, Math.floor((nowMs - pastMs) / 60000));
  const days = Math.floor(mins / 1440);
  if (days >= 1) return days + ' gün önce';
  const h = Math.floor(mins / 60), m = mins % 60;
  if (h > 0 && m > 0) return h + ' sa ' + m + ' dk önce';
  if (h > 0) return h + ' sa önce';
  return m + ' dk önce';
}

/* ---------------- ilaç planı ---------------- */

const DAY_MS = 24 * 3600 * 1000;
const MED_DUE_BEFORE_MIN = 30;   // saatinden bu kadar önce "zamanı" sayılır
const MED_LATE_AFTER_MIN = 30;   // saatinden bu kadar sonra hâlâ verilmediyse "gecikti"
export const MED_MAX_TIMES = 12;
export const MED_MAX_EVERY = 30;
// need: gerektiğinde | daily: günde N kez (times) | days: N günde 1 (times[0]) | diapers: N bezde 1
export const MED_MODES = ['need', 'daily', 'days', 'diapers'];

/** Eski kayıtlarda mode yoktur: saat varsa "günde N", yoksa "gerektiğinde". */
export function medMode(m) {
  return MED_MODES.includes(m && m.mode) ? m.mode : (m && m.times && m.times.length ? 'daily' : 'need');
}

/** İlaç tanımını doğrular. */
export function buildMed(data) {
  data = data || {};
  const name = String(data.name || '').trim().replace(/\s+/g, ' ');
  if (!name) throw new Error('İlaç adı yazılmalı.');
  if (name.length > 80) throw new Error('İlaç adı en fazla 80 karakter olabilir.');
  const mode = medMode(data);
  let times = mode === 'daily' || mode === 'days' ? [...new Set((data.times || []).map((t) => String(t).trim()))].sort() : [];
  times.forEach((t) => { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new Error('Geçersiz saat: ' + t); });
  if (mode === 'daily' && !times.length) throw new Error('En az bir saat girilmeli.');
  if (times.length > MED_MAX_TIMES) throw new Error('Günde en fazla ' + MED_MAX_TIMES + ' doz girilebilir.');
  if (mode === 'days' && times.length !== 1) throw new Error('Verme saati girilmeli.');
  let every = 0;
  if (mode === 'days' || mode === 'diapers') {
    every = Number(data.every);
    if (!Number.isInteger(every) || every < 1 || every > MED_MAX_EVERY) throw new Error('Sayı 1 ile ' + MED_MAX_EVERY + ' arasında olmalı.');
  }
  const startDate = String(data.startDate || '');
  if (mode !== 'need' && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw new Error('Başlangıç günü seçilmeli.');
  return { name, mode, times, every, startDate: mode === 'need' ? '' : startDate, active: data.active !== false };
}

function daysBetween(a, b) { return Math.round((parseLocal(b + ' 12:00') - parseLocal(a + ' 12:00')) / DAY_MS); }

/**
 * Bugünkü ilaç dozları (İstanbul günü). meds: buildMed biçiminde, events: [{med, at}] (son ~36 saat),
 * diaperTimes: son ~36 saatin bez kayıt zamanları.
 * Saatli dozlarda her dozun penceresi komşu dozlarla arasının yarısına kadardır (tek dozda ±12 saat);
 * pencerede o ilacın kaydı varsa doz "verildi" sayılır.
 * state: 'given' | 'upcoming' | 'due' (saatine 30 dk kala – 30 dk sonrası) | 'late'
 * "N bezde 1" dozlarında time boştur; diapers = son verilişten (veya başlangıçtan) beri bez sayısı.
 */
export function medDoses(meds, events, nowMs, diaperTimes) {
  const day = fmt(nowMs, 'yyyy-MM-dd');
  const out = [];
  (meds || []).forEach((m) => {
    if (!m || m.active === false || !m.name) return;
    const mode = medMode(m);
    if (mode === 'need' || (m.startDate && m.startDate > day)) return;
    const given = (events || []).filter((e) => e.med === m.name).map((e) => Number(e.at));
    if (mode === 'diapers') {
      // shortcut: yalnız son 36 saat görülür; son veriliş daha eskiyse sayım 36 saatten başlar
      const since = Math.max(given.length ? Math.max(...given) : 0, m.startDate ? parseLocal(m.startDate + ' 00:00') : 0);
      const diapers = (diaperTimes || []).filter((t) => t > since).length;
      const every = Number(m.every) || 1;
      const state = diapers >= every ? 'late' : diapers >= every - 1 ? 'due' : 'upcoming';
      const last = given.length ? Math.max(...given) : 0;
      out.push({ name: m.name, time: '', ts: nowMs, state, givenAt: last, givenTime: last ? fmt(last, 'HH:mm') : '', diapers, every });
      return;
    }
    if (mode === 'days' && m.startDate && daysBetween(m.startDate, day) % (Number(m.every) || 1) !== 0) return;
    const slots = (m.times || []).map((t) => parseLocal(day + ' ' + t)).filter((x) => !isNaN(x)).sort((a, b) => a - b);
    slots.forEach((ts, i) => {
      const prev = i > 0 ? slots[i - 1] : slots[slots.length - 1] - DAY_MS;
      const next = i < slots.length - 1 ? slots[i + 1] : slots[0] + DAY_MS;
      const from = (prev + ts) / 2, to = (ts + next) / 2;
      const at = given.find((g) => g >= from && g < to) || 0;
      let state = 'late';
      if (at) state = 'given';
      else if (nowMs < ts - MED_DUE_BEFORE_MIN * 60000) state = 'upcoming';
      else if (nowMs <= ts + MED_LATE_AFTER_MIN * 60000) state = 'due';
      out.push({ name: m.name, time: fmt(ts, 'HH:mm'), ts, state, givenAt: at, givenTime: at ? fmt(at, 'HH:mm') : '' });
    });
  });
  return out.sort((a, b) => a.ts - b.ts);
}

/* ---------------- e-posta ---------------- */

// Gmail'de "ayse.yilmaz", "ayseyilmaz" ve "ayseyilmaz+x" aynı hesaptır
export function normEmail(e) {
  e = String(e || '').toLowerCase().trim();
  const at = e.lastIndexOf('@');
  if (at < 0) return e;
  let local = e.slice(0, at), domain = e.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.split('+')[0].replace(/\./g, '');
  return local + '@' + domain;
}

/* ---------------- kayıt oluşturma ---------------- */

function normalizeType(t) {
  t = String(t || '').trim();
  if (t === 'Bez' || t === 'Beslenme') return t;
  if (t.indexOf('Diğer') === 0) return 'Diğer';
  return '';
}

function num(v, min, max, label) {
  if (v === '' || v === null || v === undefined) return '';
  const n = Number(String(v).replace(',', '.'));
  if (isNaN(n) || n < min || n > max) throw new Error(label + ' ' + min + '–' + max + ' arasında olmalı (girilen: ' + v + ').');
  return n;
}

function parseEventTime(str, nowMs) {
  const ms = parseLocal(str);
  if (isNaN(ms) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(str || '')) throw new Error('Geçersiz tarih/saat: ' + str);
  if (ms > nowMs + 60 * 60 * 1000) throw new Error('Olay zamanı gelecekte olamaz (' + String(str).replace('T', ' ') + ').');
  return ms;
}

export function cleanItems(items) {
  if (!items || !items.length) return [];
  const out = [];
  for (const it of items) {
    if (!it) continue;
    const t = /^\d{2}:\d{2}$/.test(it.startTime || '') ? it.startTime : '';
    const araGaz = (it.araGaz === 'Evet' || it.araGaz === 'Hayır') ? it.araGaz : '';
    if (it.kind === 'meme') {
      if (it.meme !== 'Sol' && it.meme !== 'Sağ') throw new Error('Meme tarafı Sol veya Sağ olmalı.');
      const sure = num(it.sure, 1, 120, 'Emzirme süresi (dk)');
      if (sure === '') throw new Error('Emzirme süresi girilmeli.');
      out.push({ kind: 'meme', meme: it.meme, sure, startTime: t, araGaz });
    } else if (it.kind === 'mama' || it.kind === 'sut') {
      const ml = num(it.ml, 1, 500, 'Miktar (ml)');
      if (ml === '') throw new Error('Miktar (ml) girilmeli.');
      out.push({ kind: it.kind, ml, startTime: t, araGaz });
    }
  }
  if (out.length) out[0].araGaz = '';
  return out;
}

export function summarizeItems(items) {
  const s = { left: 0, right: 0, rounds: 0, first: '', last: '', mama: 0, sut: 0 };
  for (const it of items) {
    if (it.kind === 'meme') {
      s.rounds++;
      if (!s.first) s.first = it.meme;
      s.last = it.meme;
      if (it.meme === 'Sol') s.left += it.sure; else s.right += it.sure;
    } else if (it.kind === 'mama') s.mama += it.ml;
    else s.sut += it.ml;
  }
  s.totalMin = s.left + s.right;
  s.totalMl = s.mama + s.sut;
  const hasMeme = s.rounds > 0;
  if (hasMeme && s.totalMl > 0) s.type = 'Emzirme + Biberon';
  else if (hasMeme) s.type = 'Emzirme';
  else if (s.mama > 0 && s.sut > 0) s.type = 'Biberon (Mama + Sağılmış Süt)';
  else if (s.sut > 0) s.type = 'Sağılmış Süt';
  else s.type = 'Mama';
  return s;
}

// Türe göre değişen alanlar: kayıt türü değişince hepsi boşaltılır
const TYPE_FIELDS = ['diaperStatus', 'wet', 'dirty', 'rash', 'cream', 'poopAmount', 'poopColor', 'poopCons', 'photoUrl', 'hasPhoto',
  'feedType', 'firstBreast', 'lastBreast', 'leftMin', 'rightMin', 'totalMin', 'rounds', 'mamaMl', 'sutMl', 'totalMl',
  'gas', 'vomit', 'event', 'med', 'temp', 'note', 'items', 'nextFeedAt'];

/** Formdan gelen veriden tam bir kayıt belgesi üretir (eski Code.gs buildRow_ ile aynı kurallar). */
export function buildRecord(data, existing, email, nowMs = Date.now()) {
  const rec = existing ? { ...existing } : {};
  const oldPhotoUrl = existing ? (existing.photoUrl || '') : '';
  const oldHasPhoto = existing ? !!existing.hasPhoto : false;
  const oldPlan = existing ? Number(existing.nextFeedAt) || 0 : 0;

  const type = normalizeType(data.kayitTuru);
  if (!type) throw new Error('Kayıt türü seçilmeli.');
  const user = String(data.dolduran || '').trim();
  if (!user) throw new Error('Formu dolduran seçilmeli.');
  const eventAt = parseEventTime(data.olayZamani, nowMs);

  for (const f of TYPE_FIELDS) rec[f] = '';
  rec.items = [];
  rec.nextFeedAt = 0;
  rec.hasPhoto = false;

  if (!existing) {
    rec.id = String(data.id);
    rec.createdAt = nowMs;
    rec.email = email || '';
    rec.updatedAt = 0;
  } else {
    rec.updatedAt = nowMs;
    rec.updatedBy = email || '';
  }
  rec.user = user;
  rec.eventAt = eventAt;
  rec.type = type;
  rec.note = String(data.not || '').trim();

  if (type === 'Bez') {
    const ds = data.bezDurumu;
    if (DIAPER_STATES.indexOf(ds) < 0) throw new Error('Bez durumu seçilmeli.');
    const hasPoop = (ds === 'Sadece kaka' || ds === 'Çiş + kaka');
    rec.diaperStatus = ds;
    rec.wet = (ds === 'Sadece çiş' || ds === 'Çiş + kaka') ? 1 : 0;
    rec.dirty = hasPoop ? 1 : 0;
    rec.rash = data.pisik || 'Yok';
    rec.cream = (data.pisikKremi === 'Evet') ? 'Evet' : 'Hayır';
    if (hasPoop) {
      rec.poopAmount = String(data.kakaMiktari || '');
      rec.poopColor = String(data.kakaRengi || '');
      rec.poopCons = String(data.kakaKivami || '');
    }
    rec.photoUrl = oldPhotoUrl;
    rec.hasPhoto = oldHasPhoto;
  } else if (type === 'Beslenme') {
    const items = cleanItems(data.feedItems);
    if (!items.length) throw new Error('En az bir beslenme kalemi eklenmeli.');
    const s = summarizeItems(items);
    rec.feedType = s.type;
    if (s.rounds > 0) {
      rec.firstBreast = s.first; rec.lastBreast = s.last;
      rec.leftMin = s.left; rec.rightMin = s.right; rec.totalMin = s.totalMin; rec.rounds = s.rounds;
    }
    if (s.mama > 0) rec.mamaMl = s.mama;
    if (s.sut > 0) rec.sutMl = s.sut;
    if (s.totalMl > 0) rec.totalMl = s.totalMl;
    rec.gas = String(data.gaz || '');
    rec.vomit = String(data.kusma || '');
    rec.items = items;
    if (data.nextFeedMin !== undefined && data.nextFeedMin !== null && data.nextFeedMin !== '') {
      const mins = num(data.nextFeedMin, 15, 12 * 60, 'Sonraki beslenme aralığı (dk)');
      rec.nextFeedAt = eventAt + mins * 60000;
    } else if (data.clearPlan) {
      rec.nextFeedAt = 0;
    } else if (oldPlan && existing) {
      // Düzenlemede plan korunur; olay saati değiştiyse plan da aynı farkla kayar
      rec.nextFeedAt = oldPlan + (eventAt - Number(existing.eventAt));
    }
  } else {
    const ev = String(data.neOldu || '').trim();
    if (!ev) throw new Error('"Ne oldu?" seçilmeli.');
    rec.event = ev;
    rec.med = String(data.ilac || '').trim();
    rec.temp = num(data.ates, 34, 43, 'Ateş (°C)');
  }
  return rec;
}

/* ---------------- uygulamaya giden biçim ---------------- */

export function toClient(r) {
  const ev = Number(r.eventAt);
  const str = (k) => (r[k] === '' || r[k] === null || r[k] === undefined) ? '' : String(r[k]);
  const n = (k) => Number(r[k]) || 0;
  const nf = Number(r.nextFeedAt) || 0;
  return {
    id: String(r.id),
    ts: ev,
    time: fmt(ev, 'dd.MM.yyyy HH:mm'),
    isoDate: fmt(ev, 'yyyy-MM-dd'),
    isoTime: fmt(ev, 'HH:mm'),
    user: str('user'),
    type: str('type'),
    diaperStatus: str('diaperStatus'),
    rash: str('rash'),
    cream: str('cream'),
    poopAmount: str('poopAmount'),
    poopColor: str('poopColor'),
    poopCons: str('poopCons'),
    photoUrl: r.hasPhoto ? 'db' : str('photoUrl'),
    feedType: str('feedType'),
    items: Array.isArray(r.items) ? r.items : [],
    firstBreast: str('firstBreast'),
    lastBreast: str('lastBreast'),
    leftMin: n('leftMin'), rightMin: n('rightMin'), totalMin: n('totalMin'), rounds: n('rounds'),
    mamaMl: n('mamaMl'), sutMl: n('sutMl'), totalMl: n('totalMl'),
    gas: str('gas'), vomit: str('vomit'),
    event: str('event'), med: str('med'),
    temp: (r.temp === '' || r.temp === null || r.temp === undefined) ? '' : Number(r.temp),
    note: str('note'),
    nextFeedTs: nf,
    nextFeedTime: nf ? fmt(nf, 'dd.MM.yyyy HH:mm') : ''
  };
}

/* ---------------- durum kartı ---------------- */

/** recs: herhangi bir sırada son kayıtlar (en az ~100). */
export function computeStatus(recs, nowMs = Date.now()) {
  const res = {
    lastFeedTime: '', feedAgo: '', lastBreast: '', nextBreast: '',
    tailSide: '', tailMinutes: 0, nextRemaining: 0, minBreastMin: MIN_BREAST_MIN,
    nextFeedTs: 0, nextFeedTime: '', lastFeedTs: 0,
    lastDiaperTime: '', diaperAgo: '', lastDiaperTs: 0, lastDiaperBy: '',
    hasAnyDiaper: false, hasAnyCreamRecord: false, diapersSinceCream: 0, medEvents: [], diaperTimes: []
  };
  const rows = recs.filter((r) => r && r.eventAt).slice().sort((a, b) => b.eventAt - a.eventAt);
  // İlaç planı için son 36 saatte verilen ilaçlar (dozlar istemcide medDoses ile hesaplanır)
  res.medEvents = rows.filter((r) => r.type === 'Diğer' && r.med && r.eventAt > nowMs - 1.5 * DAY_MS)
    .map((r) => ({ med: String(r.med), at: r.eventAt }));
  res.diaperTimes = rows.filter((r) => r.type === 'Bez' && r.eventAt > nowMs - 1.5 * DAY_MS).map((r) => r.eventAt);
  let feedDone = false, breastDone = false, diaperDone = false, creamDone = false;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.type === 'Beslenme') {
      if (!feedDone) {
        res.lastFeedTime = fmt(r.eventAt, 'HH:mm');
        res.lastFeedTs = r.eventAt;
        res.feedAgo = agoText(r.eventAt, nowMs);
        if (Number(r.nextFeedAt)) {
          res.nextFeedTs = Number(r.nextFeedAt);
          res.nextFeedTime = fmt(res.nextFeedTs, 'HH:mm');
        }
        feedDone = true;
      }
      if (!breastDone && r.lastBreast) breastDone = accumulateTail(rows, i, res);
    } else if (r.type === 'Bez') {
      res.hasAnyDiaper = true;
      if (!diaperDone) {
        res.lastDiaperTime = fmt(r.eventAt, 'HH:mm');
        res.lastDiaperTs = r.eventAt;
        res.lastDiaperBy = String(r.user || '');
        res.diaperAgo = agoText(r.eventAt, nowMs);
        diaperDone = true;
      }
      if (!creamDone) {
        if (r.cream === 'Evet') { res.hasAnyCreamRecord = true; creamDone = true; }
        else res.diapersSinceCream++;
      }
    }
    if (feedDone && breastDone && diaperDone && creamDone) break;
  }
  return res;
}

/** Son memeden geriye: aynı tarafta art arda geçen dakikaları topla (15 dk kuralı). */
function accumulateTail(rows, startIdx, res) {
  let side = '', total = 0, stop = false;
  for (let i = startIdx; i < rows.length && !stop; i++) {
    const r = rows[i];
    if (r.type !== 'Beslenme' || !Array.isArray(r.items)) continue;
    for (let k = r.items.length - 1; k >= 0; k--) {
      const it = r.items[k];
      if (it.kind !== 'meme') continue;
      if (!side) side = it.meme;
      if (it.meme !== side) { stop = true; break; }
      total += Number(it.sure) || 0;
    }
  }
  if (!side) return false;
  res.lastBreast = side;
  res.tailSide = side;
  res.tailMinutes = total;
  if (total < MIN_BREAST_MIN) { res.nextBreast = side; res.nextRemaining = MIN_BREAST_MIN - total; }
  else { res.nextBreast = side === 'Sol' ? 'Sağ' : 'Sol'; res.nextRemaining = 0; }
  return true;
}

/* ---------------- doktor raporu ---------------- */

export function reportRange(startIso, endIso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startIso || '') || !/^\d{4}-\d{2}-\d{2}$/.test(endIso || '')) {
    throw new Error('Başlangıç ve bitiş tarihi seçilmeli.');
  }
  const start = parseLocal(startIso + ' 00:00');
  const endExcl = parseLocal(endIso + ' 00:00') + 86400000;
  if (endExcl <= start) throw new Error('Bitiş tarihi başlangıçtan önce olamaz.');
  const dayCount = Math.round((endExcl - start) / 86400000);
  if (dayCount > 92) throw new Error('En fazla 92 günlük rapor alınabilir.');
  return { start, endExcl, dayCount };
}

/** recs: [start, endExcl) aralığındaki kayıtlar. */
export function buildReport(recs, startIso, endIso) {
  const { start, endExcl, dayCount } = reportRange(startIso, endIso);
  const rows = recs.filter((r) => r && r.eventAt >= start && r.eventAt < endExcl).sort((a, b) => a.eventAt - b.eventAt);

  const days = {}, order = [];
  for (let d = 0; d < dayCount; d++) {
    const key = fmt(start + d * 86400000 + 12 * 3600000, 'yyyy-MM-dd');
    if (days[key]) continue;
    days[key] = { diapers: 0, wet: 0, dirty: 0, feeds: 0, breastFeeds: 0, breastMin: 0, left: 0, right: 0, sutMl: 0, mamaMl: 0, gaps: [] };
    order.push(key);
  }

  const colors = {}, alarms = [], events = [], feedTimes = [], timeline = [];
  const tot = { diapers: 0, wet: 0, dirty: 0, feeds: 0, breastFeeds: 0, breastMin: 0, left: 0, right: 0, sutMl: 0, mamaMl: 0 };
  const n = (v) => Number(v) || 0;

  for (const r of rows) {
    const key = fmt(r.eventAt, 'yyyy-MM-dd');
    const day = days[key];
    if (!day) continue;
    const when = fmt(r.eventAt, 'dd.MM.yyyy HH:mm');
    const evMin = minuteOfDay(r.eventAt);
    const note = String(r.note || '');
    if (r.type === 'Bez') {
      day.diapers++; tot.diapers++;
      const w = n(r.wet), dt = n(r.dirty);
      timeline.push({ day: key, m: evMin, t: w && dt ? 'both' : (dt ? 'dirty' : (w ? 'wet' : 'dry')), label: String(r.diaperStatus || ''),
                      amt: dt ? String(r.poopAmount || '') : '', col: dt ? String(r.poopColor || '') : '' });
      day.wet += w; day.dirty += dt; tot.wet += w; tot.dirty += dt;
      const col = String(r.poopColor || '');
      if (col) {
        const ck = col.indexOf('Diğer') === 0 ? 'Diğer' : col;
        colors[ck] = (colors[ck] || 0) + 1;
        if (ALARM_COLORS.indexOf(col) >= 0) alarms.push({ time: when, text: 'Kaka rengi: ' + col, note });
      }
      if (r.rash === 'Belirgin') alarms.push({ time: when, text: 'Belirgin pişik', note });
    } else if (r.type === 'Beslenme') {
      day.feeds++; tot.feeds++;
      if (n(r.rounds) > 0) { day.breastFeeds++; tot.breastFeeds++; }
      day.breastMin += n(r.totalMin); day.left += n(r.leftMin); day.right += n(r.rightMin);
      day.sutMl += n(r.sutMl); day.mamaMl += n(r.mamaMl);
      tot.breastMin += n(r.totalMin); tot.left += n(r.leftMin); tot.right += n(r.rightMin);
      tot.sutMl += n(r.sutMl); tot.mamaMl += n(r.mamaMl);
      for (const it of (Array.isArray(r.items) ? r.items : [])) {
        let im = evMin;
        if (/^\d{2}:\d{2}$/.test(it.startTime || '')) {
          im = Number(it.startTime.slice(0, 2)) * 60 + Number(it.startTime.slice(3, 5));
          if (im < evMin - 120) im += 1440;   // gece yarısını geçen öğün
        }
        if (it.kind === 'meme') timeline.push({ day: key, m: im, t: 'meme', dur: n(it.sure), label: it.meme + ' meme ' + n(it.sure) + ' dk' });
        else timeline.push({ day: key, m: im, t: 'bottle', label: (it.kind === 'mama' ? 'Mama ' : 'Sağılmış süt ') + n(it.ml) + ' ml' });
      }
      if (feedTimes.length) day.gaps.push((r.eventAt - feedTimes[feedTimes.length - 1]) / 60000);
      feedTimes.push(r.eventAt);
      if (r.vomit && String(r.vomit).indexOf('Fışkır') === 0) alarms.push({ time: when, text: 'Fışkırır tarzda kusma', note });
    } else {
      const hasTemp = !(r.temp === '' || r.temp === null || r.temp === undefined);
      events.push({ time: when, event: String(r.event || ''), med: String(r.med || ''), temp: hasTemp ? n(r.temp) : '', note });
      if (hasTemp && n(r.temp) >= 38) alarms.push({ time: when, text: 'Ateş ' + n(r.temp) + ' °C', note });
    }
  }

  let allGaps = [];
  const dayList = order.map((k) => {
    const x = days[k];
    allGaps = allGaps.concat(x.gaps);
    const avg = x.gaps.length ? x.gaps.reduce((a, b) => a + b, 0) / x.gaps.length : null;
    const p = k.split('-');
    return {
      iso: k, date: p[2] + '.' + p[1] + '.' + p[0], diapers: x.diapers, wet: x.wet, dirty: x.dirty, feeds: x.feeds, breastFeeds: x.breastFeeds,
      breastMin: x.breastMin, left: x.left, right: x.right, sutMl: x.sutMl, mamaMl: x.mamaMl,
      avgGapMin: avg === null ? '' : Math.round(avg),
      maxGapMin: x.gaps.length ? Math.round(Math.max(...x.gaps)) : ''
    };
  });

  const r1 = (v) => Math.round(v * 10) / 10;
  const colorList = Object.keys(colors).sort((a, b) => colors[b] - colors[a])
    .map((k) => ({ color: k, count: colors[k], alarm: ALARM_COLORS.indexOf(k) >= 0 }));

  return {
    start: fmt(start, 'dd.MM.yyyy'),
    end: fmt(endExcl - 1, 'dd.MM.yyyy'),
    dayCount,
    recordCount: rows.length,
    summary: {
      wetPerDay: r1(tot.wet / dayCount), dirtyPerDay: r1(tot.dirty / dayCount), feedsPerDay: r1(tot.feeds / dayCount),
      breastMinPerDay: Math.round(tot.breastMin / dayCount), leftTotal: tot.left, rightTotal: tot.right,
      sutMlPerDay: Math.round(tot.sutMl / dayCount), mamaMlPerDay: Math.round(tot.mamaMl / dayCount),
      diapersPerDay: r1(tot.diapers / dayCount),
      avgGapMin: allGaps.length ? Math.round(allGaps.reduce((a, b) => a + b, 0) / allGaps.length) : '',
      maxGapMin: allGaps.length ? Math.round(Math.max(...allGaps)) : '',
      totals: tot
    },
    days: dayList, colors: colorList, alarms, events, timeline
  };
}

/* ---------------- bildirim kararları ---------------- */

export const NOTIFY_DEFAULTS = { feed: 15, diaper: 180, night: false };
export const NOTIFY_FEED_OPTIONS = [0, 5, 10, 15, 20, 30];
export const NOTIFY_DIAPER_OPTIONS = [0, 120, 150, 180, 240, 300];
export const NIGHT_START = 23, NIGHT_END = 7;

function hoursText(min) {
  const h = min / 60;
  return (h % 1 ? String(h).replace('.', ',') : String(h)) + ' saattir';
}

/**
 * Bir kişinin ayarlarına ve durum kartına göre gönderilecek bildirimleri belirler.
 * settings: { feed, diaper, night, sent: { feed, diaper } }
 * Dönüş: { msgs: [{tag,title,body}], sent: {feed?, diaper?} (güncellenecek işaretler) }
 */
export function decideNotifications(st, settings, nowMs = Date.now()) {
  const n = { ...NOTIFY_DEFAULTS, ...(settings || {}) };
  const sent = n.sent || {};
  const msgs = [], upd = {};
  const hour = Number(fmt(nowMs, 'H'));
  const quiet = (hour >= NIGHT_START || hour < NIGHT_END) && !n.night;

  if (n.feed > 0 && st.nextFeedTs && sent.feed !== st.nextFeedTs &&
      nowMs >= st.nextFeedTs - n.feed * 60000 && nowMs < st.nextFeedTs + 30 * 60000) {
    const left = Math.round((st.nextFeedTs - nowMs) / 60000);
    let body = 'Planlanan beslenme: ' + st.nextFeedTime + (left > 0 ? ' (' + left + ' dk sonra)' : '') + '.';
    if (st.nextBreast) body += ' Sıradaki meme: ' + st.nextBreast + (Number(st.nextRemaining) > 0 ? ' (yarım kalmıştı, ~' + st.nextRemaining + ' dk)' : '') + '.';
    msgs.push({ tag: 'feed', title: left > 0 ? '🍼 Beslenme zamanı yaklaşıyor' : '🍼 Beslenme zamanı geldi', body });
    upd.feed = st.nextFeedTs;
  }

  if (n.diaper > 0 && st.lastDiaperTs && !quiet && sent.diaper !== st.lastDiaperTs &&
      nowMs - st.lastDiaperTs >= n.diaper * 60000) {
    msgs.push({ tag: 'diaper', title: '🧷 ' + hoursText(Math.floor((nowMs - st.lastDiaperTs) / 1800000) * 30) + ' bez değişmedi',
                body: 'Son bez değişimi: ' + st.lastDiaperTime + (st.lastDiaperBy ? ' (' + st.lastDiaperBy + ')' : '') + '.' });
    upd.diaper = st.lastDiaperTs;
  }
  return { msgs, sent: upd };
}

/* ---------------- Sheets yedeği için satır biçimi ---------------- */

export const SHEET_COLS = [
  ['id', 'Kayıt ID'], ['createdAt', 'Kayıt Zamanı'], ['updatedAt', 'Son Güncelleme'], ['user', 'Dolduran'], ['email', 'Hesap'],
  ['eventAt', 'Olay Zamanı'], ['type', 'Tür'], ['diaperStatus', 'Bez Durumu'], ['wet', 'Islak (1/0)'], ['dirty', 'Kirli (1/0)'],
  ['rash', 'Pişik'], ['cream', 'Pişik Kremi'], ['poopAmount', 'Kaka Miktarı'], ['poopColor', 'Kaka Rengi'], ['poopCons', 'Kaka Kıvamı'],
  ['photoUrl', 'Fotoğraf'], ['feedType', 'Beslenme Tipi'], ['firstBreast', 'İlk Meme'], ['lastBreast', 'Son Meme'],
  ['leftMin', 'Sol (dk)'], ['rightMin', 'Sağ (dk)'], ['totalMin', 'Toplam Emzirme (dk)'], ['rounds', 'Meme Tur Sayısı'],
  ['mamaMl', 'Mama (ml)'], ['sutMl', 'Sağılmış Süt (ml)'], ['totalMl', 'Toplam Biberon (ml)'], ['gas', 'Gaz'], ['vomit', 'Gelme'],
  ['event', 'Ne Oldu'], ['med', 'İlaç / Doz'], ['temp', 'Ateş (°C)'], ['note', 'Not'], ['itemsJson', 'Beslenme Kalemleri (JSON)'],
  ['nextFeedAt', 'Planlanan Sonraki Beslenme']
];
const DATE_KEYS = { createdAt: 1, updatedAt: 1, eventAt: 1, nextFeedAt: 1 };

/** Kayıt -> Sheets satırı (tarihler "yyyy-MM-dd HH:mm" metni; Sheets tarih olarak tanır). */
export function recordToSheetRow(r) {
  return SHEET_COLS.map(([k]) => {
    if (k === 'itemsJson') return (Array.isArray(r.items) && r.items.length) ? JSON.stringify(r.items) : '';
    if (k === 'photoUrl') return r.hasPhoto ? 'Uygulamada' : (r.photoUrl || '');
    const v = r[k];
    if (DATE_KEYS[k]) return Number(v) ? fmt(Number(v), 'yyyy-MM-dd') + ' ' + fmt(Number(v), 'HH:mm') : '';
    return v === undefined || v === null ? '' : v;
  });
}

/** Sheets satırı (biçimlenmemiş değerler, tarihler seri sayı) -> kayıt (taşıma için). */
export function sheetRowToRecord(row) {
  const r = {};
  SHEET_COLS.forEach(([k], i) => { r[k] = row[i] === undefined || row[i] === null ? '' : row[i]; });
  const serialToMs = (v) => (typeof v === 'number' && v > 0) ? Math.round((v - 25569) * 86400000) - TZ_OFFSET_MS : 0;
  for (const k of Object.keys(DATE_KEYS)) r[k] = serialToMs(r[k]);
  let items = [];
  try { items = r.itemsJson ? JSON.parse(r.itemsJson) : []; } catch (e) { items = []; }
  delete r.itemsJson;
  r.items = Array.isArray(items) ? items : [];
  r.id = String(r.id || '');
  r.hasPhoto = false;
  return r;
}

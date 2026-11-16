// node functions/test/logic.test.js  — yüklemeden önce çalışır; hata varsa yükleme durur.
import assert from 'node:assert/strict';
import * as L from '../logic.js';

const at = (s) => L.parseLocal(s);
const now = at('2026-11-16 18:00');
let n = 0;
const test = (name, fn) => { fn(); n++; console.log('✓', name); };

test('İstanbul saati biçimleme', () => {
  assert.equal(L.fmt(at('2026-11-16 00:05'), 'dd.MM.yyyy HH:mm'), '16.11.2026 00:05');
  assert.equal(L.fmt(at('2026-11-16 23:59'), 'yyyy-MM-dd'), '2026-11-16');
  assert.equal(L.minuteOfDay(at('2026-11-16 13:45')), 13 * 60 + 45);
});

test('Gmail e-posta eşleme', () => {
  assert.equal(L.normEmail('Ayse.Yilmaz+x@googlemail.com'), 'ayseyilmaz@gmail.com');
  assert.equal(L.normEmail('ali_veli@yahoo.com'), 'ali_veli@yahoo.com');
});

const feed = (id, time, items, extra = {}) => L.buildRecord({ id, kayitTuru: 'Beslenme', dolduran: 'Kemal', olayZamani: time, feedItems: items, ...extra }, null, 'k@x', now);
const bez = (id, time, ds, krem = 'Hayır', extra = {}) => L.buildRecord({ id, kayitTuru: 'Bez', dolduran: 'Ekin', olayZamani: time, bezDurumu: ds, pisikKremi: krem, ...extra }, null, 'e@x', now);

test('Beslenme kaydı özeti ve plan', () => {
  const r = feed('a1', '2026-11-16T14:00', [{ kind: 'meme', meme: 'Sol', sure: 10, startTime: '14:00' }, { kind: 'mama', ml: 60, startTime: '14:15' }], { nextFeedMin: 150 });
  assert.equal(r.feedType, 'Emzirme + Biberon');
  assert.equal(r.leftMin, 10);
  assert.equal(r.mamaMl, 60);
  assert.equal(r.nextFeedAt, at('2026-11-16 16:30'));
  const e = L.buildRecord({ id: 'a1', kayitTuru: 'Beslenme', dolduran: 'Kemal', olayZamani: '2026-11-16T14:30', feedItems: r.items }, r, 'k@x', now);
  assert.equal(e.nextFeedAt, at('2026-11-16 17:00'), 'düzenlemede plan kayar');
  assert.equal(e.createdAt, r.createdAt);
});

test('Hatalı girişler reddedilir', () => {
  assert.throws(() => feed('x', '2026-11-16T14:00', []), /En az bir beslenme/);
  assert.throws(() => feed('x', '2026-11-17T14:00', [{ kind: 'mama', ml: 50 }]), /gelecekte/);
  assert.throws(() => bez('x', '2026-11-16T14:00', 'Islak'), /Bez durumu/);
  assert.throws(() => L.buildRecord({ id: 'x', kayitTuru: 'Diğer', dolduran: 'K', olayZamani: '2026-11-16T10:00', neOldu: 'Ateş ölçüldü', ates: '45' }, null, '', now), /Ateş/);
});

test('Durum kartı: 15 dk meme kuralı ve krem sayacı', () => {
  const recs = [
    feed('f1', '2026-11-16T12:00', [{ kind: 'meme', meme: 'Sol', sure: 15 }, { kind: 'meme', meme: 'Sağ', sure: 6 }]),
    feed('f2', '2026-11-16T15:00', [{ kind: 'meme', meme: 'Sağ', sure: 5 }], { nextFeedMin: 150 }),
    bez('b1', '2026-11-16T11:00', 'Sadece çiş', 'Evet'),
    bez('b2', '2026-11-16T13:00', 'Çiş + kaka', 'Hayır', { kakaMiktari: 'Orta', kakaRengi: 'Yeşil' }),
    bez('b3', '2026-11-16T16:00', 'Kuru')
  ];
  const st = L.computeStatus(recs, now);
  assert.equal(st.lastFeedTime, '15:00');
  assert.equal(st.tailSide, 'Sağ');
  assert.equal(st.tailMinutes, 11);
  assert.equal(st.nextBreast, 'Sağ');
  assert.equal(st.nextRemaining, 4);
  assert.equal(st.nextFeedTime, '17:30');
  assert.equal(st.lastDiaperTime, '16:00');
  assert.equal(st.diapersSinceCream, 2);
  assert.equal(st.feedAgo, '3 sa önce');
});

test('Doktor raporu gün sayıları ve alarmlar', () => {
  const recs = [
    bez('b1', '2026-11-15T09:00', 'Çiş + kaka', 'Hayır', { kakaMiktari: 'Çok (taşma)', kakaRengi: 'Kırmızı/kanlı' }),
    bez('b2', '2026-11-16T09:00', 'Sadece çiş'),
    feed('f1', '2026-11-16T10:00', [{ kind: 'meme', meme: 'Sol', sure: 12, startTime: '10:00' }]),
    feed('f2', '2026-11-16T13:00', [{ kind: 'sut', ml: 40, startTime: '13:00' }])
  ];
  const rep = L.buildReport(recs, '2026-11-15', '2026-11-16');
  assert.equal(rep.dayCount, 2);
  assert.equal(rep.days[0].diapers, 1);
  assert.equal(rep.days[1].feeds, 2);
  assert.equal(rep.days[1].avgGapMin, 180);
  assert.equal(rep.alarms.length, 1);
  assert.equal(rep.timeline.length, 4);
  assert.equal(rep.timeline.find((t) => t.t === 'dirty' || t.t === 'both').col, 'Kırmızı/kanlı');
});

test('Bildirim kararları', () => {
  const st = { nextFeedTs: at('2026-11-16 18:10'), nextFeedTime: '18:10', nextBreast: 'Sol', nextRemaining: 0,
               lastDiaperTs: at('2026-11-16 14:30'), lastDiaperTime: '14:30', lastDiaperBy: 'Ekin' };
  const d = L.decideNotifications(st, { feed: 15, diaper: 180 }, now);
  assert.deepEqual(d.msgs.map((m) => m.tag), ['feed', 'diaper']);
  assert.match(d.msgs[1].title, /3,5 saattir/);
  const again = L.decideNotifications(st, { feed: 15, diaper: 180, sent: d.sent }, now);
  assert.equal(again.msgs.length, 0, 'aynı bildirim iki kez gitmez');
  const night = L.decideNotifications(st, { feed: 15, diaper: 180 }, at('2026-11-17 02:00'));
  assert.ok(!night.msgs.some((m) => m.tag === 'diaper'), 'gece bez bildirimi yok');
});

test('Sheets satırına ve geri dönüşüm', () => {
  const r = feed('f9', '2026-11-16T10:00', [{ kind: 'meme', meme: 'Sol', sure: 12 }], { nextFeedMin: 120 });
  const row = L.recordToSheetRow(r);
  assert.equal(row[L.SHEET_COLS.findIndex(([k]) => k === 'eventAt')], '2026-11-16 10:00');
  // Sheets seri sayıya çevrilmiş haliyle geri oku
  const serial = (ms) => (ms + 3 * 3600e3) / 86400e3 + 25569;
  const raw = L.SHEET_COLS.map(([k]) => (k === 'eventAt' || k === 'createdAt' || k === 'nextFeedAt') ? serial(r[k]) : (k === 'itemsJson' ? JSON.stringify(r.items) : (r[k] ?? '')));
  const back = L.sheetRowToRecord(raw);
  assert.equal(back.eventAt, r.eventAt);
  assert.equal(back.nextFeedAt, r.nextFeedAt);
  assert.equal(back.items[0].sure, 12);
});

console.log(n + ' test geçti');

/**
 * Bebek Takip — Firebase Cloud Functions (europe-west3)
 *  - notifyCron:  5 dakikada bir beslenme / bez hatırlatmaları
 *  - pushTest:    "Deneme bildirimi gönder"
 *  - sheetsBackup: her gece kayıtları Google Sheets'e yedekler (Günlük Özet / Doktor Raporu sayfaları çalışmaya devam eder)
 *  - adminImport / adminBackupNow: tek seferlik taşıma ve elle yedek (sadece yönetici)
 *
 * Ayarlar (GitHub "APP_CONFIG" gizli bilgisinden .env olarak gelir; depoda durmaz):
 *   APP_CONFIG = {"allowed":{"e-posta":"İsim",...},"admin":"e-posta","spreadsheetId":"...","photoFolderId":"..."}
 */
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { setGlobalOptions, logger } from 'firebase-functions/v2';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { google } from 'googleapis';
import * as L from './logic.js';

setGlobalOptions({ region: 'europe-west3', maxInstances: 2, memory: '256MiB' });
initializeApp();
const db = getFirestore();

const APP_URL = 'https://kemalparlaktuna.github.io/bebek-takip/';

function config() {
  let c = {};
  try { c = JSON.parse(process.env.APP_CONFIG || '{}'); } catch (e) { logger.error('APP_CONFIG okunamadı'); }
  c.allowed = c.allowed || {};
  return c;
}

/* ---------------- ortak ---------------- */

async function recentRecords(n = 150) {
  const snap = await db.collection('records').orderBy('eventAt', 'desc').limit(n).get();
  return snap.docs.map((d) => d.data());
}

/** Aynı cihaz anahtarı birden çok kez kayıtlıysa bir kez gönderilir. */
async function sendToTokens(tokens, msgs) {
  const out = { sent: 0, failed: 0, dead: [] };
  const uniq = [...new Set(tokens)];
  if (!uniq.length || !msgs.length) return out;
  const messages = [];
  for (const token of uniq) {
    for (const m of msgs) {
      messages.push({
        token,
        data: { title: m.title, body: m.body, tag: m.tag, url: APP_URL },
        webpush: { headers: { Urgency: 'high', TTL: '3600' } }
      });
    }
  }
  const res = await getMessaging().sendEach(messages);
  res.responses.forEach((r, i) => {
    if (r.success) { out.sent++; return; }
    out.failed++;
    const code = r.error && r.error.code;
    if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
      if (out.dead.indexOf(messages[i].token) < 0) out.dead.push(messages[i].token);
    } else {
      logger.warn('FCM hata', code, r.error && r.error.message);
    }
  });
  return out;
}

async function removeDevices(tokens) {
  if (!tokens.length) return;
  const snap = await db.collection('devices').where('token', 'in', tokens.slice(0, 30)).get();
  const batch = db.batch();
  snap.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
}

async function requireAllowed(req) {
  const email = req.auth && req.auth.token && req.auth.token.email_verified ? req.auth.token.email : '';
  if (!email) throw new HttpsError('unauthenticated', 'Giriş yapılmamış.');
  const me = L.normEmail(email);
  const doc = await db.doc('allowed/' + me).get();
  if (!doc.exists) throw new HttpsError('permission-denied', 'Bu hesabın erişim izni yok.');
  return me;
}

/** Yönetici kontrolü izin listesine bakmaz (ilk kurulumda liste henüz boştur). */
function requireAdmin(req) {
  const email = req.auth && req.auth.token && req.auth.token.email_verified ? req.auth.token.email : '';
  const admin = L.normEmail(config().admin || '');
  if (!email || !admin || L.normEmail(email) !== admin) throw new HttpsError('permission-denied', 'Bu işlem sadece yönetici içindir.');
}

/* ---------------- bildirimler ---------------- */

export const notifyCron = onSchedule({ schedule: 'every 5 minutes', timeZone: L.TZ, retryCount: 0 }, async () => {
  const devSnap = await db.collection('devices').get();
  if (devSnap.empty) return;
  const byUser = {};
  devSnap.docs.forEach((d) => {
    const x = d.data();
    if (!x.token || !x.email) return;
    (byUser[x.email] = byUser[x.email] || []).push(x.token);
  });

  const st = L.computeStatus(await recentRecords());
  const now = Date.now();
  const dead = [];
  for (const email of Object.keys(byUser)) {
    const ref = db.doc('notify/' + email);
    const settings = (await ref.get()).data() || {};
    const { msgs, sent } = L.decideNotifications(st, settings, now);
    if (!msgs.length) continue;
    const r = await sendToTokens(byUser[email], msgs);
    dead.push(...r.dead);
    const upd = {};
    for (const k of Object.keys(sent)) upd['sent.' + k] = sent[k];
    await ref.set({}, { merge: true });
    await ref.update(upd);
  }
  if (dead.length) await removeDevices(dead);
});

export const pushTest = onCall(async (req) => {
  const me = await requireAllowed(req);
  const snap = await db.collection('devices').where('email', '==', me).get();
  const tokens = snap.docs.map((d) => d.data().token).filter(Boolean);
  if (!tokens.length) throw new HttpsError('failed-precondition', 'Bu hesapta bildirime açık cihaz yok.');
  const r = await sendToTokens(tokens, [{ tag: 'test', title: '🔔 Deneme bildirimi', body: 'Bildirimler çalışıyor. ' + L.fmt(Date.now(), 'HH:mm') }]);
  if (r.dead.length) await removeDevices(r.dead);
  return { sent: r.sent, failed: r.failed, devices: tokens.length - r.dead.length };
});

/* ---------------- Google Sheets / Drive ---------------- */

async function googleClients() {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.readonly']
  });
  const client = await auth.getClient();
  return { sheets: google.sheets({ version: 'v4', auth: client }), drive: google.drive({ version: 'v3', auth: client }) };
}

const SHEET_DATA = 'Veri', SHEET_ITEMS = 'Beslenme Kalemleri';
const lastCol = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

async function allRecords() {
  const snap = await db.collection('records').orderBy('eventAt', 'asc').get();
  return snap.docs.map((d) => d.data());
}

/** Veri ve Beslenme Kalemleri sayfalarını veritabanının birebir kopyası yapar. */
async function backupToSheets() {
  const c = config();
  if (!c.spreadsheetId) throw new Error('spreadsheetId ayarı yok.');
  const meta = await db.doc('meta/migration').get();
  if (!meta.exists || !meta.data().done) { logger.info('Taşıma tamamlanmadan yedek alınmaz.'); return { skipped: true }; }
  const recs = await allRecords();
  if (!recs.length) return { skipped: true };
  const { sheets } = await googleClients();
  const W = L.SHEET_COLS.length, LC = lastCol(W);

  const rows = recs.map(L.recordToSheetRow);
  await sheets.spreadsheets.values.clear({ spreadsheetId: c.spreadsheetId, range: `${SHEET_DATA}!A2:${LC}` });
  await sheets.spreadsheets.values.update({
    spreadsheetId: c.spreadsheetId, range: `${SHEET_DATA}!A2:${LC}${rows.length + 1}`,
    valueInputOption: 'USER_ENTERED', requestBody: { values: rows }
  });

  const items = [];
  for (const r of recs) {
    if (r.type !== 'Beslenme' || !Array.isArray(r.items)) continue;
    r.items.forEach((it, i) => {
      const isMeme = it.kind === 'meme';
      items.push([r.id, L.fmt(r.eventAt, 'yyyy-MM-dd') + ' ' + L.fmt(r.eventAt, 'HH:mm'), r.user, i + 1, it.startTime || '',
        isMeme ? 'Emzirme' : (it.kind === 'mama' ? 'Mama' : 'Sağılmış Süt'), isMeme ? it.meme : '', isMeme ? it.sure : '',
        isMeme ? '' : it.ml, i > 0 ? (it.araGaz || '') : '']);
    });
  }
  await sheets.spreadsheets.values.clear({ spreadsheetId: c.spreadsheetId, range: `${SHEET_ITEMS}!A2:J` });
  if (items.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: c.spreadsheetId, range: `${SHEET_ITEMS}!A2:J${items.length + 1}`,
      valueInputOption: 'USER_ENTERED', requestBody: { values: items }
    });
  }
  return { records: rows.length, items: items.length };
}

export const sheetsBackup = onSchedule({ schedule: 'every day 03:30', timeZone: L.TZ, timeoutSeconds: 300 }, async () => {
  const r = await backupToSheets();
  logger.info('Sheets yedeği', r);
});

export const adminBackupNow = onCall({ timeoutSeconds: 300 }, async (req) => {
  requireAdmin(req);
  return backupToSheets();
});

/** İzin listesini APP_CONFIG'den veritabanına yazar (giriş kuralları bu listeye bakar). */
async function syncAllowed() {
  const allowed = config().allowed;
  const want = {};
  for (const [email, name] of Object.entries(allowed)) want[L.normEmail(email)] = String(name);
  const snap = await db.collection('allowed').get();
  const batch = db.batch();
  snap.docs.forEach((d) => { if (!want[d.id]) batch.delete(d.ref); });
  for (const [id, name] of Object.entries(want)) batch.set(db.doc('allowed/' + id), { name });
  await batch.commit();
  return Object.keys(want).length;
}

/**
 * Tek seferlik taşıma: Sheets "Veri" sayfasındaki kayıtları ve Drive'daki bez fotoğraflarını veritabanına kopyalar.
 * Tekrar çalıştırılabilir (aynı kayıtlar üzerine yazılır).
 */
export const adminImport = onCall({ timeoutSeconds: 540, memory: '1GiB' }, async (req) => {
  requireAdmin(req);
  const c = config();
  const allowedCount = await syncAllowed();
  const { sheets, drive } = await googleClients();
  const W = L.SHEET_COLS.length, LC = lastCol(W);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: c.spreadsheetId, range: `${SHEET_DATA}!A2:${LC}`,
    valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'SERIAL_NUMBER'
  });
  const rows = (res.data.values || []).map((r) => { const x = r.slice(); while (x.length < W) x.push(''); return x; });
  const recs = rows.map(L.sheetRowToRecord).filter((r) => r.id && r.eventAt && r.type);

  let photos = 0, photoFail = 0;
  for (const r of recs) {
    if (!r.photoUrl) continue;
    const m = String(r.photoUrl).match(/\/d\/([-\w]{20,})/) || String(r.photoUrl).match(/[?&]id=([-\w]{20,})/);
    if (!m) continue;
    try {
      const metaRes = await drive.files.get({ fileId: m[1], fields: 'mimeType,size', supportsAllDrives: true });
      if (Number(metaRes.data.size) > 700000) { photoFail++; continue; }   // çok büyük: Drive bağlantısı kalır
      const file = await drive.files.get({ fileId: m[1], alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' });
      const dataUrl = 'data:' + (metaRes.data.mimeType || 'image/jpeg') + ';base64,' + Buffer.from(file.data).toString('base64');
      await db.doc('photos/' + r.id).set({ data: dataUrl });
      r.hasPhoto = true;
      photos++;
    } catch (e) {
      photoFail++;
      logger.warn('Fotoğraf alınamadı', r.id, e.message);
    }
  }

  for (let i = 0; i < recs.length; i += 400) {
    const batch = db.batch();
    recs.slice(i, i + 400).forEach((r) => batch.set(db.doc('records/' + r.id), r));
    await batch.commit();
  }
  await db.doc('meta/migration').set({ done: true, at: Date.now(), records: recs.length, photos });
  return { allowed: allowedCount, records: recs.length, photos, photoFail };
});

/** İzin listesi değiştiğinde (APP_CONFIG güncellenip yeniden yüklendiğinde) çağrılır. */
export const adminSyncAllowed = onCall(async (req) => {
  requireAdmin(req);
  return { allowed: await syncAllowed() };
});

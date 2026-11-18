/**
 * Bebek Takip — uygulamanın veritabanı katmanı (Firebase Auth + Firestore + Messaging).
 * Eski Apps Script sunucusuyla aynı işlem adlarını ve cevap biçimlerini sağlar; ekran kodu değişmez.
 * Paketlenmiş hali: firebase-app.js (npm run build:client)
 */
import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithCredential, onAuthStateChanged, signOut as fbSignOut } from 'firebase/auth';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, getDoc, getDocs, setDoc, deleteDoc, collection, query, where, orderBy, limit,
  onSnapshot, getCountFromServer, writeBatch
} from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { getMessaging, getToken, deleteToken, isSupported } from 'firebase/messaging';
import * as L from '../functions/logic.js';

let app, auth, db, fns;
let me = '', myName = '';
const STATUS_LIMIT = 150;

export function init(config) {
  app = initializeApp(config);
  auth = getAuth(app);
  db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  fns = getFunctions(app, 'europe-west3');
}

function err(msg, code) { const e = new Error(msg); if (code) e.code = code; return e; }

/** Firestore hatalarını uygulamanın anladığı biçime çevirir. */
function wrap(p) {
  return p.catch((e) => {
    const c = e && e.code ? String(e.code).replace(/^functions\//, '') : '';
    if (c === 'permission-denied' || c === 'unauthenticated') throw err(e.message && /izin|yönetici|Giriş/.test(e.message) ? e.message : 'Erişim izni yok veya oturum kapandı.', 'AUTH');
    if (c === 'unavailable' || c === 'deadline-exceeded' || c === 'resource-exhausted') { const x = err('Sunucuya ulaşılamadı.'); x.retry = true; x.network = c === 'unavailable'; throw x; }
    throw e;
  });
}

/* ---------------- giriş ---------------- */

/** Mevcut oturumu bekler. Dönüş: { email, name } ya da null (giriş gerekli). */
export function authReady() {
  return new Promise((resolve) => {
    const off = onAuthStateChanged(auth, (u) => {
      off();
      if (!u) return resolve(null);
      checkAllowed(u).then(resolve, () => resolve(null));
    });
  });
}

async function checkAllowed(u) {
  const email = L.normEmail(u.email || '');
  let snap = await getDoc(doc(db, 'allowed', email)).catch(() => null);
  if (!snap || !snap.exists()) {
    // İlk kurulum: yönetici girişinde izin listesi henüz boşsa sunucudan doldur
    try { await httpsCallable(fns, 'adminSyncAllowed')(); snap = await getDoc(doc(db, 'allowed', email)); } catch (e) { /* yönetici değil */ }
  }
  if (!snap || !snap.exists()) {
    await fbSignOut(auth);
    throw err('Bu Google hesabının (' + u.email + ') uygulamaya erişim izni yok.', 'AUTH');
  }
  me = email;
  myName = snap.data().name || '';
  return { email: u.email, name: myName };
}

/** Google Identity Services'ten gelen kimlik belgesiyle giriş */
export async function signIn(idToken) {
  const cred = GoogleAuthProvider.credential(idToken);
  const res = await signInWithCredential(auth, cred);
  return checkAllowed(res.user);
}

export function signOut() { me = ''; myName = ''; stopWatchers(); return fbSignOut(auth); }
export function isSignedIn() { return !!(auth && auth.currentUser && me); }

/* ---------------- canlı durum ---------------- */

let lastRecs = null, statusWatchers = [], recordWatchers = [], unsubStatus = null;

function startStatusWatch() {
  if (unsubStatus) return;
  const q = query(collection(db, 'records'), orderBy('eventAt', 'desc'), limit(STATUS_LIMIT));
  unsubStatus = onSnapshot(q, (snap) => {
    lastRecs = snap.docs.map((d) => d.data());
    const st = L.computeStatus(lastRecs);
    statusWatchers.forEach((f) => { try { f(st); } catch (e) { console.error(e); } });
    if (!snap.metadata.hasPendingWrites) recordWatchers.forEach((f) => { try { f(); } catch (e) { console.error(e); } });
  }, (e) => console.warn('Durum dinleme hatası', e));
}

function stopWatchers() {
  if (unsubStatus) { unsubStatus(); unsubStatus = null; }
  if (unsubLock) { unsubLock(); unsubLock = null; }
  if (unsubMeds) { unsubMeds(); unsubMeds = null; }
  lastRecs = null;
}

/** Durum kartı her değiştiğinde çağrılır (başkasının kaydı dahil). */
export function onStatus(cb) { statusWatchers.push(cb); startStatusWatch(); }
/** Kayıtlar sunucuda değiştiğinde çağrılır (geçmiş listesini yenilemek için). */
export function onRecordsChanged(cb) { recordWatchers.push(cb); startStatusWatch(); }

async function currentStatus() {
  if (lastRecs) return L.computeStatus(lastRecs);
  const snap = await getDocs(query(collection(db, 'records'), orderBy('eventAt', 'desc'), limit(STATUS_LIMIT)));
  return L.computeStatus(snap.docs.map((d) => d.data()));
}

/* ---------------- eski sunucu işlemleri ---------------- */

const api = {
  async getBootstrap() {
    startStatusWatch();
    const snap = await getDocs(collection(db, 'allowed'));
    const people = [];
    snap.docs.forEach((d) => { const n = d.data().name; if (n && people.indexOf(n) < 0) people.push(n); });
    const u = auth.currentUser || {};
    return { email: u.email || '', photo: u.photoURL || '', displayName: u.displayName || '', defaultName: myName, people, status: await currentStatus() };
  },

  getLastStatus() { return currentStatus(); },

  async getRecordsPage(opts) {
    opts = opts || {};
    const pageSize = Math.min(100, Math.max(1, Number(opts.pageSize) || 10));
    let page = Math.max(1, Number(opts.page) || 1);
    const type = String(opts.type || 'ALL');
    const sinceTs = Number(opts.sinceTs) || 0;
    const dir = opts.sort === 'ASC' ? 'asc' : 'desc';
    const cons = [];
    if (type !== 'ALL') cons.push(where('type', '==', type));
    if (sinceTs) cons.push(where('eventAt', '>=', sinceTs));
    const base = query(collection(db, 'records'), ...cons, orderBy('eventAt', dir));
    let total;
    try { total = (await getCountFromServer(base)).data().count; } catch (e) { total = null; }   // internetsiz: sayım yok
    if (total !== null) {
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      if (page > totalPages) page = totalPages;
    }
    const snap = await getDocs(query(base, limit(page * pageSize)));
    const all = snap.docs.map((d) => d.data());
    if (total === null) total = all.length;
    const records = all.slice((page - 1) * pageSize, page * pageSize).map(L.toClient);
    return { records, total, page, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
  },

  async saveRecord(data) {
    data = data || {};
    if (!/^[A-Za-z0-9-]{8,64}$/.test(String(data.id || ''))) data.id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
    const rec = L.buildRecord(data, null, auth.currentUser ? auth.currentUser.email : '');
    const batch = writeBatch(db);
    if (rec.type === 'Bez' && data.photoBase64) {
      if (String(data.photoBase64).length > 990000) throw err('Fotoğraf çok büyük.');
      batch.set(doc(db, 'photos', rec.id), { data: data.photoBase64 });
      rec.hasPhoto = true;
    }
    batch.set(doc(db, 'records', rec.id), rec);   // aynı form kimliği tekrar gelirse aynı kaydın üzerine yazılır (çift kayıt olmaz)
    await batch.commit();
    return { success: true, id: rec.id, status: await currentStatus() };
  },

  async updateRecord(data) {
    data = data || {};
    const ref = doc(db, 'records', String(data.id || ''));
    const snap = await getDoc(ref);
    if (!snap.exists()) throw err('Kayıt bulunamadı (başka biri silmiş olabilir). Listeyi yenileyin.');
    const rec = L.buildRecord(data, snap.data(), auth.currentUser ? auth.currentUser.email : '');
    await setDoc(ref, rec);
    return { success: true, status: await currentStatus() };
  },

  async deleteRecord(id) {
    const ref = doc(db, 'records', String(id || ''));
    const snap = await getDoc(ref);
    if (!snap.exists()) throw err('Kayıt bulunamadı (zaten silinmiş olabilir). Listeyi yenileyin.');
    const batch = writeBatch(db);
    batch.delete(ref);
    if (snap.data().hasPhoto) batch.delete(doc(db, 'photos', String(id)));
    await batch.commit();
    return { success: true, status: await currentStatus() };
  },

  async getPhoto(id) {
    const snap = await getDoc(doc(db, 'photos', String(id || '')));
    if (!snap.exists()) throw err('Bu kayıtta uygulamada saklanan fotoğraf yok.');
    return snap.data().data;
  },

  async getReport(startIso, endIso) {
    const { start, endExcl } = L.reportRange(startIso, endIso);
    const snap = await getDocs(query(collection(db, 'records'), where('eventAt', '>=', start), where('eventAt', '<', endExcl), orderBy('eventAt', 'asc')));
    return L.buildReport(snap.docs.map((d) => d.data()), startIso, endIso);
  },

  /* ---- bildirim ayarları ---- */

  async getNotify() {
    const s = await getDoc(doc(db, 'notify', me));
    const d = s.exists() ? s.data() : {};
    const devs = await getDocs(query(collection(db, 'devices'), where('email', '==', me)));
    return {
      settings: { feed: d.feed ?? L.NOTIFY_DEFAULTS.feed, diaper: d.diaper ?? L.NOTIFY_DEFAULTS.diaper, night: !!d.night },
      devices: devs.docs.map((x) => ({ device: x.data().device, at: x.data().at })),
      serverReady: true
    };
  },

  async saveNotify(s) {
    s = s || {};
    const upd = {};
    if ('feed' in s) { const f = Number(s.feed); if (L.NOTIFY_FEED_OPTIONS.indexOf(f) < 0) throw err('Geçersiz beslenme ayarı.'); upd.feed = f; }
    if ('diaper' in s) { const d = Number(s.diaper); if (L.NOTIFY_DIAPER_OPTIONS.indexOf(d) < 0) throw err('Geçersiz bez ayarı.'); upd.diaper = d; }
    if ('night' in s) upd.night = !!s.night;
    await setDoc(doc(db, 'notify', me), upd, { merge: true });
    return { success: true };
  },

  async pushRegister(token, device) {
    token = String(token || '');
    if (token.length < 20) throw err('Geçersiz bildirim anahtarı.');
    await setDoc(doc(db, 'devices', await tokenId(token)), { token, email: me, device: String(device || 'Cihaz').slice(0, 60), at: Date.now() });
    return { success: true };
  },

  async pushUnregister(token) {
    try { await deleteDoc(doc(db, 'devices', await tokenId(String(token || '')))); } catch (e) { /* başka hesaba geçmiş olabilir */ }
    return { success: true };
  },

  async pushTest() {
    const r = await httpsCallable(fns, 'pushTest')();
    return r.data;
  }
};

async function tokenId(token) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 40);
}

/** Uygulamanın runApi() katmanı buradan çağırır. */
export function call(action, args) {
  if (!api[action]) return Promise.reject(err('Bilinmeyen işlem: ' + action));
  if (!isSignedIn()) return Promise.reject(err('Oturum kapalı.', 'AUTH'));
  return wrap(Promise.resolve().then(() => api[action].apply(null, args || [])));
}

/* ---------------- "şu an beslenme giriliyor" işareti ---------------- */

export const LOCK_STALE_MS = 3 * 60 * 1000;   // bu süre işaret yenilenmezse geçersiz sayılır
let unsubLock = null, lockHeartbeat = null, lockSeen = null;

/** Kilit değiştiğinde cb({ email, name, since, at } | null) çağrılır; süresi geçmiş kilit null sayılır. */
export function watchLock(name, cb) {
  if (unsubLock) unsubLock();
  unsubLock = onSnapshot(doc(db, 'locks', name), (s) => {
    const d = s.exists() ? s.data() : null;
    lockSeen = d;
    // Başkası işareti devraldıysa bizimki dakikalık yenilemeyle geri almasın
    if (lockHeartbeat && d && d.email && d.email !== me) { clearInterval(lockHeartbeat); lockHeartbeat = null; }
    cb(d && d.email && Date.now() - Number(d.at || 0) < LOCK_STALE_MS ? d : null);
  }, () => {});
}

export function myEmail() { return me; }

export async function acquireLock(name, who) {
  const data = { email: me, name: who || myName, since: Date.now(), at: Date.now() };
  const ref = doc(db, 'locks', name);
  try {
    const cur = await getDoc(ref);
    if (cur.exists() && cur.data().email === me && Date.now() - Number(cur.data().at || 0) < LOCK_STALE_MS) data.since = cur.data().since || data.since;
  } catch (e) { /* internetsiz */ }
  setDoc(ref, data).catch(() => {});
  clearInterval(lockHeartbeat);
  lockHeartbeat = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (lockSeen && lockSeen.email && lockSeen.email !== me) { clearInterval(lockHeartbeat); lockHeartbeat = null; return; }
    setDoc(ref, { ...data, at: Date.now() }).catch(() => {});
  }, 60 * 1000);
}

export async function releaseLock(name) {
  clearInterval(lockHeartbeat);
  lockHeartbeat = null;
  const ref = doc(db, 'locks', name);
  try {
    const cur = await getDoc(ref);
    if (cur.exists() && cur.data().email === me) await deleteDoc(ref);
  } catch (e) { /* internetsiz: süresi dolunca kendiliğinden düşer */ }
}

export function holdingLock() { return !!lockHeartbeat; }

/* ---------------- ilaç listesi (aile ortak) ---------------- */

// Silinen ilaç active:false olarak kalır; böylece liste hiç boşalmaz ve eski sabit D vitamini sadece bir kez eklenir
let unsubMeds = null;
export function watchMeds(cb) {
  if (unsubMeds) unsubMeds();
  unsubMeds = onSnapshot(collection(db, 'meds'), (snap) => {
    if (snap.empty && !snap.metadata.fromCache) {
      setDoc(doc(db, 'meds', 'd-vitamini'), { ...L.buildMed({ name: 'D Vitamini (3 damla)', times: [] }), updatedAt: Date.now(), by: me }).catch(() => {});
      return;
    }
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((m) => m.active !== false)
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'tr')));
  }, (e) => console.warn('İlaç listesi dinleme hatası', e));
}

export async function saveMed(id, data) {
  const med = L.buildMed(data);
  await setDoc(id ? doc(db, 'meds', id) : doc(collection(db, 'meds')), { ...med, updatedAt: Date.now(), by: me });
}

export async function deleteMed(id) {
  await setDoc(doc(db, 'meds', id), { active: false, updatedAt: Date.now(), by: me }, { merge: true });
}

export const medDoses = L.medDoses;
export const medMode = L.medMode;

/* ---------------- bildirim anahtarı (FCM) ---------------- */

export async function pushSupported() { try { return await isSupported(); } catch (e) { return false; } }

export async function getPushToken(vapidKey, swReg) {
  if (!(await pushSupported())) throw err('UNSUPPORTED');
  return getToken(getMessaging(app), { vapidKey, serviceWorkerRegistration: swReg });
}

export async function deletePushToken() {
  try { if (await pushSupported()) await deleteToken(getMessaging(app)); } catch (e) { /* önemli değil */ }
}

/* ---------------- yönetici ---------------- */

export async function adminImport(opts) { return (await httpsCallable(fns, 'adminImport', { timeout: 540000 })(opts || {})).data; }
export async function adminBackupNow() { return (await httpsCallable(fns, 'adminBackupNow', { timeout: 300000 })()).data; }

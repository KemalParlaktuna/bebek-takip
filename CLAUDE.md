# Bebek Takip — proje notları (Claude için)

Ailenin bebek bezi, beslenme ve diğer olayları (ilaç, ateş) kaydettiği, doktora rapor çıkardığı bir PWA.
Yaklaşık 7 aile üyesi aynı anda kullanır. Arayüz ve tüm metinler **Türkçe**.

## Kullanıcı hakkında
- Kemal: Python geliştiricisi, Rust öğreniyor, güç sistemleri alanında çalışıyor. Teknik açıklamayı anlar ama
  konsol adımlarını (Firebase / Google Cloud / GitHub ayarları) **adım adım, menü adlarıyla** ister.
- Kullanıcıyla **Türkçe** konuş. Kod yorumları ve commit mesajları da Türkçe.
- Gizliliğe önem veriyor: **depo herkese açık**. Depoya asla e-posta, kişi listesi, anahtar veya Sheets/Drive kimliği koyma.
- Az da olsa ücret çıkmasını kabul ediyor (Firebase Blaze), ama gereksiz maliyetten kaçın; bütçe uyarısı istemedi.

## Mimari (Kasım 2026'dan beri)
- **Ön yüz:** GitHub Pages — https://kemalparlaktuna.github.io/bebek-takip/ (main dalı kökü, statik dosyalar).
  - `index.html`: tüm arayüz ve uygulama mantığı (tek dosya, klasik `<script>` IIFE).
  - `config.js`: `window.APP_CONFIG` = Google OAuth `CLIENT_ID`, `FIREBASE` web ayarları, `FIREBASE_VAPID_KEY` (hepsi herkese açık değerler).
  - `firebase-app.js`: **derlenmiş** dosya, elle düzenleme. Kaynağı `src/backend.js` → `npm run build:client`.
  - `sw.js`: servis çalışanı (ağ öncelikli önbellek + push bildirimleri). **Ön yüzü her değiştirdiğinde `CACHE` sürümünü artır** (`bebek-takip-vNN`).
  - `beta/`: eski beta adresi, ana adrese yönlendirir; dokunma.
- **Veritabanı:** Firebase projesi `bebek-takip-bildirim` (proje no 807179326328), Firestore `europe-west3`, Blaze planı.
  - `records/{id}`: kayıtlar (tarihler ms sayı, boş alanlar `''`, beslenme kalemleri `items` dizisi).
  - `photos/{id}`: bez fotoğrafı (küçültülmüş data URL, <1 MB). Kayıtta `hasPhoto: true`.
  - `allowed/{normEmail}`: izinli hesaplar `{name}` — sadece sunucu yazar (`APP_CONFIG`'den).
  - `locks/beslenme`: "şu an beslenme giriliyor" işareti (3 dk yenilenmezse geçersiz).
  - `notify/{normEmail}`: kişisel bildirim ayarları; `devices/{tokenHash}`: bildirim alan cihazlar.
  - `meta/migration`: taşıma bilgisi; `cutover: true` olmadan Sheets yedeği çalışmaz.
- **Giriş:** Google Identity Services (eski GCP projesi `bebek-takip-514718`'deki OAuth istemcisi) → ID belgesi →
  Firebase Auth `signInWithCredential`. OAuth istemcisi Firebase Auth'ta "harici istemci kimliği" olarak izinli.
  Chrome/Android'de FedCM açık (`use_fedcm_for_button`). Firefox PWA'da Google açılır penceresi takılabiliyor; Chrome önerildi.
- **Güvenlik kuralları:** `firestore.rules` — yalnızca `allowed` listesindeki doğrulanmış Google hesapları okur/yazar.
  `normEmail` (Gmail'de nokta ve +etiket yok sayılır) kurallarda, `functions/logic.js`'te ve istemcide aynı olmalı.
- **Sunucu (Cloud Functions v2, Node 22, europe-west3)** — `functions/index.js`:
  - `notifyCron`: 5 dk'da bir; beslenme hatırlatması (plan saatinden X dk önce) ve "X saattir bez değişmedi" (gece 23–07 susturulabilir).
  - `pushTest`: deneme bildirimi (ana arayüzde düğmesi kaldırıldı, fonksiyon duruyor).
  - `sheetsBackup`: her gece 03:30 Firestore → Google Sheets ("Veri" ve "Beslenme Kalemleri" sayfaları birebir üzerine yazılır).
  - `adminImport`, `adminBackupNow`, `adminSyncAllowed`: yönetici işlemleri (arayüzde `?admin=1` ile Bildirimler sayfasında görünür).
  - Ayarlar `process.env.APP_CONFIG` (JSON: `allowed`, `admin`, `spreadsheetId`, `photoFolderId`) — GitHub gizli bilgisinden gelir.
  - Sheets/Drive erişimi fonksiyonların hizmet hesabıyla: `807179326328-compute@developer.gserviceaccount.com` (dosya ona paylaşıldı).
- **Ortak mantık:** `functions/logic.js` — hem istemci (`src/backend.js` içine paketlenir) hem sunucu kullanır:
  kayıt doğrulama (`buildRecord`), durum kartı ve 15 dk meme kuralı (`computeStatus`), doktor raporu (`buildReport`),
  bildirim kararları (`decideNotifications`), Sheets satır dönüşümü. Saat dilimi sabit UTC+3 (İstanbul, yaz saati yok).
- **İstemci veri katmanı:** `src/backend.js` eski Apps Script işlem adlarını ve cevap biçimlerini taklit eder
  (`getBootstrap`, `getRecordsPage`, `saveRecord`, `updateRecord`, `deleteRecord`, `getPhoto`, `getReport`, `getNotify`, …).
  `index.html` bunları `runApi().withSuccessHandler(..).işlem(..)` ile çağırır. Canlı güncelleme: `onStatus`, `onRecordsChanged`, `watchLock`.

## Yükleme (deploy)
- **Ön yüz:** main'e push → GitHub Pages birkaç dakikada yayınlar.
- **Sunucu:** `functions/**`, `firestore.rules`, `firestore.indexes.json`, `firebase.json` veya workflow değişip main'e
  push edilince `.github/workflows/firebase-deploy.yml` otomatik yükler (önce `functions/test/logic.test.js` çalışır).
  - Gizli bilgiler (GitHub Actions secrets): `FIREBASE_SA` (yükleme hesabı JSON anahtarı), `APP_CONFIG`.
  - Yükleme hesabı `github-deploy@bebek-takip-514718.iam.gserviceaccount.com` **başka projede**; bu yüzden workflow'da
    `GOOGLE_CLOUD_QUOTA_PROJECT=bebek-takip-bildirim` ve `project_id` ayarlı. Rolleri: Editor, Cloud Functions Admin,
    Cloud Run Admin, Service Account User, Firebase Admin (bebek-takip-bildirim projesinde).
  - Çalışma durumunu `gh run list -R KemalParlaktuna/bebek-takip` / `gh run view <id> --log` ile izle.
  - Aynı anda çok fonksiyon derlenirken Cloud Build bazen "unexpected error" veriyor; yeniden çalıştırmak çözüyor.
- Yerelde Firestore emülatörü yoksa (ör. ağ kısıtlı ortam) güvenlik kurallarını gerçek projede dene.

## Komutlar
```bash
npm install                      # kökte: esbuild + firebase (istemci paketi için)
npm run build:client             # src/backend.js + functions/logic.js -> firebase-app.js
npm test                         # functions/test/logic.test.js
(cd functions && npm install)    # sunucu bağımlılıkları
```
Arayüzü denemek için gerçek Firebase yerine sahte bir `firebase-app.js` (aynı dışa aktarımlar, localStorage'da veri)
yazıp Playwright ile `index.html`'i açmak iyi çalıştı.

## Özellikler (unutulmasın)
- Kayıt türleri: Bez (durum, pişik, krem, kaka miktarı/rengi/kıvamı, fotoğraf), Beslenme (meme/mama/sağılmış süt kalemleri,
  aralarda gaz, sonraki beslenme planı popup'ı: varsayılan 2,5 sa, ±15 dk), Diğer (ilaç seçimi listeden, ateş).
- 15 dk meme kuralı: aynı tarafta toplam <15 dk ise sonraki emzirme o memeyle başlar, kalan süre gösterilir.
- Pişik kremi sayacı durum kartında görünür; krem için popup ve bildirim **istenmedi** (kapalı).
- Telefonda sayı girişi uygulamanın kendi tuş takımıyla (sistem klavyesi açılmaz); tarih GG/AA/YYYY.
- Yarım kalan form taslağı telefonda saklanır (12 saat); kayıt gönderimi kuyrukla arka planda (internetsiz de çalışır).
- Android geri tuşu açık pencereyi kapatır, sekmeler arasında geri gider.
- Doktor raporu: günlük tablo, süreler "X sa Y dk", 24 saatlik haftalık zaman çizelgesi
  (üstte beslenme şeridi; ortada kaka: miktar=şekil daire/kare/üçgen, renk=gerçek kaka rengi; altta çiş ✓/✗; kuru bez iki satırda ✗).
- "Şu an beslenme giriliyor" işareti: diğerlerinin durum kartında görünür; aynı anda Beslenme açan için form kilitlenir,
  "Yine de ben gireyim" ile devralınır.

## Geçmiş
- Önce Google Apps Script + Sheets ile çalışıyordu (kod sadece Kemal'de, depoda yok). 16 Kasım 2026'da Firestore'a geçildi;
  Apps Script devre dışı bırakılıyor. Google Sheets artık yalnızca gece yedeği.

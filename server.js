let webpush = null;
try { webpush = require('web-push'); } catch (e) { console.error('Pachetul web-push lipsește, notificările sunt oprite:', e.message); }
const express = require('express'), multer = require('multer'), crypto = require('crypto'), path = require('path');

const PORT = process.env.PORT || 3000;
const PASS = process.env.ADMIN_PASSWORD;
const URL_ = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_KEY;
const BUCKET = process.env.SUPABASE_BUCKET || 'boutique';
if (!PASS || !URL_ || !KEY) { console.error('Variabile lipsă: ADMIN_PASSWORD, SUPABASE_URL, SUPABASE_KEY'); process.exit(1); }

const TOKEN = crypto.createHmac('sha256', crypto.createHash('sha256').update('s:' + PASS).digest('hex')).update('admin').digest('hex');
const OBJ = `${URL_}/storage/v1/object`;
const H = (extra = {}) => ({ apikey: KEY, ...(KEY.startsWith('eyJ') ? { Authorization: 'Bearer ' + KEY } : {}), ...extra });
const DEFAULT = () => ({ settings: { shop: 'Magazinul meu', holder: '', iban: '', wa: '' }, items: [], orders: [] });

const HASH = x => crypto.createHash('sha256').update(x + KEY).digest('hex').slice(0, 24);
const DBN = 'db-' + HASH('db') + '.json';
let legacyGone = false, lastBackup = '';
const fixDb = d => { d.orders = d.orders || []; d.categories = d.categories || []; d.promos = d.promos || []; d.waitlist = d.waitlist || []; d.trash = d.trash || []; d.subs = d.subs || []; d.reviews = d.reviews || []; return d; };
async function load() {
  let r = await fetch(`${OBJ}/${BUCKET}/${DBN}?t=${Date.now()}`, { headers: H() });
  if (!r.ok && (r.status === 400 || r.status === 404)) r = await fetch(`${OBJ}/${BUCKET}/db.json?t=${Date.now()}`, { headers: H() });
  if (r.ok) return fixDb(await r.json());
  if (r.status === 400 || r.status === 404) return DEFAULT();
  throw new Error('Citire imposibilă (' + r.status + ')');
}
async function save(d) {
  const put = name => fetch(`${OBJ}/${BUCKET}/${name}`, { method: 'POST', headers: H({ 'Content-Type': 'application/json', 'x-upsert': 'true' }), body: JSON.stringify(d) });
  const r = await put(DBN);
  if (!r.ok) throw new Error('Salvare imposibilă (' + r.status + ')');
  if (!legacyGone) { legacyGone = true; fetch(`${OBJ}/${BUCKET}/db.json`, { method: 'DELETE', headers: H() }).catch(() => {}); }
  const day = new Date().toISOString().slice(0, 10);
  if (day !== lastBackup) {
    lastBackup = day; put('bk-' + HASH(day) + '.json').catch(() => {});
    fetch(`${OBJ}/${BUCKET}/bk-${HASH(new Date(Date.now() - 15 * 864e5).toISOString().slice(0, 10))}.json`, { method: 'DELETE', headers: H() }).catch(() => {});
  }
}
async function putImage(f) {
  const name = crypto.randomBytes(12).toString('hex') + EXT[f.mimetype];
  const r = await fetch(`${OBJ}/${BUCKET}/${name}`, { method: 'POST', headers: H({ 'Content-Type': f.mimetype }), body: f.buffer });
  if (!r.ok) throw new Error('Încărcarea pozei a eșuat (' + r.status + ')');
  return `${OBJ}/public/${BUCKET}/${name}`;
}
const delImage = u => fetch(`${OBJ}/${BUCKET}/${path.basename(u)}`, { method: 'DELETE', headers: H() }).catch(() => {});

function isAdmin(req) {
  const m = /(?:^|;\s*)admin=([a-f0-9]+)/.exec(req.headers.cookie || '');
  return !!m && m[1].length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(m[1]), Buffer.from(TOKEN));
}
const needAdmin = (req, res, next) => isAdmin(req) ? next() : res.status(401).json({ error: 'Neautorizat' });
const wrap = fn => (req, res) => fn(req, res).catch(e => res.status(500).json({ error: e.message }));

const limiter = (max, ms) => { const m = new Map(); return (req, res, next) => {
  const now = Date.now(), t = m.get(req.ip) || { n: 0, t: now };
  if (now - t.t > ms) { t.n = 0; t.t = now; }
  if (t.n >= max) return res.status(429).json({ error: 'Prea multe încercări, mai încearcă mai târziu.' });
  t.n++; m.set(req.ip, t); next(); }; };
const throttle = limiter(10, 15 * 60e3);
const orderLimit = limiter(20, 60 * 60e3);
const oitems = o => o.items || [{ id: o.itemId, title: o.title, price: o.price }];
const lineQty = (o, key) => oitems(o).filter(i => i.id === key).reduce((t, i) => t + (i.qty || 1), 0);
const paidQty = (d, key) => d.orders.filter(o => o.paid).reduce((t, o) => t + lineQty(o, key), 0);
const pendQty = (d, key) => d.orders.filter(o => !o.paid).reduce((t, o) => t + lineQty(o, key), 0);
const stock = x => Math.max(1, parseInt(x.qty) || 1);
const leftOf = (d, key, x) => Math.max(0, stock(x) - paidQty(d, key) - pendQty(d, key));
const sync = d => d.items.forEach(it => {
  if (it.variants && it.variants.length) { it.variants.forEach(v => { v.sold = paidQty(d, it.id + ':' + v.id) >= stock(v); }); it.sold = it.variants.every(v => v.sold); }
  else it.sold = paidQty(d, it.id) >= stock(it);
});
const view = (d, it) => {
  if (it.variants && it.variants.length) {
    const variants = it.variants.map(v => { const left = leftOf(d, it.id + ':' + v.id, v); return { ...v, qty: stock(v), left, reserved: !v.sold && left === 0 }; });
    return { ...it, variants, reserved: !it.sold && variants.filter(v => !v.sold).every(v => v.reserved) };
  }
  const left = leftOf(d, it.id, it);
  return { ...it, qty: stock(it), left, reserved: !it.sold && left === 0 };
};
const resolve = (d, key) => {
  const [iid, vid] = String(key).split(':'), it = d.items.find(x => x.id === iid);
  if (!it) return null;
  if (vid) { const v = (it.variants || []).find(x => x.id === vid); return v ? { title: it.title + ' – ' + v.name, price: v.price, sold: !!v.sold, left: leftOf(d, key, v) } : null; }
  if ((it.variants || []).length) return null;
  return { title: it.title, price: it.price, sold: !!it.sold, left: leftOf(d, key, it) };
};
const hex = c => /^#[0-9a-f]{6}$/i.test(String(c || '')) ? String(c) : '';
const catOk = (d, c, sb) => { const cat = (d.categories || []).find(x => x.id === String(c || '')); return cat ? { cat: cat.id, sub: (cat.subs || []).some(x => x.id === String(sb || '')) ? String(sb) : undefined } : {}; };
const bd = b => ['Nou', 'Reducere', 'Recomandat', 'Ediție limitată', 'Ultimul exemplar'].includes(b) ? b : undefined;
const op = v => parseFloat(v) > 0 ? Math.round(parseFloat(v) * 100) / 100 : undefined;
const qn = x => Math.max(1, Math.min(999, parseInt(x) || 1));
const parseVariants = (raw, old) => {
  let a; try { a = JSON.parse(raw || '[]'); } catch (e) { a = []; }
  if (!Array.isArray(a)) a = [];
  const out = [];
  for (const v of a.slice(0, 20)) {
    const name = String(v.name || '').trim().slice(0, 60), price = parseFloat(v.price);
    if (!name || !isFinite(price) || price < 0) return null;
    const prev = (old || []).find(x => x.id === v.id);
    out.push({ id: prev ? prev.id : crypto.randomBytes(4).toString('hex'), name, price, sold: prev ? !!prev.sold : false, img: prev && v.img && v.img === prev.img ? prev.img : '', color: hex(v.color), qty: qn(v.qty) });
  }
  return out;
};

const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 30 }, fileFilter: (req, f, cb) => cb(null, !!EXT[f.mimetype]) });
const vfields = upload.fields([{ name: 'images', maxCount: 6 }, { name: 'vimgs', maxCount: 20 }]);
const applyVariantImages = async (req, variants) => {
  let idx = []; try { idx = JSON.parse(req.body.vimgIdx || '[]'); } catch (e) {}
  const files = (req.files && req.files.vimgs) || [];
  for (let k = 0; k < files.length; k++) { const v = variants[+idx[k]]; if (v) v.img = await putImage(files[k]); }
};

const DEFAULT_STEPS = [{ t: 'Comandă primită', d: 'Am primit comanda ta.', i: '📥' }, { t: 'Confirmată', d: 'Comanda ta a fost confirmată.', i: '✅' }, { t: 'Pregătită', d: 'Comanda ta este pregătită pentru predare.', i: '📦' }, { t: 'Predată', d: 'Comanda a fost predată. Mulțumim!', i: '🤝' }];
const getSteps = d => Array.isArray(d.steps) && d.steps.length >= 2 ? d.steps : DEFAULT_STEPS;
const stepOf = (o, N) => { if (Number.isInteger(o.step)) return Math.max(0, Math.min(N - 1, o.step)); const st = o.status || 'new'; return Math.min(N - 1, st === 'new' ? 0 : st === 'confirmed' ? 1 : st === 'ready' ? 2 : N - 1); };
const statusOf = (i, N) => i <= 0 ? 'new' : i >= N - 1 ? 'delivered' : i === 1 ? 'confirmed' : 'ready';
function setStep(d, o, i) {
  const N = getSteps(d).length; i = Math.max(0, Math.min(N - 1, i));
  o.step = i; o.status = statusOf(i, N); o.stepTimes = o.stepTimes || {};
  for (let k = 0; k <= i; k++) if (!o.stepTimes[k]) o.stepTimes[k] = new Date().toISOString();
  Object.keys(o.stepTimes).forEach(k => { if (+k > i) delete o.stepTimes[k]; });
}
function applyOrderUpdate(d, o, body) {
  const steps = getSteps(d), N = steps.length, prevI = stepOf(o, N), prevP = !!o.paid;
  if (body.paid !== undefined) o.paid = !!body.paid;
  let ni = Number.isInteger(body.step) ? body.step : null;
  if (ni === null && ['new', 'confirmed', 'ready', 'delivered'].includes(body.status)) ni = { new: 0, confirmed: 1, ready: 2, delivered: N - 1 }[body.status];
  if (ni !== null) setStep(d, o, ni);
  if (typeof body.note === 'string') o.note = body.note.slice(0, 300);
  if (typeof body.eta === 'string') o.eta = /^\d{4}-\d{2}-\d{2}$/.test(body.eta) ? body.eta : '';
  const cur = stepOf(o, N);
  if (ni !== null && cur > prevI) return steps[cur].t + (steps[cur].d ? ': ' + steps[cur].d : '');
  return o.paid && !prevP ? 'Plata a fost confirmată ✓' : '';
}
async function pushTo(d, pred, payload) {
  if (!webpush || !d.vapid || !d.subs || !d.subs.length) return;
  const list = d.subs.filter(pred); if (!list.length) return;
  const subj = process.env.PUSH_SUBJECT || 'mailto:' + (String(process.env.NOTIFY_EMAIL || '').split(/[,;\s]+/)[0] || 'admin@example.com');
  webpush.setVapidDetails(subj, d.vapid.publicKey, d.vapid.privateKey);
  const dead = [];
  await Promise.all(list.map(async x => {
    try { await webpush.sendNotification({ endpoint: x.endpoint, keys: x.keys }, JSON.stringify(payload)); }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) dead.push(x.endpoint); else console.error('Push:', e.statusCode, e.body); }
  }));
  if (dead.length) { const f = await load(); f.subs = f.subs.filter(x => !dead.includes(x.endpoint)); await save(f); }
}
const notify = async text => {
  const k = process.env.RESEND_API_KEY, list = String(process.env.NOTIFY_EMAIL || '').split(/[,;\s]+/).filter(Boolean);
  const bk = process.env.BREVO_API_KEY, bs = process.env.BREVO_SENDER;
  if (bk && bs && list.length) {
    try {
      const r = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': bk, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ sender: { name: 'Magazin', email: bs }, to: list.slice(0, 10).map(email => ({ email })), subject: text.split('\n')[0], textContent: text }) });
      const body = await r.text();
      if (!r.ok) console.error('Brevo a refuzat e-mailul:', r.status, body);
      return { ok: r.ok, detail: r.ok ? 'Trimis (Brevo) către: ' + list.join(', ') : 'Brevo: ' + r.status + ' ' + body.slice(0, 300) };
    } catch (e) { console.error('Brevo:', e); return { ok: false, detail: String(e.message || e) }; }
  }
  if (!k || !list.length) return { ok: false, detail: 'Lipsesc variabilele ' + [!k && 'RESEND_API_KEY', !list.length && 'NOTIFY_EMAIL'].filter(Boolean).join(' și ') + ' pe Render.' };
  const one = async to => {
    try {
      const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + k, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'Magazin <onboarding@resend.dev>', to: [to], subject: text.split('\n')[0], text }) });
      const body = await r.text();
      if (!r.ok) console.error('Resend a refuzat e-mailul către', to, r.status, body);
      return { to, ok: r.ok, body: r.status + ' ' + body };
    } catch (e) { console.error('Resend:', e); return { to, ok: false, body: String(e.message || e) }; }
  };
  const res = await Promise.all(list.slice(0, 10).map(one)), good = res.filter(x => x.ok), bad = res.filter(x => !x.ok);
  return { ok: bad.length === 0, detail: (good.length ? 'Trimis către: ' + good.map(x => x.to).join(', ') : '') + (bad.length ? (good.length ? '\n' : '') + 'Refuzat: ' + bad.map(x => x.to + ' (' + x.body.slice(0, 120) + ')').join('; ') : '') };
};
const eh = t => String(t || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const INDEX = require('fs').readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '50kb' }));
app.get('/manifest.webmanifest', wrap(async (req, res) => {
  let n = 'Magazin', col = '#0a0a0a'; try { const st0 = (await load()).settings; n = st0.shop; col = { ivory: '#fbf7f1', noir: '#0a0a0a', bordeaux: '#2c0711' }[st0.theme] || col; } catch (e) {}
  res.type('application/manifest+json').json({ name: n, short_name: n.slice(0, 12), start_url: '/', display: 'standalone', background_color: col, theme_color: col, icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }] });
}));
app.get('/', wrap(async (req, res) => {
  let theme = 'noir', shop = 'Magazin', title = 'Magazin', desc = 'Comandă direct de aici.', img = '';
  try {
    const d = await load(); title = shop = d.settings.shop; theme = d.settings.theme || 'noir';
    const it = d.items.find(x => x.id === req.query.a && !x.hidden), ct = (d.categories || []).find(x => x.id === req.query.cat);
    if (it) { title = it.title + ' – ' + d.settings.shop; desc = it.price + ' €' + (it.desc ? ' · ' + it.desc.slice(0, 120) : ''); img = it.imgs[0] || (it.variants || []).map(v => v.img).find(Boolean) || ''; }
    else if (ct) { title = ct.name + ' – ' + d.settings.shop; desc = 'Vezi articolele din categoria ' + ct.name; const f = d.items.find(x => !x.hidden && x.cat === ct.id && x.imgs[0]); img = f ? f.imgs[0] : ''; }
    else { const f = d.items.find(x => !x.hidden && x.imgs[0]); img = f ? f.imgs[0] : ''; }
  } catch (e) {}
  const tags = '<meta property="og:title" content="' + eh(title) + '"><meta property="og:description" content="' + eh(desc) + '"><meta property="og:type" content="website">' + (img ? '<meta property="og:image" content="' + eh(img) + '">' : '') + '<meta name="twitter:card" content="summary_large_image">';
  res.type('html').send(INDEX.replace('</head>', () => tags + '</head>').replace('__SHOP__', () => eh(shop)).replace('<html lang="ro">', () => '<html lang="ro" data-theme="' + (['ivory', 'noir', 'bordeaux'].includes(theme) ? theme : 'noir') + '">'));
}));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/shop', wrap(async (req, res) => { const d = await load(); res.json({ settings: isAdmin(req) ? d.settings : { shop: d.settings.shop, wa: d.settings.wa, about: d.settings.about, zone: d.settings.zone, vacation: !!d.settings.vacation, vacMsg: d.settings.vacMsg, theme: d.settings.theme || 'noir', reviews: d.settings.reviews, banner: d.settings.banner }, items: d.items.filter(it => !it.hidden || isAdmin(req)).map(it => view(d, it)), categories: d.categories || [], steps: getSteps(d) }); }));
app.get('/api/me', (req, res) => res.json({ admin: isAdmin(req) }));

app.post('/api/login', throttle, (req, res) => {
  const a = Buffer.from(String(req.body.password || '')), b = Buffer.from(PASS);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Parolă incorectă' });
  res.cookie('admin', TOKEN, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 30 * 864e5, path: '/' });
  res.json({ admin: true });
});
app.post('/api/logout', (req, res) => { res.clearCookie('admin', { path: '/' }); res.json({ admin: false }); });

app.put('/api/settings', needAdmin, wrap(async (req, res) => {
  const d = await load(), s = req.body || {}, c = (v, n) => String(v || '').trim().slice(0, n);
  d.settings = { shop: c(s.shop, 60) || 'Magazinul meu', holder: c(s.holder, 80), iban: c(s.iban, 40), wa: c(s.wa, 20), about: c(s.about, 1000), zone: c(s.zone, 100), vacation: !!s.vacation, vacMsg: c(s.vacMsg, 200), theme: ['ivory', 'noir', 'bordeaux'].includes(s.theme) ? s.theme : 'noir', reviews: c(s.reviews, 1500), banner: c(s.banner, 200) };
  await save(d); res.json(d.settings);
}));

app.post('/api/items', needAdmin, vfields, wrap(async (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 100);
  const variants = parseVariants(req.body.variants);
  if (variants === null) return res.status(400).json({ error: 'Fiecare variantă are nevoie de nume și preț' });
  const price = variants.length ? Math.min(...variants.map(v => v.price)) : parseFloat(req.body.price);
  if (!title || !isFinite(price) || price < 0) return res.status(400).json({ error: 'Titlul și prețul sunt obligatorii' });
  const imgs = [];
  for (const f of (req.files && req.files.images) || []) imgs.push(await putImage(f));
  await applyVariantImages(req, variants);
  const d = await load();
  const item = { id: crypto.randomBytes(6).toString('hex'), title, desc: String(req.body.desc || '').trim().slice(0, 2000), price, imgs, ...catOk(d, req.body.cat, req.body.sub), color: hex(req.body.color), badge: bd(req.body.badge), oldPrice: op(req.body.oldPrice), qty: qn(req.body.qty), variants: variants.length ? variants : undefined };
  d.items.unshift(item); await save(d);
  if (!item.hidden) pushTo(d, () => true, { title: '✨ Articol nou', body: item.title + ' – ' + item.price + ' €', tag: 'new-items', url: '/?a=' + item.id }).catch(() => {}); res.json(item);
}));

app.put('/api/items/:id', needAdmin, vfields, wrap(async (req, res) => {
  const d = await load(), it = d.items.find(x => x.id === req.params.id);
  if (!it) return res.status(404).json({ error: 'Negăsit' });
  const title = String(req.body.title || '').trim().slice(0, 100);
  const variants = parseVariants(req.body.variants, it.variants);
  if (variants === null) return res.status(400).json({ error: 'Fiecare variantă are nevoie de nume și preț' });
  const price = variants.length ? Math.min(...variants.map(v => v.price)) : parseFloat(req.body.price);
  if (!title || !isFinite(price) || price < 0) return res.status(400).json({ error: 'Titlul și prețul sunt obligatorii' });
  let keep = [];
  try { keep = JSON.parse(req.body.keep || '[]'); } catch (e) {}
  keep = keep.filter(u => it.imgs.includes(u));
  const added = [];
  for (const f of (req.files && req.files.images) || []) added.push(await putImage(f));
  const oldVImgs = (it.variants || []).map(v => v.img).filter(Boolean);
  await applyVariantImages(req, variants);
  const removed = it.imgs.filter(u => !keep.includes(u));
  it.title = title; it.desc = String(req.body.desc || '').trim().slice(0, 2000); it.price = price; delete it.cat; delete it.sub; Object.assign(it, catOk(d, req.body.cat, req.body.sub)); it.color = hex(req.body.color); it.badge = bd(req.body.badge); it.oldPrice = op(req.body.oldPrice); it.qty = qn(req.body.qty); it.variants = variants.length ? variants : undefined; sync(d);
  it.imgs = [...keep, ...added].slice(0, 6);
  await save(d); removed.forEach(delImage);
  const keepV = new Set(variants.map(v => v.img)); oldVImgs.filter(u => !keepV.has(u)).forEach(delImage);
  res.json(it);
}));

app.put('/api/categories', needAdmin, wrap(async (req, res) => {
  const d = await load(), raw = Array.isArray(req.body.categories) ? req.body.categories : [];
  const nm = v => String(v || '').trim().slice(0, 40);
  const nid = v => /^[a-f0-9]{1,16}$/.test(String(v || '')) ? String(v) : crypto.randomBytes(4).toString('hex');
  const cats = [];
  for (const c of raw.slice(0, 50)) {
    const name = nm(c.name); if (!name) continue;
    const subs = [];
    for (const x of (Array.isArray(c.subs) ? c.subs : []).slice(0, 50)) { const sn = nm(x.name); if (sn) subs.push({ id: nid(x.id), name: sn }); }
    cats.push({ id: nid(c.id), name, subs });
  }
  d.categories = cats;
  d.items.forEach(it => {
    const c = cats.find(x => x.id === it.cat);
    if (!c) { delete it.cat; delete it.sub; } else if (it.sub && !c.subs.some(x => x.id === it.sub)) delete it.sub;
  });
  await save(d); res.json(cats);
}));

const imgsOf = it => [...(it.imgs || []), ...(it.variants || []).map(v => v.img).filter(Boolean)];
const purgeTrash = d => { const lim = Date.now() - 30 * 864e5; d.trash = d.trash.filter(t => { if (t.at < lim) { imgsOf(t.item).forEach(delImage); return false; } return true; }); };
app.delete('/api/items/:id', needAdmin, wrap(async (req, res) => {
  const d = await load(), it = d.items.find(x => x.id === req.params.id);
  if (!it) return res.status(404).json({ error: 'Negăsit' });
  d.items = d.items.filter(x => x !== it); d.trash.unshift({ item: it, at: Date.now() }); purgeTrash(d);
  await save(d); res.json({ ok: true });
}));
app.get('/api/trash', needAdmin, wrap(async (req, res) => { const d = await load(); res.json(d.trash.map(t => ({ id: t.item.id, title: t.item.title, img: (t.item.imgs || [])[0] || '', at: t.at }))); }));
app.post('/api/trash/:id/restore', needAdmin, wrap(async (req, res) => {
  const d = await load(), i = d.trash.findIndex(t => t.item.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'Negăsit' });
  const [t] = d.trash.splice(i, 1); d.items.unshift(t.item); sync(d); await save(d); res.json({ ok: true });
}));
app.delete('/api/trash/:id', needAdmin, wrap(async (req, res) => {
  const d = await load(), t = d.trash.find(x => x.item.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Negăsit' });
  d.trash = d.trash.filter(x => x !== t); imgsOf(t.item).forEach(delImage); await save(d); res.json({ ok: true });
}));

app.get('/api/promos', needAdmin, wrap(async (req, res) => res.json((await load()).promos)));
app.put('/api/promos', needAdmin, wrap(async (req, res) => {
  const d = await load(), raw = Array.isArray(req.body.promos) ? req.body.promos : [], out = [];
  for (const p of raw.slice(0, 50)) {
    const code = String(p.code || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 20), value = parseFloat(p.value), type = p.type === 'amt' ? 'amt' : 'pct';
    if (!code || !(value > 0) || (type === 'pct' && value > 100) || out.some(x => x.code === code)) continue;
    const prev = d.promos.find(x => x.code === code);
    out.push({ code, type, value, max: Math.max(0, parseInt(p.max) || 0), active: p.active !== false, uses: prev ? prev.uses || 0 : 0 });
  }
  d.promos = out; await save(d); res.json(out);
}));
app.get('/api/promo/:code', limiter(60, 3600e3), wrap(async (req, res) => {
  const d = await load(), p = d.promos.find(x => x.code === String(req.params.code).toUpperCase());
  if (!p || !p.active || (p.max && (p.uses || 0) >= p.max)) return res.status(404).json({ error: 'Cod promoțional invalid sau expirat' });
  res.json({ code: p.code, type: p.type, value: p.value });
}));

app.post('/api/waitlist', limiter(30, 3600e3), wrap(async (req, res) => {
  const d = await load(), key = String(req.body.key || ''), u = resolve(d, key), c = (v, n) => String(v || '').trim().slice(0, n);
  const name = c(req.body.name, 80), phone = c(req.body.phone, 30);
  if (!u) return res.status(404).json({ error: 'Negăsit' });
  if (!name || phone.length < 3) return res.status(400).json({ error: 'Numele și telefonul sunt obligatorii' });
  if (!d.waitlist.some(w => w.key === key && w.phone === phone)) {
    d.waitlist.unshift({ id: crypto.randomBytes(5).toString('hex'), key, title: u.title, name, phone, date: new Date().toISOString() });
    d.waitlist = d.waitlist.slice(0, 500); await save(d);
    notify('⏳ Listă de așteptare: ' + name + ' (' + phone + ') vrea „' + u.title + '”');
  }
  res.json({ ok: true });
}));
app.get('/api/waitlist', needAdmin, wrap(async (req, res) => res.json((await load()).waitlist)));
app.delete('/api/waitlist/:id', needAdmin, wrap(async (req, res) => { const d = await load(); d.waitlist = d.waitlist.filter(w => w.id !== req.params.id); await save(d); res.json({ ok: true }); }));

app.post('/api/orders', orderLimit, wrap(async (req, res) => {
  const d = await load(), c = (v, n) => String(v || '').trim().slice(0, n);
  const name = c(req.body.name, 80), phone = c(req.body.phone, 30);
  if (d.settings.vacation) return res.status(403).json({ error: d.settings.vacMsg || 'Magazinul este în vacanță. Nu se primesc comenzi acum.' });
  const raw = (Array.isArray(req.body.itemIds) ? req.body.itemIds.map(String) : []).slice(0, 200), counts = new Map();
  raw.forEach(k => counts.set(k, (counts.get(k) || 0) + 1));
  if (!counts.size) return res.status(400).json({ error: 'Coș gol' });
  if (!name || phone.length < 3) return res.status(400).json({ error: 'Numele și telefonul sunt obligatorii' });
  const items = [];
  for (const [id, n] of counts) {
    const u = resolve(d, id);
    if (!u) return res.status(404).json({ error: 'Un articol din coș nu mai există' });
    if (u.sold || u.left === 0) return res.status(409).json({ error: '„' + u.title + '” nu este disponibil momentan' });
    if (u.left < n) return res.status(409).json({ error: 'Din „' + u.title + '” sunt disponibile doar ' + u.left + ' bucăți' });
    items.push({ id, title: u.title, price: u.price, qty: n });
  }
  if (d.orders.length >= 1000) return res.status(429).json({ error: 'Prea multe comenzi în așteptare' });
  const total = Math.round(items.reduce((t, i) => t + i.price * (i.qty || 1), 0) * 100) / 100;
  let discount = 0, promo = '';
  if (req.body.promo) {
    const pr = d.promos.find(x => x.code === String(req.body.promo).toUpperCase());
    if (!pr || !pr.active || (pr.max && (pr.uses || 0) >= pr.max)) return res.status(400).json({ error: 'Cod promoțional invalid sau expirat' });
    discount = Math.round((pr.type === 'pct' ? total * pr.value / 100 : Math.min(pr.value, total)) * 100) / 100;
    promo = pr.code; pr.uses = (pr.uses || 0) + 1;
  }
  const final = Math.round((total - discount) * 100) / 100;
  const oid = crypto.randomBytes(6).toString('hex');
  d.orders.unshift({ id: oid, status: 'new', step: 0, stepTimes: { 0: new Date().toISOString() }, items, total: final, subtotal: total, discount, promo, consent: new Date().toISOString(), gift: !!req.body.gift, giftNote: String(req.body.giftNote || '').slice(0, 200), name, phone, date: new Date().toISOString(), paid: false });
  await save(d);
  const LOW = parseInt(process.env.LOW_STOCK || '2'), low = [];
  for (const i of items) {
    const u = resolve(d, i.id), [iid, vid] = i.id.split(':'), it0 = d.items.find(x => x.id === iid), x0 = it0 && (vid ? (it0.variants || []).find(v => v.id === vid) : it0);
    if (u && x0 && stock(x0) > 1 && u.left <= LOW) low.push(u.title + ' – ' + (u.left === 0 ? 'stoc epuizat' : 'mai sunt ' + u.left));
  }
  notify('🛒 Comandă nouă de la ' + name + ' (' + phone + ')\n' + items.map(i => i.title + (i.qty > 1 ? ' ×' + i.qty : '')).join(', ') + '\nTotal: ' + final + ' €' + (promo ? ' (cod ' + promo + ')' : '') + (req.body.gift ? '\n🎁 Ambalaj cadou' + (req.body.giftNote ? ': ' + String(req.body.giftNote).slice(0, 200) : '') : '') + (low.length ? '\n\n⚠️ Stoc redus:\n' + low.map(l => '• ' + l).join('\n') : ''));
  pushTo(d, x => x.role === 'admin' && Date.now() - (x.adminAt || 0) < 30 * 864e5, { title: '🛒 Comandă nouă', body: name + ' – ' + final + ' €', tag: 'order', url: '/' }).catch(() => {});
  res.json({ ok: true, total: final, id: oid });
}));

app.get('/api/orders/:id/track', limiter(3000, 3600e3), wrap(async (req, res) => {
  const d = await load(), o = d.orders.find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'Negăsit' });
  const steps = getSteps(d), N = steps.length, cur = stepOf(o, N), times = o.stepTimes || {};
  res.json({
    id: o.id, status: statusOf(cur, N), step: cur, steps: steps.map((x, i) => ({ t: x.t, d: x.d, i: x.i || '', time: times[i] || (i === 0 ? o.date : '') })),
    eta: o.eta || '', paid: !!o.paid, total: o.total, note: o.note || '', date: o.date,
    review: (() => { const r = d.reviews.find(x => x.orderId === o.id); return r ? { rating: r.rating, text: r.text, approved: r.approved } : null; })(),
    items: oitems(o).map(i => ({ title: i.title, qty: i.qty || 1, price: i.price })), discount: o.discount || 0, promo: o.promo || '', shop: d.settings.shop
  });
}));

app.put('/api/items/:id/hidden', needAdmin, wrap(async (req, res) => {
  const d = await load(), it = d.items.find(x => x.id === req.params.id);
  if (!it) return res.status(404).json({ error: 'Negăsit' });
  it.hidden = !!req.body.hidden; await save(d); res.json({ ok: true });
}));

app.post('/api/test-email', needAdmin, wrap(async (req, res) => res.json(await notify('✅ Test e-mail de la magazin\nDacă primești acest mesaj, alertele de comandă funcționează.'))));

app.get('/api/push/key', limiter(120, 3600e3), wrap(async (req, res) => {
  if (!webpush) return res.status(503).json({ error: 'Notificările nu sunt disponibile pe server (pachetul web-push lipsește).' });
  const d = await load();
  if (!d.vapid) { d.vapid = webpush.generateVAPIDKeys(); await save(d); }
  res.json({ key: d.vapid.publicKey });
}));
app.post('/api/push/subscribe', limiter(60, 3600e3), wrap(async (req, res) => {
  if (!webpush) return res.status(503).json({ error: 'Notificările nu sunt disponibile pe server (pachetul web-push lipsește).' });
  const d = await load(), sub = req.body.subscription || {}, k = sub.keys || {};
  if (!d.vapid || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || typeof k.p256dh !== 'string' || typeof k.auth !== 'string') return res.status(400).json({ error: 'Abonare invalidă' });
  const orders = (Array.isArray(req.body.orders) ? req.body.orders : []).map(String).slice(0, 50);
  const role = isAdmin(req) ? 'admin' : 'customer', ex = d.subs.find(x => x.endpoint === sub.endpoint);
  if (ex) { ex.keys = { p256dh: k.p256dh, auth: k.auth }; ex.role = role; ex.adminAt = role === 'admin' ? Date.now() : 0; ex.orders = [...new Set([...(ex.orders || []), ...orders])].slice(0, 50); }
  else { if (d.subs.length >= 2000) return res.status(429).json({ error: 'Prea multe abonări' }); d.subs.push({ endpoint: sub.endpoint, keys: { p256dh: k.p256dh, auth: k.auth }, role, adminAt: role === 'admin' ? Date.now() : 0, orders, created: new Date().toISOString() }); }
  await save(d); res.json({ ok: true, role });
}));
app.post('/api/push/unsubscribe', limiter(60, 3600e3), wrap(async (req, res) => {
  const d = await load(); d.subs = d.subs.filter(x => x.endpoint !== String(req.body.endpoint || '')); await save(d); res.json({ ok: true });
}));
app.post('/api/push/test', limiter(20, 3600e3), wrap(async (req, res) => {
  if (!webpush) return res.status(503).json({ error: 'Notificările nu sunt disponibile pe server (pachetul web-push lipsește).' });
  const d = await load(), ep = String(req.body.endpoint || '');
  if (!d.subs.some(x => x.endpoint === ep)) return res.status(404).json({ error: 'Nu ești abonat la notificări' });
  await pushTo(d, x => x.endpoint === ep, { title: '🔔 Test notificare', body: 'Notificările funcționează!', tag: 'test', url: '/' });
  res.json({ ok: true });
}));

app.post('/api/reviews', limiter(20, 3600e3), wrap(async (req, res) => {
  const d = await load(), o = d.orders.find(x => x.id === String(req.body.orderId || ''));
  if (!o) return res.status(404).json({ error: 'Negăsit' });
  const rating = Math.round(parseFloat(req.body.rating));
  if (!(rating >= 1 && rating <= 5)) return res.status(400).json({ error: 'Alege o notă de la 1 la 5 stele.' });
  const text = String(req.body.text || '').trim().slice(0, 500), name = String(o.name || '').trim().split(/\s+/)[0].slice(0, 30);
  let r = d.reviews.find(x => x.orderId === o.id);
  if (r) { r.rating = rating; r.text = text; r.approved = false; r.date = new Date().toISOString(); }
  else { r = { id: crypto.randomBytes(5).toString('hex'), orderId: o.id, name, rating, text, approved: false, date: new Date().toISOString() }; d.reviews.unshift(r); d.reviews = d.reviews.slice(0, 1000); }
  await save(d);
  notify('⭐ Recenzie nouă: ' + rating + '/5 de la ' + name + (text ? '\n' + text : ''));
  pushTo(d, x => x.role === 'admin' && Date.now() - (x.adminAt || 0) < 30 * 864e5, { title: '⭐ Recenzie nouă', body: name + ' – ' + rating + '/5', tag: 'review', url: '/' }).catch(() => {});
  res.json({ ok: true });
}));
app.get('/api/reviews', wrap(async (req, res) => {
  const d = await load(), L = d.reviews.filter(r => r.approved);
  res.json({ avg: L.length ? Math.round(L.reduce((t, r) => t + r.rating, 0) / L.length * 10) / 10 : 0, count: L.length, reviews: L.slice(0, 100).map(r => ({ name: r.name, rating: r.rating, text: r.text, reply: r.reply || '', date: r.date })) });
}));
app.get('/api/reviews/all', needAdmin, wrap(async (req, res) => res.json((await load()).reviews)));
app.put('/api/reviews/:id', needAdmin, wrap(async (req, res) => {
  const d = await load(), r = d.reviews.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Negăsit' });
  if (req.body.approved !== undefined) r.approved = !!req.body.approved; if (typeof req.body.reply === 'string') r.reply = req.body.reply.slice(0, 300); await save(d); res.json({ ok: true });
}));
app.delete('/api/reviews/:id', needAdmin, wrap(async (req, res) => {
  const d = await load(); d.reviews = d.reviews.filter(x => x.id !== req.params.id); await save(d); res.json({ ok: true });
}));

app.post('/api/orders-bulk', needAdmin, wrap(async (req, res) => {
  const d = await load(), want = new Set((Array.isArray(req.body.ids) ? req.body.ids : []).map(String)), todo = [];
  for (const o of d.orders) { if (!want.has(o.id)) continue; const text = applyOrderUpdate(d, o, req.body); if (text) todo.push([o, text]); }
  sync(d); await save(d); res.json({ ok: true, changed: todo.length });
  todo.forEach(([o, text]) => pushTo(d, x => (x.orders || []).includes(o.id), { title: 'Comanda ta', body: text, tag: 'ord-' + o.id, url: '/?comanda=' + o.id }).catch(() => {}));
}));

const DASHKEY = crypto.createHash('sha256').update('dash:' + PASS).digest('hex');
const dsig = ts => crypto.createHmac('sha256', DASHKEY).update(String(ts)).digest('hex');
function dashOk(req) {
  const m = /(?:^|;\s*)dash=(\d+)\.([a-f0-9]+)/.exec(req.headers.cookie || ''); if (!m) return false;
  const ts = +m[1]; if (Date.now() - ts > 2 * 3600e3 || ts > Date.now() + 60e3) return false;
  const sig = dsig(ts); return m[2].length === sig.length && crypto.timingSafeEqual(Buffer.from(m[2]), Buffer.from(sig));
}
const needDash = (req, res, next) => dashOk(req) ? next() : res.status(401).json({ error: 'Cod necesar' });
const tot = o => o.total != null ? o.total : oitems(o).reduce((t, i) => t + (i.price || 0) * (i.qty || 1), 0);
function dashData(d, days) {
  const now = Date.now(), since = now - days * 864e5, r2 = n => Math.round(n * 100) / 100;
  const all = d.orders, inr = all.filter(o => new Date(o.date).getTime() >= since), paid = inr.filter(o => o.paid);
  const sum = a => r2(a.reduce((t, o) => t + tot(o), 0));
  const findItem = id => { const k = String(id).split(':')[0]; return d.items.find(x => x.id === k) || ((d.trash || []).find(t => t.item.id === k) || {}).item; };
  const catOf = id => { const it = findItem(id), c = it && d.categories.find(x => x.id === it.cat); return c ? c.name : 'Fără categorie'; };
  const top = {}, cats = {};
  inr.forEach(o => oitems(o).forEach(i => {
    const q = i.qty || 1, v = (i.price || 0) * q, t = top[i.title] || (top[i.title] = { title: i.title, units: 0, paidUnits: 0, revenue: 0 });
    t.units += q;
    if (o.paid) { t.paidUnits += q; t.revenue += v; const cn = catOf(i.id); cats[cn] = (cats[cn] || 0) + v; }
  }));
  const day = t => new Date(t).toISOString().slice(0, 10), n = Math.min(days, 90), daily = [];
  for (let k = n - 1; k >= 0; k--) daily.push({ d: day(now - k * 864e5), rev: 0, n: 0 });
  const di = Object.fromEntries(daily.map((x, i) => [x.d, i]));
  inr.forEach(o => { const i = di[day(new Date(o.date).getTime())]; if (i !== undefined) { daily[i].n++; if (o.paid) daily[i].rev += tot(o); } });
  const mk = t => t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0'), monthly = [];
  for (let k = 11; k >= 0; k--) { const t = new Date(now); t.setDate(1); t.setMonth(t.getMonth() - k); monthly.push({ m: mk(t), rev: 0, n: 0 }); }
  const mi = Object.fromEntries(monthly.map((x, i) => [x.m, i]));
  all.forEach(o => { const i = mi[mk(new Date(o.date))]; if (i !== undefined) { monthly[i].n++; if (o.paid) monthly[i].rev += tot(o); } });
  daily.forEach(x => x.rev = r2(x.rev)); monthly.forEach(x => x.rev = r2(x.rev));
  const cust = {};
  all.forEach(o => {
    const ph = String(o.phone || '').replace(/\D/g, ''), t = new Date(o.date).getTime(), c = cust[ph] || (cust[ph] = { name: o.name, phone: o.phone, n: 0, spent: 0, first: t, last: t });
    c.n++; if (o.paid) c.spent += tot(o); c.first = Math.min(c.first, t); c.last = Math.max(c.last, t);
  });
  const cl = Object.values(cust);
  const stp = getSteps(d), st = stp.map(x => ({ t: x.t, n: 0 })); all.forEach(o => { st[stepOf(o, stp.length)].n++; });
  const views = d.items.map(it => view(d, it)), low = [], soldOut = [];
  views.forEach(it => {
    if (it.variants && it.variants.length) { it.variants.forEach(v => { if (v.sold) soldOut.push(it.title + ' – ' + v.name); else if (v.qty > 1 && v.left <= 2) low.push({ title: it.title + ' – ' + v.name, left: v.left, qty: v.qty }); }); }
    else if (it.sold) soldOut.push(it.title);
    else if (it.qty > 1 && it.left <= 2) low.push({ title: it.title, left: it.left, qty: it.qty });
  });
  const wl = {}; (d.waitlist || []).forEach(w => { wl[w.title] = (wl[w.title] || 0) + 1; });
  const rv = d.reviews || [], rvA = rv.filter(r => r.approved);
  const avg = a => a.length ? Math.round(a.reduce((t, r) => t + r.rating, 0) / a.length * 10) / 10 : 0;
  const stt = { new: 'nouă', confirmed: 'confirmată', ready: 'pregătită', delivered: 'predată' };
  return {
    days, kpi: { orders: inr.length, paidOrders: paid.length, revenue: sum(paid), pending: sum(inr.filter(o => !o.paid)), avgOrder: paid.length ? r2(sum(paid) / paid.length) : 0, units: inr.reduce((t, o) => t + oitems(o).reduce((a, i) => a + (i.qty || 1), 0), 0), discount: r2(inr.reduce((t, o) => t + (o.discount || 0), 0)), paidRate: inr.length ? Math.round(paid.length / inr.length * 100) : 0, customers: cl.length, repeat: cl.filter(c => c.n >= 2).length, newCustomers: cl.filter(c => c.first >= since).length },
    daily, monthly, topItems: Object.values(top).map(t => ({ ...t, revenue: r2(t.revenue) })).sort((a, b) => b.units - a.units).slice(0, 12),
    categories: Object.entries(cats).map(([name, v]) => ({ name, revenue: r2(v) })).sort((a, b) => b.revenue - a.revenue),
    pipeline: st, topCustomers: cl.sort((a, b) => b.spent - a.spent).slice(0, 8).map(c => ({ name: c.name, phone: c.phone, orders: c.n, spent: r2(c.spent) })),
    stock: { items: d.items.length, hidden: d.items.filter(i => i.hidden).length, low, soldOut: soldOut.slice(0, 30), trash: (d.trash || []).length },
    promos: (d.promos || []).map(p => ({ code: p.code, type: p.type, value: p.value, uses: p.uses || 0, active: p.active !== false, discount: r2(all.filter(o => o.promo === p.code).reduce((t, o) => t + (o.discount || 0), 0)) })),
    waitlist: { total: (d.waitlist || []).length, top: Object.entries(wl).map(([title, n]) => ({ title, n })).sort((a, b) => b.n - a.n).slice(0, 6) },
    reviews: { count: rv.length, approved: rvA.length, pending: rv.length - rvA.length, avg: avg(rvA) },
    push: { admin: (d.subs || []).filter(x => x.role === 'admin').length, customers: (d.subs || []).filter(x => x.role !== 'admin').length },
    recent: all.slice(0, 10).map(o => ({ name: o.name, total: r2(tot(o)), status: getSteps(d)[stepOf(o, getSteps(d).length)].t, paid: !!o.paid, date: o.date, items: oitems(o).map(i => i.title + ((i.qty || 1) > 1 ? ' ×' + i.qty : '')).join(', ') }))
  };
}
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.post('/api/dash/login', throttle, (req, res) => {
  const a = Buffer.from(String(req.body.password || '')), b = Buffer.from(PASS);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Cod incorect' });
  const ts = Date.now();
  res.cookie('dash', ts + '.' + dsig(ts), { httpOnly: true, sameSite: 'strict', secure: req.secure, maxAge: 2 * 3600e3, path: '/' });
  res.json({ ok: true });
});
app.post('/api/dash/logout', (req, res) => { res.clearCookie('dash', { path: '/' }); res.json({ ok: true }); });
app.get('/api/dash/data', needDash, wrap(async (req, res) => {
  const days = [7, 30, 90, 365].includes(parseInt(req.query.days)) ? parseInt(req.query.days) : 30;
  res.json(dashData(await load(), days));
}));
app.get('/api/dash/orders.csv', needDash, wrap(async (req, res) => {
  const d = await load(), q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const rows = [['Data', 'Nr comandă', 'Nume', 'Telefon', 'Articole', 'Total', 'Plătită', 'Stare']].concat(d.orders.map(o => [o.date, o.id, o.name, o.phone, oitems(o).map(i => i.title + ((i.qty || 1) > 1 ? ' ×' + i.qty : '')).join(', '), tot(o), o.paid ? 'Da' : 'Nu', o.status || 'new']));
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="comenzi.csv"' });
  res.send('\ufeff' + rows.map(r => r.map(q).join(';')).join('\r\n'));
}));
app.get('/api/dash/backup', needDash, wrap(async (req, res) => {
  const d = await load(); res.set('Content-Disposition', 'attachment; filename="backup-' + new Date().toISOString().slice(0, 10) + '.json"'); res.json(d);
}));

app.get('/api/backup', needAdmin, wrap(async (req, res) => {
  const d = await load();
  res.set('Content-Disposition', 'attachment; filename="backup-' + new Date().toISOString().slice(0, 10) + '.json"'); res.json(d);
}));

const copyImg = async u => { try { const r = await fetch(u); if (!r.ok) return ''; const ct = (r.headers.get('content-type') || 'image/jpeg').split(';')[0]; return await putImage({ mimetype: EXT[ct] ? ct : 'image/jpeg', buffer: Buffer.from(await r.arrayBuffer()) }); } catch (e) { return ''; } };
app.post('/api/items/:id/duplicate', needAdmin, wrap(async (req, res) => {
  const d = await load(), it = d.items.find(x => x.id === req.params.id);
  if (!it) return res.status(404).json({ error: 'Negăsit' });
  const copy = JSON.parse(JSON.stringify(it));
  copy.id = crypto.randomBytes(6).toString('hex'); copy.title = (it.title + ' (copie)').slice(0, 100); delete copy.sold;
  copy.imgs = (await Promise.all((it.imgs || []).map(copyImg))).filter(Boolean);
  for (const v of copy.variants || []) { v.id = crypto.randomBytes(4).toString('hex'); v.sold = false; if (v.img) v.img = await copyImg(v.img); }
  d.items.unshift(copy); await save(d); res.json(copy);
}));

app.get('/api/orders', needAdmin, wrap(async (req, res) => res.json((await load()).orders)));

app.put('/api/orders/:id', needAdmin, wrap(async (req, res) => {
  const d = await load(), o = d.orders.find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'Negăsit' });
  const text = applyOrderUpdate(d, o, req.body);
  sync(d); await save(d); res.json(o);
  if (text) pushTo(d, x => (x.orders || []).includes(o.id), { title: 'Comanda ta', body: text, tag: 'ord-' + o.id, url: '/?comanda=' + o.id }).catch(() => {});
}));

app.put('/api/steps', needAdmin, wrap(async (req, res) => {
  const d = await load(), raw = Array.isArray(req.body.steps) ? req.body.steps : [], out = [];
  for (const x of raw.slice(0, 10)) { const t = String(x.t || '').trim().slice(0, 40), ds = String(x.d || '').trim().slice(0, 120); if (t) out.push({ t, d: ds, i: String(x.i || '').trim().slice(0, 4) }); }
  if (out.length < 2) return res.status(400).json({ error: 'Trebuie cel puțin 2 etape.' });
  d.steps = out;
  d.orders.forEach(o => { const i = o.status === 'delivered' ? out.length - 1 : stepOf(o, out.length); o.step = i; o.status = statusOf(i, out.length); });
  await save(d); res.json(out);
}));

app.delete('/api/orders/:id', needAdmin, wrap(async (req, res) => {
  const d = await load();
  d.orders = d.orders.filter(x => x.id !== req.params.id); sync(d); await save(d); res.json({ ok: true });
}));

app.use((err, req, res, next) => res.status(400).json({ error: err.message || 'Eroare' }));
let lastSummary = '';
const SUM_HOUR = parseInt(process.env.SUMMARY_HOUR || '8'), TZ = process.env.SUMMARY_TZ || 'Europe/Bucharest';
setInterval(async () => {
  try {
    const now = new Date(), day = now.toLocaleDateString('en-CA', { timeZone: TZ }), hour = parseInt(now.toLocaleString('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }));
    if (hour !== SUM_HOUR || lastSummary === day) return;
    lastSummary = day;
    const d = await load(), open = d.orders.filter(o => (o.status || 'new') !== 'delivered');
    if (!open.length) return;
    const st = { new: 'nouă', confirmed: 'confirmată', ready: 'pregătită' };
    await notify('📋 Rezumat zilnic: ' + open.filter(o => (o.status || 'new') === 'new').length + ' de confirmat, ' + open.filter(o => !o.paid).length + ' neplătite\n\n' + open.slice(0, 20).map(o => '• ' + o.name + ' (' + o.phone + ') – ' + oitems(o).map(i => i.title + (i.qty > 1 ? ' ×' + i.qty : '')).join(', ') + ' – ' + o.total + ' € – ' + st[o.status || 'new'] + (o.paid ? ', plătită' : ', neplătită')).join('\n'));
  } catch (e) { console.error('Rezumat:', e); }
}, 10 * 60e3);
app.listen(PORT, () => console.log('Magazin pornit pe portul ' + PORT));

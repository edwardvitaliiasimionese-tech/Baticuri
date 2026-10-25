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
const fixDb = d => { d.orders = d.orders || []; d.categories = d.categories || []; return d; };
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
const bd = b => ['Nou', 'Reducere', 'Recomandat'].includes(b) ? b : undefined;
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

const notify = async text => {
  const k = process.env.RESEND_API_KEY, to = process.env.NOTIFY_EMAIL;
  if (!k || !to) return { ok: false, detail: 'Lipsesc variabilele ' + [!k && 'RESEND_API_KEY', !to && 'NOTIFY_EMAIL'].filter(Boolean).join(' și ') + ' pe Render.' };
  try {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + k, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'Magazin <onboarding@resend.dev>', to: [to], subject: text.split('\n')[0], text }) });
    const body = await r.text();
    if (!r.ok) console.error('Resend a refuzat e-mailul:', r.status, body);
    return { ok: r.ok, detail: r.ok ? 'E-mail trimis către ' + to : 'Resend: ' + r.status + ' ' + body.slice(0, 300) };
  } catch (e) { console.error('Resend:', e); return { ok: false, detail: String(e.message || e) }; }
};
const eh = t => String(t || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const INDEX = require('fs').readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '50kb' }));
app.get('/manifest.webmanifest', wrap(async (req, res) => {
  let n = 'Magazin'; try { n = (await load()).settings.shop; } catch (e) {}
  res.type('application/manifest+json').json({ name: n, short_name: n.slice(0, 12), start_url: '/', display: 'standalone', background_color: '#f472b6', theme_color: '#f472b6', icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }] });
}));
app.get('/', wrap(async (req, res) => {
  let title = 'Magazin', desc = 'Comandă direct de aici.', img = '';
  try {
    const d = await load(); title = d.settings.shop;
    const it = d.items.find(x => x.id === req.query.a && !x.hidden);
    if (it) { title = it.title + ' – ' + d.settings.shop; desc = it.price + ' €' + (it.desc ? ' · ' + it.desc.slice(0, 120) : ''); img = it.imgs[0] || (it.variants || []).map(v => v.img).find(Boolean) || ''; }
    else { const f = d.items.find(x => !x.hidden && x.imgs[0]); img = f ? f.imgs[0] : ''; }
  } catch (e) {}
  const tags = '<meta property="og:title" content="' + eh(title) + '"><meta property="og:description" content="' + eh(desc) + '"><meta property="og:type" content="website">' + (img ? '<meta property="og:image" content="' + eh(img) + '">' : '') + '<meta name="twitter:card" content="summary_large_image">';
  res.type('html').send(INDEX.replace('</head>', tags + '</head>'));
}));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/shop', wrap(async (req, res) => { const d = await load(); res.json({ settings: isAdmin(req) ? d.settings : { shop: d.settings.shop, wa: d.settings.wa, about: d.settings.about, zone: d.settings.zone }, items: d.items.filter(it => !it.hidden || isAdmin(req)).map(it => view(d, it)), categories: d.categories || [] }); }));
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
  d.settings = { shop: c(s.shop, 60) || 'Magazinul meu', holder: c(s.holder, 80), iban: c(s.iban, 40), wa: c(s.wa, 20), about: c(s.about, 1000), zone: c(s.zone, 100) };
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
  d.items.unshift(item); await save(d); res.json(item);
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

app.delete('/api/items/:id', needAdmin, wrap(async (req, res) => {
  const d = await load(), it = d.items.find(x => x.id === req.params.id);
  if (!it) return res.status(404).json({ error: 'Negăsit' });
  d.items = d.items.filter(x => x !== it); await save(d);
  [...it.imgs, ...(it.variants || []).map(v => v.img).filter(Boolean)].forEach(delImage);
  res.json({ ok: true });
}));

app.post('/api/orders', orderLimit, wrap(async (req, res) => {
  const d = await load(), c = (v, n) => String(v || '').trim().slice(0, n);
  const name = c(req.body.name, 80), phone = c(req.body.phone, 30);
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
  const oid = crypto.randomBytes(6).toString('hex');
  d.orders.unshift({ id: oid, status: 'new', items, total, name, phone, date: new Date().toISOString(), paid: false });
  await save(d);
  notify('🛒 Comandă nouă de la ' + name + ' (' + phone + ')\n' + items.map(i => i.title + (i.qty > 1 ? ' ×' + i.qty : '')).join(', ') + '\nTotal: ' + total + ' €');
  res.json({ ok: true, total, id: oid });
}));

app.get('/api/orders/:id/track', limiter(3000, 3600e3), wrap(async (req, res) => {
  const d = await load(), o = d.orders.find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'Negăsit' });
  res.json({ status: o.status || 'new', paid: !!o.paid, total: o.total, note: o.note || '', date: o.date, items: oitems(o).map(i => ({ title: i.title, qty: i.qty || 1 })) });
}));

app.put('/api/items/:id/hidden', needAdmin, wrap(async (req, res) => {
  const d = await load(), it = d.items.find(x => x.id === req.params.id);
  if (!it) return res.status(404).json({ error: 'Negăsit' });
  it.hidden = !!req.body.hidden; await save(d); res.json({ ok: true });
}));

app.post('/api/test-email', needAdmin, wrap(async (req, res) => res.json(await notify('✅ Test e-mail de la magazin\nDacă primești acest mesaj, alertele de comandă funcționează.'))));

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
  if (req.body.paid !== undefined) o.paid = !!req.body.paid; if (['new', 'confirmed', 'ready', 'delivered'].includes(req.body.status)) o.status = req.body.status; if (typeof req.body.note === 'string') o.note = req.body.note.slice(0, 300); sync(d); await save(d); res.json(o);
}));

app.delete('/api/orders/:id', needAdmin, wrap(async (req, res) => {
  const d = await load();
  d.orders = d.orders.filter(x => x.id !== req.params.id); sync(d); await save(d); res.json({ ok: true });
}));

app.use((err, req, res, next) => res.status(400).json({ error: err.message || 'Eroare' }));
app.listen(PORT, () => console.log('Magazin pornit pe portul ' + PORT));

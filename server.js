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

async function load() {
  const r = await fetch(`${OBJ}/${BUCKET}/db.json?t=${Date.now()}`, { headers: H() });
  if (r.ok) { const d = await r.json(); d.orders = d.orders || []; return d; }
  if (r.status === 400 || r.status === 404) return DEFAULT();   // fichier pas encore créé
  throw new Error('Citire imposibilă (' + r.status + ')');
}
async function save(d) {
  const r = await fetch(`${OBJ}/${BUCKET}/db.json`, { method: 'POST', headers: H({ 'Content-Type': 'application/json', 'x-upsert': 'true' }), body: JSON.stringify(d) });
  if (!r.ok) throw new Error('Salvare imposibilă (' + r.status + ')');
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
const isPaid = (d, key) => d.orders.some(o => o.paid && oitems(o).some(i => i.id === key));
const isPending = (d, key) => d.orders.some(o => !o.paid && oitems(o).some(i => i.id === key));
const sync = d => d.items.forEach(it => {
  if (it.variants && it.variants.length) { it.variants.forEach(v => { v.sold = isPaid(d, it.id + ':' + v.id); }); it.sold = it.variants.every(v => v.sold); }
  else it.sold = isPaid(d, it.id);
});
const view = (d, it) => {
  if (it.variants && it.variants.length) {
    const variants = it.variants.map(v => ({ ...v, reserved: !v.sold && isPending(d, it.id + ':' + v.id) }));
    return { ...it, variants, reserved: !it.sold && variants.filter(v => !v.sold).every(v => v.reserved) };
  }
  return { ...it, reserved: !it.sold && isPending(d, it.id) };
};
const resolve = (d, key) => {
  const [iid, vid] = String(key).split(':'), it = d.items.find(x => x.id === iid);
  if (!it) return null;
  if (vid) { const v = (it.variants || []).find(x => x.id === vid); return v ? { title: it.title + ' – ' + v.name, price: v.price, sold: !!v.sold } : null; }
  if ((it.variants || []).length) return null;
  return { title: it.title, price: it.price, sold: !!it.sold };
};
const hex = c => /^#[0-9a-f]{6}$/i.test(String(c || '')) ? String(c) : '';
const parseVariants = (raw, old) => {
  let a; try { a = JSON.parse(raw || '[]'); } catch (e) { a = []; }
  if (!Array.isArray(a)) a = [];
  const out = [];
  for (const v of a.slice(0, 20)) {
    const name = String(v.name || '').trim().slice(0, 60), price = parseFloat(v.price);
    if (!name || !isFinite(price) || price < 0) return null;
    const prev = (old || []).find(x => x.id === v.id);
    out.push({ id: prev ? prev.id : crypto.randomBytes(4).toString('hex'), name, price, sold: prev ? !!prev.sold : false, img: prev && v.img && v.img === prev.img ? prev.img : '', color: hex(v.color) });
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

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/shop', wrap(async (req, res) => { const d = await load(); res.json({ settings: isAdmin(req) ? d.settings : { shop: d.settings.shop, wa: d.settings.wa }, items: d.items.map(it => view(d, it)) }); }));
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
  d.settings = { shop: c(s.shop, 60) || 'Magazinul meu', holder: c(s.holder, 80), iban: c(s.iban, 40), wa: c(s.wa, 20) };
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
  const item = { id: crypto.randomBytes(6).toString('hex'), title, desc: String(req.body.desc || '').trim().slice(0, 2000), price, imgs, color: hex(req.body.color), variants: variants.length ? variants : undefined };
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
  it.title = title; it.desc = String(req.body.desc || '').trim().slice(0, 2000); it.price = price; it.color = hex(req.body.color); it.variants = variants.length ? variants : undefined; sync(d);
  it.imgs = [...keep, ...added].slice(0, 6);
  await save(d); removed.forEach(delImage);
  const keepV = new Set(variants.map(v => v.img)); oldVImgs.filter(u => !keepV.has(u)).forEach(delImage);
  res.json(it);
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
  const ids = [...new Set(Array.isArray(req.body.itemIds) ? req.body.itemIds.map(String) : [])].slice(0, 30);
  if (!ids.length) return res.status(400).json({ error: 'Coș gol' });
  if (!name || phone.length < 3) return res.status(400).json({ error: 'Numele și telefonul sunt obligatorii' });
  const items = [];
  for (const id of ids) {
    const u = resolve(d, id);
    if (!u) return res.status(404).json({ error: 'Un articol din coș nu mai există' });
    if (u.sold) return res.status(409).json({ error: '„' + u.title + '” este deja vândut' });
    if (isPending(d, id)) return res.status(409).json({ error: '„' + u.title + '” nu este disponibil momentan' });
    items.push({ id, title: u.title, price: u.price });
  }
  if (d.orders.length >= 1000) return res.status(429).json({ error: 'Prea multe comenzi în așteptare' });
  const total = Math.round(items.reduce((t, i) => t + i.price, 0) * 100) / 100;
  d.orders.unshift({ id: crypto.randomBytes(6).toString('hex'), items, total, name, phone, date: new Date().toISOString(), paid: false });
  await save(d); res.json({ ok: true, total });
}));

app.get('/api/orders', needAdmin, wrap(async (req, res) => res.json((await load()).orders)));

app.put('/api/orders/:id', needAdmin, wrap(async (req, res) => {
  const d = await load(), o = d.orders.find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'Negăsit' });
  o.paid = !!req.body.paid; sync(d); await save(d); res.json(o);
}));

app.delete('/api/orders/:id', needAdmin, wrap(async (req, res) => {
  const d = await load();
  d.orders = d.orders.filter(x => x.id !== req.params.id); sync(d); await save(d); res.json({ ok: true });
}));

app.use((err, req, res, next) => res.status(400).json({ error: err.message || 'Eroare' }));
app.listen(PORT, () => console.log('Magazin pornit pe portul ' + PORT));

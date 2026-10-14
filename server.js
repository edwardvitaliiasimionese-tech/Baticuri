const express = require('express'), multer = require('multer'), crypto = require('crypto'), path = require('path');

const PORT = process.env.PORT || 3000;
const PASS = process.env.ADMIN_PASSWORD;
const URL_ = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_KEY;
const BUCKET = process.env.SUPABASE_BUCKET || 'boutique';
if (!PASS || !URL_ || !KEY) { console.error('Variables manquantes : ADMIN_PASSWORD, SUPABASE_URL, SUPABASE_KEY'); process.exit(1); }

const TOKEN = crypto.createHmac('sha256', crypto.createHash('sha256').update('s:' + PASS).digest('hex')).update('admin').digest('hex');
const OBJ = `${URL_}/storage/v1/object`;
const H = (extra = {}) => ({ apikey: KEY, ...(KEY.startsWith('eyJ') ? { Authorization: 'Bearer ' + KEY } : {}), ...extra });
const DEFAULT = () => ({ settings: { shop: 'Ma boutique', holder: '', iban: '', wa: '' }, items: [] });

async function load() {
  const r = await fetch(`${OBJ}/${BUCKET}/db.json?t=${Date.now()}`, { headers: H() });
  if (r.ok) return r.json();
  if (r.status === 400 || r.status === 404) return DEFAULT();   // fichier pas encore créé
  throw new Error('Lecture impossible (' + r.status + ')');
}
async function save(d) {
  const r = await fetch(`${OBJ}/${BUCKET}/db.json`, { method: 'POST', headers: H({ 'Content-Type': 'application/json', 'x-upsert': 'true' }), body: JSON.stringify(d) });
  if (!r.ok) throw new Error('Sauvegarde impossible (' + r.status + ')');
}
async function putImage(f) {
  const name = crypto.randomBytes(12).toString('hex') + EXT[f.mimetype];
  const r = await fetch(`${OBJ}/${BUCKET}/${name}`, { method: 'POST', headers: H({ 'Content-Type': f.mimetype }), body: f.buffer });
  if (!r.ok) throw new Error('Envoi photo impossible (' + r.status + ')');
  return `${OBJ}/public/${BUCKET}/${name}`;
}
const delImage = u => fetch(`${OBJ}/${BUCKET}/${path.basename(u)}`, { method: 'DELETE', headers: H() }).catch(() => {});

function isAdmin(req) {
  const m = /(?:^|;\s*)admin=([a-f0-9]+)/.exec(req.headers.cookie || '');
  return !!m && m[1].length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(m[1]), Buffer.from(TOKEN));
}
const needAdmin = (req, res, next) => isAdmin(req) ? next() : res.status(401).json({ error: 'Non autorisé' });
const wrap = fn => (req, res) => fn(req, res).catch(e => res.status(500).json({ error: e.message }));

const tries = new Map();
function throttle(req, res, next) {
  const now = Date.now(), t = tries.get(req.ip) || { n: 0, t: now };
  if (now - t.t > 15 * 60e3) { t.n = 0; t.t = now; }
  if (t.n >= 10) return res.status(429).json({ error: 'Trop d\'essais, réessaie plus tard.' });
  t.n++; tries.set(req.ip, t); next();
}

const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 6 }, fileFilter: (req, f, cb) => cb(null, !!EXT[f.mimetype]) });

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/shop', wrap(async (req, res) => res.json(await load())));
app.get('/api/me', (req, res) => res.json({ admin: isAdmin(req) }));

app.post('/api/login', throttle, (req, res) => {
  const a = Buffer.from(String(req.body.password || '')), b = Buffer.from(PASS);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Mot de passe incorrect' });
  res.cookie('admin', TOKEN, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 30 * 864e5, path: '/' });
  res.json({ admin: true });
});
app.post('/api/logout', (req, res) => { res.clearCookie('admin', { path: '/' }); res.json({ admin: false }); });

app.put('/api/settings', needAdmin, wrap(async (req, res) => {
  const d = await load(), s = req.body || {}, c = (v, n) => String(v || '').trim().slice(0, n);
  d.settings = { shop: c(s.shop, 60) || 'Ma boutique', holder: c(s.holder, 80), iban: c(s.iban, 40), wa: c(s.wa, 20) };
  await save(d); res.json(d.settings);
}));

app.post('/api/items', needAdmin, upload.array('images', 6), wrap(async (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 100), price = parseFloat(req.body.price);
  if (!title || !isFinite(price) || price < 0) return res.status(400).json({ error: 'Titre et prix requis' });
  const imgs = [];
  for (const f of req.files || []) imgs.push(await putImage(f));
  const d = await load();
  const item = { id: crypto.randomBytes(6).toString('hex'), title, desc: String(req.body.desc || '').trim().slice(0, 2000), price, imgs };
  d.items.unshift(item); await save(d); res.json(item);
}));

app.delete('/api/items/:id', needAdmin, wrap(async (req, res) => {
  const d = await load(), it = d.items.find(x => x.id === req.params.id);
  if (!it) return res.status(404).json({ error: 'Introuvable' });
  d.items = d.items.filter(x => x !== it); await save(d);
  it.imgs.forEach(delImage);
  res.json({ ok: true });
}));

app.use((err, req, res, next) => res.status(400).json({ error: err.message || 'Erreur' }));
app.listen(PORT, () => console.log('Boutique sur le port ' + PORT));

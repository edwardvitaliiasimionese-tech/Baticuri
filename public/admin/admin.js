/* BATICURI ADMIN — frontend connected to the existing Express API */
(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const state = { page: "overview", shop: null, items: [], categories: [], orders: [], promos: [], reviews: [], waitlist: [], trash: [], loading: false };
  const titles = {
    overview: "Vue d'ensemble", products: "Produits", orders: "Commandes", customers: "Clients",
    categories: "Catégories", promos: "Promotions", reviews: "Avis clients", waitlist: "Liste d'attente",
    trash: "Corbeille", settings: "Paramètres"
  };

  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  const money = value => `${Number(value || 0).toFixed(2).replace(".", ",")} €`;
  const date = value => {
    if (!value) return "—";
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("fr-BE", { day:"2-digit", month:"short", year:"numeric" });
  };
  const statusLabel = status => ({ new:"Nouvelle", confirmed:"Confirmée", ready:"Prête", delivered:"Livrée" }[status] || status || "Nouvelle");
  const toast = (message, type = "success") => {
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.textContent = message;
    $("#toastRegion").append(el);
    setTimeout(() => el.remove(), 3800);
  };
  const api = async (url, options = {}) => {
    const config = { credentials:"same-origin", ...options, headers:{ ...(options.headers || {}) } };
    if (config.body && !(config.body instanceof FormData) && typeof config.body !== "string") {
      config.headers["Content-Type"] = "application/json";
      config.body = JSON.stringify(config.body);
    }
    const response = await fetch(url, config);
    const type = response.headers.get("content-type") || "";
    const data = type.includes("application/json") ? await response.json() : await response.text();
    if (!response.ok) {
      if (response.status === 401 && !url.includes("/api/login")) showLogin();
      throw new Error(data?.error || `Erreur ${response.status}`);
    }
    return data;
  };
  const showLogin = () => {
    $("#appShell").classList.add("hidden");
    $("#loginScreen").classList.remove("hidden");
    $("#adminPassword").focus();
  };
  const showApp = () => {
    $("#loginScreen").classList.add("hidden");
    $("#appShell").classList.remove("hidden");
  };
  const setLoading = (message = "Chargement…") => {
    $("#pageContent").innerHTML = `<div class="loading-state"><span class="spinner"></span>${escapeHtml(message)}</div>`;
  };
  const pageHeading = (title, subtitle, actions = "") => `
    <div class="page-heading">
      <div><p class="eyebrow">BATICURI / ADMINISTRATION</p><h1>${title}</h1><p>${subtitle}</p></div>
      <div class="heading-actions">${actions}</div>
    </div>`;
  const empty = (title, text) => `<div class="empty-state"><div><div class="empty-icon">◇</div><strong>${escapeHtml(title)}</strong>${escapeHtml(text)}</div></div>`;
  const productImage = item => (item.imgs || []).find(Boolean) || (item.variants || []).map(v => v.img).find(Boolean) || "";
  const productCell = item => `<div class="product-cell">${productImage(item) ? `<img class="product-thumb" src="${escapeHtml(productImage(item))}" alt="">` : `<span class="product-thumb placeholder">◇</span>`}<span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.id)}</small></span></div>`;
  const status = (label, cls = "") => `<span class="status ${escapeHtml(cls)}">${escapeHtml(label)}</span>`;
  const getPageData = async () => {
    const shop = await api("/api/shop");
    state.shop = shop.settings || {};
    state.items = shop.items || [];
    state.categories = shop.categories || [];
    const tasks = [
      api("/api/orders").then(x => state.orders = x || []),
      api("/api/promos").then(x => state.promos = x || []),
      api("/api/reviews/all").then(x => state.reviews = x || []),
      api("/api/waitlist").then(x => state.waitlist = x || []),
      api("/api/trash").then(x => state.trash = x || [])
    ];
    const results = await Promise.allSettled(tasks);
    const denied = results.filter(x => x.status === "rejected" && /401|non autorisé|neautorizat/i.test(x.reason?.message || ""));
    if (denied.length) throw new Error("Session administrateur expirée. Reconnecte-toi.");
  };
  const navigate = async page => {
    state.page = page;
    $$(".nav-link").forEach(btn => btn.classList.toggle("active", btn.dataset.page === page));
    $("#pageTitle").textContent = titles[page] || "Administration";
    closeSidebar();
    setLoading();
    try {
      await getPageData();
      renderPage();
    } catch (error) {
      $("#pageContent").innerHTML = `<div class="notice">${escapeHtml(error.message)} <button class="btn btn-small" data-action="retry">Réessayer</button></div>`;
      if (/session administrateur/i.test(error.message)) showLogin();
    }
  };
  const renderPage = () => {
    const renderers = { overview:renderOverview, products:renderProducts, orders:renderOrders, customers:renderCustomers, categories:renderCategories, promos:renderPromos, reviews:renderReviews, waitlist:renderWaitlist, trash:renderTrash, settings:renderSettings };
    (renderers[state.page] || renderOverview)();
    const newCount = state.orders.filter(o => (o.status || "new") === "new").length;
    $("#newOrdersBadge").textContent = newCount;
    $("#newOrdersBadge").classList.toggle("hidden", !newCount);
  };

  function renderOverview() {
    const revenue = state.orders.filter(o => o.paid).reduce((sum,o) => sum + Number(o.total || 0), 0);
    const unpaid = state.orders.filter(o => !o.paid).length;
    const pending = state.orders.filter(o => (o.status || "new") !== "delivered").length;
    const customers = new Set(state.orders.map(o => String(o.phone || "").trim()).filter(Boolean)).size;
    const last7 = Array.from({length:7}, (_,i) => {
      const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate() - (6-i));
      const key = d.toISOString().slice(0,10);
      const total = state.orders.filter(o => String(o.date || "").slice(0,10) === key).reduce((s,o) => s + Number(o.total || 0),0);
      return { label:d.toLocaleDateString("fr-BE",{weekday:"short"}).replace(".",""), total };
    });
    const max = Math.max(1,...last7.map(x => x.total));
    const recent = state.orders.slice(0,5);
    $("#pageContent").innerHTML = `
      ${pageHeading("Vue d'ensemble","Voici ce qui se passe dans ta boutique aujourd'hui.",`<button class="btn" data-action="refresh">↻ Actualiser</button><a class="btn btn-primary" href="/" target="_blank" rel="noopener">Voir la boutique ↗</a>`)}
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-top">Chiffre d'affaires <span class="stat-icon">€</span></div><div class="stat-value">${money(revenue)}</div><div class="stat-foot">Total des commandes marquées payées</div></div>
        <div class="stat-card"><div class="stat-top">Commandes <span class="stat-icon">▤</span></div><div class="stat-value">${state.orders.length}</div><div class="stat-foot">${pending} encore à traiter</div></div>
        <div class="stat-card"><div class="stat-top">Produits <span class="stat-icon">◇</span></div><div class="stat-value">${state.items.length}</div><div class="stat-foot">${state.items.filter(x => x.hidden).length} masqués</div></div>
        <div class="stat-card"><div class="stat-top">Clients <span class="stat-icon">♙</span></div><div class="stat-value">${customers}</div><div class="stat-foot">${unpaid} commande(s) non payée(s)</div></div>
      </div>
      <div class="dashboard-grid">
        <section class="panel"><div class="panel-header"><div><h3>Activité des commandes</h3><p>Montant des commandes créées sur les 7 derniers jours</p></div>${status("7 derniers jours","ready")}</div>
          <div class="chart">${last7.map(x => `<div class="chart-col"><div class="chart-bar-wrap"><div class="chart-bar" title="${money(x.total)}" style="height:${Math.max(3,(x.total/max)*100)}%"></div></div><span class="chart-label">${escapeHtml(x.label)}</span></div>`).join("")}</div>
        </section>
        <section class="panel"><div class="panel-header"><div><h3>À surveiller</h3><p>Résumé de la boutique</p></div></div>
          <div class="activity-list">
            <div class="activity-item"><span class="activity-dot"></span><div><strong>${state.orders.filter(o => (o.status || "new") === "new").length} nouvelles commandes</strong><small>À confirmer ou traiter</small></div></div>
            <div class="activity-item"><span class="activity-dot"></span><div><strong>${state.reviews.filter(r => !r.approved).length} avis à vérifier</strong><small>En attente de publication</small></div></div>
            <div class="activity-item"><span class="activity-dot"></span><div><strong>${state.waitlist.length} demande(s) d'attente</strong><small>Clients intéressés par un article</small></div></div>
            <div class="activity-item"><span class="activity-dot"></span><div><strong>${state.items.filter(x => x.hidden).length} produit(s) masqué(s)</strong><small>Non visibles dans la boutique</small></div></div>
          </div>
        </section>
      </div>
      <section class="panel" style="margin-top:15px"><div class="panel-header"><div><h3>Commandes récentes</h3><p>Les cinq dernières commandes reçues</p></div><button class="btn btn-small" data-page-go="orders">Toutes les commandes →</button></div>
        ${recent.length ? ordersTable(recent,false) : empty("Aucune commande","Les nouvelles commandes apparaîtront ici.")}</section>`;
  }

  function ordersTable(orders, showActions = true) {
    return `<div class="table-wrap"><table><thead><tr><th>Commande</th><th>Client</th><th>Date</th><th>Total</th><th>Statut</th><th>Paiement</th>${showActions?"<th>Action</th>":""}</tr></thead><tbody>
      ${orders.map(o => `<tr><td><strong>#${escapeHtml(o.id)}</strong></td><td>${escapeHtml(o.name || "—")}<small style="display:block;color:var(--muted-2);margin-top:3px">${escapeHtml(o.phone || "")}</small></td><td>${date(o.date)}</td><td>${money(o.total)}</td><td>${status(statusLabel(o.status || "new"),o.status || "new")}</td><td>${o.paid ? status("Payée","paid") : status("Non payée","unpaid")}</td>${showActions?`<td><button class="btn btn-small" data-action="order-edit" data-id="${escapeHtml(o.id)}">Gérer</button></td>`:""}</tr>`).join("")}
      </tbody></table></div>`;
  }

  function renderProducts() {
    $("#pageContent").innerHTML = `${pageHeading("Produits","Ajoute, modifie et organise les articles de ta boutique.",`<button class="btn btn-primary" data-action="product-add">＋ Ajouter un produit</button>`)}
      <div class="toolbar"><div class="toolbar-left"><input class="search-input" id="productSearch" placeholder="Rechercher un produit…"><select id="productFilter" class="select-small"><option value="all">Tous les produits</option><option value="visible">Visibles</option><option value="hidden">Masqués</option><option value="sold">Épuisés</option></select></div><span class="inline-note">${state.items.length} produit(s)</span></div>
      <div id="productsTable">${productsTable(state.items)}</div>`;
  }
  function productsTable(items) {
    if (!items.length) return empty("Aucun produit","Ajoute ton premier produit pour commencer.");
    return `<div class="table-wrap"><table><thead><tr><th>Produit</th><th>Prix</th><th>Stock</th><th>Visibilité</th><th>État</th><th>Actions</th></tr></thead><tbody>
      ${items.map(it => `<tr><td>${productCell(it)}</td><td>${money(it.price)}</td><td>${it.variants?.length ? `${it.variants.length} variante(s)` : Number(it.left ?? it.qty ?? 0)}</td><td>${it.hidden?status("Masqué","hidden-status"):status("Visible","paid")}</td><td>${it.sold?status("Épuisé","unpaid"):it.reserved?status("Réservé","pending"):status("Disponible","confirmed")}</td><td><div class="actions"><button class="btn btn-small" data-action="product-edit" data-id="${escapeHtml(it.id)}">Modifier</button><button class="btn btn-small" data-action="product-duplicate" data-id="${escapeHtml(it.id)}">Copier</button><button class="btn btn-small" data-action="product-hide" data-id="${escapeHtml(it.id)}" data-hidden="${!it.hidden}">${it.hidden?"Afficher":"Masquer"}</button><button class="btn btn-small btn-danger" data-action="product-delete" data-id="${escapeHtml(it.id)}">Supprimer</button></div></td></tr>`).join("")}
      </tbody></table></div>`;
  }

  function productForm(item = null) {
    const editing = !!item;
    const cats = state.categories.map(c => `<option value="${escapeHtml(c.id)}" ${item?.cat===c.id?"selected":""}>${escapeHtml(c.name)}</option>`).join("");
    const keep = (item?.imgs || []).map(u => `<label class="check-row"><input type="checkbox" name="keepImage" value="${escapeHtml(u)}" checked><img src="${escapeHtml(u)}" class="product-thumb" alt="">Conserver cette image</label>`).join("");
    const variants = item?.variants?.length ? JSON.stringify(item.variants.map(v => ({id:v.id,name:v.name,price:v.price,qty:v.qty,color:v.color,img:v.img})),null,2) : "[]";
    openModal(editing ? "Modifier le produit" : "Ajouter un produit", `
      <form id="productForm">
        <div class="form-grid">
          <div class="field full-width"><label>Nom du produit *</label><input name="title" maxlength="100" required value="${escapeHtml(item?.title || "")}" placeholder="Ex. Produit Baticuri"></div>
          <div class="field"><label>Prix (€) *</label><input name="price" type="number" min="0" step="0.01" required value="${escapeHtml(item?.price ?? "")}"></div>
          <div class="field"><label>Quantité en stock</label><input name="qty" type="number" min="1" max="999" value="${escapeHtml(item?.qty ?? 1)}"></div>
          <div class="field"><label>Catégorie</label><select name="cat"><option value="">Sans catégorie</option>${cats}</select></div>
          <div class="field"><label>Sous-catégorie (ID)</label><input name="sub" value="${escapeHtml(item?.sub || "")}" placeholder="ID de sous-catégorie"></div>
          <div class="field"><label>Prix précédent (€)</label><input name="oldPrice" type="number" min="0" step="0.01" value="${escapeHtml(item?.oldPrice ?? "")}"></div>
          <div class="field"><label>Badge</label><select name="badge"><option value="">Aucun</option>${["Nou","Reducere","Recomandat","Ediție limitată","Ultimul exemplar"].map(b=>`<option ${item?.badge===b?"selected":""}>${b}</option>`).join("")}</select></div>
          <div class="field"><label>Couleur (hex)</label><input name="color" value="${escapeHtml(item?.color || "")}" placeholder="#F4A7C5"></div>
          <div class="field full-width"><label>Description</label><textarea name="desc" maxlength="2000" placeholder="Description du produit…">${escapeHtml(item?.desc || "")}</textarea></div>
          <div class="field full-width"><label>Ajouter des photos (JPEG, PNG, WEBP ou GIF)</label><input name="images" type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple><span class="hint">Maximum 6 photos, 8 Mo par photo.</span></div>
          ${editing && keep ? `<div class="field full-width"><label>Photos actuelles</label><div class="stack">${keep}</div></div>` : ""}
          <div class="field full-width"><label>Variantes (JSON)</label><textarea name="variants" spellcheck="false">${escapeHtml(variants)}</textarea><span class="hint">Laisse [] pour un produit sans variantes. Pour les variantes, conserve le format JSON existant : name, price, qty et éventuellement id, color, img.</span></div>
        </div>
        <div class="modal-footer"><button type="button" class="btn" data-action="modal-close">Annuler</button><button class="btn btn-primary" type="submit">${editing?"Enregistrer":"Créer le produit"}</button></div>
      </form>`, true);
    $("#productForm").addEventListener("submit", async e => {
      e.preventDefault();
      const form = e.currentTarget, fd = new FormData(form);
      if (editing) fd.set("keep", JSON.stringify($$('input[name="keepImage"]:checked',form).map(x=>x.value)));
      fd.delete("keepImage");
      try {
        const raw = fd.get("variants") || "[]"; JSON.parse(raw);
        await api(editing ? `/api/items/${encodeURIComponent(item.id)}` : "/api/items", { method:editing?"PUT":"POST", body:fd });
        closeModal(); toast(editing ? "Produit modifié." : "Produit ajouté."); await navigate("products");
      } catch(err) { toast(err.message || "Vérifie le JSON des variantes.", "error"); }
    });
  }

  function renderOrders() {
    $("#pageContent").innerHTML = `${pageHeading("Commandes","Consulte les commandes et mets à jour leur avancement.",`<button class="btn" data-action="refresh">↻ Actualiser</button>`)}
      <div class="toolbar"><div class="toolbar-left"><input class="search-input" id="orderSearch" placeholder="Rechercher nom, téléphone ou ID…"><select id="orderFilter" class="select-small"><option value="all">Tous les statuts</option><option value="new">Nouvelles</option><option value="confirmed">Confirmées</option><option value="ready">Prêtes</option><option value="delivered">Livrées</option></select><select id="paidFilter" class="select-small"><option value="all">Tous paiements</option><option value="paid">Payées</option><option value="unpaid">Non payées</option></select></div><span class="inline-note">${state.orders.length} commande(s)</span></div><div id="ordersTable">${ordersTable(state.orders)}</div>`;
  }

  function orderEdit(order) {
    const items = (order.items || []).map(i=>`<div class="activity-item"><span class="activity-dot"></span><div><strong>${escapeHtml(i.title)} × ${Number(i.qty||1)}</strong><small>${money(i.price)} / unité</small></div></div>`).join("");
    openModal(`Commande #${order.id}`, `
      <div class="stack">
        <div class="notice"><strong>${escapeHtml(order.name || "Client")}</strong><br>${escapeHtml(order.phone || "")}<br>Créée le ${date(order.date)}</div>
        <div><p class="eyebrow">ARTICLES</p>${items || "Aucun détail disponible"}</div>
        <div class="split"><span>Sous-total</span><strong>${money(order.subtotal ?? order.total)}</strong></div>
        ${Number(order.discount)>0?`<div class="split"><span>Réduction ${escapeHtml(order.promo||"")}</span><strong>− ${money(order.discount)}</strong></div>`:""}
        <div class="split"><strong>Total</strong><strong class="pink-text">${money(order.total)}</strong></div>
        <form id="orderForm" class="form-grid">
          <div class="field"><label>Statut</label><select name="status">${["new","confirmed","ready","delivered"].map(s=>`<option value="${s}" ${(order.status||"new")===s?"selected":""}>${statusLabel(s)}</option>`).join("")}</select></div>
          <div class="field"><label>Paiement</label><select name="paid"><option value="false" ${!order.paid?"selected":""}>Non payée</option><option value="true" ${order.paid?"selected":""}>Payée</option></select></div>
          <div class="field full-width"><label>Note interne</label><textarea name="note" maxlength="300">${escapeHtml(order.note||"")}</textarea></div>
          <div class="field full-width"><button class="btn btn-primary full" type="submit">Enregistrer la commande</button></div>
        </form>
        <div class="modal-footer"><button class="btn btn-danger" data-action="order-delete" data-id="${escapeHtml(order.id)}">Supprimer la commande</button><button class="btn" data-action="modal-close">Fermer</button></div>
      </div>`, true);
    $("#orderForm").addEventListener("submit", async e=>{
      e.preventDefault(); const f=new FormData(e.currentTarget);
      try { await api(`/api/orders/${encodeURIComponent(order.id)}`,{method:"PUT",body:{status:f.get("status"),paid:f.get("paid")==="true",note:f.get("note")}}); closeModal(); toast("Commande mise à jour."); await navigate("orders"); }
      catch(err){toast(err.message,"error");}
    });
  }

  function renderCustomers() {
    const map = new Map();
    state.orders.forEach(o=>{
      const key=String(o.phone||"").trim() || String(o.name||"Client");
      const c=map.get(key)||{name:o.name||"Client",phone:o.phone||"",orders:0,total:0,last:o.date};
      c.orders++; c.total+=Number(o.total||0); if(new Date(o.date)>new Date(c.last))c.last=o.date; map.set(key,c);
    });
    const list=[...map.values()].sort((a,b)=>b.orders-a.orders);
    $("#pageContent").innerHTML = `${pageHeading("Clients","Clients déduits des informations présentes dans les commandes.",`<button class="btn" data-action="refresh">↻ Actualiser</button>`)}
      <div class="notice" style="margin-bottom:15px">Cette version n'a pas de table clients dédiée : les profils sont regroupés à partir du nom et du téléphone des commandes existantes.</div>
      <div class="toolbar"><input id="customerSearch" class="search-input" placeholder="Rechercher un client…"><span class="inline-note">${list.length} client(s)</span></div>
      <div id="customersGrid" class="customer-grid">${list.length?list.map(c=>`<div class="customer-card"><strong>${escapeHtml(c.name)}</strong><small>${escapeHtml(c.phone||"Téléphone non fourni")}</small><div class="split" style="margin-top:13px"><span>${c.orders} commande(s)</span><b>${money(c.total)}</b></div><small>Dernière commande : ${date(c.last)}</small></div>`).join(""):empty("Aucun client","Les clients apparaîtront après les premières commandes.")}</div>`;
  }

  function renderCategories() {
    $("#pageContent").innerHTML = `${pageHeading("Catégories","Organise les produits par catégories et sous-catégories.",`<button class="btn btn-primary" data-action="category-add">＋ Ajouter une catégorie</button>`)}
      <div class="stack">${state.categories.length?state.categories.map(c=>`<div class="panel"><div class="split"><div><strong>${escapeHtml(c.name)}</strong><p class="inline-note">${(c.subs||[]).length} sous-catégorie(s) · ${state.items.filter(i=>i.cat===c.id).length} produit(s)</p></div><div class="actions"><button class="btn btn-small" data-action="category-edit" data-id="${escapeHtml(c.id)}">Modifier</button><button class="btn btn-small btn-danger" data-action="category-delete" data-id="${escapeHtml(c.id)}">Supprimer</button></div></div>${(c.subs||[]).length?`<div class="tag-list">${c.subs.map(s=>`<span class="status">${escapeHtml(s.name)}</span>`).join("")}</div>`:""}</div>`).join(""):empty("Aucune catégorie","Crée une catégorie pour organiser tes produits.")}</div>`;
  }
  function categoryForm(cat=null) {
    const subs=(cat?.subs||[]).map(s=>s.name).join("\n");
    openModal(cat?"Modifier la catégorie":"Nouvelle catégorie",`<form id="categoryForm" class="stack"><div class="field"><label>Nom de la catégorie *</label><input name="name" required maxlength="40" value="${escapeHtml(cat?.name||"")}"></div><div class="field"><label>Sous-catégories (une par ligne)</label><textarea name="subs" placeholder="Exemple&#10;Sous-catégorie 1&#10;Sous-catégorie 2">${escapeHtml(subs)}</textarea></div><div class="modal-footer"><button type="button" class="btn" data-action="modal-close">Annuler</button><button class="btn btn-primary">Enregistrer</button></div></form>`);
    $("#categoryForm").addEventListener("submit",async e=>{
      e.preventDefault(); const f=new FormData(e.currentTarget), name=String(f.get("name")).trim();
      const next=state.categories.filter(x=>x.id!==cat?.id).concat([{id:cat?.id,name,subs:String(f.get("subs")||"").split("\n").map(x=>x.trim()).filter(Boolean).map((n,i)=>({id:cat?.subs?.find(s=>s.name===n)?.id||undefined,name:n}))}]);
      try{await api("/api/categories",{method:"PUT",body:{categories:next}});closeModal();toast("Catégories enregistrées.");await navigate("categories");}catch(err){toast(err.message,"error");}
    });
  }

  function renderPromos() {
    $("#pageContent").innerHTML = `${pageHeading("Promotions","Crée et active des codes de réduction.",`<button class="btn btn-primary" data-action="promo-add">＋ Nouveau code</button>`)}
      ${state.promos.length?`<div class="table-wrap"><table><thead><tr><th>Code</th><th>Réduction</th><th>Utilisations</th><th>Limite</th><th>État</th><th>Actions</th></tr></thead><tbody>${state.promos.map(p=>`<tr><td><strong>${escapeHtml(p.code)}</strong></td><td>${p.type==="amt"?money(p.value):`${p.value}%`}</td><td>${Number(p.uses||0)}</td><td>${p.max||"Illimitée"}</td><td>${p.active?status("Actif","paid"):status("Inactif","unpaid")}</td><td><div class="actions"><button class="btn btn-small" data-action="promo-edit" data-id="${escapeHtml(p.code)}">Modifier</button><button class="btn btn-small btn-danger" data-action="promo-delete" data-id="${escapeHtml(p.code)}">Supprimer</button></div></td></tr>`).join("")}</tbody></table></div>`:empty("Aucun code promo","Crée ton premier code de réduction.")}`;
  }
  function promoForm(promo=null) {
    openModal(promo?"Modifier le code promo":"Nouveau code promo",`<form id="promoForm" class="form-grid"><div class="field full-width"><label>Code *</label><input name="code" required maxlength="20" value="${escapeHtml(promo?.code||"")}" placeholder="BIENVENUE10"></div><div class="field"><label>Type</label><select name="type"><option value="pct" ${promo?.type!=="amt"?"selected":""}>Pourcentage (%)</option><option value="amt" ${promo?.type==="amt"?"selected":""}>Montant (€)</option></select></div><div class="field"><label>Valeur *</label><input name="value" type="number" min="0.01" step="0.01" required value="${escapeHtml(promo?.value??"")}"></div><div class="field"><label>Nombre maximum d'utilisations</label><input name="max" type="number" min="0" value="${escapeHtml(promo?.max||0)}"><span class="hint">0 = illimité</span></div><div class="field"><label class="check-row"><input name="active" type="checkbox" ${promo?.active!==false?"checked":""}> Code actif</label></div><div class="modal-footer field full-width"><button type="button" class="btn" data-action="modal-close">Annuler</button><button class="btn btn-primary">Enregistrer</button></div></form>`);
    $("#promoForm").addEventListener("submit",async e=>{
      e.preventDefault();const f=new FormData(e.currentTarget);const list=state.promos.filter(x=>x.code!==promo?.code);
      list.push({code:String(f.get("code")).toUpperCase(),type:f.get("type"),value:Number(f.get("value")),max:Number(f.get("max")||0),active:f.get("active")==="on"});
      try{await api("/api/promos",{method:"PUT",body:{promos:list}});closeModal();toast("Promotions enregistrées.");await navigate("promos");}catch(err){toast(err.message,"error");}
    });
  }

  function renderReviews() {
    $("#pageContent").innerHTML = `${pageHeading("Avis clients","Modère les avis avant leur publication sur la boutique.",`<button class="btn" data-action="refresh">↻ Actualiser</button>`)}
      ${state.reviews.length?state.reviews.map(r=>`<div class="review-card"><div class="split"><div><strong>${escapeHtml(r.name||"Client")}</strong><div class="review-stars">${"★".repeat(Math.max(0,Math.min(5,Number(r.rating)||0)))}${"☆".repeat(5-Math.max(0,Math.min(5,Number(r.rating)||0)))}</div></div>${r.approved?status("Publié","approved"):status("À valider","pending")}</div><p style="font-size:12px;color:#d6cdd8;line-height:1.6">${escapeHtml(r.text||"Aucun commentaire")}</p>${r.reply?`<p class="inline-note">Réponse : ${escapeHtml(r.reply)}</p>`:""}<div class="actions"><button class="btn btn-small" data-action="review-toggle" data-id="${escapeHtml(r.id)}" data-approved="${!r.approved}">${r.approved?"Dépublier":"Approuver"}</button><button class="btn btn-small" data-action="review-reply" data-id="${escapeHtml(r.id)}">Répondre</button><button class="btn btn-small btn-danger" data-action="review-delete" data-id="${escapeHtml(r.id)}">Supprimer</button></div></div>`).join(""):empty("Aucun avis","Les nouveaux avis clients apparaîtront ici.")}`;
  }

  function renderWaitlist() {
    $("#pageContent").innerHTML = `${pageHeading("Liste d'attente","Personnes intéressées par un produit indisponible.",`<button class="btn" data-action="refresh">↻ Actualiser</button>`)}
      ${state.waitlist.length?`<div class="table-wrap"><table><thead><tr><th>Client</th><th>Téléphone</th><th>Produit</th><th>Date</th><th>Action</th></tr></thead><tbody>${state.waitlist.map(w=>`<tr><td>${escapeHtml(w.name)}</td><td>${escapeHtml(w.phone)}</td><td>${escapeHtml(w.title)}</td><td>${date(w.date)}</td><td><button class="btn btn-small btn-danger" data-action="waitlist-delete" data-id="${escapeHtml(w.id)}">Retirer</button></td></tr>`).join("")}</tbody></table></div>`:empty("Liste vide","Aucune demande d'attente pour le moment.")}`;
  }

  function renderTrash() {
    $("#pageContent").innerHTML = `${pageHeading("Corbeille","Restaure un produit supprimé ou efface-le définitivement.",`<button class="btn" data-action="refresh">↻ Actualiser</button>`)}
      ${state.trash.length?`<div class="table-wrap"><table><thead><tr><th>Produit</th><th>Supprimé le</th><th>Actions</th></tr></thead><tbody>${state.trash.map(t=>`<tr><td><div class="product-cell">${t.img?`<img class="product-thumb" src="${escapeHtml(t.img)}" alt="">`:`<span class="product-thumb placeholder">◇</span>`}<strong>${escapeHtml(t.title)}</strong></div></td><td>${date(t.at)}</td><td><div class="actions"><button class="btn btn-small" data-action="trash-restore" data-id="${escapeHtml(t.id)}">Restaurer</button><button class="btn btn-small btn-danger" data-action="trash-delete" data-id="${escapeHtml(t.id)}">Effacer</button></div></td></tr>`).join("")}</tbody></table></div>`:empty("Corbeille vide","Aucun produit supprimé.")}`;
  }

  function renderSettings() {
    const s=state.shop||{};
    $("#pageContent").innerHTML = `${pageHeading("Paramètres","Configure les informations et l'apparence de ta boutique.")}
      <form id="settingsForm" class="panel stack">
        <div><h3 style="margin:0 0 5px;font:700 14px Manrope">Informations de la boutique</h3><p class="inline-note">Ces données sont enregistrées dans les paramètres du magasin.</p></div>
        <div class="form-grid">
          <div class="field"><label>Nom de la boutique</label><input name="shop" maxlength="60" value="${escapeHtml(s.shop||"")}"></div>
          <div class="field"><label>WhatsApp / téléphone</label><input name="wa" maxlength="20" value="${escapeHtml(s.wa||"")}"></div>
          <div class="field"><label>Nom du bénéficiaire</label><input name="holder" maxlength="80" value="${escapeHtml(s.holder||"")}"></div>
          <div class="field"><label>IBAN</label><input name="iban" maxlength="40" value="${escapeHtml(s.iban||"")}"></div>
          <div class="field"><label>Zone de livraison</label><input name="zone" maxlength="100" value="${escapeHtml(s.zone||"")}"></div>
          <div class="field"><label>Thème de la boutique</label><select name="theme"><option value="noir" ${s.theme==="noir"?"selected":""}>Noir</option><option value="ivory" ${s.theme==="ivory"?"selected":""}>Ivoire</option><option value="bordeaux" ${s.theme==="bordeaux"?"selected":""}>Bordeaux</option></select></div>
          <div class="field full-width"><label>À propos</label><textarea name="about" maxlength="1000">${escapeHtml(s.about||"")}</textarea></div>
          <div class="field full-width"><label>Bannière d'annonce</label><input name="banner" maxlength="200" value="${escapeHtml(s.banner||"")}"></div>
          <div class="field full-width"><label>Texte des avis / présentation</label><textarea name="reviews" maxlength="1500">${escapeHtml(s.reviews||"")}</textarea></div>
          <div class="field full-width"><label class="check-row"><input type="checkbox" name="vacation" ${s.vacation?"checked":""}> Activer le mode vacances (bloque les nouvelles commandes)</label></div>
          <div class="field full-width"><label>Message affiché pendant les vacances</label><input name="vacMsg" maxlength="200" value="${escapeHtml(s.vacMsg||"")}"></div>
        </div>
        <div class="actions"><button class="btn btn-primary" type="submit">Enregistrer les paramètres</button><button class="btn" type="button" data-action="backup">Télécharger une sauvegarde JSON</button><button class="btn" type="button" data-action="test-email">Envoyer un e-mail de test</button></div>
      </form>
      <div class="notice" style="margin-top:15px">La sauvegarde contient les données stockées dans ton fichier JSON Supabase Storage. Garde-la dans un endroit privé : elle peut contenir des informations de commandes et de clients.</div>`;
    $("#settingsForm").addEventListener("submit",async e=>{
      e.preventDefault();const f=new FormData(e.currentTarget);
      const payload=Object.fromEntries(["shop","holder","iban","wa","about","zone","vacMsg","theme","reviews","banner"].map(k=>[k,f.get(k)||""]));
      payload.vacation=f.get("vacation")==="on";
      try{await api("/api/settings",{method:"PUT",body:payload});toast("Paramètres enregistrés.");await navigate("settings");}catch(err){toast(err.message,"error");}
    });
  }

  function openModal(title, body, wide=false) {
    $("#modalRoot").innerHTML=`<div class="modal-backdrop" data-action="backdrop-close"><section class="modal ${wide?"wide":""}" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}"><header class="modal-header"><h3>${escapeHtml(title)}</h3><button class="icon-btn" data-action="modal-close" aria-label="Fermer">×</button></header><div class="modal-body">${body}</div></section></div>`;
  }
  function closeModal(){ $("#modalRoot").innerHTML=""; }
  function closeSidebar(){ $("#sidebar").classList.remove("open");$("#sidebarOverlay").classList.remove("show"); }
  const confirmAction = message => window.confirm(message);

  async function action(action, button) {
    const id=button.dataset.id;
    if(action==="modal-close"){closeModal();return;}
    if(action==="backdrop-close" && button.classList.contains("modal-backdrop")){closeModal();return;}
    if(action==="retry"||action==="refresh"){await navigate(state.page);return;}
    if(action==="product-add"){productForm();return;}
    if(action==="product-edit"){const it=state.items.find(x=>x.id===id);if(it)productForm(it);return;}
    if(action==="product-delete"){if(!confirmAction("Déplacer ce produit dans la corbeille ?"))return;await api(`/api/items/${encodeURIComponent(id)}`,{method:"DELETE"});toast("Produit déplacé dans la corbeille.");await navigate("products");return;}
    if(action==="product-hide"){await api(`/api/items/${encodeURIComponent(id)}/hidden`,{method:"PUT",body:{hidden:button.dataset.hidden==="true"}});toast("Visibilité modifiée.");await navigate("products");return;}
    if(action==="product-duplicate"){await api(`/api/items/${encodeURIComponent(id)}/duplicate`,{method:"POST",body:{}});toast("Produit dupliqué.");await navigate("products");return;}
    if(action==="order-edit"){const o=state.orders.find(x=>x.id===id);if(o)orderEdit(o);return;}
    if(action==="order-delete"){if(!confirmAction("Supprimer définitivement cette commande ?"))return;await api(`/api/orders/${encodeURIComponent(id)}`,{method:"DELETE"});closeModal();toast("Commande supprimée.");await navigate("orders");return;}
    if(action==="category-add"){categoryForm();return;}
    if(action==="category-edit"){const c=state.categories.find(x=>x.id===id);if(c)categoryForm(c);return;}
    if(action==="category-delete"){if(!confirmAction("Supprimer cette catégorie ? Les produits associés perdront leur catégorie."))return;const cats=state.categories.filter(x=>x.id!==id);await api("/api/categories",{method:"PUT",body:{categories:cats}});toast("Catégorie supprimée.");await navigate("categories");return;}
    if(action==="promo-add"){promoForm();return;}
    if(action==="promo-edit"){const p=state.promos.find(x=>x.code===id);if(p)promoForm(p);return;}
    if(action==="promo-delete"){if(!confirmAction("Supprimer ce code promotionnel ?"))return;await api("/api/promos",{method:"PUT",body:{promos:state.promos.filter(x=>x.code!==id)}});toast("Code supprimé.");await navigate("promos");return;}
    if(action==="review-toggle"){const r=state.reviews.find(x=>x.id===id);await api(`/api/reviews/${encodeURIComponent(id)}`,{method:"PUT",body:{approved:button.dataset.approved==="true"}});toast("Statut de l'avis modifié.");await navigate("reviews");return;}
    if(action==="review-reply"){const r=state.reviews.find(x=>x.id===id);const reply=prompt("Réponse publique à cet avis :",r?.reply||"");if(reply===null)return;await api(`/api/reviews/${encodeURIComponent(id)}`,{method:"PUT",body:{reply}});toast("Réponse enregistrée.");await navigate("reviews");return;}
    if(action==="review-delete"){if(!confirmAction("Supprimer cet avis ?"))return;await api(`/api/reviews/${encodeURIComponent(id)}`,{method:"DELETE"});toast("Avis supprimé.");await navigate("reviews");return;}
    if(action==="waitlist-delete"){if(!confirmAction("Retirer cette personne de la liste d'attente ?"))return;await api(`/api/waitlist/${encodeURIComponent(id)}`,{method:"DELETE"});toast("Entrée retirée.");await navigate("waitlist");return;}
    if(action==="trash-restore"){await api(`/api/trash/${encodeURIComponent(id)}/restore`,{method:"POST",body:{}});toast("Produit restauré.");await navigate("trash");return;}
    if(action==="trash-delete"){if(!confirmAction("Effacer définitivement ce produit et ses images ?"))return;await api(`/api/trash/${encodeURIComponent(id)}`,{method:"DELETE"});toast("Produit effacé définitivement.");await navigate("trash");return;}
    if(action==="backup"){const response=await fetch("/api/backup",{credentials:"same-origin"});if(!response.ok)throw new Error("Téléchargement de la sauvegarde impossible.");const blob=await response.blob(),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=`baticuri-backup-${new Date().toISOString().slice(0,10)}.json`;a.click();URL.revokeObjectURL(url);toast("Sauvegarde téléchargée.");return;}
    if(action==="test-email"){const r=await api("/api/test-email",{method:"POST",body:{}});toast(r.detail||"Demande d'e-mail envoyée.",r.ok?"success":"error");return;}
  }

  document.addEventListener("click", async e => {
    const pageBtn=e.target.closest("[data-page]");
    if(pageBtn){navigate(pageBtn.dataset.page);return;}
    const go=e.target.closest("[data-page-go]");
    if(go){navigate(go.dataset.pageGo);return;}
    const btn=e.target.closest("[data-action]");
    if(btn){
      if(btn.dataset.action === "backdrop-close" && e.target !== btn) return;
      try{await action(btn.dataset.action,btn);}catch(err){toast(err.message||"Une erreur est survenue.","error");}
    }
  });

  $("#pageContent").addEventListener("change", e=>{
    if(["productFilter","orderFilter","paidFilter"].includes(e.target.id)) e.target.dispatchEvent(new Event("input",{bubbles:true}));
  });

  $("#pageContent").addEventListener("input", e=>{
    if(e.target.id==="productSearch"||e.target.id==="productFilter"){
      const q=($("#productSearch")?.value||"").toLowerCase(), f=$("#productFilter")?.value||"all";
      const list=state.items.filter(it=>(it.title||"").toLowerCase().includes(q) && (f==="all"||(f==="visible"&&!it.hidden)||(f==="hidden"&&it.hidden)||(f==="sold"&&it.sold)));
      $("#productsTable").innerHTML=productsTable(list);
    }
    if(e.target.id==="orderSearch"||e.target.id==="orderFilter"||e.target.id==="paidFilter"){
      const q=($("#orderSearch")?.value||"").toLowerCase(),f=$("#orderFilter")?.value||"all",p=$("#paidFilter")?.value||"all";
      const list=state.orders.filter(o=>(`${o.id} ${o.name} ${o.phone}`).toLowerCase().includes(q)&&(f==="all"||(o.status||"new")===f)&&(p==="all"||(p==="paid"&&o.paid)||(p==="unpaid"&&!o.paid)));
      $("#ordersTable").innerHTML=ordersTable(list);
    }
    if(e.target.id==="customerSearch"){
      const q=e.target.value.toLowerCase();
      $$(".customer-card").forEach(c=>c.classList.toggle("hidden",!c.textContent.toLowerCase().includes(q)));
    }
  });

  $("#loginForm").addEventListener("submit",async e=>{
    e.preventDefault();$("#loginError").textContent="";
    const password=$("#adminPassword").value;
    try{await api("/api/login",{method:"POST",body:{password}});$("#adminPassword").value="";showApp();await navigate("overview");}
    catch(err){$("#loginError").textContent=err.message==="Parolă incorectă"?"Mot de passe incorrect.":err.message;}
  });
  $("#logoutBtn").addEventListener("click",async()=>{
    try{await api("/api/logout",{method:"POST",body:{}});}catch(e){}
    showLogin();toast("Déconnexion effectuée.");
  });
  $("#refreshBtn").addEventListener("click",()=>navigate(state.page));
  $("#openSidebar").addEventListener("click",()=>{$("#sidebar").classList.add("open");$("#sidebarOverlay").classList.add("show");});
  $("#closeSidebar").addEventListener("click",closeSidebar);
  $("#sidebarOverlay").addEventListener("click",closeSidebar);

  (async()=>{
    try{const me=await api("/api/me");if(me.admin){showApp();await navigate("overview");}else showLogin();}
    catch(e){showLogin();$("#loginError").textContent="Impossible de vérifier la connexion. Recharge la page.";}
  })();
})();

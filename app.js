// =======================================
// VEIA – PIN Local + Firebase Anonymous + Firestore
// + Compras + Check Rápido
// + ETAPA 10: Botão "Comprei" (hortifruti => verde; quantidade => soma)
// + ETAPA 11 (FIX): Admin edita ESTOQUE MÍNIMO + DURAÇÃO (dias) por item (controle quantidade)
// + FIX BUSCA: debounce + preservar foco/cursor
// + ETAPA 12 (AJUSTE REGRA): Quantidade = 0 => VERMELHO | <= mínimo => AMARELO | regra do "abriu última unidade" mantém vermelho por tempo
// =======================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-auth.js";
import {
  getFirestore,
  doc, getDoc,
  collection, getDocs, addDoc, updateDoc, deleteDoc,
  query, orderBy,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js";

// -----------------------------
// Firebase
// -----------------------------
const firebaseConfig = window.firebaseConfig;
if (!firebaseConfig || !firebaseConfig.apiKey) {
  alert("firebaseConfig não encontrado no index.html. Verifique o script window.firebaseConfig.");
  throw new Error("firebaseConfig missing");
}
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// -----------------------------
// PIN Local (MVP)
// -----------------------------
const USERS_PIN = { admin: "2212", Veia: "1212" };

// -----------------------------
// UI State
// -----------------------------
const UI_STATE_KEY = "veia_ui_state_v3";
let UI_STATE = loadUIState();

function loadUIState() {
  try {
    return JSON.parse(localStorage.getItem(UI_STATE_KEY)) || { filterCategory: "(todas)", searchText: "", screen: "itens" };
  } catch {
    return { filterCategory: "(todas)", searchText: "", screen: "itens" };
  }
}
function saveUIState() {
  localStorage.setItem(UI_STATE_KEY, JSON.stringify(UI_STATE));
}

// -----------------------------
// FIX BUSCA: debounce + preservar foco/cursor
// -----------------------------
let _searchDebounceTimer = null;

function snapshotSearchFocus() {
  const el = document.activeElement;
  if (!el) return null;
  if (el.id !== "searchInput") return null;

  return {
    id: el.id,
    start: typeof el.selectionStart === "number" ? el.selectionStart : 0,
    end: typeof el.selectionEnd === "number" ? el.selectionEnd : 0,
  };
}

function restoreSearchFocus(snap) {
  if (!snap) return;
  const el = document.getElementById(snap.id);
  if (!el) return;

  el.focus();
  try { el.setSelectionRange(snap.start, snap.end); } catch (_) {}
}

// -----------------------------
// DOM
// -----------------------------
const userSelect = document.getElementById("userSelect");
const pinInput = document.getElementById("pinInput");
const btnLogin = document.getElementById("btnLogin");
const btnLogout = document.getElementById("btnLogout");

const viewLogin = document.getElementById("viewLogin");
const viewApp = document.getElementById("viewApp");

const who = document.getElementById("who");
const welcome = document.getElementById("welcome");

const btnCategorias = document.getElementById("btnCategorias");
const btnItens = document.getElementById("btnItens");
const btnCompras = document.getElementById("btnCompras");
const btnCheck = document.getElementById("btnCheck");
const content = document.getElementById("content");

const required = { userSelect, pinInput, btnLogin, btnLogout, viewLogin, viewApp, who, welcome, btnCategorias, btnItens, btnCompras, btnCheck, content };
for (const [k, el] of Object.entries(required)) {
  if (!el) {
    alert(`Elemento não encontrado no HTML: ${k}. Verifique o id="${k}" no index.html`);
    throw new Error(`Missing DOM element: ${k}`);
  }
}

// -----------------------------
// Sessão local
// -----------------------------
function setSession(userId) { localStorage.setItem("veia_user", userId); }
function getSession() { return localStorage.getItem("veia_user"); }
function clearSession() { localStorage.removeItem("veia_user"); }

// -----------------------------
// Util
// -----------------------------
function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
function norm(s) {
  return String(s ?? "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}
function isAdmin(role) {
  return String(role || "").toLowerCase() === "admin";
}
function addDays(dateISO, days) {
  const d = new Date(dateISO);
  d.setDate(d.getDate() + Number(days || 0));
  return d.toISOString();
}
function formatBR(dateISO) {
  try {
    const d = new Date(dateISO);
    return d.toLocaleDateString("pt-BR");
  } catch { return ""; }
}
function parsePositiveInt(v) {
  const n = Number(String(v ?? "").replace(",", "."));
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return i > 0 ? i : null;
}
function parseNonNegativeNumber(v, fallback = 0) {
  const n = Number(String(v ?? "").replace(",", "."));
  if (!Number.isFinite(n)) return fallback;
  return n < 0 ? fallback : n;
}
function parsePositiveNumber(v, fallback = 1) {
  const n = Number(String(v ?? "").replace(",", "."));
  if (!Number.isFinite(n)) return fallback;
  return n <= 0 ? fallback : n;
}

// -----------------------------
// Firebase helpers
// -----------------------------
async function ensureAnonAuth() {
  if (auth.currentUser) return;
  await signInAnonymously(auth);
}
async function fetchUserDoc(userId) {
  const ref = doc(db, "users", userId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  return snap.data();
}

// -----------------------------
// UI
// -----------------------------
function showLogin() {
  viewLogin.classList.remove("hidden");
  viewApp.classList.add("hidden");
  btnLogout.classList.add("hidden");
  who.textContent = "offline";
  content.innerHTML = "";
}
function showAppHeader({ name, role }) {
  viewLogin.classList.add("hidden");
  viewApp.classList.remove("hidden");
  btnLogout.classList.remove("hidden");

  who.textContent = role || "online";
  const display = name || (role === "admin" ? "ADMIN" : "VEIA");
  welcome.textContent = role === "admin"
    ? `Bem-vindo, ${display}. Você está logado como ADMIN.`
    : `Bem-vindo, ${display}.`;
}

// -----------------------------
// Regras de controle
// -----------------------------
function isHortifrutiCategory(categoryName) {
  return norm(categoryName) === norm("Hortifruti & Frescos");
}
function computeHortifrutiSeverity(item) {
  const s = norm(item.statusCor || item.status || "verde");
  if (s === "vermelho") return "red";
  if (s === "amarelo") return "yellow";
  return "green";
}

/**
 * ETAPA 12 (AJUSTE):
 * - qty === 0 => red (acabou)
 * - qty <= min => yellow (atenção)
 * - regra de tempo continua: qty===1 + abriuUltimaUnidade + passou 70% da duração => red
 */
function computeQuantitySeverity(item) {
  const qty = Number(item.quantidadeAtual ?? 0);
  const min = Number(item.quantidadeMinima ?? 1);
  const dur = Number(item.duracaoMediaDias ?? 7);

  // acabou => vermelho direto
  if (qty === 0) return "red";

  // abaixo/igual ao mínimo => amarelo
  if (qty <= min) return "yellow";

  // vermelho por tempo apenas se for a última unidade e já foi aberta
  if (qty === 1 && item.abriuUltimaUnidade === true && item.abriuEm) {
    const openedAt = (item.abriuEm?.toDate?.() ? item.abriuEm.toDate().toISOString() : item.abriuEm);
    const startRed = addDays(openedAt, Math.ceil(dur * 0.7));
    if (new Date() >= new Date(startRed)) return "red";
  }

  return "green";
}

function computeQuantityEndDate(item) {
  const qty = Number(item.quantidadeAtual ?? 0);
  const dur = Number(item.duracaoMediaDias ?? 7);

  // só faz sentido estimar "acabar" quando estamos na última unidade e ela foi aberta
  if (qty !== 1) return null;
  if (item.abriuUltimaUnidade !== true) return null;
  if (!item.abriuEm) return null;

  const openedAt = (item.abriuEm?.toDate?.() ? item.abriuEm.toDate().toISOString() : item.abriuEm);
  return addDays(openedAt, dur);
}

function computeItemSeverityAndReason(it) {
  const categoryName = it.categoryName || "";
  const control = it.control || (isHortifrutiCategory(categoryName) ? "status" : "quantidade");

  if (control === "status" || isHortifrutiCategory(categoryName)) {
    const sev = computeHortifrutiSeverity(it);
    return { sev, control: "status", reason: "Hortifruti (cor)" };
  }

  const sev = computeQuantitySeverity(it);
  const endDate = computeQuantityEndDate(it);

  const qty = Number(it.quantidadeAtual ?? 0);
  const min = Number(it.quantidadeMinima ?? 1);

  let reason = "OK";
  if (sev === "red") {
    reason = qty === 0
      ? "Sem estoque (0)"
      : `Última unidade acabando (${endDate ? formatBR(endDate) : "sem data"})`;
  } else if (sev === "yellow") {
    reason = `Abaixo/igual ao mínimo (mín: ${min})`;
  }

  return { sev, control: "quantidade", reason, endDate };
}

// -----------------------------
// ETAPA 10: "Comprei"
// -----------------------------
async function handleComprei(it, currentUser, returnTo) {
  const itemRef = doc(db, "items", it.id);

  // Hortifruti: volta para VERDE automático
  const isHorti = (it.control === "status") || isHortifrutiCategory(it.categoryName || "");
  if (isHorti) {
    await updateDoc(itemRef, { statusCor: "verde", updatedAt: serverTimestamp() });
    if (returnTo === "check") return renderCheck(currentUser);
    if (returnTo === "compras") return renderCompras(currentUser);
    return renderItens(currentUser);
  }

  // Quantidade: pergunta quantidade comprada
  const boughtStr = prompt(`Quantas unidades você comprou de "${it.name}"?`, "1");
  if (boughtStr === null) return; // cancelou

  const bought = parsePositiveInt(boughtStr);
  if (!bought) return alert("Digite um número inteiro maior que 0.");

  // Recarrega para evitar concorrência
  const snap = await getDoc(itemRef);
  const current = snap.exists() ? snap.data() : {};
  const oldQty = Number(current.quantidadeAtual ?? 0);
  const newQty = oldQty + bought;

  await updateDoc(itemRef, {
    quantidadeAtual: newQty,
    abriuUltimaUnidade: false,
    abriuEm: null,
    updatedAt: serverTimestamp()
  });

  if (returnTo === "check") return renderCheck(currentUser);
  if (returnTo === "compras") return renderCompras(currentUser);
  return renderItens(currentUser);
}

// -----------------------------
// Render: Categorias (Admin)
// -----------------------------
async function renderCategorias(currentUser) {
  UI_STATE.screen = "categorias"; saveUIState();
  content.innerHTML = `<div class="muted">Carregando categorias...</div>`;

  const catsCol = collection(db, "categories");
  const snap = await getDocs(query(catsCol, orderBy("name")));
  const rows = [];
  snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));

  const admin = isAdmin(currentUser.role);

  content.innerHTML = `
    <h2>Categorias</h2>
    <p class="muted">Cadastre e edite as categorias (apenas ADMIN).</p>

    ${admin ? `
      <div class="row" style="margin-top:12px;">
        <input id="catName" placeholder="Nome da categoria" />
        <button id="btnAddCat" class="btn primary" type="button">Adicionar</button>
      </div>
    ` : `<div class="muted">Perfil VEIA não altera categorias.</div>`}

    <div style="margin-top:14px;">
      ${rows.length ? rows.map(r => `
        <div class="row" style="justify-content:space-between; margin:10px 0;">
          <div><strong>${escapeHtml(r.name)}</strong></div>
          ${admin ? `
            <div class="row" style="gap:10px;">
              <button class="btn" data-editcat="${r.id}">Editar</button>
              <button class="btn danger" data-delcat="${r.id}">Excluir</button>
            </div>
          ` : ``}
        </div>
      `).join("") : `<div class="muted">Nenhuma categoria cadastrada.</div>`}
    </div>
  `;

  if (!admin) return;

  const catName = document.getElementById("catName");
  const btnAddCat = document.getElementById("btnAddCat");

  btnAddCat.onclick = async () => {
    const name = (catName.value || "").trim();
    if (!name) return alert("Digite o nome da categoria.");
    await addDoc(catsCol, { name, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    catName.value = "";
    await renderCategorias(currentUser);
  };

  content.onclick = async (e) => {
    const btn = e.target?.closest("button");
    if (!btn) return;

    const editId = btn.getAttribute("data-editcat");
    const delId = btn.getAttribute("data-delcat");

    if (editId) {
      const newName = prompt("Novo nome da categoria:");
      if (!newName || !newName.trim()) return;
      await updateDoc(doc(db, "categories", editId), { name: newName.trim(), updatedAt: serverTimestamp() });
      await renderCategorias(currentUser);
    }

    if (delId) {
      if (!confirm("Excluir categoria? (itens não são apagados automaticamente)")) return;
      await deleteDoc(doc(db, "categories", delId));
      await renderCategorias(currentUser);
    }
  };
}

// -----------------------------
// Render: Itens (normal)
// -----------------------------
async function renderItens(currentUser) {
  UI_STATE.screen = "itens"; saveUIState();

  // snapshot do foco/cursor ANTES de destruir o HTML
  const focusSnap = snapshotSearchFocus();

  content.innerHTML = `<div class="muted">Carregando itens...</div>`;

  const catsCol = collection(db, "categories");
  const itemsCol = collection(db, "items");

  const catsSnap = await getDocs(query(catsCol, orderBy("name")));
  const cats = [];
  catsSnap.forEach((d) => cats.push(d.data()?.name));

  const filterCatValue = UI_STATE.filterCategory || "(todas)";
  const filterOptions = [
    `<option value="(todas)" ${filterCatValue === "(todas)" ? "selected" : ""}>(Todas categorias)</option>`,
    ...cats.map(c => `<option value="${escapeHtml(c)}" ${c === filterCatValue ? "selected" : ""}>${escapeHtml(c)}</option>`)
  ].join("");

  const addOptions = cats.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");

  const itemsSnap = await getDocs(query(itemsCol, orderBy("name")));
  const allItems = [];
  itemsSnap.forEach((d) => allItems.push({ id: d.id, ...d.data() }));

  const searchTxt = UI_STATE.searchText || "";
  let items = allItems.slice();

  if (filterCatValue !== "(todas)") items = items.filter(it => (it.categoryName || "") === filterCatValue);

  const s = norm(searchTxt);
  if (s) items = items.filter(it => norm(it.name).includes(s));

  const admin = isAdmin(currentUser.role);

  content.innerHTML = `
    <h2>Itens</h2>

    <div class="row" style="margin-top:12px; align-items:flex-end; justify-content:space-between;">
      <div class="grid-3" style="width:100%;">
        <div class="field">
          <label>Filtrar por categoria</label>
          <select id="filterCat">${filterOptions}</select>
        </div>

        <div class="field">
          <label>Busca por nome</label>
          <input id="searchInput" value="${escapeHtml(searchTxt)}" placeholder="Buscar por nome (ex: tomate)" />
        </div>

        <div class="field" style="align-items:flex-end;">
          <div class="small muted">Dica: Use “Check rápido” para operar só amarelo/vermelho.</div>
        </div>
      </div>
    </div>

    ${admin ? `
      <div class="panel" style="margin-top:14px;">
        <div style="font-weight:800; margin-bottom:10px;">Novo item</div>
        <div class="fields">
          <div class="field" style="min-width:220px;">
            <label>Categoria</label>
            <select id="newCat">${addOptions}</select>
          </div>
          <div class="field" style="min-width:260px;">
            <label>Nome do item</label>
            <input id="newName" placeholder="Nome do item (ex: Tomate)" />
          </div>
          <div class="field" style="min-width:160px;">
            <label>Unidade</label>
            <select id="newUnit">
              <option value="un">un</option>
              <option value="pct">pct</option>
              <option value="kg">kg</option>
              <option value="L">L</option>
              <option value="dias">dias</option>
              <option value="rolo">rolo</option>
              <option value="frasco">frasco</option>
              <option value="tubo">tubo</option>
            </select>
          </div>
          <div class="field" style="min-width:160px;">
            <label>&nbsp;</label>
            <button class="btn primary" id="btnAddItem" type="button">Adicionar</button>
          </div>
        </div>
        <div class="small muted" style="margin-top:8px;">
          Para Hortifruti &amp; Frescos o controle é por cor (Verde/Amarelo/Vermelho). As demais categorias usam quantidade + mínimo + duração.
        </div>
      </div>
    ` : ``}

    <div style="margin-top:14px;">
      ${items.length ? items.map(it => renderItemCard(it, admin)).join("") : `<div class="muted">Nenhum item encontrado.</div>`}
    </div>
  `;

  const filterCatEl = document.getElementById("filterCat");
  const searchInputEl = document.getElementById("searchInput");

  filterCatEl.onchange = () => {
    UI_STATE.filterCategory = filterCatEl.value;
    saveUIState();
    renderItens(currentUser);
  };

  // FIX: debounce + não recriar a tela a cada tecla imediatamente
  searchInputEl.oninput = () => {
    UI_STATE.searchText = searchInputEl.value;
    saveUIState();

    clearTimeout(_searchDebounceTimer);
    _searchDebounceTimer = setTimeout(() => {
      const snap = snapshotSearchFocus();
      (async () => {
        await renderItens(currentUser);
        restoreSearchFocus(snap);
      })();
    }, 200);
  };

  searchInputEl.onkeydown = (e) => {
    if (e.key === "Enter") e.preventDefault();
  };

  // restaura foco se estava digitando
  restoreSearchFocus(focusSnap);

  // Adicionar item (admin)
  if (admin) {
    const btnAddItem = document.getElementById("btnAddItem");
    const newCat = document.getElementById("newCat");
    const newName = document.getElementById("newName");
    const newUnit = document.getElementById("newUnit");

    btnAddItem.onclick = async () => {
      const categoryName = (newCat.value || "").trim();
      const name = (newName.value || "").trim();
      const unit = (newUnit.value || "un").trim();

      if (!categoryName) return alert("Selecione a categoria.");
      if (!name) return alert("Digite o nome do item.");

      const horti = isHortifrutiCategory(categoryName);

      const payload = {
        categoryName,
        name,
        unit,
        control: horti ? "status" : "quantidade",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };

      if (horti) {
        payload.statusCor = "verde";
      } else {
        payload.quantidadeAtual = 0;
        payload.quantidadeMinima = 1;     // ESTOQUE MÍNIMO (default)
        payload.duracaoMediaDias = 7;     // DURAÇÃO (default)
        payload.abriuUltimaUnidade = false;
        payload.abriuEm = null;
      }

      await addDoc(collection(db, "items"), payload);

      newName.value = "";
      await renderItens(currentUser);
    };
  }

  // ações
  content.onclick = async (e) => {
    const btn = e.target?.closest("button");
    if (!btn) return;

    // preserva filtros
    const fcNow = document.getElementById("filterCat");
    const siNow = document.getElementById("searchInput");
    if (fcNow) UI_STATE.filterCategory = fcNow.value;
    if (siNow) UI_STATE.searchText = siNow.value;
    saveUIState();

    const idSaveStatus = btn.getAttribute("data-savestatus");
    const idSaveQty = btn.getAttribute("data-saveqty");
    const idBuy = btn.getAttribute("data-buy");
    const idEdit = btn.getAttribute("data-edit");
    const idDelete = btn.getAttribute("data-del");

    try {
      if (idBuy) {
        const it = JSON.parse(btn.getAttribute("data-itemjson") || "{}");
        await handleComprei(it, currentUser, "itens");
        return;
      }

      if (idEdit) {
        if (!admin) return alert("Apenas ADMIN pode editar itens.");
        const it = JSON.parse(btn.getAttribute("data-itemjson") || "{}");

        const newName = prompt("Novo nome do item:", it.name || "");
        if (newName === null) return;

        const newUnit = prompt("Nova unidade (ex: un, pct, kg, L, dias):", it.unit || "un");
        if (newUnit === null) return;

        const newCat = prompt("Nova categoria (deixe em branco para manter):", it.categoryName || "");
        if (newCat === null) return;

        const finalName = (newName || "").trim();
        const finalUnit = (newUnit || "").trim() || "un";
        const finalCat = (newCat || "").trim() || it.categoryName || "";

        if (!finalName) return alert("Nome não pode ficar vazio.");
        if (!finalCat) return alert("Categoria não pode ficar vazia.");

        const horti = isHortifrutiCategory(finalCat);

        const updatePayload = {
          name: finalName,
          unit: finalUnit,
          categoryName: finalCat,
          control: horti ? "status" : "quantidade",
          updatedAt: serverTimestamp(),
        };

        if (horti) {
          updatePayload.statusCor = (it.statusCor || "verde");
        } else {
          updatePayload.quantidadeMinima = Number.isFinite(Number(it.quantidadeMinima)) ? Number(it.quantidadeMinima) : 1;
          updatePayload.duracaoMediaDias = Number.isFinite(Number(it.duracaoMediaDias)) ? Number(it.duracaoMediaDias) : 7;
          updatePayload.quantidadeAtual = Number.isFinite(Number(it.quantidadeAtual)) ? Number(it.quantidadeAtual) : 0;
          updatePayload.abriuUltimaUnidade = it.abriuUltimaUnidade === true;
        }

        await updateDoc(doc(db, "items", idEdit), updatePayload);
        await renderItens(currentUser);
        return;
      }

      if (idDelete) {
        if (!admin) return alert("Apenas ADMIN pode excluir itens.");
        if (!confirm("Excluir este item?")) return;
        await deleteDoc(doc(db, "items", idDelete));
        await renderItens(currentUser);
        return;
      }

      if (idSaveStatus) {
        const sel = document.getElementById(`status-${idSaveStatus}`);
        const val = (sel?.value || "verde").toLowerCase();
        await updateDoc(doc(db, "items", idSaveStatus), { statusCor: val, updatedAt: serverTimestamp() });
        await renderItens(currentUser);
        return;
      }

      if (idSaveQty) {
        const q = document.getElementById(`q-${idSaveQty}`);
        const opened = document.getElementById(`opened-${idSaveQty}`);

        // ETAPA 11: mínimos/duração (ADMIN)
        const minEl = document.getElementById(`min-${idSaveQty}`);
        const durEl = document.getElementById(`dur-${idSaveQty}`);

        const quantidadeAtual = parseNonNegativeNumber(q?.value ?? 0, 0);
        const abriuUltimaUnidade = opened?.checked === true;

        const payload = {
          quantidadeAtual,
          abriuUltimaUnidade,
          updatedAt: serverTimestamp()
        };

        if (admin && minEl && durEl) {
          payload.quantidadeMinima = parsePositiveNumber(minEl.value, 1);
          payload.duracaoMediaDias = parsePositiveNumber(durEl.value, 7);
        }

        const snap = await getDoc(doc(db, "items", idSaveQty));
        if (snap.exists()) {
          const old = snap.data();
          const had = !!old.abriuEm;
          if (abriuUltimaUnidade && !had) payload.abriuEm = serverTimestamp();
          if (!abriuUltimaUnidade) payload.abriuEm = null;
        }

        await updateDoc(doc(db, "items", idSaveQty), payload);
        await renderItens(currentUser);
        return;
      }
    } catch (err) {
      console.error(err);
      alert(err?.message || "Erro ao salvar.");
    }
  };
}

function renderItemCard(it, admin) {
  const categoryName = it.categoryName || "";
  const name = it.name || "";
  const unit = it.unit || "un";
  const control = it.control || (isHortifrutiCategory(categoryName) ? "status" : "quantidade");

  const adminBtns = admin ? `
    <div class="row" style="gap:10px;">
      <button class="btn" data-edit="${it.id}" data-itemjson='${escapeHtml(JSON.stringify({
        id: it.id, name, unit, categoryName, control,
        statusCor: it.statusCor,
        quantidadeAtual: it.quantidadeAtual,
        quantidadeMinima: it.quantidadeMinima,
        duracaoMediaDias: it.duracaoMediaDias,
        abriuUltimaUnidade: it.abriuUltimaUnidade
      }))}' type="button">Editar</button>
      <button class="btn danger" data-del="${it.id}" type="button">Excluir</button>
    </div>
  ` : ``;

  if (control === "status" || isHortifrutiCategory(categoryName)) {
    const sev = computeHortifrutiSeverity(it);
    const label = sev === "red" ? "Vermelho" : sev === "yellow" ? "Amarelo" : "Verde";

    return `
      <div class="item-card ${sev}">
        <div class="item-top">
          <div>
            <div class="item-title">${escapeHtml(name)}</div>
            <div class="item-meta">${escapeHtml(categoryName)} • Unidade: ${escapeHtml(unit)} • Controle: Hortifruti</div>
          </div>
          <div class="row" style="gap:12px; align-items:center;">
            <span class="pill ${sev}">${label}</span>
            ${adminBtns}
          </div>
        </div>

        <div class="fields">
          <div class="field" style="min-width:220px;">
            <label>Cor</label>
            <select id="status-${it.id}">
              <option value="verde" ${norm(it.statusCor) === "verde" ? "selected" : ""}>Verde</option>
              <option value="amarelo" ${norm(it.statusCor) === "amarelo" ? "selected" : ""}>Amarelo</option>
              <option value="vermelho" ${norm(it.statusCor) === "vermelho" ? "selected" : ""}>Vermelho</option>
            </select>
          </div>

          <div class="field" style="min-width:160px;">
            <label>&nbsp;</label>
            <button class="btn primary" data-savestatus="${it.id}" type="button">Salvar</button>
          </div>

          <div class="field" style="min-width:160px;">
            <label>&nbsp;</label>
            <button class="btn" data-buy="${it.id}" data-itemjson='${escapeHtml(JSON.stringify({ id: it.id, name, categoryName, control }))}' type="button">🛒 Comprei</button>
          </div>
        </div>
      </div>
    `;
  }

  const sev = computeQuantitySeverity(it);
  const endDate = computeQuantityEndDate(it);
  const label = sev === "red" ? "Vermelho" : sev === "yellow" ? "Amarelo" : "Verde";

  const qty = Number(it.quantidadeAtual ?? 0);
  const opened = it.abriuUltimaUnidade === true;

  const min = Number.isFinite(Number(it.quantidadeMinima)) ? Number(it.quantidadeMinima) : 1;
  const dur = Number.isFinite(Number(it.duracaoMediaDias)) ? Number(it.duracaoMediaDias) : 7;

  const endLine = endDate
    ? `Previsto para acabar: <strong>${escapeHtml(formatBR(endDate))}</strong>`
    : `Previsto para acabar: <span class="muted">—</span>`;

  const adminMinDur = admin ? `
    <div class="field" style="min-width:160px;">
      <label>Estoque mínimo</label>
      <input id="min-${it.id}" type="number" value="${escapeHtml(min)}" />
    </div>

    <div class="field" style="min-width:160px;">
      <label>Duração (dias)</label>
      <input id="dur-${it.id}" type="number" value="${escapeHtml(dur)}" />
    </div>
  ` : ``;

  return `
    <div class="item-card ${sev}">
      <div class="item-top">
        <div>
          <div class="item-title">${escapeHtml(name)}</div>
          <div class="item-meta">${escapeHtml(categoryName)} • Unidade: ${escapeHtml(unit)} • Controle: Quantidade</div>
          <div class="small" style="margin-top:6px;">${endLine}</div>
        </div>
        <div class="row" style="gap:12px; align-items:center;">
          <span class="pill ${sev}">${label}</span>
          ${adminBtns}
        </div>
      </div>

      <div class="fields">
        <div class="field">
          <label>Qtd atual</label>
          <input id="q-${it.id}" type="number" value="${escapeHtml(qty)}" />
        </div>

        <div class="field" style="min-width:220px;">
          <label>Abriu última unidade?</label>
          <input id="opened-${it.id}" type="checkbox" ${opened ? "checked" : ""} />
        </div>

        ${adminMinDur}

        <div class="field" style="min-width:160px;">
          <label>&nbsp;</label>
          <button class="btn primary" data-saveqty="${it.id}" type="button">Salvar</button>
        </div>

        <div class="field" style="min-width:160px;">
          <label>&nbsp;</label>
          <button class="btn" data-buy="${it.id}" data-itemjson='${escapeHtml(JSON.stringify({ id: it.id, name, categoryName, control }))}' type="button">🛒 Comprei</button>
        </div>
      </div>
    </div>
  `;
}

// -----------------------------
// Render: Compras (amarelo/vermelho) + Comprei
// -----------------------------
async function renderCompras(currentUser) {
  UI_STATE.screen = "compras"; saveUIState();
  content.innerHTML = `<div class="muted">Carregando compras...</div>`;

  const itemsCol = collection(db, "items");
  const itemsSnap = await getDocs(query(itemsCol, orderBy("name")));
  const allItems = [];
  itemsSnap.forEach((d) => allItems.push({ id: d.id, ...d.data() }));

  const needs = [];
  for (const it of allItems) {
    const { sev, control, reason, endDate } = computeItemSeverityAndReason(it);
    if (sev === "yellow" || sev === "red") needs.push({ ...it, _sev: sev, _control: control, _reason: reason, _endDate: endDate });
  }

  needs.sort((a, b) => (a._sev === b._sev ? norm(a.name).localeCompare(norm(b.name)) : (a._sev === "red" ? -1 : 1)));

  content.innerHTML = `
    <h2>Compras</h2>
    <p class="muted">Lista automática baseada nos alertas. Use “🛒 Comprei” para dar baixa.</p>

    ${needs.length ? `
      <div class="panel" style="margin-top:12px;">
        ${needs.map(it => `
          <div class="row" style="justify-content:space-between; padding:10px 0; border-top:1px solid var(--border); gap:12px;">
            <div style="flex:1;">
              <div style="font-weight:800;">${escapeHtml(it.name)}</div>
              <div class="small">${escapeHtml(it.categoryName || "")} • ${escapeHtml(it._reason || "")}</div>
            </div>
            <span class="pill ${it._sev}">${it._sev === "red" ? "Vermelho" : "Amarelo"}</span>
            <button class="btn" data-comprei="${it.id}" data-itemjson='${escapeHtml(JSON.stringify({ id: it.id, name: it.name, categoryName: it.categoryName, control: it._control }))}'>🛒 Comprei</button>
          </div>
        `).join("")}
      </div>
    ` : `<div class="muted">Nada para comprar agora. Tudo em verde.</div>`}
  `;

  content.onclick = async (e) => {
    const btn = e.target?.closest("button");
    if (!btn) return;

    const id = btn.getAttribute("data-comprei");
    if (!id) return;

    try {
      const it = JSON.parse(btn.getAttribute("data-itemjson") || "{}");
      await handleComprei(it, currentUser, "compras");
    } catch (err) {
      console.error(err);
      alert(err?.message || "Erro ao confirmar compra.");
    }
  };
}

// -----------------------------
// Render: Check Rápido (somente amarelo/vermelho) + Comprei
// -----------------------------
async function renderCheck(currentUser) {
  UI_STATE.screen = "check"; saveUIState();
  content.innerHTML = `<div class="muted">Carregando Check rápido...</div>`;

  const itemsCol = collection(db, "items");
  const itemsSnap = await getDocs(query(itemsCol, orderBy("name")));
  const allItems = [];
  itemsSnap.forEach((d) => allItems.push({ id: d.id, ...d.data() }));

  const hot = [];
  for (const it of allItems) {
    const { sev, control, reason, endDate } = computeItemSeverityAndReason(it);
    if (sev === "yellow" || sev === "red") hot.push({ ...it, _sev: sev, _control: control, _reason: reason, _endDate: endDate });
  }

  hot.sort((a, b) => (a._sev === b._sev ? norm(a.name).localeCompare(norm(b.name)) : (a._sev === "red" ? -1 : 1)));

  content.innerHTML = `
    <h2>Check rápido</h2>
    <p class="muted">Somente itens em <strong>Amarelo</strong> ou <strong>Vermelho</strong>. Ajuste, salve e/ou confirme compra.</p>

    ${hot.length ? `
      <div style="margin-top:14px;">
        ${hot.map(it => renderCheckCard(it)).join("")}
      </div>
    ` : `<div class="muted">Nada pendente. Tudo em verde.</div>`}
  `;

  content.onclick = async (e) => {
    const btn = e.target?.closest("button");
    if (!btn) return;

    const idSaveStatus = btn.getAttribute("data-check-savestatus");
    const idSaveQty = btn.getAttribute("data-check-saveqty");
    const idBuy = btn.getAttribute("data-check-buy");

    try {
      if (idBuy) {
        const it = JSON.parse(btn.getAttribute("data-itemjson") || "{}");
        await handleComprei(it, currentUser, "check");
        return;
      }

      if (idSaveStatus) {
        const sel = document.getElementById(`check-status-${idSaveStatus}`);
        const val = (sel?.value || "verde").toLowerCase();
        await updateDoc(doc(db, "items", idSaveStatus), { statusCor: val, updatedAt: serverTimestamp() });
        await renderCheck(currentUser);
        return;
      }

      if (idSaveQty) {
        const q = document.getElementById(`check-q-${idSaveQty}`);
        const opened = document.getElementById(`check-opened-${idSaveQty}`);

        const quantidadeAtual = parseNonNegativeNumber(q?.value ?? 0, 0);
        const abriuUltimaUnidade = opened?.checked === true;

        const payload = {
          quantidadeAtual,
          abriuUltimaUnidade,
          updatedAt: serverTimestamp()
        };

        const snap = await getDoc(doc(db, "items", idSaveQty));
        if (snap.exists()) {
          const old = snap.data();
          const had = !!old.abriuEm;
          if (abriuUltimaUnidade && !had) payload.abriuEm = serverTimestamp();
          if (!abriuUltimaUnidade) payload.abriuEm = null;
        }

        await updateDoc(doc(db, "items", idSaveQty), payload);
        await renderCheck(currentUser);
        return;
      }
    } catch (err) {
      console.error(err);
      alert(err?.message || "Erro no Check.");
    }
  };
}

function renderCheckCard(it) {
  const sev = it._sev;
  const label = sev === "red" ? "Vermelho" : "Amarelo";

  if (it._control === "status") {
    return `
      <div class="item-card ${sev}">
        <div class="item-top">
          <div>
            <div class="item-title">${escapeHtml(it.name)}</div>
            <div class="item-meta">${escapeHtml(it.categoryName || "")} • ${escapeHtml(it._reason || "")}</div>
          </div>
          <span class="pill ${sev}">${label}</span>
        </div>

        <div class="fields">
          <div class="field" style="min-width:220px;">
            <label>Cor</label>
            <select id="check-status-${it.id}">
              <option value="verde" ${norm(it.statusCor) === "verde" ? "selected" : ""}>Verde</option>
              <option value="amarelo" ${norm(it.statusCor) === "amarelo" ? "selected" : ""}>Amarelo</option>
              <option value="vermelho" ${norm(it.statusCor) === "vermelho" ? "selected" : ""}>Vermelho</option>
            </select>
          </div>

          <div class="field" style="min-width:160px;">
            <label>&nbsp;</label>
            <button class="btn primary" data-check-savestatus="${it.id}" type="button">Salvar</button>
          </div>

          <div class="field" style="min-width:160px;">
            <label>&nbsp;</label>
            <button class="btn" data-check-buy="${it.id}" data-itemjson='${escapeHtml(JSON.stringify({ id: it.id, name: it.name, categoryName: it.categoryName, control: "status" }))}' type="button">🛒 Comprei</button>
          </div>
        </div>
      </div>
    `;
  }

  const endLine = it._endDate
    ? `Previsto para acabar: <strong>${escapeHtml(formatBR(it._endDate))}</strong>`
    : `Previsto para acabar: <span class="muted">—</span>`;

  const qty = Number(it.quantidadeAtual ?? 0);
  const opened = it.abriuUltimaUnidade === true;

  return `
    <div class="item-card ${sev}">
      <div class="item-top">
        <div>
          <div class="item-title">${escapeHtml(it.name)}</div>
          <div class="item-meta">${escapeHtml(it.categoryName || "")} • ${escapeHtml(it._reason || "")}</div>
          <div class="small" style="margin-top:6px;">${endLine}</div>
        </div>
        <span class="pill ${sev}">${label}</span>
      </div>

      <div class="fields">
        <div class="field">
          <label>Qtd atual</label>
          <input id="check-q-${it.id}" type="number" value="${escapeHtml(qty)}" />
        </div>

        <div class="field" style="min-width:220px;">
          <label>Abriu última unidade?</label>
          <input id="check-opened-${it.id}" type="checkbox" ${opened ? "checked" : ""} />
        </div>

        <div class="field" style="min-width:160px;">
          <label>&nbsp;</label>
          <button class="btn primary" data-check-saveqty="${it.id}" type="button">Salvar</button>
        </div>

        <div class="field" style="min-width:160px;">
          <label>&nbsp;</label>
          <button class="btn" data-check-buy="${it.id}" data-itemjson='${escapeHtml(JSON.stringify({ id: it.id, name: it.name, categoryName: it.categoryName, control: "quantidade" }))}' type="button">🛒 Comprei</button>
        </div>
      </div>
    </div>
  `;
}

// -----------------------------
// Login flow
// -----------------------------
async function loginFlow(userId) {
  await ensureAnonAuth();

  const userData = await fetchUserDoc(userId);
  if (!userData) {
    alert(`Não achei users/${userId} no Firestore. Crie esse documento (name/role).`);
    return;
  }

  showAppHeader({ name: userData.name, role: userData.role });

  if (UI_STATE.screen === "compras") await renderCompras(userData);
  else if (UI_STATE.screen === "categorias") await renderCategorias(userData);
  else if (UI_STATE.screen === "check") await renderCheck(userData);
  else await renderItens(userData);
}

// -----------------------------
// Navegação
// -----------------------------
btnCategorias.onclick = () => {
  const userId = getSession();
  if (!userId) return;
  fetchUserDoc(userId).then(u => renderCategorias(u)).catch(e => alert(e?.message || "Erro ao abrir Categorias."));
};
btnItens.onclick = () => {
  const userId = getSession();
  if (!userId) return;
  fetchUserDoc(userId).then(u => renderItens(u)).catch(e => alert(e?.message || "Erro ao abrir Itens."));
};
btnCompras.onclick = () => {
  const userId = getSession();
  if (!userId) return;
  fetchUserDoc(userId).then(u => renderCompras(u)).catch(e => alert(e?.message || "Erro ao abrir Compras."));
};
btnCheck.onclick = () => {
  const userId = getSession();
  if (!userId) return;
  fetchUserDoc(userId).then(u => renderCheck(u)).catch(e => alert(e?.message || "Erro ao abrir Check."));
};

// -----------------------------
// Entrar
// -----------------------------
btnLogin.addEventListener("click", async (e) => {
  e.preventDefault();

  const userId = userSelect.value;
  const pin = pinInput.value.trim();

  if (!pin) return alert("Digite o PIN.");
  if (USERS_PIN[userId] !== pin) return alert("PIN inválido.");

  setSession(userId);

  try {
    await loginFlow(userId);
  } catch (err) {
    console.error(err);
    alert(err?.message || "Erro no login.");
  }
});

// -----------------------------
// Logout
// -----------------------------
btnLogout.addEventListener("click", async () => {
  clearSession();
  try { if (auth.currentUser) await signOut(auth); } catch (_) {}
  location.reload();
});

// -----------------------------
// Boot
// -----------------------------
onAuthStateChanged(auth, async () => {
  const sessionUser = getSession();
  if (!sessionUser) {
    showLogin();
    return;
  }

  try {
    await loginFlow(sessionUser);
  } catch (err) {
    console.error(err);
    showLogin();
  }
});


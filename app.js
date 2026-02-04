/* GOC Library - GitHub Pages (Static)
 * Storage: localStorage (single-browser)
 * Book info: Hybrid (Google Books API + Open Library fallback)
 */

const STORAGE_KEY = "goc_library_v1";
const GOOGLE_BOOKS_API_KEY = "AIzaSyB75eePCH1FTX3jXLA2mfk0EwoV_uf-Yxg";
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBEluBIaKWmj7TaJ32eisZ9Noq52P8ZNoQ",
  authDomain: "gocbook2.firebaseapp.com",
  projectId: "gocbook2",
  storageBucket: "gocbook2.firebasestorage.app",
  messagingSenderId: "152276564487",
  appId: "1:152276564487:web:8dc5644bdc867438cd48a2",
  measurementId: "G-BTD4Y2213N"
};
const FIREBASE_DOC_ID = "default";
const CLIENT_ID_KEY = "goc_library_client_id";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const todayYmd = () => new Date().toISOString().slice(0, 10);
const addDays = (ymd, days) => {
  const d = new Date(ymd + "T00:00:00");
  d.setDate(d.getDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
};
const daysDiff = (aYmd, bYmd) => {
  // b - a (days)
  const a = new Date(aYmd + "T00:00:00").getTime();
  const b = new Date(bYmd + "T00:00:00").getTime();
  return Math.round((b - a) / (1000 * 60 * 60 * 24));
};

function defaultData() {
  return {
    version: 1,
    seq: 1,
    meta: {
      updatedAt: 0,
      updatedBy: ""
    },
    settings: {
      libName: "GOC 도서관",
      defaultLoanDays: 14,
      pinHash: null,       // base64
      pinSalt: null        // base64
    },
    books: {},             // { invNo: Book }
    activity: []           // recent first
  };
}

let db = null;
let remoteReady = false;
let remoteSaveTimer = null;

function initFirebase() {
  try {
    if (!FIREBASE_CONFIG?.apiKey || !window.firebase) return;
    firebase.initializeApp(FIREBASE_CONFIG);
    db = firebase.firestore();
    remoteReady = true;
  } catch (e) {
    console.warn("Firebase init failed", e);
  }
}

function normalizeData(input) {
  const base = defaultData();
  const data = input && typeof input === "object" ? input : base;
  if (!data.version) data.version = 1;
  if (!data.meta) data.meta = base.meta;
  if (!data.settings) data.settings = base.settings;
  if (!data.books) data.books = {};
  if (!data.activity) data.activity = [];
  if (!Number.isFinite(data.seq)) data.seq = 1;
  return data;
}

function getClientId() {
  let id = localStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : `c_${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

const CLIENT_ID = getClientId();

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultData();
    const data = JSON.parse(raw);
    return normalizeData(data);
  } catch {
    return defaultData();
  }
}

function saveLocal(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function scheduleRemoteSave(data) {
  if (!remoteReady || !db) return;
  clearTimeout(remoteSaveTimer);
  remoteSaveTimer = setTimeout(async () => {
    try {
      data.meta = data.meta || {};
      data.meta.updatedAt = Date.now();
      data.meta.updatedBy = CLIENT_ID;
      await db.collection("libraries").doc(FIREBASE_DOC_ID).set(data);
    } catch (e) {
      console.warn("Firebase save failed", e);
      toast("Firebase 저장 실패. 로컬에 저장됨.");
    }
  }, 800);
}

function save(data) {
  saveLocal(data);
  scheduleRemoteSave(data);
}

async function loadRemoteData(localData) {
  if (!remoteReady || !db) return localData;
  try {
    const snap = await db.collection("libraries").doc(FIREBASE_DOC_ID).get();
    if (snap.exists) {
      const remote = normalizeData(snap.data());
      saveLocal(remote);
      return remote;
    }
    await db.collection("libraries").doc(FIREBASE_DOC_ID).set(localData);
  } catch (e) {
    console.warn("Firebase load failed", e);
    toast("Firebase 연결 실패. 로컬 데이터 사용.");
  }
  return localData;
}

function startRemoteSync() {
  if (!remoteReady || !db) return;
  db.collection("libraries").doc(FIREBASE_DOC_ID).onSnapshot((snap) => {
    if (!snap.exists) return;
    const remote = normalizeData(snap.data());
    const localUpdated = data?.meta?.updatedAt || 0;
    const remoteUpdated = remote?.meta?.updatedAt || 0;
    if (remoteUpdated > localUpdated) {
      data = remote;
      saveLocal(data);
      renderAll();
      ensureEmptyStates();
      applyView(localStorage.getItem(VIEW_KEY) || "grid");
    }
  }, (err) => {
    console.warn("Firebase snapshot failed", err);
  });
}
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.style.display = "block";
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.style.display = "none"), 1800);
}

function nextInvNo(data) {
  const n = String(data.seq).padStart(4, "0");
  data.seq += 1;
  return `GOC-${n}`;
}

function isOverdue(book) {
  if (book.status !== "loaned" || !book.currentLoan?.dueDate) return false;
  return book.currentLoan.dueDate < todayYmd();
}

function isDueSoon(book, windowDays = 3) {
  if (book.status !== "loaned" || !book.currentLoan?.dueDate) return false;
  const diff = daysDiff(todayYmd(), book.currentLoan.dueDate); // due - today
  return diff <= windowDays;
}

function pushActivity(data, item) {
  data.activity.unshift({
    at: new Date().toISOString(),
    ...item
  });
  if (data.activity.length > 80) data.activity.length = 80;
}

async function sha256Base64(text) {
  const enc = new TextEncoder().encode(text);
  const hashBuf = await crypto.subtle.digest("SHA-256", enc);
  const bytes = new Uint8Array(hashBuf);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

function randomSaltBase64(len = 16) {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  let bin = "";
  a.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

async function pinHash(pin, saltB64) {
  // hash = sha256(pin + ":" + salt)
  const salt = saltB64 || randomSaltBase64();
  const hash = await sha256Base64(`${pin}:${salt}`);
  return { salt, hash };
}

let data = load();
let unlocked = false;

// -------------------- Tabs / Router --------------------
function showPage(name) {
  $$(".tab").forEach((b) => b.classList.toggle("is-active", b.dataset.page === name));
  $$(".page").forEach((p) => p.classList.toggle("is-active", p.id === `page-${name}`));
  renderAll();
}

$$(".tab").forEach((b) => b.addEventListener("click", () => showPage(b.dataset.page)));

// -------------------- Render --------------------
function renderHeader() {
  $("#libNameTitle").textContent = data.settings.libName || "GOC 도서관";
  $("#lockBtn").textContent = unlocked ? "🔓 해제됨" : "🔒 잠금";
  $("#adminHint").textContent = unlocked ? "🔓 관리자 모드: 등록/수정 가능" : "🔒 잠금 상태에서는 등록/수정이 제한돼요";
}

function renderDashboard() {
  const books = Object.values(data.books);
  const total = books.length;
  const loaned = books.filter((b) => b.status === "loaned").length;
  const overdue = books.filter((b) => isOverdue(b)).length;
  const avail = total - loaned;

  $("#mTotal").textContent = total;
  $("#mAvail").textContent = avail;
  $("#mLoaned").textContent = loaned;
  $("#mOverdue").textContent = overdue;

  // due soon list
  const dueSoon = books
    .filter((b) => b.status === "loaned")
    .filter((b) => isDueSoon(b, 3))
    .sort((a, b) => a.currentLoan.dueDate.localeCompare(b.currentLoan.dueDate))
    .slice(0, 10);

  const list = $("#dueSoonList");
  list.innerHTML = "";
  if (dueSoon.length === 0) {
    $("#dueSoonEmpty").classList.add("is-show");
  } else {
    $("#dueSoonEmpty").classList.remove("is-show");
    for (const b of dueSoon) {
      const due = b.currentLoan.dueDate;
      const diff = daysDiff(todayYmd(), due);
      const status = diff < 0 ? `연체 D${diff}` : `D-${diff}`;
      const badgeCls = diff < 0 ? "bad" : (diff <= 1 ? "warn" : "good");

      list.appendChild(itemRow(
        `${b.invNo} · ${b.title}`,
        `${b.currentLoan.borrower} · 반납예정 ${due} (${status})`,
        `<span class="badge ${badgeCls}">${diff < 0 ? "연체" : "임박"}</span>`
      ));
    }
  }

  // activity
  const act = $("#activityList");
  act.innerHTML = "";
  const recent = (data.activity || []).slice(0, 12);
  if (recent.length === 0) {
    $("#activityEmpty").classList.add("is-show");
  } else {
    $("#activityEmpty").classList.remove("is-show");
    for (const a of recent) {
      const when = a.at.slice(0, 16).replace("T", " ");
      act.appendChild(itemRow(
        `${a.type} · ${a.invNo || ""} ${a.title || ""}`.trim(),
        `${a.by || a.borrower || ""} ${a.note ? "· " + a.note : ""} · ${when}`.trim(),
        ""
      ));
    }
  }
}

function itemRow(title, sub, rightHtml) {
  const div = document.createElement("div");
  div.className = "item";
  div.innerHTML = `
    <div>
      <strong>${escapeHtml(title)}</strong>
      <div class="muted">${escapeHtml(sub || "")}</div>
    </div>
    <div>${rightHtml || ""}</div>
  `;
  return div;
}

function renderSearchResults(results) {
  const box = $("#searchResults");
  box.innerHTML = "";
  if (!results || results.length === 0) {
    $("#searchEmpty").classList.add("is-show");
    $("#searchEmpty").textContent = "검색 결과가 없어요. ISBN/키워드를 바꿔보거나 수동 입력을 사용해봐!";
    return;
  }
  $("#searchEmpty").classList.remove("is-show");

  results.forEach((r, idx) => {
    const el = document.createElement("div");
    el.className = "book";
    const authors = (r.authors || []).join(", ") || "저자 정보 없음";
    const hasThumb = !!r.thumbnail;
    el.innerHTML = `
      <div class="book-cover">
        <div class="cover-frame${hasThumb ? "" : " no-img"}">
          ${hasThumb ? `<img class="cover-img" src="${escapeAttr(r.thumbnail || "")}" alt="" onerror="this.remove(); this.parentElement.classList.add('no-img');"/>` : ""}
          <div class="cover-placeholder">
            <div class="ph-title">${escapeHtml(r.title || "(제목 없음)")}</div>
            <div class="ph-sub">${escapeHtml(authors)}</div>
          </div>
        </div>
        <div class="cover-badge badge good">검색 결과</div>
        ${idx < 3 ? `<div class="cover-ribbon">추천</div>` : ""}
      </div>
      <div class="book-info">
        <div class="book-title">${escapeHtml(r.title || "(제목 없음)")}</div>
        <div class="book-sub">${escapeHtml(authors)}</div>
        <div class="book-meta-lines">
          <div class="small">${escapeHtml(r.publisher || "")} ${escapeHtml(r.publishedDate || "")}</div>
          <div class="small">ISBN: ${escapeHtml(r.isbn13 || r.isbn10 || "-")}</div>
        </div>
      </div>
      <div class="actions">
        <button class="btn" data-act="add" data-payload='${escapeAttr(JSON.stringify(r))}'>➕ 이 도서 등록</button>
      </div>
    `;
    box.appendChild(el);
  });

  box.querySelectorAll("[data-act='add']").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!guardAdmin()) return;
      const payload = JSON.parse(btn.dataset.payload);
      addBookFromApi(payload);
    });
  });
}

function renderBooks() {
  const books = Object.values(data.books);
  const q = ($("#bookSearch").value || "").trim().toLowerCase();
  const filter = $("#bookFilter").value;

  const filtered = books.filter((b) => {
    const text = `${b.invNo} ${b.title} ${(b.authors || []).join(" ")} ${b.isbn13 || ""} ${b.isbn10 || ""}`.toLowerCase();
    if (q && !text.includes(q)) return false;

    if (filter === "available") return b.status === "available";
    if (filter === "loaned") return b.status === "loaned";
    if (filter === "overdue") return isOverdue(b);
    return true;
  });

  const nowYm = new Date().toISOString().slice(0, 7);
  const monthly = filtered.filter((b) => (b.addedAt || "").slice(0, 7) === nowYm);
  const rest = filtered.filter((b) => (b.addedAt || "").slice(0, 7) !== nowYm);

  const monthlyList = $("#monthlyBooksList");
  monthlyList.innerHTML = "";
  if (monthly.length === 0) {
    $("#monthlyBooksEmpty").classList.add("is-show");
  } else {
    $("#monthlyBooksEmpty").classList.remove("is-show");
    monthly
      .sort((a, b) => a.invNo.localeCompare(b.invNo))
      .forEach((b, idx) => monthlyList.appendChild(bookCard(b, idx)));
  }

  const list = $("#booksList");
  list.innerHTML = "";
  if (rest.length === 0) {
    $("#booksEmpty").classList.add("is-show");
  } else {
    $("#booksEmpty").classList.remove("is-show");
    rest
      .sort((a, b) => a.invNo.localeCompare(b.invNo))
      .forEach((b, idx) => list.appendChild(bookCard(b, idx)));
  }
}

function bookCard(b, idx) {
  const el = document.createElement("div");
  el.className = "book";

  const statusLabel = (() => {
    if (b.status === "available") return { text: "비치중", cls: "good" };
    if (isOverdue(b)) return { text: "연체", cls: "bad" };
    return { text: "대여중", cls: "warn" };
  })();

  const dueLine = (() => {
    if (b.status !== "loaned") return "";
    const due = b.currentLoan?.dueDate || "";
    const diff = daysDiff(todayYmd(), due);
    const tag = diff < 0 ? `D${diff}` : `D-${diff}`;
    const borrower = b.currentLoan?.borrower || "-";
    return `${escapeHtml(borrower)} · ${escapeHtml(due)} (${tag})`;
  })();

  const loanLine = (b.status === "loaned")
    ? `<div class="small">대여자: <b>${escapeHtml(b.currentLoan.borrower || "-")}</b></div>
       <div class="small">반납예정: <b>${escapeHtml(b.currentLoan.dueDate || "-")}</b></div>`
    : `<div class="small">상태: 비치중</div>`;

  const authors = (b.authors || []).join(", ") || "";
  const hasThumb = !!b.thumbnail;

  const summary = truncateText(stripTags(b.description || ""), 140);

  el.innerHTML = `
    <div class="book-cover">
      <div class="cover-frame${hasThumb ? "" : " no-img"}">
        ${hasThumb ? `<img class="cover-img" src="${escapeAttr(b.thumbnail || "")}" alt="" onerror="this.remove(); this.parentElement.classList.add('no-img');"/>` : ""}
        <div class="cover-placeholder">
          <div class="ph-title">${escapeHtml(b.title || "")}</div>
          <div class="ph-sub">${escapeHtml(authors || "저자 정보 없음")}</div>
        </div>
      </div>
      <div class="cover-badge badge ${statusLabel.cls}">${statusLabel.text}</div>
      ${dueLine ? `<div class="cover-chip">${dueLine}</div>` : ""}
      ${idx < 3 ? `<div class="cover-ribbon">BEST</div>` : ""}
    </div>
    <div class="book-info">
      <div class="book-title">${escapeHtml(b.title || "")}</div>
      <div class="book-sub">${escapeHtml(authors)}</div>
      ${summary ? `<div class="book-summary">${escapeHtml(summary)}</div>` : ""}
      <div class="book-meta-lines">
        <div class="small">인벤번호: <b>${escapeHtml(b.invNo)}</b></div>
        <div class="small">ISBN: ${escapeHtml(b.isbn13 || b.isbn10 || "-")}</div>
        ${loanLine}
        <div class="small">분류: ${escapeHtml((b.categories || []).join(", ") || "-")}</div>
        <div class="small">메모: ${escapeHtml(b.note || "-")}</div>
      </div>
    </div>
    <div class="actions">
      ${b.status === "available"
        ? `<button class="btn" data-act="checkout" data-id="${escapeAttr(b.invNo)}">📌 대여</button>`
        : `<button class="btn" data-act="return" data-id="${escapeAttr(b.invNo)}">✅ 반납</button>
           <button class="btn btn-ghost" data-act="extend" data-id="${escapeAttr(b.invNo)}">🗓️ 연장</button>`
      }
      <button class="btn btn-ghost" data-act="edit" data-id="${escapeAttr(b.invNo)}">✏️ 수정</button>
      <button class="btn btn-danger" data-act="del" data-id="${escapeAttr(b.invNo)}">🗑️ 삭제</button>
    </div>
  `;

  el.querySelectorAll("[data-act]").forEach((btn) => {
    btn.addEventListener("click", () => onBookAction(btn.dataset.act, btn.dataset.id));
  });

  return el;
}

function renderLoans() {
  const books = Object.values(data.books).filter((b) => b.status === "loaned");
  const q = ($("#loanSearch").value || "").trim().toLowerCase();
  const tbody = $("#loanTbody");
  tbody.innerHTML = "";

  const rows = books
    .filter((b) => {
      const text = `${b.invNo} ${b.title} ${(b.currentLoan?.borrower || "")}`.toLowerCase();
      return !q || text.includes(q);
    })
    .sort((a, b) => a.currentLoan.dueDate.localeCompare(b.currentLoan.dueDate));

  if (rows.length === 0) {
    $("#loansEmpty").classList.add("is-show");
    return;
  }
  $("#loansEmpty").classList.remove("is-show");

  rows.forEach((b) => {
    const due = b.currentLoan?.dueDate || "";
    const diff = daysDiff(todayYmd(), due);
    const state = diff < 0 ? "연체" : "대여중";
    const badge = diff < 0 ? `<span class="badge bad">연체</span>` : `<span class="badge warn">대여중</span>`;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${badge}</td>
      <td><b>${escapeHtml(b.invNo)}</b></td>
      <td>${escapeHtml(b.title)}</td>
      <td>${escapeHtml(b.currentLoan?.borrower || "")}</td>
      <td>${escapeHtml(b.currentLoan?.loanDate || "")}</td>
      <td>${escapeHtml(due)} <span class="muted">(${state}${diff < 0 ? ` D${diff}` : ` D-${diff}`})</span></td>
      <td>
        <button class="btn" data-act="return" data-id="${escapeAttr(b.invNo)}">반납</button>
        <button class="btn btn-ghost" data-act="extend" data-id="${escapeAttr(b.invNo)}">연장</button>
      </td>
    `;
    tr.querySelectorAll("[data-act]").forEach((btn) => {
      btn.addEventListener("click", () => onBookAction(btn.dataset.act, btn.dataset.id));
    });
    tbody.appendChild(tr);
  });
}

function renderSettings() {
  $("#libName").value = data.settings.libName || "GOC 도서관";
  $("#defaultLoanDays").value = Number(data.settings.defaultLoanDays || 14);
}

function renderAll() {
  renderHeader();
  renderDashboard();
  renderBooks();
  renderLoans();
  renderSettings();
}

// -------------------- Admin Guard --------------------
function hasPinSet() {
  return !!(data.settings.pinHash && data.settings.pinSalt);
}

async function promptPinAndUnlock() {
  if (!hasPinSet()) {
    // require PIN to enter admin mode
    toast("??? PIN? ???? ?????. ???? PIN? ?? ?????.");
    return;
  }
  const pin = await dialogPrompt("관리자 PIN 입력", `
    <div class="field">
      <label>PIN</label>
      <input id="pinInput" type="password" inputmode="numeric" placeholder="PIN 입력" />
    </div>
  `, () => $("#pinInput")?.value?.trim());

  if (pin == null) return;

  const { hash } = await pinHash(pin, data.settings.pinSalt);
  if (hash === data.settings.pinHash) {
    unlocked = true;
    toast("관리자 모드 해제!");
  } else {
    toast("PIN이 올바르지 않아요.");
  }
}

function guardAdmin() {
  if (unlocked) return true;
  toast("잠금 상태입니다. 우측 상단 🔒 잠금을 해제하세요.");
  return false;
}

// -------------------- Google Books API --------------------
async function googleBooksSearch(query) {
  const q = query.trim();
  if (!q) return [];

  const isIsbn = /^[0-9Xx-]{10,20}$/.test(q);
  const term = isIsbn ? `isbn:${q.replace(/-/g, "")}` : q;

  // Public endpoint: GET https://www.googleapis.com/books/v1/volumes?q={search terms}
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(term)}&maxResults=10&key=${encodeURIComponent(GOOGLE_BOOKS_API_KEY)}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error("API 실패");
  const json = await res.json();
  const items = json.items || [];
  return items.map(normalizeGoogleVolume).filter(Boolean);
}

function normalizeGoogleVolume(item) {
  try {
    const v = item.volumeInfo || {};
    const ids = v.industryIdentifiers || [];
    const getId = (type) => ids.find((x) => x.type === type)?.identifier;
    const isbn13 = getId("ISBN_13");
    const isbn10 = getId("ISBN_10");

    let thumb = v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail || "";
    if (thumb.startsWith("http://")) thumb = "https://" + thumb.slice(7);

    return {
      title: v.title || "",
      subtitle: v.subtitle || "",
      authors: v.authors || [],
      publisher: v.publisher || "",
      publishedDate: v.publishedDate || "",
      description: v.description || "",
      categories: v.categories || [],
      pageCount: v.pageCount || null,
      language: v.language || "",
      thumbnail: thumb,
      isbn13,
      isbn10
    };
  } catch {
    return null;
  }
}

// -------------------- Open Library API (fallback) --------------------
async function openLibrarySearch(query) {
  const q = query.trim();
  if (!q) return [];

  const isIsbn = /^[0-9Xx-]{10,20}$/.test(q);
  const term = isIsbn ? `isbn:${q.replace(/-/g, "")}` : q;

  // Public endpoint: GET https://openlibrary.org/search.json?q={search terms}
  const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(term)}&limit=10`;

  const res = await fetch(url);
  if (!res.ok) throw new Error("API 실패");
  const json = await res.json();
  const docs = json.docs || [];
  return docs.map(normalizeOpenLibraryDoc).filter(Boolean);
}

function normalizeOpenLibraryDoc(doc) {
  try {
    const isbns = Array.isArray(doc.isbn) ? doc.isbn : [];
    const pickIsbn = (len) => isbns.find((v) => String(v).replace(/-/g, "").length === len);
    const isbn13 = pickIsbn(13) || "";
    const isbn10 = pickIsbn(10) || "";

    let thumb = "";
    if (doc.cover_i) {
      thumb = `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg`;
    } else if (isbn13 || isbn10) {
      const id = isbn13 || isbn10;
      thumb = `https://covers.openlibrary.org/b/isbn/${id}-M.jpg`;
    }

    return {
      title: doc.title || "",
      subtitle: doc.subtitle || "",
      authors: doc.author_name || [],
      publisher: (doc.publisher && doc.publisher[0]) || "",
      publishedDate: doc.first_publish_year ? String(doc.first_publish_year) : "",
      description: "",
      categories: doc.subject || [],
      pageCount: doc.number_of_pages_median || null,
      language: (doc.language && doc.language[0]) || "",
      thumbnail: thumb,
      isbn13,
      isbn10
    };
  } catch {
    return null;
  }
}

// -------------------- Hybrid Search --------------------
async function hybridBookSearch(query) {
  try {
    const g = await googleBooksSearch(query);
    if (g && g.length > 0) return g;
  } catch {
    // fall back to Open Library below
  }
  return openLibrarySearch(query);
}

// -------------------- CRUD --------------------
function addBookFromApi(apiBook) {
  const copies = Math.max(1, Number($("#copyCount").value || 1));
  for (let i = 0; i < copies; i++) {
    const invNo = nextInvNo(data);
    data.books[invNo] = {
      invNo,
      status: "available",
      addedAt: new Date().toISOString(),
      // metadata
      title: apiBook.title || "",
      subtitle: apiBook.subtitle || "",
      authors: apiBook.authors || [],
      publisher: apiBook.publisher || "",
      publishedDate: apiBook.publishedDate || "",
      description: apiBook.description || "",
      categories: apiBook.categories || [],
      pageCount: apiBook.pageCount || null,
      language: apiBook.language || "",
      thumbnail: apiBook.thumbnail || "",
      isbn13: apiBook.isbn13 || "",
      isbn10: apiBook.isbn10 || "",
      note: ""
    };

    pushActivity(data, { type: "등록", invNo, title: apiBook.title || "" });
  }
  save(data);
  toast(`도서 ${copies}권 등록 완료!`);
  renderAll();
  showPage("books");
}

async function manualAdd() {
  if (!guardAdmin()) return;
  const result = await dialogForm("수동 등록", `
    <div class="grid-2">
      <div class="field"><label>제목</label><input id="mTitle" /></div>
      <div class="field"><label>저자(쉼표구분)</label><input id="mAuthors" placeholder="예: 로버트 C. 마틴" /></div>
    </div>
    <div class="grid-2 mt-12">
      <div class="field"><label>ISBN</label><input id="mIsbn" placeholder="ISBN10/13" /></div>
      <div class="field"><label>출판사</label><input id="mPub" /></div>
    </div>
    <div class="grid-2 mt-12">
      <div class="field"><label>출간일</label><input id="mDate" placeholder="YYYY-MM-DD 또는 YYYY" /></div>
      <div class="field"><label>표지 이미지 URL(선택)</label><input id="mThumb" placeholder="https://..." /></div>
    </div>
    <div class="field mt-12"><label>분류(쉼표구분)</label><input id="mCat" placeholder="예: 개발, 에세이" /></div>
    <div class="field mt-12"><label>메모(선택)</label><input id="mNote" placeholder="예: GOC 3층 책장" /></div>
    <div class="field mt-12"><label>권수</label><input id="mCopies" type="number" min="1" value="1" /></div>
  `, () => ({
    title: $("#mTitle").value.trim(),
    authors: $("#mAuthors").value.trim(),
    isbn: $("#mIsbn").value.trim(),
    publisher: $("#mPub").value.trim(),
    publishedDate: $("#mDate").value.trim(),
    thumbnail: $("#mThumb").value.trim(),
    categories: $("#mCat").value.trim(),
    note: $("#mNote").value.trim(),
    copies: Number($("#mCopies").value || 1)
  }));

  if (!result) return;
  if (!result.title) return toast("제목은 필수입니다.");

  const copies = Math.max(1, result.copies || 1);
  for (let i = 0; i < copies; i++) {
    const invNo = nextInvNo(data);
    data.books[invNo] = {
      invNo,
      status: "available",
      addedAt: new Date().toISOString(),
      title: result.title,
      authors: result.authors ? result.authors.split(",").map(s => s.trim()).filter(Boolean) : [],
      isbn13: result.isbn || "",
      publisher: result.publisher || "",
      publishedDate: result.publishedDate || "",
      thumbnail: result.thumbnail || "",
      categories: result.categories ? result.categories.split(",").map(s => s.trim()).filter(Boolean) : [],
      note: result.note || ""
    };
    pushActivity(data, { type: "등록", invNo, title: result.title });
  }

  save(data);
  toast("수동 등록 완료!");
  renderAll();
  showPage("books");
}

async function checkoutBook(invNo) {
  const b = data.books[invNo];
  if (!b) return;
  if (b.status !== "available") return toast("이미 대여중입니다.");

  const defDays = Number(data.settings.defaultLoanDays || 14);
  const loanDate = todayYmd();
  const dueDate = addDays(loanDate, defDays);

  const form = await dialogForm("대여 처리", `
    <div class="muted">인벤번호 <b>${escapeHtml(invNo)}</b> · ${escapeHtml(b.title)}</div>
    <div class="grid-2 mt-12">
      <div class="field"><label>대여자</label><input id="cBorrower" placeholder="이름" /></div>
      <div class="field"><label>연락처(선택)</label><input id="cContact" placeholder="내선/전화/메일" /></div>
    </div>
    <div class="grid-2 mt-12">
      <div class="field"><label>대여일</label><input id="cLoan" type="date" value="${loanDate}" /></div>
      <div class="field"><label>반납예정일</label><input id="cDue" type="date" value="${dueDate}" /></div>
    </div>
    <div class="field mt-12"><label>메모(선택)</label><input id="cNote" placeholder="예: 다음주 회의용" /></div>
  `, () => ({
    borrower: $("#cBorrower").value.trim(),
    contact: $("#cContact").value.trim(),
    loanDate: $("#cLoan").value,
    dueDate: $("#cDue").value,
    note: $("#cNote").value.trim()
  }));

  if (!form) return;
  if (!form.borrower) return toast("대여자 이름은 필수입니다.");
  if (!form.dueDate) return toast("반납예정일은 필수입니다.");

  b.status = "loaned";
  b.currentLoan = {
    borrower: form.borrower,
    contact: form.contact || "",
    loanDate: form.loanDate || loanDate,
    dueDate: form.dueDate,
    note: form.note || ""
  };
  b.history = b.history || [];
  b.history.unshift({ type: "대여", at: new Date().toISOString(), ...b.currentLoan });

  pushActivity(data, { type: "대여", invNo, title: b.title, borrower: form.borrower });

  save(data);
  toast("대여 처리 완료!");
  renderAll();
}

async function returnBook(invNo) {
  const b = data.books[invNo];
  if (!b) return;
  if (b.status !== "loaned") return toast("대여중이 아닙니다.");

  const borrower = b.currentLoan?.borrower || "";
  const ok = await dialogConfirm("반납 처리", `
    <div>정말 반납 처리할까요?</div>
    <div class="muted mt-8">${escapeHtml(invNo)} · ${escapeHtml(b.title)}</div>
    <div class="muted">대여자: <b>${escapeHtml(borrower)}</b></div>
  `);
  if (!ok) return;

  b.history = b.history || [];
  b.history.unshift({ type: "반납", at: new Date().toISOString(), borrower });

  pushActivity(data, { type: "반납", invNo, title: b.title, borrower });

  b.status = "available";
  b.currentLoan = null;

  save(data);
  toast("반납 처리 완료!");
  renderAll();
}

async function extendBook(invNo) {
  const b = data.books[invNo];
  if (!b || b.status !== "loaned") return;

  const cur = b.currentLoan?.dueDate || todayYmd();
  const form = await dialogForm("반납일 연장", `
    <div class="muted">${escapeHtml(invNo)} · ${escapeHtml(b.title)}</div>
    <div class="grid-2 mt-12">
      <div class="field"><label>현재 반납예정일</label><input value="${escapeAttr(cur)}" disabled /></div>
      <div class="field"><label>새 반납예정일</label><input id="eDue" type="date" value="${escapeAttr(cur)}" /></div>
    </div>
    <div class="field mt-12"><label>연장 메모(선택)</label><input id="eNote" placeholder="예: 1주 연장" /></div>
  `, () => ({
    dueDate: $("#eDue").value,
    note: $("#eNote").value.trim()
  }));
  if (!form) return;
  if (!form.dueDate) return toast("날짜가 필요합니다.");

  b.currentLoan.dueDate = form.dueDate;
  b.history = b.history || [];
  b.history.unshift({ type: "연장", at: new Date().toISOString(), dueDate: form.dueDate, note: form.note || "" });

  pushActivity(data, { type: "연장", invNo, title: b.title, note: `반납예정 ${form.dueDate}` });

  save(data);
  toast("연장 완료!");
  renderAll();
}

async function editBook(invNo) {
  if (!guardAdmin()) return;
  const b = data.books[invNo];
  if (!b) return;

  const form = await dialogForm("도서 수정", `
    <div class="muted">${escapeHtml(invNo)} · ${escapeHtml(b.title)}</div>
    <div class="grid-2 mt-12">
      <div class="field"><label>메모</label><input id="eNote2" value="${escapeAttr(b.note || "")}" placeholder="예: 책장 위치" /></div>
      <div class="field"><label>분류(쉼표구분)</label><input id="eCat2" value="${escapeAttr((b.categories || []).join(", "))}" placeholder="예: 개발, 운영" /></div>
    </div>
  `, () => ({
    note: $("#eNote2").value.trim(),
    categories: $("#eCat2").value.trim()
  }));
  if (!form) return;

  b.note = form.note;
  b.categories = form.categories ? form.categories.split(",").map(s => s.trim()).filter(Boolean) : [];

  pushActivity(data, { type: "수정", invNo, title: b.title });

  save(data);
  toast("수정 완료!");
  renderAll();
}

async function deleteBook(invNo) {
  if (!guardAdmin()) return;
  const b = data.books[invNo];
  if (!b) return;

  const ok = await dialogConfirm("도서 삭제", `
    <div class="danger">삭제하면 복구할 수 없어요.</div>
    <div class="muted mt-8">${escapeHtml(invNo)} · ${escapeHtml(b.title)}</div>
  `);
  if (!ok) return;

  delete data.books[invNo];
  pushActivity(data, { type: "삭제", invNo, title: b.title });
  save(data);
  toast("삭제 완료!");
  renderAll();
}

function onBookAction(act, invNo) {
  if (act === "checkout") return checkoutBook(invNo);
  if (act === "return") return returnBook(invNo);
  if (act === "extend") return extendBook(invNo);
  if (act === "edit") return editBook(invNo);
  if (act === "del") return deleteBook(invNo);
}

// -------------------- Dialog helpers --------------------
const dlg = $("#dlg");
const dlgTitle = $("#dlgTitle");
const dlgBody = $("#dlgBody");
const dlgOkBtn = $("#dlgOkBtn");

function openDialog(title, bodyHtml, okText = "확인") {
  dlgTitle.textContent = title;
  dlgBody.innerHTML = bodyHtml;
  dlgOkBtn.textContent = okText;
  dlg.showModal();
}

function closeDialog() {
  try { dlg.close(); } catch {}
}

function dialogConfirm(title, bodyHtml) {
  return new Promise((resolve) => {
    openDialog(title, bodyHtml, "확인");
    dlgOkBtn.onclick = () => resolve(true);
    dlg.addEventListener("close", function onClose() {
      dlg.removeEventListener("close", onClose);
      if (dlg.returnValue !== "ok") resolve(false);
    }, { once: true });
  });
}

function dialogForm(title, bodyHtml, collectFn) {
  return new Promise((resolve) => {
    openDialog(title, bodyHtml, "저장");
    dlgOkBtn.onclick = () => resolve(collectFn?.() ?? {});
    dlg.addEventListener("close", function onClose() {
      dlg.removeEventListener("close", onClose);
      if (dlg.returnValue !== "ok") resolve(null);
    }, { once: true });
  });
}

function dialogPrompt(title, bodyHtml, collectFn) {
  return new Promise((resolve) => {
    openDialog(title, bodyHtml, "확인");
    dlgOkBtn.onclick = () => resolve(collectFn?.());
    dlg.addEventListener("close", function onClose() {
      dlg.removeEventListener("close", onClose);
      if (dlg.returnValue !== "ok") resolve(null);
    }, { once: true });
  });
}

// -------------------- Events --------------------
$("#searchBtn").addEventListener("click", async () => {
  const q = ($("#q").value || "").trim();
  if (!q) {
    $("#searchEmpty").classList.add("is-show");
    $("#searchEmpty").textContent = "검색어를 입력해줘!";
    return;
  }
  $("#searchEmpty").classList.add("is-show");
  $("#searchEmpty").textContent = "검색 중…";
  try {
    const results = await hybridBookSearch(q);
    renderSearchResults(results);
  } catch (e) {
    $("#searchEmpty").classList.add("is-show");
    $("#searchEmpty").textContent = "API 검색 실패… 잠시 후 다시 시도해줘.";
  }
});

$("#manualAddBtn").addEventListener("click", manualAdd);

$("#bookSearch").addEventListener("input", renderBooks);
$("#bookFilter").addEventListener("change", renderBooks);
$("#loanSearch").addEventListener("input", renderLoans);

$("#lockBtn").addEventListener("click", async () => {
  if (unlocked) {
    unlocked = false;
    toast("잠금 설정!");
    renderHeader();
    return;
  }
  await promptPinAndUnlock();
  renderHeader();
});

$("#saveSettingsBtn").addEventListener("click", async () => {
  const libName = ($("#libName").value || "").trim() || "GOC 도서관";
  const days = Math.max(1, Number($("#defaultLoanDays").value || 14));

  const pin = ($("#pin").value || "").trim();
  data.settings.libName = libName;
  data.settings.defaultLoanDays = days;

  if (pin) {
    const { salt, hash } = await pinHash(pin, null);
    data.settings.pinSalt = salt;
    data.settings.pinHash = hash;
    $("#pin").value = "";
    toast("설정 저장 + PIN 변경 완료!");
  } else {
    toast("설정 저장 완료!");
  }

  save(data);
  renderAll();
});

$("#resetBtn").addEventListener("click", async () => {
  if (!guardAdmin()) return;
  const ok = await dialogConfirm("전체 초기화", `
    <div class="danger">정말로 모든 데이터를 삭제할까요?</div>
    <div class="muted mt-8">도서/대여/활동 기록이 전부 삭제됩니다.</div>
  `);
  if (!ok) return;
  data = defaultData();
  save(data);
  unlocked = false;
  toast("초기화 완료!");
  renderAll();
  showPage("dashboard");
});

// Init
function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
function escapeAttr(s){ return escapeHtml(s).replaceAll("\n"," "); }
function stripTags(s){ return String(s ?? "").replace(/<[^>]*>/g, ""); }
function truncateText(s, max){
  const t = String(s ?? "").trim();
  if (!t) return "";
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + "…";
}

// show empty placeholders
function ensureEmptyStates() {
  $("#searchEmpty").classList.add("is-show");
  $("#booksEmpty").classList.toggle("is-show", Object.keys(data.books).length === 0);
  const nowYm = new Date().toISOString().slice(0, 7);
  const monthlyCount = Object.values(data.books).filter((b) => (b.addedAt || "").slice(0, 7) === nowYm).length;
  $("#monthlyBooksEmpty").classList.toggle("is-show", monthlyCount === 0);
}

// -------------------- Small UX: Enter to search --------------------
$("#q").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#searchBtn").click();
});

// -------------------- View Toggle (Grid/List) --------------------
const VIEW_KEY = "goc_library_view";
function applyView(view) {
  const list = $("#booksList");
  const monthlyList = $("#monthlyBooksList");
  list.classList.toggle("list-view", view === "list");
  monthlyList?.classList.toggle("list-view", view === "list");
  $("#viewGridBtn")?.classList.toggle("is-active", view === "grid");
  $("#viewListBtn")?.classList.toggle("is-active", view === "list");
  localStorage.setItem(VIEW_KEY, view);
}
$("#viewGridBtn")?.addEventListener("click", () => applyView("grid"));
$("#viewListBtn")?.addEventListener("click", () => applyView("list"));

// -------------------- Init (Local + Firebase) --------------------
initFirebase();
(async () => {
  data = await loadRemoteData(load());
  renderAll();
  ensureEmptyStates();
  applyView(localStorage.getItem(VIEW_KEY) || "grid");
  startRemoteSync();
})();

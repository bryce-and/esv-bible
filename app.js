/* ESV Bible, offline PWA. Plain JS, no build step, no network after first load.
   Scripture text is read verbatim from data/esv.json; nothing here rewrites it. */
(() => {
'use strict';

const APP_VERSION = '1.0.0';
const NOTICE = 'Scripture quotations are from the ESV® Bible (The Holy Bible, English Standard Version®), © 2001 by Crossway, ' +
  'a publishing ministry of Good News Publishers. ESV Text Edition: 2016. Used by permission. All rights reserved. ' +
  'This copy is for personal use only.';
const COLORS = ['yellow', 'green', 'blue', 'pink', 'orange'];

/* ---------- helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } },
};
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 2200);
}
const dayNumber = (d = new Date()) => Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
const isoDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dayNumberOfIso = (s) => { const [y, m, d] = s.split('-').map(Number); return Math.floor(Date.UTC(y, m - 1, d) / 86400000); };

/* ---------- storage (IndexedDB, with in-memory fallback) ---------- */
const idb = (() => {
  let db = null; const mem = { highlights: new Map(), notes: new Map(), bookmarks: new Map(), plans: new Map(), habit: new Map(), tags: new Map(), prayers: new Map(), bible: new Map() };
  let nextId = 1; let persistent = false;
  const keyOf = { highlights: 'ref', notes: 'id', bookmarks: 'ref', plans: 'id', habit: 'date', tags: 'ref', prayers: 'id', bible: 'id' };
  const open = () => new Promise((resolve) => {
    if (!('indexedDB' in window)) return resolve();
    try {
      const r = indexedDB.open('esv-bible', 4);
      r.onupgradeneeded = () => {
        const d = r.result;
        const make = (name, keyPath, opts = {}) => { if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, { keyPath, ...opts }); };
        make('highlights', 'ref'); make('notes', 'id', { autoIncrement: true }); make('bookmarks', 'ref');
        make('plans', 'id'); make('habit', 'date'); make('tags', 'ref'); make('prayers', 'id', { autoIncrement: true }); make('bible', 'id');
      };
      r.onsuccess = () => { db = r.result; persistent = true; resolve(); };
      r.onerror = () => resolve();
    } catch { resolve(); }
  });
  const tx = (name, mode, fn) => new Promise((resolve, reject) => {
    const t = db.transaction(name, mode); const req = fn(t.objectStore(name));
    t.oncomplete = () => resolve(req && req.result); t.onerror = () => reject(t.error); t.onabort = () => reject(t.error);
  });
  return {
    open,
    get persistent() { return persistent; },
    async all(name) { return db ? tx(name, 'readonly', (s) => s.getAll()) : [...mem[name].values()]; },
    async put(name, val) {
      if (db) return tx(name, 'readwrite', (s) => s.put(val));
      if ((name === 'notes' || name === 'prayers') && !val.id) val.id = nextId++;
      mem[name].set(val[keyOf[name]], val); return val[keyOf[name]];
    },
    async del(name, key) { return db ? tx(name, 'readwrite', (s) => s.delete(key)) : void mem[name].delete(key); },
    async clear(name) { return db ? tx(name, 'readwrite', (s) => s.clear()) : void mem[name].clear(); },
  };
})();

/* ---------- Bible data ---------- */
let BOOKS = [], HEAD = {}, EDITION = '';
let FB = [], FC = [], FV = [], FT = [], FN = [], OFF = [];
let INDEX = null, WORDS = null;

function validateBible(d) {   // returns an error message, or '' when the file is a usable ESV data file
  if (!d || !Array.isArray(d.books) || d.books.length !== 66) return 'This is not an ESV data file (expected 66 books).';
  let verses = 0;
  for (const b of d.books) { if (!b.n || !Array.isArray(b.c)) return 'The file is damaged (a book is missing its chapters).'; for (const c of b.c) for (const v of c) if (v) verses++; }
  if (verses < 31000 || verses > 31200) return `The file has ${verses.toLocaleString()} verses; the ESV should have about 31,086.`;
  return '';
}
function applyData(d) {
  BOOKS = d.books; HEAD = d.h || {}; EDITION = d.edition || 'ESV';
  FB = []; FC = []; FV = []; FT = []; OFF = []; INDEX = null; WORDS = null;
  BOOKS.forEach((bk, b) => {
    OFF[b] = [];
    bk.c.forEach((verses, ci) => {
      OFF[b][ci + 1] = FB.length;
      verses.forEach((t, vi) => { if (t) { FB.push(b); FC.push(ci + 1); FV.push(vi + 1); FT.push(t); } });
    });
  });
}
async function loadBibleData() {      // 1) text imported onto this device, 2) a data/esv.json served next to the app
  const stored = (await idb.all('bible')).find((x) => x.id === 'esv');
  if (stored && !validateBible(stored.data)) return stored.data;
  try { const r = await fetch('data/esv.json'); if (r.ok) { const d = await r.json(); if (!validateBible(d)) return d; } } catch { /* no file served */ }
  return null;
}
async function importBibleFile(file) {
  let d;
  try { d = JSON.parse(await file.text()); } catch { throw new Error('That file is not valid JSON. Choose the esv.json file.'); }
  const err = validateBible(d); if (err) throw new Error(err);
  await idb.put('bible', { id: 'esv', data: d, t: Date.now() });
  return d;
}
const verseText = (b, c, v) => (BOOKS[b].c[c - 1] || [])[v - 1] || '';
const chapterCount = (b) => BOOKS[b].c.length;
const verseCount = (b, c) => BOOKS[b].c[c - 1].length;
const refKey = (b, c, v) => `${b}:${c}:${v}`;
const parseKey = (k) => k.split(':').map(Number);
const flatIndex = (b, c, v) => { let i = OFF[b][c]; while (i < FB.length && FB[i] === b && FC[i] === c && FV[i] < v) i++; return i; };

function fmtVerses(vs) { // [1,2,3,5] -> "1-3, 5"
  const out = []; let s = vs[0], p = vs[0];
  for (let i = 1; i <= vs.length; i++) {
    if (vs[i] === p + 1) { p = vs[i]; continue; }
    out.push(s === p ? `${s}` : `${s}–${p}`); s = vs[i]; p = vs[i];
  }
  return out.join(', ');
}
const fmtRef = (b, c, v1, v2) => (v1 ? `${BOOKS[b].n} ${c}:${v1}${v2 && v2 !== v1 ? '–' + v2 : ''}` : `${BOOKS[b].n} ${c}`);

/* ---------- reference parsing ("jn 3:16", "1 cor 13", "ps 23") ---------- */
const ALIAS = { ps: 'psalms', psa: 'psalms', psalm: 'psalms', jn: 'john', jhn: 'john', mt: 'matthew', mk: 'mark', lk: 'luke', phil: 'philippians',
  php: 'philippians', phm: 'philemon', philem: 'philemon', jud: 'judges', jdg: 'judges', jude: 'jude', sos: 'songofsolomon', song: 'songofsolomon',
  songs: 'songofsolomon', ex: 'exodus', dt: 'deuteronomy', rev: 'revelation', heb: 'hebrews', jas: 'james', eccl: 'ecclesiastes', prov: 'proverbs', pr: 'proverbs' };
function findBook(key) {
  key = key.replace(/\s+/g, '').toLowerCase();
  if (!key) return -1;
  if (ALIAS[key]) key = ALIAS[key];
  let i = BOOKS.findIndex((b) => b.n.replace(/\s+/g, '').toLowerCase() === key);
  if (i < 0 && key.length >= 2) i = BOOKS.findIndex((b) => b.n.replace(/\s+/g, '').toLowerCase().startsWith(key));
  return i;
}
function parseRef(input) {
  const s = input.toLowerCase().replace(/\./g, ' ').replace(/[–—]/g, '-').trim();
  const m = s.match(/^([1-3]?\s*[a-z][a-z\s]*?)\s*(?:(\d+)(?:\s*:\s*(\d+)(?:\s*-\s*(\d+))?)?)?$/);
  if (!m) return null;
  const b = findBook(m[1]); if (b < 0) return null;
  let c = m[2] ? +m[2] : 1;
  if (c < 1 || c > chapterCount(b)) return null;
  let v1 = m[3] ? +m[3] : 0, v2 = m[4] ? +m[4] : 0;
  if (v1 && !verseText(b, c, v1)) return null;
  if (v2 && (v2 < v1 || !verseText(b, c, v2))) v2 = 0;
  return { b, c, v1, v2, explicitChapter: !!m[2] };
}

/* ---------- user data ---------- */
const U = { hl: new Map(), notes: [], bm: new Map(), plans: new Map(), habit: new Map(), tags: new Map(), prayers: [] };
async function loadUser() {
  (await idb.all('habit')).forEach((h) => U.habit.set(h.date, h));
  (await idb.all('tags')).forEach((t) => U.tags.set(t.ref, t));
  U.prayers = await idb.all('prayers');
  (await idb.all('highlights')).forEach((h) => U.hl.set(h.ref, h));
  U.notes = await idb.all('notes');
  (await idb.all('bookmarks')).forEach((b) => U.bm.set(b.ref, b));
  (await idb.all('plans')).forEach((p) => U.plans.set(p.id, p));
}

/* ---------- settings ---------- */
const S = Object.assign({ theme: 'auto', size: 19, nums: true }, store.get('settings', {}));
if (!['auto', 'light', 'dark'].includes(S.theme)) S.theme = 'auto';   // sepia was removed
const isDark = () => S.theme === 'dark' || (S.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
function applySettings() {
  const r = document.documentElement;
  r.dataset.theme = S.theme;
  r.style.setProperty('--reader-size', S.size + 'px');
  $('#meta-theme').content = isDark() ? '#0f1114' : '#fbfaf7';
}
const saveSettings = () => { store.set('settings', S); applySettings(); };
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applySettings);

/* ---------- state + navigation ---------- */
const R = { b: 0, c: 1, sel: new Set(), flash: 0 };
let TAB = 'today';
const L = { seg: 'highlights', plan: null, tag: null };
const SR = { q: '', shown: 100, scope: 'all' };

function setTab(tab) {
  TAB = tab; clearSelection(true); stopReadTimer();
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  ({ today: renderToday, read: renderRead, prayer: renderPrayer, search: renderSearch, library: renderLibrary, settings: renderSettings })[tab]();
}
function refreshAfterEdit() {
  if (TAB === 'prayer') renderPrayer(); else if (TAB === 'today') renderToday(); else if (TAB === 'library') renderLibrary(); else if (TAB === 'search') drawResults();
}
function setTop(title, { picker = false, actions = '' } = {}) {
  const t = $('#top-title'); t.textContent = title + (picker ? ' ▾' : ''); t.dataset.act = picker ? 'picker' : ''; t.classList.toggle('plain', !picker);
  $('#top-actions').innerHTML = actions;
}
const setView = (html) => { const v = $('#view'); v.innerHTML = html; v.scrollTop = 0; return v; };

/* ---------- Reader ---------- */
/* Habit tracker: a day counts as "read" once a chapter has been open on screen for 10 seconds. Only the date is stored. */
const READ_SECONDS = 10;
let readTimer = null;
const isoFromDay = (n) => { const d = new Date(n * 86400000); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`; };
function stopReadTimer() { clearTimeout(readTimer); readTimer = null; }
const isReadDay = (iso) => { const r = U.habit.get(iso); return !!r && r.read !== false; };   // journal-only days are not "read" days
const readDayCount = () => [...U.habit.values()].filter((r) => r.read !== false).length;
const chapterLogged = () => !!U.habit.get(isoDate())?.chapters?.includes(`${R.b}:${R.c}`);
function startReadTimer() {
  stopReadTimer();
  if (TAB !== 'read' || document.hidden || chapterLogged()) return;
  readTimer = setTimeout(markRead, READ_SECONDS * 1000);
}
async function markRead() {
  readTimer = null;
  const d = isoDate(); const key = `${R.b}:${R.c}`;
  const existing = U.habit.get(d);
  const wasRead = !!existing && existing.read !== false;
  const rec = existing || { date: d, t: Date.now(), chapters: [], journal: '' };
  rec.chapters = rec.chapters || [];
  if (rec.chapters.includes(key)) return;
  rec.chapters.push(key); rec.read = true;
  U.habit.set(d, rec); await idb.put('habit', rec);
  if (!wasRead) toast('Today is logged \u2713');
}
function streakDays() {
  let n = dayNumber(); if (!isReadDay(isoFromDay(n))) n--;
  let s = 0; while (isReadDay(isoFromDay(n))) { s++; n--; }
  return s;
}
document.addEventListener('visibilitychange', () => { if (document.hidden) stopReadTimer(); else startReadTimer(); });

function openChapter(b, c, v, resume) {
  R.b = b; R.c = c; R.flash = resume ? 0 : (v || 0); R.resume = resume ? (v || 0) : 0;
  store.set('pos', { b, c, v: v || 1 });
  setTab('read');
}
let posTimer = null;
function trackPosition() {            // remember the first verse on screen so "pick up where you left off" is exact
  clearTimeout(posTimer);
  posTimer = setTimeout(() => {
    if (TAB !== 'read') return;
    const top = $('#view').getBoundingClientRect().top + 8;
    const el = $$('.v').find((e) => e.getBoundingClientRect().bottom > top);
    if (el) { const [b, c, v] = parseKey(el.dataset.r); store.set('pos', { b, c, v }); }
  }, 250);
}
function renderRead() {
  const { b, c } = R; const bk = BOOKS[b];
  setTop(`${bk.n} ${c}`, { picker: true, actions: '<button data-act="appearance" aria-label="Text size and theme" style="font-weight:600;font-size:17px">Aa</button>' });
  let html = `<article class="reader${S.nums ? '' : ' nonums'}" data-b="${b}" data-c="${c}"><h1>${esc(bk.n)}</h1><div class="chnum">Chapter ${c}</div><p>`;
  let open = true;
  const verses = bk.c[c - 1];
  verses.forEach((t, i) => {
    const v = i + 1;
    const heads = HEAD[refKey(b, c, v)];
    if (heads) {
      html += '</p>';
      heads.forEach(([k, txt]) => {
        html += k === 'h' ? `<h3 class="sec">${esc(txt)}</h3>` : k === 'd' ? `<div class="bookdiv">${esc(txt)}</div>` : `<p class="title">${esc(txt)}</p>`;
      });
      html += '<p>'; open = true;
    }
    if (!t) { html += `<span class="omitted"> [verse ${v} is not in the ESV text] </span>`; return; }
    const key = refKey(b, c, v);
    const hl = U.hl.get(key);
    html += `<span class="v${hl ? ' hl-' + hl.color : ''}${R.sel.has(key) ? ' sel' : ''}" data-r="${key}">` +
      (v > 1 || S.nums ? `<sup class="vn">${v}</sup>` : '') + esc(t) + (noteAt(b, c, v) ? '<span class="ind">✎</span>' : '') +
      (U.bm.has(key) ? '<span class="ind">★</span>' : '') + ' </span>';
  });
  if (open) html += '</p>';
  const prev = prevChapter(b, c), next = nextChapter(b, c);
  html += `<div class="pager">${prev ? `<button class="btn" data-act="goto" data-b="${prev[0]}" data-c="${prev[1]}">‹ ${esc(fmtRef(prev[0], prev[1]))}</button>` : '<span></span>'}` +
    `${next ? `<button class="btn" data-act="goto" data-b="${next[0]}" data-c="${next[1]}">${esc(fmtRef(next[0], next[1]))} ›</button>` : '<span></span>'}</div>` +
    `<div class="copyright">${esc(NOTICE)}</div></article>`;
  const view = setView(html);
  if (R.flash) {
    const el = $(`.v[data-r="${refKey(b, c, R.flash)}"]`, view);
    if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); }
    R.flash = 0;
  } else if (R.resume > 1) {
    const el = $(`.v[data-r="${refKey(b, c, R.resume)}"]`, view);
    if (el) view.scrollTop = Math.max(0, el.getBoundingClientRect().top - view.getBoundingClientRect().top + view.scrollTop - 12);
  }
  R.resume = 0;
  updateSheet(); startReadTimer();
}
function prevChapter(b, c) { if (c > 1) return [b, c - 1]; if (b > 0) return [b - 1, chapterCount(b - 1)]; return null; }
function nextChapter(b, c) { if (c < chapterCount(b)) return [b, c + 1]; if (b < BOOKS.length - 1) return [b + 1, 1]; return null; }
const noteAt = (b, c, v) => U.notes.some((n) => n.b === b && n.c === c && v >= n.v1 && v <= n.v2);

/* verse selection + action sheet */
function toggleVerse(key) {
  if (R.sel.has(key)) R.sel.delete(key); else R.sel.add(key);
  $(`.v[data-r="${key}"]`)?.classList.toggle('sel', R.sel.has(key));
  updateSheet();
}
function clearSelection(silent) {
  if (!R.sel.size) return;
  R.sel.clear(); $$('.v.sel').forEach((e) => e.classList.remove('sel'));
  if (!silent) updateSheet(); else $('#sheet').hidden = true;
}
function selectedVerses() { return [...R.sel].map(parseKey).filter(([b, c]) => b === R.b && c === R.c).map((x) => x[2]).sort((a, b) => a - b); }
function selectionLabel() { const vs = selectedVerses(); return vs.length ? `${BOOKS[R.b].n} ${R.c}:${fmtVerses(vs)}` : ''; }
function selectionText() { return selectedVerses().map((v) => verseText(R.b, R.c, v)).join(' '); }
function updateSheet() {
  const sh = $('#sheet'); const vs = selectedVerses();
  if (TAB !== 'read' || !vs.length) { sh.hidden = true; return; }
  const cur = new Set(vs.map((v) => U.hl.get(refKey(R.b, R.c, v))?.color));
  const same = cur.size === 1 ? [...cur][0] : null;
  const allBm = vs.every((v) => U.bm.has(refKey(R.b, R.c, v)));
  const ic = (d) => `<svg viewBox="0 0 24 24">${d}</svg>`;
  sh.innerHTML = `<div class="sheet-top"><span class="ref">${esc(selectionLabel())}</span><button class="iconbtn" data-act="clearsel" aria-label="Clear selection">${ic('<path d="M6 6l12 12M18 6L6 18"/>')}</button></div>` +
    `<div class="swatches">${COLORS.map((c) => `<button class="sw${same === c ? ' on' : ''}" data-act="color" data-c="${c}" aria-label="${c} highlight"></button>`).join('')}` +
    `<button class="sw none" data-act="color" data-c="" aria-label="Remove highlight">${ic('<path d="M7 7l10 10M17 7L7 17"/>')}</button></div>` +
    `<div class="tools">` +
    `<button data-act="share" aria-label="Share">${ic('<path d="M12 15V4M8 8l4-4 4 4"/><path d="M6 11H5a1 1 0 00-1 1v7a1 1 0 001 1h14a1 1 0 001-1v-7a1 1 0 00-1-1h-1"/>')}<span>Share</span></button>` +
    `<button data-act="copy" aria-label="Copy">${ic('<rect x="8" y="8" width="11" height="12" rx="2"/><path d="M5 15V5a1 1 0 011-1h9"/>')}<span>Copy</span></button>` +
    `<button data-act="note" aria-label="Note">${ic('<path d="M5 19l1-4L17 4l3 3L9 18z"/>')}<span>Note</span></button>` +
    `<button data-act="bookmark" aria-label="Bookmark" class="${allBm ? 'on' : ''}">${ic('<path d="M7 4h10v16l-5-3.500L7 20z"/>')}<span>${allBm ? 'Saved' : 'Bookmark'}</span></button>` +
    `<button data-act="tags" aria-label="Tag" class="${vs.some((v) => U.tags.get(refKey(R.b, R.c, v))?.tags.length) ? 'on' : ''}">${ic('<path d="M4 12V5a1 1 0 011-1h7l8 8-8 8z"/><circle cx="8.500" cy="8.500" r="1.200"/>')}<span>Tag</span></button></div>`;
  sh.hidden = false;
}
async function applyColor(color) {
  for (const v of selectedVerses()) {
    const key = refKey(R.b, R.c, v);
    if (color) { const h = { ref: key, color, t: Date.now() }; U.hl.set(key, h); await idb.put('highlights', h); }
    else { U.hl.delete(key); await idb.del('highlights', key); }
  }
  refreshVerses(); updateSheet();
}
function refreshVerses() {
  $$('.v').forEach((el) => {
    const h = U.hl.get(el.dataset.r);
    COLORS.forEach((c) => el.classList.toggle('hl-' + c, !!h && h.color === c));
    const [b, c, v] = parseKey(el.dataset.r);
    el.querySelectorAll('.ind').forEach((i) => i.remove());
    const ind = (noteAt(b, c, v) ? '✎' : '') + (U.bm.has(el.dataset.r) ? '★' : '');
    if (ind) el.insertAdjacentHTML('beforeend', ' <span class="ind">' + ind + '</span>');
  });
}
async function toggleBookmark() {
  const vs = selectedVerses(); const all = vs.every((v) => U.bm.has(refKey(R.b, R.c, v)));
  for (const v of vs) {
    const key = refKey(R.b, R.c, v);
    if (all) { U.bm.delete(key); await idb.del('bookmarks', key); }
    else if (!U.bm.has(key)) { const bm = { ref: key, t: Date.now() }; U.bm.set(key, bm); await idb.put('bookmarks', bm); }
  }
  refreshVerses(); updateSheet(); toast(all ? 'Bookmark removed' : 'Bookmarked');
}
/* Copy and share send only the verse text and its reference, never a link (same as YouVersion). */
const quoteString = (text, label) => `${text}\n${label} ESV`;
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied'); return true; } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(ta);
    ta.select(); const ok = document.execCommand('copy'); ta.remove(); toast(ok ? 'Copied' : 'Copy failed'); return ok;
  } catch { toast('Copy failed'); return false; }
}
const copySelection = () => copyText(quoteString(selectionText(), selectionLabel()));
async function shareText(text) {
  if (navigator.share) {
    try { await navigator.share({ text }); return; } catch (e) { if (e.name === 'AbortError') return; }   // text only: no url field
  }
  copyText(text);
}
const shareSelection = () => shareText(quoteString(selectionText(), selectionLabel()));

/* notes */
function openNoteEditor(existing) {
  const vs = existing ? null : selectedVerses();
  const b = existing ? existing.b : R.b, c = existing ? existing.c : R.c;
  const v1 = existing ? existing.v1 : vs[0], v2 = existing ? existing.v2 : vs[vs.length - 1];
  openModal(`Note · ${fmtRef(b, c, v1, v2)}`,
    `<div class="item" style="border:0"><div class="txt">${esc(Array.from({ length: v2 - v1 + 1 }, (_, i) => verseText(b, c, v1 + i)).filter(Boolean).join(' '))}</div></div>` +
    `<textarea class="note-input" id="note-text" placeholder="Write your note…">${esc(existing ? existing.text : '')}</textarea>` +
    `<div class="row" style="margin-top:12px"><button class="btn primary" data-act="savenote">Save</button>` +
    (existing ? '<button class="btn danger" data-act="delnote">Delete</button>' : '') + '</div>',
    { note: { id: existing?.id, b, c, v1, v2 } });
  setTimeout(() => $('#note-text')?.focus(), 50);
}
async function saveNote() {
  const ctx = MODAL.ctx.note; const text = $('#note-text').value.trim();
  if (!text) { toast('Note is empty'); return; }
  const n = { b: ctx.b, c: ctx.c, v1: ctx.v1, v2: ctx.v2, text, t: Date.now() };
  if (ctx.id) n.id = ctx.id;
  const id = await idb.put('notes', n); n.id = id;
  U.notes = U.notes.filter((x) => x.id !== n.id); U.notes.push(n);
  closeModal(); clearSelection(); refreshVerses(); toast('Note saved'); refreshAfterEdit();
}
async function deleteNote() {
  const id = MODAL.ctx.note.id; await idb.del('notes', id); U.notes = U.notes.filter((n) => n.id !== id);
  closeModal(); refreshVerses(); toast('Note deleted'); refreshAfterEdit();
}

/* ---------- Journal: one short entry per day, plus the chapters read that day ---------- */
let JALL = false;
const dayTitle = (iso, long = true) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString(undefined, long ? { weekday: 'long', month: 'long', day: 'numeric' } : { month: 'short', day: 'numeric', ...(y === new Date().getFullYear() ? {} : { year: 'numeric' }) }); };
function fmtChapterList(keys) {   // ["42:3","42:4"] -> [{ b, c, label: "John 3–4" }]
  const items = keys.map((k) => k.split(':').map(Number)).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = []; let cur = null;
  for (const [b, c] of items) { if (cur && cur.b === b && c === cur.c2 + 1) cur.c2 = c; else { cur = { b, c1: c, c2: c }; out.push(cur); } }
  return out.map((x) => ({ b: x.b, c: x.c1, label: `${BOOKS[x.b].n} ${x.c1 === x.c2 ? x.c1 : `${x.c1}–${x.c2}`}` }));
}
function journalSection() {
  const today = isoDate(); const t = U.habit.get(today);
  const entries = [...U.habit.values()].filter((r) => r.journal && r.date !== today).sort((a, b) => (a.date < b.date ? 1 : -1));
  const shown = JALL ? entries : entries.slice(0, 3);
  const excerpt = (x) => esc(x.length > 120 ? x.slice(0, 120).trimEnd() + '…' : x);
  return `<section class="journal"><div class="eyebrow">Journal</div>` +
    `<button class="jtoday" data-act="day" data-date="${today}">${t?.journal ? `<span>${excerpt(t.journal)}</span>` : '<span class="muted">What stood out today?</span>'}` +
    `<svg viewBox="0 0 24 24"><path d="M5 19l1-4L17 4l3 3L9 18z"/></svg></button>` +
    (shown.length ? `<ul class="list jlist">${shown.map((r) => `<li class="item" data-open data-act="day" data-date="${r.date}"><div class="ref">${esc(dayTitle(r.date, false))}</div><div class="jtxt">${excerpt(r.journal)}</div></li>`).join('')}</ul>` : '') +
    (entries.length > 3 ? `<button class="linkbtn" data-act="jall">${JALL ? 'Show fewer' : `Show all ${entries.length} entries`}</button>` : '') + '</section>';
}
function openDay(iso) {
  if (iso > isoDate()) { toast('That day hasn’t happened yet'); return; }
  const rec = U.habit.get(iso); const chs = rec?.chapters?.length ? fmtChapterList(rec.chapters) : [];
  const read = chs.length
    ? `<div>${chs.map((x) => `<button class="chip link" data-act="goto" data-b="${x.b}" data-c="${x.c}">${esc(x.label)}</button>`).join('')}</div>`
    : `<div class="muted small">${rec && rec.read !== false ? 'Logged as read. The passages weren’t recorded for this day.' : iso === isoDate() ? `Chapters you read for ${READ_SECONDS} seconds appear here.` : 'No reading logged.'}</div>`;
  openModal(dayTitle(iso),
    `<div class="eyebrow">Read</div>${read}<div class="eyebrow" style="margin-top:24px">Journal</div>` +
    `<textarea class="note-input" id="journal-text" placeholder="What did you learn? What stood out?">${esc(rec?.journal || '')}</textarea>` +
    `<div class="row" style="margin-top:12px"><button class="btn primary" data-act="savejournal" data-date="${iso}">Save</button>` +
    (rec?.journal ? `<button class="btn danger" data-act="deljournal" data-date="${iso}">Delete entry</button>` : '') + '</div>', { day: iso });
}
async function saveJournal(iso, clear) {
  const text = clear ? '' : ($('#journal-text')?.value || '').trim();
  const existing = U.habit.get(iso);
  const rec = existing || { date: iso, t: Date.now(), read: false, chapters: [], journal: '' };
  rec.journal = text;
  if (!text && rec.read === false && !(rec.chapters || []).length) { U.habit.delete(iso); await idb.del('habit', iso); }
  else { U.habit.set(iso, rec); await idb.put('habit', rec); }
  closeModal(); toast(text ? 'Journal saved' : 'Entry removed');
  refreshAfterEdit();
}

/* ---------- Tags (categories for verses) ---------- */
const DEFAULT_TAGS = ['Prayer', 'Praise', 'Life verse', 'Studying', 'Promise', 'Encouragement', 'Memorize'];
const cleanTag = (t) => t.replace(/\s+/g, ' ').trim().slice(0, 40);
const sameTag = (a, b) => a.toLowerCase() === b.toLowerCase();
const tagsOf = (ref) => U.tags.get(ref)?.tags || [];
function tagIndex() {   // lower-case name -> { name, refs[] }, built from the verses that carry each tag
  const m = new Map();
  U.tags.forEach((rec) => rec.tags.forEach((t) => { const k = t.toLowerCase(); if (!m.has(k)) m.set(k, { name: t, refs: [] }); m.get(k).refs.push(rec.ref); }));
  return m;
}
function allTagNames() {   // suggestions first, then your own tags
  const seen = new Map(DEFAULT_TAGS.map((t) => [t.toLowerCase(), t]));
  tagIndex().forEach((v, k) => { if (!seen.has(k)) seen.set(k, v.name); });
  return [...seen.values()];
}
async function writeTags(ref, tags) {
  if (tags.length) { const rec = { ref, tags }; U.tags.set(ref, rec); await idb.put('tags', rec); }
  else { U.tags.delete(ref); await idb.del('tags', ref); }
}
async function setTagForSelection(name, on) {
  for (const v of selectedVerses()) {
    const key = refKey(R.b, R.c, v); const cur = tagsOf(key); const has = cur.some((t) => sameTag(t, name));
    if (on && !has) await writeTags(key, [...cur, name]);
    else if (!on && has) await writeTags(key, cur.filter((t) => !sameTag(t, name)));
  }
}
function tagEditorBody() {
  const vs = selectedVerses();
  const chips = allTagNames().map((name) => {
    const on = vs.length && vs.every((v) => tagsOf(refKey(R.b, R.c, v)).some((t) => sameTag(t, name)));
    return `<button class="tagchip${on ? ' on' : ''}" data-act="tagtoggle" data-tag="${esc(name)}">${esc(name)}</button>`;
  }).join('');
  return `<div class="muted small" style="margin-bottom:14px">Tap a tag to add or remove it. You’ll find everything under each tag in the Library.</div><div class="tagchips">${chips}</div>` +
    `<form class="tagadd" data-submit="tagadd"><input id="tag-new" placeholder="New tag…" maxlength="40" autocomplete="off" autocapitalize="words" enterkeyhint="done"><button class="btn primary" type="submit">Add</button></form>` +
    `<div class="row" style="margin-top:22px"><button class="btn" data-act="closemodal">Done</button></div>`;
}
function openTagEditor() {
  if (!selectedVerses().length) return;
  openModal(`Tags · ${selectionLabel()}`, tagEditorBody(), { tagEditor: true });
}
function refreshTagEditor() { const b = $('#modal .modal-body'); if (b && MODAL.ctx.tagEditor) b.innerHTML = tagEditorBody(); updateSheet(); }
const tagLine = (ref) => { const t = tagsOf(ref); return t.length ? `<div class="taglist">${t.map((x) => `<span>${esc(x)}</span>`).join('')}</div>` : ''; };
const canon = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
function savedTags() {
  if (L.tag) return tagDetail(L.tag);
  const idx = [...tagIndex().values()].sort((a, b) => a.name.localeCompare(b.name));
  if (!idx.length) return '<div class="muted">No tags yet. Select a verse in the reader and tap <b>Tag</b> to sort it into a category such as Prayer, Praise, Life verse or Studying.</div>';
  return '<ul class="list">' + idx.map((t) => `<li class="item tagrow" data-open data-act="tagopen" data-tag="${esc(t.name)}"><span>${esc(t.name)}</span><span class="muted">${t.refs.length}</span></li>`).join('') + '</ul>';
}
function tagDetail(name) {
  const rec = tagIndex().get(name.toLowerCase());
  if (!rec) { L.tag = null; return savedTags(); }
  const items = rec.refs.map((r) => ({ r, p: parseKey(r) })).sort((a, b) => canon(a.p, b.p));
  return `<div class="row" style="margin-bottom:6px"><button class="btn" data-act="tagback">‹ Tags</button><button class="btn" data-act="tagrename" data-tag="${esc(rec.name)}">Rename</button>` +
    `<button class="btn danger" data-act="tagdelete" data-tag="${esc(rec.name)}">Delete</button></div>` +
    `<h2 style="font:600 24px var(--reader-font);margin:14px 0 2px">${esc(rec.name)}</h2><div class="muted small">${items.length} verse${items.length === 1 ? '' : 's'}</div><ul class="list">` +
    items.map(({ r, p }) => { const h = U.hl.get(r); return `<li class="item" data-open data-act="open" data-b="${p[0]}" data-c="${p[1]}" data-v="${p[2]}"><div class="ref">${h ? `<span class="dot ${h.color}"></span>` : ''}${esc(fmtRef(...p))}</div><div class="txt">${esc(verseText(...p))}</div></li>`; }).join('') + '</ul>';
}
async function renameTag(name) {
  const next = cleanTag(prompt('Rename tag', name) || ''); if (!next || next === name) return;
  for (const rec of [...U.tags.values()]) {
    if (!rec.tags.some((t) => sameTag(t, name))) continue;
    const out = []; rec.tags.forEach((t) => { const n = sameTag(t, name) ? next : t; if (!out.some((x) => sameTag(x, n))) out.push(n); });
    await writeTags(rec.ref, out);
  }
  L.tag = next; renderLibrary();
}
async function deleteTag(name) {
  if (!confirm(`Delete the tag “${name}”? Your verses and highlights stay; only the tag is removed.`)) return;
  for (const rec of [...U.tags.values()]) if (rec.tags.some((t) => sameTag(t, name))) await writeTags(rec.ref, rec.tags.filter((t) => !sameTag(t, name)));
  L.tag = null; renderLibrary();
}

/* ---------- Prayer list: who/what to pray for and why, checked off each day ---------- */
const prayedToday = (p) => (p.prayed || []).includes(isoDate());
const byCreated = (a, b) => (a.created || 0) - (b.created || 0);
function prayerSummary() {
  const active = U.prayers.filter((p) => !p.answered);
  return { total: active.length, done: active.filter(prayedToday).length };
}
function renderPrayer() {
  setTop('Prayer', { actions: '<button data-act="prayeradd" aria-label="Add to prayer list"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>' });
  const active = U.prayers.filter((p) => !p.answered).sort(byCreated);
  const answered = U.prayers.filter((p) => p.answered).sort((a, b) => (b.answeredAt || '').localeCompare(a.answeredAt || ''));
  const { total, done } = prayerSummary();
  let html = '<div class="page">';
  if (!active.length) {
    html += '<div class="empty"><div class="empty-title">Your prayer list</div><p class="muted">Add the people and needs you want to bring to God, and why. Check them off as you pray; the list resets each day.</p>' +
      '<button class="btn primary" data-act="prayeradd">Add the first one</button></div>';
  } else {
    html += `<div class="prayprog"><span><b>${done}</b> of ${total} prayed today</span></div><div class="progress"><i style="width:${Math.round(done / total * 100)}%"></i></div>` +
      '<ul class="list prayers">' + active.map((p) => {
        const on = prayedToday(p);
        return `<li class="prayer${on ? ' done' : ''}"><button class="check${on ? ' on' : ''}" data-act="prayertoggle" data-id="${p.id}" aria-label="Prayed for ${esc(p.who)}">${on ? '✓' : ''}</button>` +
          `<div class="pbody" data-act="prayeredit" data-id="${p.id}"><div class="who">${esc(p.who)}</div>${p.why ? `<div class="why">${esc(p.why)}</div>` : ''}</div></li>`;
      }).join('') + '</ul>';
    if (done === total) html += '<div class="allset">All prayed for today.</div>';
  }
  if (answered.length) {
    html += `<div class="eyebrow" style="margin:30px 0 6px">Answered (${answered.length})</div><ul class="list prayers answered">` +
      answered.map((p) => `<li class="prayer"><div class="pbody" data-act="prayeredit" data-id="${p.id}"><div class="who">${esc(p.who)}</div>${p.why ? `<div class="why">${esc(p.why)}</div>` : ''}` +
        `<div class="when">Answered ${esc(p.answeredAt ? dayTitle(p.answeredAt, false) : '')}</div>${p.answeredNote ? `<div class="answernote">${esc(p.answeredNote)}</div>` : ''}</div></li>`).join('') + '</ul>';
  }
  setView(html + '</div>');
}
async function savePrayer(p) { const id = await idb.put('prayers', p); p.id = p.id || id; if (!U.prayers.includes(p)) U.prayers.push(p); return p; }
async function togglePrayed(id) {
  const p = U.prayers.find((x) => x.id === id); if (!p) return;
  const d = isoDate(); const list = p.prayed || [];
  p.prayed = list.includes(d) ? list.filter((x) => x !== d) : [...list, d];
  await idb.put('prayers', p);
  if (TAB === 'prayer') { const t = $('#view').scrollTop; renderPrayer(); $('#view').scrollTop = t; }
}
function openPrayerEditor(id) {
  const p = id ? U.prayers.find((x) => x.id === id) : null;
  const times = p?.prayed?.length || 0;
  openModal(p ? 'Edit prayer' : 'Add to prayer list',
    `<div class="eyebrow">Who or what</div><input class="text-input" id="prayer-who" maxlength="80" placeholder="Name, family, situation…" value="${esc(p?.who || '')}" autocomplete="off" autocapitalize="words">` +
    `<div class="eyebrow" style="margin-top:20px">Why / what to pray</div><textarea class="note-input" id="prayer-why" style="min-height:22vh" placeholder="What are you praying for?">${esc(p?.why || '')}</textarea>` +
    (p?.answered ? `<div class="eyebrow" style="margin-top:20px">Date answered</div><input type="date" class="text-input" id="prayer-adate" value="${esc(p.answeredAt || isoDate())}" max="${isoDate()}">` +
      `<div class="eyebrow" style="margin-top:20px">How it was answered</div><textarea class="note-input" id="prayer-anote" style="min-height:18vh" placeholder="What happened?">${esc(p.answeredNote || '')}</textarea>` : '') +
    (p ? `<div class="muted small" style="margin-top:8px">Prayed for on ${times} day${times === 1 ? '' : 's'}.</div>` : '') +
    `<div class="row" style="margin-top:16px"><button class="btn primary" data-act="prayersave" data-id="${p?.id || ''}">Save</button>` +
    (p && !p.answered ? `<button class="btn" data-act="prayeranswered" data-id="${p.id}">Mark answered</button>` : '') +
    (p && p.answered ? `<button class="btn" data-act="prayerreopen" data-id="${p.id}">Move back to list</button>` : '') +
    (p ? `<button class="btn danger" data-act="prayerdelete" data-id="${p.id}">Delete</button>` : '') + '</div>', { prayer: p?.id || 0 });
  setTimeout(() => (p ? $('#prayer-why') : $('#prayer-who'))?.focus(), 60);
}
async function submitPrayer(id) {
  const who = $('#prayer-who').value.replace(/\s+/g, ' ').trim(); const why = $('#prayer-why').value.trim();
  if (!who) { toast('Add a name or need first'); $('#prayer-who').focus(); return; }
  const p = id ? U.prayers.find((x) => x.id === id) : { who: '', why: '', created: Date.now(), prayed: [] };
  p.who = who; p.why = why;
  if (p.answered) {
    const d = $('#prayer-adate')?.value; if (d) p.answeredAt = d > isoDate() ? isoDate() : d;
    if ($('#prayer-anote')) p.answeredNote = $('#prayer-anote').value.trim();
  }
  await savePrayer(p);
  closeModal(); toast('Saved'); refreshAfterEdit();
}
function openAnsweredForm(id) {
  const p = U.prayers.find((x) => x.id === id); if (!p) return;
  openModal('Answered prayer',
    `<div style="font-size:19px;font-weight:600">${esc(p.who)}</div>${p.why ? `<div class="muted" style="margin-top:2px;white-space:pre-wrap">${esc(p.why)}</div>` : ''}` +
    `<div class="muted small" style="margin-top:14px">Will be recorded as answered on ${esc(dayTitle(isoDate()))}.</div>` +
    `<div class="eyebrow" style="margin-top:20px">How was it answered? <span style="text-transform:none;letter-spacing:0;font-weight:400">(optional)</span></div><textarea class="note-input" id="ans-note" style="min-height:22vh" placeholder="A few words about what happened\u2026"></textarea>` +
    `<div class="row" style="margin-top:16px"><button class="btn primary" data-act="prayeranswersave" data-id="${id}">Save as answered</button><button class="btn" data-act="prayeredit" data-id="${id}">Back</button></div>`, { answering: id });
  setTimeout(() => $('#ans-note')?.focus(), 60);
}
async function setAnswered(id, on, date, note) {
  const p = U.prayers.find((x) => x.id === id); if (!p) return;
  if (!on && p.answeredNote && !confirm('Move this back to your list? Its answer note will be removed.')) return;
  p.answered = on; p.answeredAt = on ? (date && date <= isoDate() ? date : isoDate()) : ''; p.answeredNote = on ? (note || '') : '';
  await idb.put('prayers', p);
  closeModal(); toast(on ? 'Marked answered \u2713' : 'Moved back to your list'); refreshAfterEdit();
}
async function deletePrayer(id) {
  if (!confirm('Delete this prayer request?')) return;
  await idb.del('prayers', id); U.prayers = U.prayers.filter((x) => x.id !== id); closeModal(); refreshAfterEdit();
}
function prayerHomeSection() {
  const { total, done } = prayerSummary();
  const label = total ? `${done} of ${total} prayed today` : 'Add people and needs to pray for';
  return `<section class="prayhome"><div class="eyebrow">Prayer</div><button class="jtoday" data-act="gotab" data-tab="prayer"><span>${label}${total ? `<div class="progress" style="margin:8px 0 0"><i style="width:${Math.round(done / total * 100)}%"></i></div>` : ''}</span>` +
    '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg></button></section>';
}

/* ---------- Modal ---------- */
const MODAL = { ctx: {} };
function openModal(title, html, ctx = {}) {
  MODAL.ctx = ctx;
  const m = $('#modal');
  m.innerHTML = `<div class="modal-head"><span>${esc(title)}</span><button class="iconbtn" data-act="closemodal" aria-label="Close">✕</button></div><div class="modal-body">${html}</div>`;
  m.hidden = false; $('.modal-body', m).scrollTop = 0;
}
function closeModal() { $('#modal').hidden = true; $('#modal').innerHTML = ''; MODAL.ctx = {}; }

function openPicker(step = 'books', b = R.b) {
  if (step === 'books') {
    const grp = (from, to, title) => `<div class="group-title">${title}</div><div class="booklist">` +
      BOOKS.slice(from, to).map((bk, i) => `<button data-act="pickbook" data-b="${from + i}" class="${from + i === R.b ? 'cur' : ''}">${esc(bk.n)}</button>`).join('') + '</div>';
    openModal('Choose a book', grp(0, 39, 'Old Testament') + grp(39, 66, 'New Testament'));
  } else {
    openModal(BOOKS[b].n, `<div class="chgrid">${Array.from({ length: chapterCount(b) }, (_, i) =>
      `<button data-act="goto" data-b="${b}" data-c="${i + 1}" class="${b === R.b && i + 1 === R.c ? 'cur' : ''}">${i + 1}</button>`).join('')}</div>` +
      '<div class="row" style="margin-top:16px"><button class="btn" data-act="picker">‹ All books</button></div>');
  }
}

function openAppearance() {
  openModal('Text & theme', settingsControls(), {});
}

/* ---------- Today ---------- */
const VOTD = ['Genesis 1:27', 'Joshua 1:9', 'Psalm 23:1-3', 'Psalm 27:1', 'Psalm 34:8', 'Psalm 46:1', 'Psalm 91:1-2', 'Psalm 119:105', 'Psalm 121:1-2',
  'Proverbs 3:5-6', 'Proverbs 16:3', 'Isaiah 40:31', 'Isaiah 41:10', 'Isaiah 53:5', 'Jeremiah 29:11', 'Lamentations 3:22-23', 'Micah 6:8', 'Nahum 1:7',
  'Zephaniah 3:17', 'Matthew 5:16', 'Matthew 6:33', 'Matthew 11:28', 'Matthew 28:19-20', 'Mark 10:45', 'Luke 1:37', 'John 1:1', 'John 3:16', 'John 8:12',
  'John 10:10', 'John 14:6', 'John 14:27', 'John 15:5', 'John 16:33', 'Acts 1:8', 'Romans 5:8', 'Romans 8:1', 'Romans 8:28', 'Romans 8:38-39', 'Romans 12:2',
  '1 Corinthians 13:4-7', '1 Corinthians 15:58', '2 Corinthians 5:17', '2 Corinthians 12:9', 'Galatians 2:20', 'Galatians 5:22-23', 'Ephesians 2:8-9',
  'Philippians 4:6-7', 'Philippians 4:13', 'Colossians 3:23', '1 Thessalonians 5:16-18', '2 Timothy 1:7', 'Hebrews 11:1', 'Hebrews 12:1-2', 'James 1:2-3',
  '1 Peter 5:7', '1 John 4:19', 'Revelation 21:4'];
function votdRef() {
  const list = VOTD.map(parseRef).filter(Boolean);   // text always comes from the Bible data, never hard-coded
  return list[dayNumber() % list.length];
}
const CAL = { y: new Date().getFullYear(), m: new Date().getMonth() };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function calendarHTML() {
  const first = new Date(CAL.y, CAL.m, 1).getDay(); const days = new Date(CAL.y, CAL.m + 1, 0).getDate(); const today = isoDate();
  let cells = ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d) => `<i class="dow">${d}</i>`).join('') + '<i></i>'.repeat(first);
  for (let d = 1; d <= days; d++) {
    const iso = `${CAL.y}-${String(CAL.m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    cells += `<button class="day${isReadDay(iso) ? ' read' : ''}${iso === today ? ' today' : ''}${U.habit.get(iso)?.journal ? ' has-note' : ''}" data-act="day" data-date="${iso}" aria-label="${iso}">${d}</button>`;
  }
  const readThisMonth = [...U.habit.values()].filter((r) => r.read !== false && r.date.startsWith(`${CAL.y}-${String(CAL.m + 1).padStart(2, '0')}`)).length;
  return `<div class="cal-head"><button class="iconbtn" data-act="calprev" aria-label="Previous month"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button>` +
    `<div><div class="cal-title">${MONTHS[CAL.m]} ${CAL.y}</div><div class="muted small" style="text-align:center">${readThisMonth} day${readThisMonth === 1 ? '' : 's'} read</div></div>` +
    `<button class="iconbtn" data-act="calnext" aria-label="Next month"><svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg></button></div><div class="cal">${cells}</div>`;
}
function renderToday() {
  const now = new Date();
  const hr = now.getHours(); const greet = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  setTop('', { actions: '<button data-act="settings" aria-label="Settings"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.600 5.600L7 7M17 17l1.400 1.400M5.600 18.400L7 17M17 7l1.400-1.400"/></svg></button>' });
  const pos = store.get('pos', { b: 0, c: 1, v: 1 });
  const r = votdRef(); const v2 = r.v2 || r.v1;
  const txt = rangeText(r.b, r.c, r.v1, v2);
  const streak = streakDays(); const total = readDayCount(); const readToday = isReadDay(isoDate());
  const week = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay() + i);
    const iso = isoDate(d);
    return `<button class="wd${iso === isoDate() ? ' today' : ''}" data-act="day" data-date="${iso}" aria-label="${iso}"><span>${'SMTWTFS'[i]}</span><i class="${isReadDay(iso) ? 'read' : ''}"></i></button>`;
  }).join('');
  let html = `<div class="page home"><div class="hello"><div class="date">${now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</div><h1>${greet}</h1></div>` +
    `<button class="resume" data-act="resume"><span class="lbl">Pick up where you left off</span><span class="where">${esc(fmtRef(pos.b, pos.c, pos.v > 1 ? pos.v : 0))}</span>` +
    `<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg></button>` +
    `<section class="habit"><div class="stats"><div><b>${streak}</b><span>day streak</span></div><div><b>${total}</b><span>days read</span></div></div>` +
    `<div class="week">${week}</div><div class="status">${readToday ? '✓ You’ve read today' : `Read for ${READ_SECONDS} seconds to log today`}</div>` +
    `<button class="linkbtn" data-act="calendar">${CALOPEN ? 'Hide calendar' : 'Show calendar'}</button>${CALOPEN ? `<div class="calwrap">${calendarHTML()}</div>` : ''}</section>`;
  html += journalSection() + prayerHomeSection();
  html += `<section class="votd"><div class="eyebrow">Verse of the day</div><blockquote>${esc(txt)}</blockquote><div class="votd-ref">${esc(fmtRef(r.b, r.c, r.v1, r.v2))} ESV</div>` +
    `<div class="row"><button class="btn" data-act="open" data-b="${r.b}" data-c="${r.c}" data-v="${r.v1}">Read in context</button><button class="btn" data-act="votdshare">Share</button></div></section>`;
  [...U.plans.values()].filter((p) => p.start).forEach((p) => {
    const def = PLANS.find((x) => x.id === p.id); if (!def) return;
    const day = Math.min(def.days - 1, Math.max(0, dayNumber() - dayNumberOfIso(p.start))); const done = p.done?.[day];
    html += `<section class="plan"><div class="eyebrow">${esc(def.name)} · Day ${day + 1} of ${def.days}</div><div>${planDay(def, day).map(([b, c]) =>
      `<button class="chip link" data-act="goto" data-b="${b}" data-c="${c}">${esc(fmtRef(b, c))}</button>`).join('')}</div>` +
      `<button class="btn${done ? '' : ' primary'}" data-act="plantoggle" data-plan="${def.id}" data-day="${day}">${done ? '✓ Done today' : 'Mark today done'}</button></section>`;
  });
  setView(html + '</div>');
}
let CALOPEN = false;

/* ---------- Search ---------- */
const WORD = /[a-z]+(?:'[a-z]+)*/g;
const normText = (s) => s.toLowerCase().replace(/[’‘]/g, "'");
function buildIndex() {
  if (INDEX) return;
  INDEX = new Map();
  for (let i = 0; i < FT.length; i++) {
    const ws = normText(FT[i]).match(WORD); if (!ws) continue;
    for (const w of ws) { const a = INDEX.get(w); if (!a) INDEX.set(w, [i]); else if (a[a.length - 1] !== i) a.push(i); }
  }
  WORDS = [...INDEX.keys()].sort();
}
const intersect = (a, b) => { const out = []; let i = 0, j = 0; while (i < a.length && j < b.length) { if (a[i] === b[j]) { out.push(a[i]); i++; j++; } else if (a[i] < b[j]) i++; else j++; } return out; };
function unionPostings(words) { const s = new Set(); words.forEach((w) => INDEX.get(w).forEach((x) => s.add(x))); return [...s].sort((a, b) => a - b); }
function runSearch(q) {
  buildIndex();
  const parts = []; const re = /"([^"]+)"|(\S+)/g; let m;
  while ((m = re.exec(q))) parts.push(m[1] ? { phrase: normText(m[1]).match(WORD) || [] } : { term: normText(m[2]).replace(/[^a-z'*]/g, '') });
  const lists = []; const marks = []; const phrases = [];
  for (const p of parts) {
    if (p.phrase) {
      if (!p.phrase.length) continue;
      phrases.push(p.phrase.join(' ')); marks.push(p.phrase.join('[^a-z]+').replace(/'/g, "['’]"));
      for (const w of p.phrase) { if (!INDEX.has(w)) return { hits: [], re: null }; lists.push(INDEX.get(w)); }
    } else if (p.term) {
      const t = p.term;
      if (t.endsWith('*')) {
        const stem = t.slice(0, -1); if (!stem) continue;
        const ws = WORDS.filter((w) => w.startsWith(stem)); if (!ws.length) return { hits: [], re: null };
        lists.push(unionPostings(ws)); marks.push(stem.replace(/'/g, "['’]") + "[a-z'’]*");
      } else { const l = INDEX.get(t); if (!l) return { hits: [], re: null }; lists.push(l); marks.push(t.replace(/'/g, "['’]")); }
    }
  }
  if (!lists.length) return { hits: [], re: null };
  lists.sort((a, b) => a.length - b.length);
  let hits = lists[0]; for (let i = 1; i < lists.length && hits.length; i++) hits = intersect(hits, lists[i]);
  if (phrases.length) hits = hits.filter((i) => { const n = normText(FT[i]).replace(/[^a-z']+/g, ' '); return phrases.every((p) => n.includes(p)); });
  return { hits, re: new RegExp('(?<![A-Za-z’\'])(' + marks.join('|') + ')(?![A-Za-z])', 'gi') };
}
function markText(text, re) {
  if (!re) return esc(text);
  let out = '', last = 0, m; re.lastIndex = 0;
  while ((m = re.exec(text))) { out += esc(text.slice(last, m.index)) + '<mark>' + esc(m[0]) + '</mark>'; last = m.index + m[0].length; if (m[0] === '') re.lastIndex++; }
  return out + esc(text.slice(last));
}
/* ---------- Search across the Bible and everything you have written ---------- */
const SCOPES = [['all', 'All'], ['bible', 'Bible'], ['journal', 'Journal'], ['prayers', 'Prayers'], ['notes', 'Notes'], ['verses', 'Verses']];
function parseQuery(q) {
  const terms = [], phrases = []; const re = /"([^"]+)"|(\S+)/g; let m;
  while ((m = re.exec(q))) {
    if (m[1]) { const p = normText(m[1]).replace(/\s+/g, ' ').trim(); if (p) phrases.push(p); }
    else { const t = normText(m[2]).replace(/[*"]/g, ''); if (t) terms.push(t); }
  }
  return { terms, phrases };
}
const hayNorm = (t) => normText(t).replace(/\s+/g, ' ');
const matchesQuery = (hay, pq) => { const h = hayNorm(hay); return pq.terms.every((t) => h.includes(t)) && pq.phrases.every((p) => h.includes(p)); };
function personalRegex(pq) {
  const parts = [...pq.phrases, ...pq.terms].map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+').replace(/'/g, "['\u2019]"));
  return parts.length ? new RegExp('(' + parts.join('|') + ')', 'gi') : null;
}
function excerptHTML(text, re, max = 200) {   // a window of text around the first match, matches highlighted
  if (text.length <= max) return markText(text, re);
  re && (re.lastIndex = 0); const m = re ? re.exec(text) : null; const at = m ? m.index : 0;
  const start = Math.max(0, at - 70); const end = Math.min(text.length, start + max);
  return (start > 0 ? '\u2026' : '') + markText(text.slice(start, end), re) + (end < text.length ? '\u2026' : '');
}
function personalResults(pq) {
  const out = { journal: [], prayers: [], notes: [], verses: [] };
  U.habit.forEach((rec) => {
    const chs = rec.chapters?.length ? fmtChapterList(rec.chapters) : [];
    if (!rec.journal && !chs.length) return;
    if (matchesQuery(`${rec.journal || ''} ${dayTitle(rec.date)} ${dayTitle(rec.date, false)} ${rec.date} ${chs.map((c) => c.label).join(' ')}`, pq)) out.journal.push({ rec, chs });
  });
  out.journal.sort((a, b) => (a.rec.date < b.rec.date ? 1 : -1));
  out.prayers = U.prayers.filter((p) => matchesQuery(`${p.who} ${p.why || ''} ${p.answeredNote || ''} ${p.answered ? 'answered' : ''} ${p.answeredAt || ''}`, pq)).sort((a, b) => (b.created || 0) - (a.created || 0));
  out.notes = U.notes.filter((n) => matchesQuery(`${n.text} ${fmtRef(n.b, n.c, n.v1, n.v2)} ${rangeText(n.b, n.c, n.v1, n.v2)}`, pq)).sort((a, b) => (b.t || 0) - (a.t || 0));
  new Set([...U.hl.keys(), ...U.tags.keys(), ...U.bm.keys()]).forEach((ref) => {
    const p = parseKey(ref);
    if (matchesQuery(`${verseText(...p)} ${fmtRef(...p)} ${tagsOf(ref).join(' ')} ${U.hl.get(ref)?.color || ''} ${U.bm.has(ref) ? 'bookmark saved' : ''}`, pq)) out.verses.push({ ref, p });
  });
  out.verses.sort((a, b) => canon(a.p, b.p));
  return out;
}
const badge = (t) => `<span class="badge">${t}</span>`;
const SECTIONS = {
  journal: { title: 'Journal', item: (x, re) => `<li class="item" data-open data-act="day" data-date="${x.rec.date}"><div class="ref">${esc(dayTitle(x.rec.date, false))}${badge('Journal')}</div>` +
    (x.rec.journal ? `<div class="jtxt">${excerptHTML(x.rec.journal, re)}</div>` : '') +
    (x.chs.length ? `<div class="small muted" style="margin-top:3px">Read: ${markText(x.chs.map((c) => c.label).join(', '), re)}</div>` : '') + '</li>' },
  prayers: { title: 'Prayers', item: (p, re) => `<li class="item" data-open data-act="prayeredit" data-id="${p.id}"><div class="ref">${markText(p.who, re)}${badge(p.answered ? 'Answered' : 'Prayer')}</div>` +
    (p.why ? `<div class="jtxt">${excerptHTML(p.why, re)}</div>` : '') +
    (p.answered && p.answeredNote ? `<div class="answernote">${p.answeredAt ? 'Answered ' + esc(dayTitle(p.answeredAt, false)) + ': ' : ''}${excerptHTML(p.answeredNote, re)}</div>` : '') + '</li>' },
  notes: { title: 'Notes', item: (n, re) => `<li class="item" data-open data-act="editnote" data-id="${n.id}"><div class="ref">${esc(fmtRef(n.b, n.c, n.v1, n.v2))}${badge('Note')}</div>` +
    `<div class="jtxt">${excerptHTML(n.text, re)}</div><div class="txt muted" style="font-size:14.5px;margin-top:4px">${esc(rangeText(n.b, n.c, n.v1, n.v2))}</div></li>` },
  verses: { title: 'Verses', item: (x, re) => { const h = U.hl.get(x.ref); return `<li class="item" data-open data-act="open" data-b="${x.p[0]}" data-c="${x.p[1]}" data-v="${x.p[2]}"><div class="ref">${h ? `<span class="dot ${h.color}"></span>` : ''}${esc(fmtRef(...x.p))}${U.bm.has(x.ref) ? '<span class="ind">\u2605</span>' : ''}</div>` +
    `<div class="txt">${markText(verseText(...x.p), re)}</div>${tagsOf(x.ref).length ? `<div class="taglist">${tagsOf(x.ref).map((t) => `<span>${markText(t, re)}</span>`).join('')}</div>` : ''}</li>`; } },
};
function renderSearch() {
  setTop('Search', {});
  setView(`<div class="searchbox"><input id="q" type="search" inputmode="search" enterkeyhint="search" autocomplete="off" autocapitalize="off" spellcheck="false" ` +
    `placeholder="Search the Bible and your own writing" value="${esc(SR.q)}"><div class="scopes">${SCOPES.map(([k, l]) => `<button class="scope${SR.scope === k ? ' on' : ''}" data-act="scope" data-scope="${k}">${l}</button>`).join('')}</div></div>` +
    '<div class="page" id="results" style="padding-top:4px"></div>');
  drawResults();
}
function drawResults() {
  const box = $('#results'); if (!box) return;
  const q = SR.q.trim(); const all = SR.scope === 'all';
  if (!q) { box.innerHTML = '<div class="muted small">Search the whole ESV and everything you\u2019ve written: journal entries, prayers (and how they were answered), notes, and your highlighted or tagged verses. ' +
    'Use <b>\u201Cquotes\u201D</b> for an exact phrase, <b>love*</b> for word endings in the Bible, or type a reference like <b>ps 23</b> to jump there.</div>'; return; }
  let html = ''; const ref = parseRef(q);
  if (ref && (all || SR.scope === 'bible')) html += `<div class="card"><button class="btn primary" data-act="open" data-b="${ref.b}" data-c="${ref.c}" data-v="${ref.v1}">Go to ${esc(fmtRef(ref.b, ref.c, ref.v1, ref.v2))}</button></div>`;
  const pq = parseQuery(q); const pre = personalRegex(pq);
  const personal = SR.scope === 'bible' ? {} : personalResults(pq);
  const bible = all || SR.scope === 'bible' ? runSearch(q) : null;
  const limit = all ? 4 : SR.shown; let total = 0;
  const section = (key, title, count, itemsHtml, more) => {
    total += count; if (!count) return '';
    return `<div class="resgroup"><div class="eyebrow">${title} \u00B7 ${count.toLocaleString()}</div><ul class="list">${itemsHtml}</ul>` +
      (more ? `<button class="linkbtn" data-act="${all ? 'scope' : 'moreresults'}" data-scope="${key}">${all ? `See all ${count.toLocaleString()}` : 'Show more'}</button>` : '') + '</div>';
  };
  for (const key of ['journal', 'prayers', 'notes', 'verses']) {
    if (!personal[key] || (!all && SR.scope !== key)) continue;
    const arr = personal[key]; html += section(key, SECTIONS[key].title, arr.length, arr.slice(0, limit).map((x) => SECTIONS[key].item(x, pre)).join(''), arr.length > limit);
  }
  if (bible) {
    const hits = bible.hits; const lim = all ? 6 : SR.shown;
    html += section('bible', 'Bible', hits.length, hits.slice(0, lim).map((i) => `<li class="item" data-open data-act="open" data-b="${FB[i]}" data-c="${FC[i]}" data-v="${FV[i]}"><div class="ref">${esc(fmtRef(FB[i], FC[i], FV[i]))}</div><div class="txt">${markText(FT[i], bible.re)}</div></li>`).join(''), hits.length > lim);
  }
  if (!total) html += `<div class="muted" style="margin-top:14px">No matches${all ? '' : ' in ' + SCOPES.find((x) => x[0] === SR.scope)[1]}.</div>`;
  box.innerHTML = html;
}

/* ---------- Plans ---------- */
const allChapters = (from = 0, to = BOOKS.length) => { const o = []; for (let b = from; b < to; b++) for (let c = 1; c <= chapterCount(b); c++) o.push([b, c]); return o; };
const bookIdx = (name) => BOOKS.findIndex((b) => b.n === name);
let PLANS = [];
function buildPlans() {
  PLANS = [
    { id: 'year', name: 'Bible in a Year', days: 365, desc: 'Every chapter, front to back, in 365 days.', list: allChapters() },
    { id: 'nt90', name: 'New Testament in 90 Days', days: 90, desc: 'Matthew through Revelation, about three chapters a day.', list: allChapters(39) },
    { id: 'gospels', name: 'The Four Gospels', days: 30, desc: 'Matthew, Mark, Luke and John in a month.', list: allChapters(39, 43) },
    { id: 'psalms', name: 'Psalms in a Month', days: 30, desc: 'All 150 Psalms, five a day.', list: allChapters(bookIdx('Psalms'), bookIdx('Psalms') + 1) },
    { id: 'proverbs', name: 'Proverbs in a Month', days: 31, desc: 'One chapter of Proverbs per day.', list: allChapters(bookIdx('Proverbs'), bookIdx('Proverbs') + 1) },
  ];
}
const planDay = (def, d) => def.list.slice(Math.floor(d * def.list.length / def.days), Math.floor((d + 1) * def.list.length / def.days));
const planDoneCount = (p) => Object.values(p.done || {}).filter(Boolean).length;

/* ---------- Library ---------- */
function renderLibrary() {
  setTop('Library', {});
  const seg = (k, label) => `<button data-act="seg" data-seg="${k}" class="${L.seg === k ? 'on' : ''}">${label}</button>`;
  let html = `<div class="page"><div class="seg lib">${seg('highlights', 'Highlights')}${seg('tags', 'Tags')}${seg('notes', 'Notes')}${seg('bookmarks', 'Saved')}${seg('plans', 'Plans')}</div>`;
  if (L.seg === 'plans') html += L.plan ? planDetail(L.plan) : planList();
  else if (L.seg === 'highlights') html += savedHighlights();
  else if (L.seg === 'tags') html += savedTags();
  else if (L.seg === 'notes') html += savedNotes();
  else html += savedBookmarks();
  setView(html + '</div>');
}
function planList() {
  return PLANS.map((def) => {
    const p = U.plans.get(def.id); const pct = p ? Math.round(planDoneCount(p) / def.days * 100) : 0;
    return `<div class="card" data-open data-act="plan" data-plan="${def.id}" style="cursor:pointer"><div style="font-weight:650">${esc(def.name)}</div>` +
      `<div class="muted small">${esc(def.desc)}</div>` +
      (p ? `<div class="progress"><i style="width:${pct}%"></i></div><div class="small muted">${planDoneCount(p)} of ${def.days} days done</div>` : '') + '</div>';
  }).join('');
}
function planDetail(id) {
  const def = PLANS.find((p) => p.id === id); const p = U.plans.get(id);
  let html = `<div class="row" style="margin-bottom:10px"><button class="btn" data-act="planback">‹ Plans</button></div><div class="card"><div style="font-weight:650;font-size:18px">${esc(def.name)}</div><div class="muted small">${esc(def.desc)}</div>`;
  if (!p) return html + `<div class="row" style="margin-top:12px"><button class="btn primary" data-act="planstart" data-plan="${id}">Start today</button></div></div>`;
  const today = Math.min(def.days - 1, Math.max(0, dayNumber() - dayNumberOfIso(p.start)));
  html += `<div class="progress"><i style="width:${Math.round(planDoneCount(p) / def.days * 100)}%"></i></div><div class="small muted">Started ${esc(p.start)} · ${planDoneCount(p)} of ${def.days} days done</div>` +
    '<div class="row" style="margin-top:10px"><button class="btn danger" data-act="planreset" data-plan="' + id + '">Stop and reset</button></div></div><div class="daylist"><ul class="list">';
  for (let d = 0; d < def.days; d++) {
    const chs = planDay(def, d); const done = !!p.done?.[d];
    html += `<li class="item${done ? ' done' : ''}"><div><div class="ref">Day ${d + 1}${d === today ? ' · today' : ''}</div><div>${chs.map(([b, c]) =>
      `<button class="chip link" data-act="goto" data-b="${b}" data-c="${c}">${esc(fmtRef(b, c))}</button>`).join('')}</div></div>` +
      `<button class="check${done ? ' on' : ''}" data-act="plantoggle" data-plan="${id}" data-day="${d}" aria-label="Mark day ${d + 1} done">${done ? '✓' : ''}</button></li>`;
  }
  return html + '</ul></div>';
}
async function planToggle(id, day) {
  const p = U.plans.get(id); if (!p) return;
  p.done = p.done || {}; p.done[day] = !p.done[day]; await idb.put('plans', p);
  if (TAB === 'library') renderLibrary(); else renderToday();
}
const rangeText = (b, c, v1, v2) => Array.from({ length: v2 - v1 + 1 }, (_, i) => verseText(b, c, v1 + i)).filter(Boolean).join(' ');
function savedHighlights() {
  const items = [...U.hl.values()].map((h) => ({ ...h, p: parseKey(h.ref) })).sort((a, b) => a.p[0] - b.p[0] || a.p[1] - b.p[1] || a.p[2] - b.p[2]);
  if (!items.length) return '<div class="muted">No highlights yet. Tap a verse in the reader, then pick a color.</div>';
  return '<ul class="list">' + items.map((h) => `<li class="item" data-open data-act="open" data-b="${h.p[0]}" data-c="${h.p[1]}" data-v="${h.p[2]}"><div class="ref"><span class="dot ${h.color}"></span>${esc(fmtRef(...h.p))}</div><div class="txt">${esc(verseText(...h.p))}</div>${tagLine(h.ref)}</li>`).join('') + '</ul>';
}
function savedNotes() {
  if (!U.notes.length) return '<div class="muted">No notes yet. Select verses in the reader and tap Note.</div>';
  const items = [...U.notes].sort((a, b) => a.b - b.b || a.c - b.c || a.v1 - b.v1);
  return '<ul class="list">' + items.map((n) => `<li class="item" data-open data-act="editnote" data-id="${n.id}"><div class="ref">${esc(fmtRef(n.b, n.c, n.v1, n.v2))}</div><div class="txt">${esc(rangeText(n.b, n.c, n.v1, n.v2))}</div><div class="note">${esc(n.text)}</div></li>`).join('') + '</ul>';
}
function savedBookmarks() {
  const items = [...U.bm.values()].map((x) => ({ ...x, p: parseKey(x.ref) })).sort((a, b) => a.p[0] - b.p[0] || a.p[1] - b.p[1] || a.p[2] - b.p[2]);
  if (!items.length) return '<div class="muted">No bookmarks yet. Select a verse in the reader and tap Bookmark.</div>';
  return '<ul class="list">' + items.map((x) => `<li class="item" data-open data-act="open" data-b="${x.p[0]}" data-c="${x.p[1]}" data-v="${x.p[2]}"><div class="ref">★ ${esc(fmtRef(...x.p))}</div><div class="txt">${esc(verseText(...x.p))}</div></li>`).join('') + '</ul>';
}

/* ---------- Settings ---------- */
function settingsControls() {
  const seg = (key, opts) => `<div class="seg" style="margin:0;min-width:210px">${opts.map(([v, l]) => `<button data-act="set" data-key="${key}" data-val="${v}" class="${String(S[key]) === String(v) ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  const tog = (key, label) => `<div class="field"><label>${label}</label><div class="seg" style="margin:0"><button data-act="set" data-key="${key}" data-val="1" class="${S[key] ? 'on' : ''}">On</button><button data-act="set" data-key="${key}" data-val="0" class="${S[key] ? '' : 'on'}">Off</button></div></div>`;
  return `<div class="field"><label>Theme</label>${seg('theme', [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']])}</div>` +
    `<div class="field"><label>Text size <span class="muted">${S.size}</span></label><div class="sizer"><small>A</small><input type="range" min="15" max="32" step="1" value="${S.size}" data-range="size" aria-label="Text size"><big>A</big></div></div>` +
    tog('nums', 'Verse numbers');
}
function renderSettings() {
  setTop('Settings', {});
  setView(`<div class="page"><div class="card" id="settings-controls">${settingsControls()}</div>` +
    `<div class="card"><h2>Your data</h2><div class="muted small" style="margin-bottom:10px">Highlights, notes, bookmarks and plan progress are stored only on this device. Export a backup now and then, especially before clearing Safari data or changing phones.</div>` +
    `<div class="row"><button class="btn" data-act="export">Export backup</button><button class="btn" data-act="import">Import backup</button></div><input type="file" id="importfile" accept="application/json" hidden>` +
    `<div class="small muted" id="storage-status" style="margin-top:10px"></div></div>` +
    `<div class="card"><h2>Bible text</h2><div class="small muted" style="margin-bottom:10px">${esc(EDITION)} \u00B7 ${FT.length.toLocaleString()} verses, saved on this device. Import a new esv.json here if you ever rebuild it.</div>` +
    `<div class="row"><button class="btn" data-act="importbible">Import esv.json</button></div><input type="file" id="biblefile" accept=".json,application/json" hidden></div>` +
    `<div class="card"><h2>Offline</h2><div id="offline-status" class="small">Checking…</div></div>` +
    `<div class="card"><h2>About</h2><div class="small muted">${esc(EDITION)} · App v${APP_VERSION}<br><br>${esc(NOTICE)}</div></div></div>`);
  offlineStatus(); storageStatus();
}
async function offlineStatus() {
  const el = $('#offline-status'); if (!el) return;
  try {
    if (!('serviceWorker' in navigator)) { el.textContent = 'This browser does not support offline install.'; return; }
    const reg = await navigator.serviceWorker.getRegistration();
    const hit = await caches.match('data/esv.json');
    el.innerHTML = reg && hit ? '✅ Ready for airplane mode. The app and the full Bible text are saved on this device.' : '⚠️ Not saved for offline yet. Keep this page open on Wi-Fi for a moment, then reopen it.';
  } catch { el.textContent = 'Could not check offline status.'; }
}
async function storageStatus() {
  const el = $('#storage-status'); if (!el) return;
  let msg = idb.persistent ? 'Saved in this browser’s database.' : 'Warning: storage is unavailable (private browsing?). Your marks will be lost when you close the app.';
  try { if (navigator.storage?.persist) { const ok = await navigator.storage.persisted() || await navigator.storage.persist(); msg += ok ? ' Persistent storage granted.' : ' Persistent storage not granted, so keep a backup.'; } } catch { /* ignore */ }
  el.textContent = msg;
}
async function exportBackup() {
  const data = { app: 'esv-bible', version: 1, exported: new Date().toISOString(), highlights: [...U.hl.values()], notes: U.notes, bookmarks: [...U.bm.values()], plans: [...U.plans.values()], habit: [...U.habit.values()], tags: [...U.tags.values()], prayers: U.prayers, settings: S };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const file = new File([blob], `esv-bible-backup-${isoDate()}.json`, { type: 'application/json' });
  try { if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: 'ESV Bible backup' }); return; } } catch (e) { if (e.name === 'AbortError') return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file.name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
async function importBackup(file) {
  try {
    const d = JSON.parse(await file.text());
    if (d.app !== 'esv-bible') throw new Error('Not an ESV Bible backup');
    for (const h of d.highlights || []) { U.hl.set(h.ref, h); await idb.put('highlights', h); }
    for (const b of d.bookmarks || []) { U.bm.set(b.ref, b); await idb.put('bookmarks', b); }
    for (const p of d.plans || []) { U.plans.set(p.id, p); await idb.put('plans', p); }
    for (const t of d.tags || []) { const merged = [...tagsOf(t.ref)]; (t.tags || []).forEach((x) => { if (!merged.some((m) => sameTag(m, x))) merged.push(x); }); await writeTags(t.ref, merged); }
    for (const pr of d.prayers || []) { const o = { ...pr }; delete o.id; const id = await idb.put('prayers', o); o.id = id; U.prayers.push(o); }
    for (const h of d.habit || []) { const rec = typeof h === 'string' ? { date: h, t: Date.now(), chapters: [], journal: '' } : h; U.habit.set(rec.date, rec); await idb.put('habit', rec); }
    for (const n of d.notes || []) { const o = { ...n }; delete o.id; const id = await idb.put('notes', o); o.id = id; U.notes.push(o); }
    toast('Backup imported'); renderSettings();
  } catch (e) { toast('Import failed: ' + e.message); }
}

/* ---------- events ---------- */
const ACT = {
  picker: () => openPicker('books'),
  pickbook: (e) => openPicker('chapters', +e.dataset.b),
  goto: (e) => { closeModal(); openChapter(+e.dataset.b, +e.dataset.c); },
  open: (e) => { closeModal(); openChapter(+e.dataset.b, +e.dataset.c, +e.dataset.v || 0); },
  closemodal: closeModal,
  appearance: openAppearance,
  clearsel: () => clearSelection(),
  color: (e) => applyColor(e.dataset.c),
  note: () => openNoteEditor(),
  savenote: saveNote, delnote: deleteNote,
  editnote: (e) => openNoteEditor(U.notes.find((n) => n.id === +e.dataset.id)),
  bookmark: toggleBookmark, copy: copySelection,
  tags: openTagEditor,
  tagtoggle: async (e) => { const vs = selectedVerses(); const name = e.dataset.tag; const on = !vs.every((v) => tagsOf(refKey(R.b, R.c, v)).some((t) => sameTag(t, name))); await setTagForSelection(name, on); refreshTagEditor(); },
  tagopen: (e) => { L.tag = e.dataset.tag; renderLibrary(); },
  tagback: () => { L.tag = null; renderLibrary(); },
  tagrename: (e) => renameTag(e.dataset.tag),
  tagdelete: (e) => deleteTag(e.dataset.tag),
  votdshare: () => { const r = votdRef(); shareText(quoteString(rangeText(r.b, r.c, r.v1, r.v2 || r.v1), fmtRef(r.b, r.c, r.v1, r.v2))); },
  share: shareSelection,
  settings: () => setTab('settings'),
  gotab: (e) => setTab(e.dataset.tab),
  prayeradd: () => openPrayerEditor(0),
  prayeredit: (e) => openPrayerEditor(+e.dataset.id),
  prayertoggle: (e) => togglePrayed(+e.dataset.id),
  prayersave: (e) => submitPrayer(+e.dataset.id || 0),
  prayeranswered: (e) => openAnsweredForm(+e.dataset.id),
  prayeranswersave: (e) => setAnswered(+e.dataset.id, true, isoDate(), ($('#ans-note')?.value || '').trim()),
  prayerreopen: (e) => setAnswered(+e.dataset.id, false),
  prayerdelete: (e) => deletePrayer(+e.dataset.id),
  day: (e) => openDay(e.dataset.date),
  savejournal: (e) => saveJournal(e.dataset.date),
  deljournal: (e) => { if (confirm('Delete this journal entry?')) saveJournal(e.dataset.date, true); },
  jall: () => { JALL = !JALL; renderToday(); },
  resume: () => { const p = store.get('pos', { b: 0, c: 1, v: 1 }); openChapter(p.b, p.c, p.v, true); },
  calendar: () => { CALOPEN = !CALOPEN; renderToday(); },
  calprev: () => { CAL.m--; if (CAL.m < 0) { CAL.m = 11; CAL.y--; } renderToday(); },
  calnext: () => { CAL.m++; if (CAL.m > 11) { CAL.m = 0; CAL.y++; } renderToday(); },
  seg: (e) => { L.seg = e.dataset.seg; L.plan = null; L.tag = null; renderLibrary(); },
  plan: (e) => { L.plan = e.dataset.plan; renderLibrary(); },
  planback: () => { L.plan = null; renderLibrary(); },
  planstart: async (e) => { const p = { id: e.dataset.plan, start: isoDate(), done: {} }; U.plans.set(p.id, p); await idb.put('plans', p); renderLibrary(); toast('Plan started'); },
  planreset: async (e) => { if (!confirm('Stop this plan and erase its progress?')) return; U.plans.delete(e.dataset.plan); await idb.del('plans', e.dataset.plan); L.plan = null; renderLibrary(); },
  plantoggle: (e) => planToggle(e.dataset.plan, +e.dataset.day),
  moreresults: () => { SR.shown += 100; drawResults(); },
  scope: (e) => { SR.scope = e.dataset.scope; SR.shown = 100; renderSearch(); },
  set: (e) => {
    const k = e.dataset.key; const v = e.dataset.val; S[k] = k === 'nums' ? v === '1' : v;
    saveSettings(); refreshSettingsUI();
  },
  export: exportBackup,
  import: () => $('#importfile').click(),
  importbible: () => $('#biblefile').click(),
};
function refreshSettingsUI() {
  const modalBody = !$('#modal').hidden ? $('#modal .modal-body') : null;
  if (modalBody) modalBody.innerHTML = settingsControls(); else if ($('#settings-controls')) $('#settings-controls').innerHTML = settingsControls();
  if (TAB === 'read') { const t = $('#view').scrollTop; renderRead(); $('#view').scrollTop = t; }
}

document.addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-act]');
  if (t && ACT[t.dataset.act]) { ev.preventDefault(); ACT[t.dataset.act](t); return; }
  const tab = ev.target.closest('#tabs [data-tab]'); if (tab) { setTab(tab.dataset.tab); return; }
  const v = ev.target.closest('.v');
  if (v && TAB === 'read') { if (window.getSelection().toString().length > 0) return; toggleVerse(v.dataset.r); }
});
document.addEventListener('input', (ev) => {
  const r = ev.target.closest('[data-range]');
  if (r) {
    S[r.dataset.range] = +r.value; saveSettings();
    const lab = r.closest('.field').querySelector('label span'); if (lab) lab.textContent = S.size;
    if (TAB === 'read') { const t = $('#view').scrollTop; renderRead(); $('#view').scrollTop = t; }
    return;
  }
  if (ev.target.id === 'q') { SR.q = ev.target.value; SR.shown = 100; clearTimeout(SR.t); SR.t = setTimeout(drawResults, 120); }
});
document.addEventListener('submit', async (ev) => {
  if (ev.target.dataset.submit !== 'tagadd') return;
  ev.preventDefault();
  const input = $('#tag-new'); const typed = cleanTag(input.value); if (!typed) return;
  const name = allTagNames().find((t) => sameTag(t, typed)) || typed;   // reuse an existing tag's spelling
  await setTagForSelection(name, true); refreshTagEditor(); toast(`Tagged \u201C${name}\u201D`);
});
document.addEventListener('change', async (ev) => {
  if (ev.target.id === 'importfile' && ev.target.files[0]) importBackup(ev.target.files[0]);
  if (ev.target.id === 'biblefile' && ev.target.files[0]) {
    try { await importBibleFile(ev.target.files[0]); toast('Bible text imported. Reloading\u2026'); setTimeout(() => location.reload(), 700); }
    catch (e) { toast(e.message); }
  }
});
let touch = null;
document.addEventListener('touchstart', (e) => { touch = TAB === 'read' && e.touches.length === 1 && $('#modal').hidden ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null; }, { passive: true });
document.addEventListener('touchend', (e) => {
  if (!touch) return; const dx = e.changedTouches[0].clientX - touch.x, dy = e.changedTouches[0].clientY - touch.y; touch = null;
  if (Math.abs(dx) > 90 && Math.abs(dy) < 45) { const n = dx < 0 ? nextChapter(R.b, R.c) : prevChapter(R.b, R.c); if (n) openChapter(n[0], n[1]); }
}, { passive: true });

/* ---------- init ---------- */
function showImportScreen(message) {
  $('#splash-msg').outerHTML = '<div id="import-box" class="import">' +
    '<p>To keep the ESV text off the public internet, this app does not include it. Choose your <b>esv.json</b> file once; it is saved on this device and works offline from then on.</p>' +
    '<button class="btn primary" id="import-btn">Choose esv.json</button><input type="file" id="import-file" accept=".json,application/json" hidden>' +
    `<p class="import-err" id="import-err">${esc(message || '')}</p></div>`;
  $('#import-btn').onclick = () => $('#import-file').click();
  $('#import-file').onchange = async (ev) => {
    const f = ev.target.files[0]; if (!f) return;
    $('#import-err').textContent = 'Importing\u2026';
    try { const d = await importBibleFile(f); $('#import-box').remove(); await start(d); }
    catch (e) { $('#import-err').textContent = e.message; }
  };
}
async function start(d) {
  applyData(d);
  await loadUser(); buildPlans();
  const pos = store.get('pos', { b: 0, c: 1 }); if (BOOKS[pos.b] && pos.c <= chapterCount(pos.b)) { R.b = pos.b; R.c = pos.c; }
  $('#view').addEventListener('scroll', trackPosition, { passive: true });
  setTab('today');
  $('#splash').classList.add('gone'); setTimeout(() => $('#splash')?.remove(), 400);
}
async function init() {
  applySettings();
  try {
    await idb.open();
    const d = await loadBibleData();
    if (d) await start(d); else showImportScreen();
  } catch (e) {
    const m = $('#splash-msg'); if (m) m.textContent = 'Could not start: ' + e.message;
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { /* offline install unavailable */ });
}
window.__esv = { parseRef, runSearch, verseText, get books() { return BOOKS; }, openChapter, setTab }; // handy for testing in dev tools
init();
})();

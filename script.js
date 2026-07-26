const API_URL = '/api/notes';
const RATE_WINDOW_MS = 60 * 1000;
let notes = [];
let lastPostTs = 0;
let rateLimitOn = true;

const board = document.getElementById('bulletin-board');
const input = document.getElementById('note-input');
const charCount = document.getElementById('char-current');

function showRateLimit() {
  alert('chill out bru — one note per minute, please');
}

input.addEventListener('input', () => {
  charCount.textContent = input.value.length;
});

let topZ = 0;

function randomPlacement(el) {
  el.style.left = `${5 + (Math.random() * 75)}%`;
  el.style.top = `${5 + (Math.random() * 75)}%`;
  el.style.transform = `rotate(${(Math.random() - 0.5) * 20}deg)`;
}

function formatCreatedAt(ts) {
  if (!ts || typeof ts !== 'number') return '';
  return new Date(ts).toLocaleString('en-US', {
    timeZone: 'Asia/Manila',
    month: '2-digit', day: '2-digit', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).replace(/\s?(AM|PM)$/, '$1');
}

function backText(note) {
  const where = note.geo
    ? [note.geo.city, note.geo.country].filter(Boolean).join(', ') || '???'
    : '???';
  const what = note.device || '???';
  const when = formatCreatedAt(note.ts);
  return when ? `${what} · ${where} · ${when}` : `${what} · ${where}`;
}

function appendNote(note) {
  const el = document.createElement('div');
  el.className = 'note';

  const face = document.createElement('span');
  face.className = 'face';
  face.textContent = note.text;
  el.appendChild(face);

  const back = document.createElement('span');
  back.className = 'back';
  back.textContent = backText(note);
  el.appendChild(back);

  el.addEventListener('click', () => el.classList.toggle('flipped'));
  randomPlacement(el);
  el.style.zIndex = ++topZ;
  board.appendChild(el);
  return el;
}

async function loadNotes() {
  try {
    const res = await fetch(API_URL);
    if (!res.ok) return;
    rateLimitOn = res.headers.get('x-rate-limit') !== 'off';
    const data = await res.json();
    notes = Array.isArray(data) ? data : [];
    board.innerHTML = '';
    topZ = 0;
    notes.forEach(appendNote);
  } catch (e) { /* silent */ }
}

function handleSubmit(e) {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || text.length > 20) return false;

  if (rateLimitOn && Date.now() - lastPostTs < RATE_WINDOW_MS) {
    showRateLimit();
    return false;
  }

  const note = { text, ts: Date.now() };
  notes.push(note);
  const el = appendNote(note);
  input.value = '';
  charCount.textContent = '0';
  lastPostTs = Date.now();

  fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  }).then(async (res) => {
    if (res.status === 429) {
      el.remove();
      const i = notes.indexOf(note);
      if (i !== -1) notes.splice(i, 1);
      showRateLimit();
      return;
    }
    if (!res.ok) return;
    const data = await res.json().catch(() => null);
    if (!data?.note) return;
    const i = notes.indexOf(note);
    if (i !== -1) notes[i] = data.note;
    const backEl = el.querySelector('.back');
    if (backEl) backEl.textContent = backText(data.note);
  }).catch(() => {});

  return false;
}

function shuffleNotes() {
  const els = Array.from(board.children);
  const zOrder = [...els.keys()].sort(() => Math.random() - 0.5);
  els.forEach((el, i) => {
    el.classList.remove('flipped');
    randomPlacement(el);
    el.style.zIndex = zOrder[i];
  });
  topZ = els.length;
}

document.getElementById('shuffle-btn').addEventListener('click', shuffleNotes);
document.addEventListener('DOMContentLoaded', loadNotes);

async function loadVisitorCount() {
  try {
    const res = await fetch('/api/visitors');
    if (!res.ok) return;
    const data = await res.json();
    if (typeof data.count !== 'number') return;
    document.getElementById('visitor-count').textContent = String(data.count);
  } catch (e) { /* silent */ }
}
document.addEventListener('DOMContentLoaded', loadVisitorCount);

async function loadLastUpdated() {
  const el = document.getElementById('last-updated');
  try {
    const res = await fetch('/api/last-updated');
    if (!res.ok) return;
    const data = await res.json();
    if (!data.date) return;
    el.textContent = new Date(data.date).toLocaleDateString('en-US', {
      timeZone: 'Asia/Manila',
      month: 'long', day: 'numeric', year: 'numeric',
    });
  } catch (e) { /* silent */ }
}
document.addEventListener('DOMContentLoaded', loadLastUpdated);

async function loadWikiImage() {
  const container = document.getElementById('wiki-img-container');
  try {
    const res = await fetch('/api/wiki-image');
    if (!res.ok) {
      container.innerHTML = '<p style="color:#888;font-style:italic;font-size:.9rem;">No image yet — check back tomorrow.</p>';
      return;
    }
    const img = await res.json();
    const safeCaption = (img.caption || '')
      .replace(/href="\/wiki\//g, 'href="https://en.wikipedia.org/wiki/')
      .replace(/<a /g, '<a target="_blank" rel="noopener" ');
    const safeUrl = img.commonsUrl || '#';
    const safeSrc = img.src || '';
    const safeTitle = img.title ? img.title.replace(/^File:/, '') : 'Wikipedia image';
    container.innerHTML = `
      <div class="wiki-thumb">
        <a href="${safeUrl}" target="_blank" rel="noopener">
          <img src="${safeSrc}" alt="${safeTitle}" loading="lazy">
        </a>
        <div class="wiki-thumbcaption">
          <span class="wiki-magnify">
            <a href="${safeUrl}" target="_blank" rel="noopener" title="View on Wikimedia Commons" aria-label="View full image on Wikimedia Commons">
              <svg width="15" height="15" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <circle cx="6" cy="6" r="4.5" stroke="#555" stroke-width="1.4"/>
                <line x1="9.5" y1="9.5" x2="13.5" y2="13.5" stroke="#555" stroke-width="1.4" stroke-linecap="round"/>
              </svg>
            </a>
          </span>
          ${safeCaption}
        </div>
      </div>`;
  } catch (e) {
    container.innerHTML = '<p style="color:#888;font-style:italic;font-size:.9rem;">Could not load image.</p>';
  }
}
document.addEventListener('DOMContentLoaded', loadWikiImage);

const sunMoonToggle = document.getElementById('sun-moon-toggle');
sunMoonToggle.addEventListener('click', () => {
  const isMoon = sunMoonToggle.textContent === '☀︎';
  sunMoonToggle.textContent = isMoon ? '☾' : '☀︎';
  document.documentElement.classList.toggle('dark-mode', isMoon);
});


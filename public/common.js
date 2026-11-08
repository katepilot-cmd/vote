// 진행자 화면과 휴대폰 화면이 함께 쓰는 코드
const COLORS = ['#e21b3c', '#1368ce', '#d89e00', '#26890c', '#864cbf', '#0aa3a3', '#e5631b', '#c2185b', '#5d7b00', '#3949ab'];
const TYPE_LABEL = { choice: '객관식', person: '동기 고르기', number: '숫자', short: '주관식', long: '메시지' };
const MEDALS = ['🥇', '🥈', '🥉'];

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function makeSSE(url, onData) {
  let es, last = Date.now();
  const open = () => {
    if (es) es.close();
    es = new EventSource(url);
    es.onmessage = e => { last = Date.now(); onData(JSON.parse(e.data)); };
    es.onopen = () => { last = Date.now(); setConn(true); };
    es.onerror = () => setConn(false);
  };
  // 프록시 등에서 연결이 조용히 끊긴 경우 다시 연결
  setInterval(() => { if (Date.now() - last > 40000) { last = Date.now(); open(); } }, 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && es && es.readyState === 2) open(); });
  open();
}
function setConn(ok) {
  const el = document.getElementById('conn');
  if (el) el.classList.toggle('show', !ok);
}

function barsHTML(items, { limit = 99, medals = false, colorByIndex = true } = {}) {
  const max = Math.max(1, ...items.map(i => i.count));
  const shown = items.slice(0, limit);
  const rows = shown.map((it, k) => {
    const rank = 1 + items.filter(o => o.count > it.count).length;
    const medal = medals && it.count > 0 && rank <= 3 ? `<span class="medal">${MEDALS[rank - 1]}</span>` : '';
    const color = colorByIndex ? COLORS[k % COLORS.length] : COLORS[1];
    return `<div class="bar-row${medals && rank === 1 && it.count > 0 ? ' top' : ''}" style="--d:${k * 0.06}s">
      <div class="bar-label">${medal}${esc(it.label)}</div>
      <div class="bar-track"><div class="bar-fill" style="--w:${(it.count / max) * 100}%;background:${color}"></div></div>
      <div class="bar-count">${it.count}</div></div>`;
  }).join('');
  const more = items.length > limit ? `<div class="more">외 ${items.length - limit}개 답변</div>` : '';
  return `<div class="bars">${rows}${more}</div>`;
}

function columnsHTML(items) {
  const max = Math.max(1, ...items.map(i => i.count));
  return `<div class="cols">${items.map((it, k) => `
    <div class="col" style="--d:${k * 0.04}s">
      <div class="col-count">${it.count || ''}</div>
      <div class="col-bar" style="--h:${(it.count / max) * 100}%;background:${COLORS[k % COLORS.length]}"></div>
      <div class="col-label">${esc(it.label)}</div>
    </div>`).join('')}</div>`;
}

function cloudHTML(items) {
  const max = Math.max(1, ...items.map(i => i.count));
  // 큰 단어가 가운데 오도록 섞기
  const sorted = [...items].sort((a, b) => b.count - a.count);
  const arr = [];
  sorted.forEach((it, k) => (k % 2 ? arr.push(it) : arr.unshift(it)));
  return `<div class="cloud">${arr.map((it, k) => {
    const size = 1 + (it.count / max) * 2.6;
    return `<span style="font-size:${size}em;color:${COLORS[k % COLORS.length]};--d:${k * 0.05}s" title="${it.count}표">${esc(it.label)}</span>`;
  }).join('')}</div>`;
}

function cardsHTML(items) {
  return `<div class="cards">${items.map((it, k) => `
    <div class="card" data-k="${k}" style="--d:${Math.min(k, 30) * 0.07}s;--rot:${((k * 37) % 7) - 3}deg;background:${['#fff59d', '#ffccbc', '#c8e6c9', '#b3e5fc', '#e1bee7', '#ffe0b2'][k % 6]}">${esc(it.label)}</div>`).join('')}</div>`;
}

// mode: 'host' | 'phone'
function renderResults(r, mode) {
  if (!r) return '';
  const phone = mode === 'phone';
  if (!r.total) return '<div class="empty">아무도 답하지 않았어요 😢</div>';
  const head = `<div class="res-total">총 <b>${r.total}</b>명 응답</div>`;
  switch (r.type) {
    case 'choice':
      return head + barsHTML(r.items, { limit: phone ? 10 : 99 });
    case 'person':
      return head + barsHTML(r.items, { limit: phone ? 5 : 12, medals: true });
    case 'number':
      return head + `<div class="stats">
          <div><small>평균</small><b>${r.avg}</b></div>
          <div><small>가장 많은 답</small><b>${r.mode}</b></div>
          <div><small>최댓값</small><b>${r.max}</b></div></div>` + columnsHTML(r.items);
    case 'short':
      if (phone) return head + barsHTML(r.items, { limit: 5, medals: true });
      return head + `<div class="split">${cloudHTML(r.items)}<div class="side-rank"><h3>TOP 순위</h3>${barsHTML(r.items, { limit: 8, medals: true })}</div></div>`;
    case 'long':
      if (phone) return head + `<div class="empty">메시지 ${r.total}개가 큰 화면에 공개됐어요 💌</div>`;
      return head + cardsHTML(r.items);
  }
  return '';
}

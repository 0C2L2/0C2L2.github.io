const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const root = document.documentElement;
const RAMP = ' .:-=+*#%@';

// Reveal sections as they scroll into view
const seen = new IntersectionObserver(entries => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    e.target.classList.add('in');
    seen.unobserve(e.target);
  }
}, { threshold: 0.15 });
document.querySelectorAll('.reveal').forEach(el => seen.observe(el));

// Preview videos play only while on screen
const players = new IntersectionObserver(entries => {
  for (const e of entries) e.isIntersecting && !reduced ? e.target.play().catch(() => {}) : e.target.pause();
}, { threshold: 0.3 });
document.querySelectorAll('video[data-autoplay]').forEach(v => players.observe(v));

// Count-up numbers in the hero
function count(el) {
  const end = parseFloat(el.dataset.count), dec = +el.dataset.dec || 0, t0 = performance.now();
  const tick = now => {
    const k = Math.min((now - t0) / 1600, 1), eased = 1 - Math.pow(1 - k, 3);
    el.textContent = (end * eased).toFixed(dec);
    if (k < 1) requestAnimationFrame(tick);
  };
  reduced ? (el.textContent = end.toFixed(dec)) : requestAnimationFrame(tick);
}
const startCounters = () => setTimeout(() => document.querySelectorAll('[data-count]').forEach(count), 800);

// Boot sequence (head script adds .booting once per visit); hero animations wait for it
const boot = document.getElementById('boot');
if (root.classList.contains('booting')) {
  try { sessionStorage.setItem('booted', '1'); } catch (e) {}
  const pre = boot.querySelector('pre');
  const lines = [
    '<b>rashid.os</b> v2026.11 — booting',
    '<i>[ ok ]</i> perception    vision · speech · diarization',
    '<i>[ ok ]</i> actuators     arm 2-dof · gripper',
    '<i>[ ok ]</i> telemetry     uart · hc-12 · bluetooth',
    '<i>[ ok ]</i> projects      5 loaded',
    '&gt; launching portfolio_',
  ];
  lines.forEach((l, i) => setTimeout(() => { pre.innerHTML += l + '\n'; }, 100 + i * 140));
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    boot.classList.add('off');
    root.classList.remove('booting');
    startCounters();
    setTimeout(() => boot.remove(), 800);
  };
  setTimeout(finish, 1250);
  boot.addEventListener('click', finish);
} else {
  boot.remove();
  startCounters();
}

// Nav background + scroll progress bar
const nav = document.querySelector('.nav');
addEventListener('scroll', () => {
  nav.classList.toggle('scrolled', scrollY > 20);
  root.style.setProperty('--p', scrollY / (root.scrollHeight - innerHeight || 1));
}, { passive: true });

// Cursor spotlight on cards
document.querySelectorAll('.card').forEach(card => card.addEventListener('pointermove', e => {
  const r = card.getBoundingClientRect();
  card.style.setProperty('--x', e.clientX - r.left + 'px');
  card.style.setProperty('--y', e.clientY - r.top + 'px');
}));

// Full video in a native <dialog>
const dlg = document.getElementById('player'), vid = dlg.querySelector('video');
document.querySelectorAll('[data-video]').forEach(btn => btn.addEventListener('click', () => {
  vid.src = btn.dataset.video;
  dlg.showModal();
  vid.play().catch(() => {});
}));
dlg.querySelector('.close').addEventListener('click', () => dlg.close());
dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
dlg.addEventListener('close', () => { vid.pause(); vid.removeAttribute('src'); vid.load(); });

/* ---------------- ASCII ---------------- */

// Hero portrait: wipe in line by line (CSS), then a few characters flicker
const portrait = document.getElementById('portrait');
if (portrait) {
  const lines = portrait.textContent.replace(/^\n/, '').split('\n');
  portrait.innerHTML = lines.map((l, i) => `<span style="--i:${i}">${l}</span>`).join('');
  const spans = portrait.children;
  if (!reduced) setInterval(() => {
    for (let k = 0; k < 8; k++) {
      const i = Math.random() * lines.length | 0, line = lines[i], j = Math.random() * line.length | 0;
      const r = RAMP.indexOf(line[j]);
      if (r < 1) continue;
      const nc = RAMP[Math.max(1, Math.min(9, r + (Math.random() < .5 ? -3 : 3)))];
      spans[i].textContent = line.slice(0, j) + nc + line.slice(j + 1);
      setTimeout(() => { spans[i].textContent = line; }, 260);
    }
  }, 110);
}

// Run draw(t) at `fps` only while the element is on screen
function animate(el, fps, draw) {
  if (reduced) return draw(2.2);
  let on = false, last = 0, id, t0 = performance.now();
  const step = now => {
    if (now - last >= 1000 / fps) { last = now; draw((now - t0) / 1000); }
    id = requestAnimationFrame(step);
  };
  new IntersectionObserver(([e]) => {
    if (e.isIntersecting === on) return;
    on = e.isIntersecting;
    on ? (id = requestAnimationFrame(step)) : cancelAnimationFrame(id);
  }).observe(el);
  draw(0);
}

const W = 56, H = 22;
const blank = (w = W, h = H) => Array.from({ length: h }, () => Array(w).fill(' '));
const put = (g, r, c, s) => { for (let k = 0; k < s.length; k++) if (g[r] && c + k >= 0 && c + k < g[r].length) g[r][c + k] = s[k]; };
const text = g => g.map(row => row.join('')).join('\n');

// 1. Face detection: shaded ASCII head + green detection box, landmarks, emotion bars
function faceScene(base, layer) {
  const emos = [['happy', 1], ['neutral', 0], ['surprise', 2], ['sad', -1]];
  const FW = 72, FH = 28, cw = .6, ch_ = 1.2126, S = 15.5;   // grid + cell size in em; S = em per unit
  const X = c => ((c + .5) * cw - FW * cw / 2) / S, Y = r => ((r + .5) * ch_ - FH * ch_ / 2) / S;
  const C = x => Math.round((x * S + FW * cw / 2) / cw - .5), R = y => Math.round((y * S + FH * ch_ / 2) / ch_ - .5);
  return t => {
    const cur = (t / 2.8 | 0) % emos.length, s = emos[cur][1];
    const cx = Math.sin(t * .8) * .05, cy = .06, rx = .52, ry = .8, yaw = Math.sin(t * .8) * .12;
    const blink = t % 3.3 < .14;
    const g = blank(FW, FH);
    for (let r = 0; r < FH; r++) for (let c = 0; c < FW; c++) {
      const hx = (X(c) - cx) / rx, hy = (Y(r) - cy) / ry, d = hx * hx + hy * hy;
      let ch = ((c * 7 + r * 13 + (t * 3 | 0)) % 61 === 0) ? '.' : ' ';
      if (d < 1) {
        const nz = Math.sqrt(1 - d), fx = hx - yaw;
        const b = Math.max(0, Math.min(1, .15 + .85 * (nz * .85 - hx * .25 - hy * .15)));
        let idx = 1 + Math.round(b * 6);
        if (hy < -.5 + .06 * Math.sin(hx * 11)) idx = (c + r) % 3 ? 8 : 7;     // hair
        for (const ex of [-.36, .36]) {
          const dx = (fx - ex) / .2, dy = (hy + .12) / .13, e2 = dx * dx + dy * dy;
          if (blink && Math.abs(hy + .12) < .07 && Math.abs(dx) < 1) idx = 3;  // closed eye
          else if (!blink && e2 < 1) idx = e2 < .3 ? 9 : 0;                    // socket + pupil
          const by = s === 2 ? -.4 : -.32;                                      // brows rise on surprise
          if (Math.abs(fx - ex) < .2 && Math.abs(hy - by - (s === -1 ? (fx - ex) * Math.sign(ex) * -.25 : 0)) < .065) idx = 8;
        }
        if (Math.abs(fx) < .06 && hy > -.02 && hy < .24) idx = Math.min(idx, 4);  // nose bridge
        if (s === 2) {                                                          // "O" mouth
          const dx = fx / .14, dy = (hy - .52) / .13, m = dx * dx + dy * dy;
          if (m < 1) idx = m < .45 ? 0 : 9;
        } else if (Math.abs(fx) < .3) {                                         // smile / flat / frown
          const my = .52 + s * (.08 - fx * fx) * 1.1;
          if (Math.abs(hy - my) < .075) idx = 9;
        }
        ch = RAMP[idx];
      } else if (Math.abs(X(c) - cx * .5) < .17 && Y(r) > .8) {
        ch = RAMP[2 + (r % 2)];                                                 // neck
      }
      g[r][c] = ch;
    }
    base.textContent = text(g);

    // overlay: box, label, landmarks, emotion bars
    const o = blank(FW, FH), j = Math.round(Math.sin(t * 7) * .4);
    const c0 = C(cx - rx) - 2 + j, c1 = C(cx + rx) + 2 + j, r0 = Math.max(1, R(cy - ry) - 1), r1 = Math.min(FH - 1, R(cy + ry) + 1);
    for (let c = c0; c <= c1; c++) { put(o, r0, c, '─'); put(o, r1, c, '─'); }
    for (let r = r0; r <= r1; r++) { put(o, r, c0, '│'); put(o, r, c1, '│'); }
    put(o, r0, c0, '┌'); put(o, r0, c1, '┐'); put(o, r1, c0, '└'); put(o, r1, c1, '┘');
    put(o, r0 - 1, c0, ` face ${(.96 + Math.sin(t * 3) * .02).toFixed(2)} · ${emos[cur][0]} `);
    for (const [lx, ly] of [[-.36, -.12], [.36, -.12], [0, .24], [-.3, .52], [.3, .52]])
      put(o, R(cy + ly * ry), C(cx + (lx + yaw) * rx), '+');
    put(o, 3, 1, 'opencv'); put(o, 4, 1, 'deepface'); put(o, 6, 1, `fps ${28 + (t * 2 | 0) % 4}`);
    put(o, 7, 1, 'faces 1'); put(o, 8, 1, 'nms .45'); put(o, 9, 1, 'eq hist');
    emos.forEach(([name], i) => {
      const p = i === cur ? .8 + .1 * Math.sin(t * 2) : .04 + .03 * Math.sin(t + i);
      put(o, 4 + i * 3, 56, name);
      put(o, 5 + i * 3, 56, '█'.repeat(Math.round(p * 12)).padEnd(12, '·') + (i === cur ? ' ◀' : ''));
    });
    layer.textContent = text(o);
  };
}

// 2. Greenhouse: sensor nodes → master → dashboard, live readings, relay log
function greenhouseScene(pre) {
  const nodes = [['n-1', 24.2, 61, 52], ['n-2', 25.1, 57, 37], ['n-3', 23.6, 64, 48]];
  const pump = [false, false, false], log = ['--:--:-- master online', '--:--:-- 3 nodes polled', '--:--:-- dashboard :5000'];
  const link = (s, end) => s.padEnd(24, '─') + end;
  const packet = (s, a, b, pos) => {
    const i = a + Math.floor(pos) % (b - a);
    return s[i] === '─' ? s.slice(0, i) + '●' + s.slice(i + 1) : s;
  };
  return t => {
    const clock = new Date().toTimeString().slice(0, 8);
    const rows = nodes.map(([id, tb, hb, sb], i) => {
      const temp = tb + Math.sin(t * .5 + i) * .6, hum = Math.round(hb + Math.sin(t * .4 + i * 2) * 3);
      const soil = Math.round(sb + Math.sin(t * .45 + i * 1.7) * 12), on = soil < 35;
      if (on !== pump[i]) { pump[i] = on; log.push(`${clock} ${id} soil ${soil}% → pump ${on ? 'ON' : 'off'}`); log.shift(); }
      const bar = '▓'.repeat(Math.round(soil / 10)).padEnd(10, '░');
      return (' ' + id).padEnd(7) + (temp.toFixed(1) + '°C').padEnd(9) + (hum + '%').padEnd(7) + (bar + ' ' + soil + '%').padEnd(16) + (on ? 'ON' : 'off');
    });
    const L = [
      ' greenhouse · 3 nodes'.padEnd(46) + '◉ LIVE',
      '',
      packet(link(' [n-1]──uart 9600', '┐'), 6, 24, t * 9),
      packet(packet(link(' [n-2]──hc-12 433MHz', '┼───▶ [master] ──http:5000──▶ ui'), 6, 24, t * 9 + 7), 39, 52, t * 11),
      packet(link(' [n-3]──bt spp', '┘'), 6, 24, t * 9 + 13),
      '',
      ' node'.padEnd(7) + 'temp'.padEnd(9) + 'humid'.padEnd(7) + 'soil'.padEnd(16) + 'pump',
      ' ' + '─'.repeat(52),
      ...rows,
      '',
      ' rule: soil below 35% → relay + buzzer',
      '',
      ' $ tail -f relay.log',
      ...log.map(l => ' ' + l),
    ];
    pre.innerHTML = L.join('\n')
      .replace(/●/g, '<b>●</b>').replace('◉ LIVE', '<i>◉ LIVE</i>')
      .replace(/\bON\b/g, '<b>ON</b>').replace(/▓+/g, m => `<i>${m}</i>`).replace(/░+/g, m => `<u>${m}</u>`);
  };
}

// 3. Library: scan a barcode, type the SQL lookup, show the row
function libraryScene(pre) {
  const books = [
    ['9780262046305', 'Introduction to Algorithms', 'available'],
    ['9780073523323', 'Database System Concepts', 'on loan'],
    ['9780262035613', 'Deep Learning', 'available'],
  ];
  const enc = ['█ ', '▌│', '│█', '█▌', ' █', '│ ', '▌ ', '█│', '│▌', '▌█'];
  return t => {
    const k = Math.floor(t / 7), p = t % 7, [isbn, title, status] = books[k % books.length];
    const code = '▌│' + [...isbn].map(d => enc[d]).join('') + '│▌';
    const pad = ' '.repeat((W - code.length) / 2 | 0);
    const laser = p < 1.6 ? 2 + Math.round((Math.sin(t * 5) + 1) * 3) : -1;
    const L = [' isbn-scanner'.padEnd(44) + (p < 1.6 ? '<b>scanning</b>' : '<i>✓ match</i>'), ''];
    for (let r = 2; r < 9; r++) L.push(r === laser ? pad.slice(2) + '<b>' + '━'.repeat(code.length + 4) + '</b>' : pad + code);
    L.push(pad + '  ' + isbn[0] + ' ' + isbn.slice(1, 7) + ' ' + isbn.slice(7), '');
    const q = `SELECT title, status FROM book_copy\n      WHERE barcode = '${isbn}';`;
    const n = p < 1.6 ? 0 : Math.min(q.length, Math.floor((p - 1.6) / 1.8 * q.length));
    const caret = p >= 1.6 && p < 3.8 && (t * 3 | 0) % 2 ? '█' : '';
    const typed = (q.slice(0, n) + caret).split('\n');
    L.push(' <u>sql›</u> ' + (typed[0] || ''), typed[1] || '', '');
    if (p >= 3.8) {
      const st = status === 'available' ? `<i>${status.padEnd(10)}</i>` : `<b>${status.padEnd(10)}</b>`;
      L.push(' ┌' + '─'.repeat(30) + '┬' + '─'.repeat(11) + '┐',
             ' │ ' + title.padEnd(29) + '│ ' + st + '│',
             ' └' + '─'.repeat(30) + '┴' + '─'.repeat(11) + '┘',
             ' <u>1 row in set · idx_barcode · 0.4 ms</u>');
    }
    pre.innerHTML = L.join('\n');
  };
}

/* ---- Interest scenes: a tiny character grid with per-cell colour (b orange, i green, u dim) ---- */

class Grid {
  constructor(w, h) {
    this.w = w; this.h = h;
    this.ch = Array.from({ length: h }, () => Array(w).fill(' '));
    this.cl = Array.from({ length: h }, () => Array(w).fill(''));
  }
  // write a string; spaces are transparent unless `opaque`
  set(r, c, s, cls = '', opaque = false) {
    r = Math.round(r); c = Math.round(c);
    if (r < 0 || r >= this.h) return;
    for (let k = 0; k < s.length; k++) {
      const x = c + k;
      if (x < 0 || x >= this.w || (s[k] === ' ' && !opaque)) continue;
      this.ch[r][x] = s[k]; this.cl[r][x] = cls;
    }
  }
  box(r0, c0, r1, c1, cls, label = '') {
    for (let c = c0 + 1; c < c1; c++) { this.set(r0, c, '─', cls); this.set(r1, c, '─', cls); }
    for (let r = r0 + 1; r < r1; r++) { this.set(r, c0, '│', cls); this.set(r, c1, '│', cls); }
    this.set(r0, c0, '┌', cls); this.set(r0, c1, '┐', cls); this.set(r1, c0, '└', cls); this.set(r1, c1, '┘', cls);
    if (label) this.set(r0 - 1, c0, label, cls);
  }
  // straight line; the character follows its on-screen slope (a row is twice as tall as a column is wide)
  line(r0, c0, r1, c1, cls = '') {
    const dc = c1 - c0, dr = r1 - r0, n = Math.max(1, Math.ceil(Math.max(Math.abs(dc), Math.abs(dr) * 2)));
    const a = ((Math.atan2(-dr * 2, dc) * 180 / Math.PI) % 180 + 180) % 180;
    const ch = a < 22.5 || a >= 157.5 ? '-' : a < 67.5 ? '/' : a < 112.5 ? '|' : '\\';
    for (let k = 0; k <= n; k++) this.set(r0 + dr * k / n, c0 + dc * k / n, ch, cls);
  }
  html() {
    const esc = ch => ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '&' ? '&amp;' : ch;
    return this.ch.map((row, r) => {
      let out = '', cur = '', buf = '';
      const flush = () => { out += cur ? `<${cur}>${buf}</${cur}>` : buf; buf = ''; };
      for (let c = 0; c < this.w; c++) {
        if (this.cl[r][c] !== cur) { flush(); cur = this.cl[r][c]; }
        buf += esc(row[c]);
      }
      flush();
      return out;
    }).join('\n');
  }
}
const ease = p => p < .5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;

// Self-driving: perspective road, detected lanes, tracked cars, planned path
function carScene(pre) {
  const W = 96, H = 22, hz = 5, N = H - 1 - hz;
  const cxAt = (d, curve) => W / 2 + curve * ((N - d) / N) ** 2 * 16;
  const hwAt = d => d * 2.75;
  const car = (g, r, c, w, label) => {
    const c0 = Math.round(c - w / 2);
    g.set(r - 1, c0, '.' + '-'.repeat(w - 2) + '.', '', true);
    g.set(r, c0, '[' + '='.repeat(w - 2) + ']', '', true);
    g.box(r - 2, c0 - 2, r + 1, c0 + w + 1, 'i', label);
  };
  return t => {
    const g = new Grid(W, H), curve = Math.sin(t * .35) * 1.2;
    const hill = c => Math.round(1.4 + Math.sin(c * .11 + t * .05) * 1.1 + Math.sin(c * .043) * .9);
    for (let c = 0; c < W; c++) {
      const s = hill(c + 1) - hill(c - 1);
      g.set(hz - hill(c), c, s > 0 ? '/' : s < 0 ? '\\' : '_', 'u');
    }
    for (let d = 1; d <= N; d++) {
      const r = hz + d, cx = cxAt(d, curve), hw = hwAt(d), z = N / d;
      const lc = Math.round(cx - hw), rc = Math.round(cx + hw);
      for (let c = 0; c < W; c++)
        if ((c < lc || c > rc) && (c * 7 + Math.floor(z * 3 + t * 8) * 13) % 19 === 0) g.set(r, c, d > 9 ? ',' : '.', 'u');
      g.set(r, lc, '/'); g.set(r, rc, '\\');
      if ((z * 1.3 + t * 4) % 2 < 1) { g.set(r, cx - hw / 3, '/', 'i'); g.set(r, cx + hw / 3, '\\', 'i'); }
    }
    const zl = 3 + Math.sin(t * .4) * .9, dl = N / zl;
    for (let d = N - 2; d > dl + 1; d--) g.set(hz + d, cxAt(d, curve), '·', 'b');            // planned path
    const zo = 15 - (t * 3.5) % 14, dop = N / zo;                                             // oncoming, left lane
    if (dop < N - 4) car(g, hz + dop, cxAt(dop, curve) - hwAt(dop) * .74, Math.max(3, Math.round(hwAt(dop) * .38)), 'car');
    car(g, hz + dl, cxAt(dl, curve), Math.max(4, Math.round(hwAt(dl) * .5)), `car ${Math.round(zl * 7)}m`);
    g.set(H - 2, W / 2 - 22, '.' + '-'.repeat(42) + '.', 'u', true);                           // our hood
    g.set(H - 1, W / 2 - 23, '/' + ' '.repeat(44) + '\\', 'u', true);
    const st = Math.round(5 - curve * 4);
    g.set(0, 1, 'autopilot.py'); g.set(0, 17, `${62 + Math.round(Math.sin(t * .5) * 6)} km/h`);
    g.set(0, 30, 'lane keep ●', 'i'); g.set(0, 45, 'v2x: 3 peers', 'b');
    g.set(0, W - 21, 'steer [' + [...'···········'].map((ch, i) => i === st ? '|' : ch).join('') + ']', 'u');
    pre.innerHTML = g.html();
  };
}

// Drone: figure-8 waypoint flight, spinning props, camera cone, scrolling terrain
function droneScene(pre) {
  const W = 56, H = 22, trail = [];
  return t => {
    const g = new Grid(W, H);
    const x = 28 + Math.sin(t * .6) * 15, y = 6 + Math.sin(t * 1.2) * 1.6;
    const off = Math.floor(t * 6);
    for (let c = 0; c < W; c++) {
      const k = (c + off) % 13;
      if (k === 3) { g.set(18, c, '^', 'u'); g.set(19, c, '^', 'u'); g.set(20, c, '|', 'u'); }
      if (k === 8) { g.set(19, c, '^', 'u'); g.set(20, c, '|', 'u'); }
      g.set(21, c, (c + off) % 2 ? '-' : '_', 'u');
    }
    for (const [wc, name] of [[13, 'WP1'], [43, 'WP2']]) { g.set(8, wc, '◇', 'u'); g.set(9, wc - 1, name, 'u'); }
    trail.push([x, y]); if (trail.length > 45) trail.shift();
    trail.forEach(([tx, ty], i) => i % 3 || g.set(ty + 2, tx, '·', 'u'));
    const cy = Math.round(y) + 4;
    for (let r = cy; r <= 20; r++) if (r % 2 === 0) { const s = (r - cy) * .7; g.set(r, x - s, '/', 'i'); g.set(r, x + s, '\\', 'i'); }
    g.set(20, Math.round(x) - 1, '[+]', 'i');
    const sp = (t * 16 | 0) % 2 ? '-=o=-' : '=-o-=', c0 = Math.round(x) - 7, r0 = Math.round(y);
    g.set(r0, c0, sp, 'b'); g.set(r0, c0 + 10, sp, 'b');
    g.set(r0 + 1, c0 + 3, '\\ .---. /', '', true);
    g.set(r0 + 2, c0 + 4, '=| o |=', '', true); g.set(r0 + 2, c0 + 7, 'o', 'i');
    g.set(r0 + 3, c0 + 5, "'---'", '', true);
    g.set(0, 1, 'drone/flight.py'); g.set(0, 19, `alt ${((18 - y) * 1.6).toFixed(1)}m`);
    g.set(0, 31, `bat ${87 - (t / 4 | 0) % 30}%`); g.set(0, 41, 'gps 11 ●', 'i');
    g.set(1, 1, `mode AUTO · waypoint ${x > 28 ? 2 : 1}/2`, 'u');
    pre.innerHTML = g.html();
  };
}

// Robot arm: 2-link inverse kinematics doing pick-and-place
function robotScene(pre) {
  const W = 56, bc = 11, br = 17, L1 = 17, L2 = 17;
  const names = ['HOME', 'APPROACH', 'DESCEND', 'GRASP', 'LIFT', 'MOVE', 'LOWER', 'RELEASE', 'RETRACT'];
  const toGrid = (x, y) => [br - y / 2, bc + x];                     // physical units: 1 row = 2 cols
  const link = (g, [r0, c0], [r1, c1]) => {
    const dc = c1 - c0, dr = r1 - r0, a = ((Math.atan2(-dr * 2, dc) * 180 / Math.PI) % 180 + 180) % 180;
    const ch = a < 22.5 || a >= 157.5 ? '=' : a < 67.5 ? '/' : a < 112.5 ? '|' : '\\';
    const n = Math.ceil(Math.max(Math.abs(dc), Math.abs(dr) * 2)) * 2;
    for (let k = 0; k <= n; k++) {
      g.set(r0 + dr * k / n, c0 + dc * k / n, ch);
      if (ch !== '=') g.set(r0 + dr * k / n, c0 + dc * k / n + 1, ch);   // thicker steep links
    }
  };
  return t => {
    const g = new Grid(W, 22), cyc = Math.floor(t / 6.3), p = t % 6.3;
    const seg = Math.min(8, Math.floor(p / .7)), f = ease(Math.min(1, (p - seg * .7) / .7));
    const [A, B] = cyc % 2 ? [43, 29] : [29, 43], xa = A - bc, xb = B - bc;
    const K = [[8, 16, 0], [xa, 9, 0], [xa, -2, 0], [xa, -2, 1], [xa, 9, 1], [xb, 9, 1], [xb, -2, 1], [xb, -2, 0], [xb, 9, 0], [8, 16, 0]];
    const k0 = K[seg], k1 = K[seg + 1];
    const x = k0[0] + (k1[0] - k0[0]) * f, y = k0[1] + (k1[1] - k0[1]) * f;
    const d = Math.min(L1 + L2 - .01, Math.max(Math.abs(L1 - L2) + .01, Math.hypot(x, y)));
    const a2 = Math.acos((d * d - L1 * L1 - L2 * L2) / (2 * L1 * L2));
    const a1 = Math.atan2(y, x) + Math.atan2(L2 * Math.sin(a2), L1 + L2 * Math.cos(a2));   // elbow-up solution
    const ex = L1 * Math.cos(a1), ey = L1 * Math.sin(a1);
    const hx = ex + L2 * Math.cos(a1 - a2), hy = ey + L2 * Math.sin(a1 - a2);
    for (let c = 0; c < W; c++) g.set(20, c, '─', 'u');
    const held = k0[2] === 1, closed = held || (k1[2] === 1 && f > .6);
    if (!held) g.set(19, (seg <= 2 ? A : B) - 1, '###', 'b');
    const [tr, tc] = toGrid(k1[0], k1[1]);
    g.set(tr + 1, tc, '+', 'i');                                        // next target
    const shoulder = [br, bc], elbow = toGrid(ex, ey), hand = toGrid(hx, hy);
    link(g, shoulder, elbow); link(g, elbow, hand);
    const [hr, hc] = hand.map(Math.round);
    g.set(hr + 1, hc - 2, closed ? '[' : '/'); g.set(hr + 1, hc + 2, closed ? ']' : '\\');
    if (held) g.set(hr + 1, hc - 1, '###', 'b');
    g.set(...shoulder, 'O', 'b'); g.set(...elbow, 'O', 'b'); g.set(hr, hc, 'o', 'b');
    g.set(18, bc - 3, '/#####\\'); g.set(19, bc - 4, '[=======]');
    g.set(0, 1, 'arm/ik.py'); g.set(0, 14, `state ${names[seg]}`, 'b'); g.set(0, 34, `grip ${closed ? 'closed' : 'open'}`, closed ? 'i' : 'u');
    g.set(1, 1, `θ1 ${(a1 * 180 / Math.PI).toFixed(1)}°  θ2 ${(-a2 * 180 / Math.PI).toFixed(1)}°`, 'u');
    g.set(21, 1, 'workcell 01 · 2-dof · inverse kinematics', 'u');
    pre.innerHTML = g.html();
  };
}

// 3D: z-buffered, shaded torus inside a rotating 3D bounding box
function torusScene(pre) {
  const W = 56, H = 22, K2 = 8, K1 = 40, LUM = '.,-~:;=!*#$@';
  const corners = [];
  for (const x of [-3, 3]) for (const y of [-1, 1]) for (const z of [-3, 3]) corners.push([x, y, z]);
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  return t => {
    const A = t * .9, B = t * .5, cA = Math.cos(A), sA = Math.sin(A), cB = Math.cos(B), sB = Math.sin(B);
    const rot = (x, y, z) => { const y1 = y * cA - z * sA, z1 = y * sA + z * cA; return [x * cB - y1 * sB, x * sB + y1 * cB, z1]; };
    const proj = ([x, y, z]) => { const o = 1 / (z + K2); return [Math.round(H / 2 - K1 * .5 * y * o), Math.round(W / 2 + K1 * x * o), o]; };
    const g = new Grid(W, H), zb = Array.from({ length: H }, () => Array(W).fill(0));
    let pts = 0;
    for (let th = 0; th < 6.283; th += .07) {
      const ct = Math.cos(th), st = Math.sin(th), rr = 2 + ct;
      for (let ph = 0; ph < 6.283; ph += .02) {
        const cp = Math.cos(ph), sp = Math.sin(ph);
        const [r, c, o] = proj(rot(rr * cp, st, -rr * sp));
        pts++;
        if (r < 1 || r >= H - 1 || c < 0 || c >= W || o <= zb[r][c]) continue;
        zb[r][c] = o;
        const n = rot(ct * cp, st, -ct * sp), lum = (n[1] - n[2]) * .7071;
        g.ch[r][c] = LUM[Math.max(0, Math.min(11, Math.round(lum * 8)))];
      }
    }
    const P = corners.map(([x, y, z]) => proj(rot(x, y, z)));
    for (const [a, b] of edges) for (let k = 0; k <= 24; k++) {
      const r = Math.round(P[a][0] + (P[b][0] - P[a][0]) * k / 24), c = Math.round(P[a][1] + (P[b][1] - P[a][1]) * k / 24);
      if (g.ch[r] && g.ch[r][c] === ' ') g.set(r, c, '·', 'i');
    }
    P.forEach(([r, c]) => g.set(r, c, '+', 'i'));
    const deg = v => Math.round(v * 180 / Math.PI) % 360;
    g.set(0, 1, 'vision3d/render.py'); g.set(0, 33, `yaw ${deg(B)}°  pitch ${deg(A)}°`, 'u');
    g.set(H - 1, 1, `bbox3d · z-buffer · ${pts.toLocaleString('en')} pts`, 'u');
    pre.innerHTML = g.html();
  };
}

// Football: pitch, two teams, passes, tracked receiver
function footballScene(pre) {
  const W = 56, H = 22;
  const A = [[.05, .5], [.24, .28], [.24, .72], [.44, .5], [.64, .24], [.66, .76]], ids = [1, 4, 5, 8, 10, 9];
  const B = [[.95, .5], [.76, .34], [.76, .66], [.58, .5], [.4, .28], [.4, .72]];
  const order = [3, 1, 3, 4, 5, 3, 2, 3, 5, 4];
  const at = ([x, y]) => [2 + y * 17, 2 + x * 51];
  return t => {
    const g = new Grid(W, H), push = .06 * Math.sin(t * .25);
    const a = A.map(([x, y], i) => [x + (i ? push : 0) + .015 * Math.sin(t * 1.3 + i * 2), y + .03 * Math.sin(t * .9 + i)]);
    const k = Math.floor(t / 1.2), f = Math.min(1, (t % 1.2) / .8), e = 1 - (1 - f) ** 2;
    const fi = order[k % order.length], ti = order[(k + 1) % order.length], from = a[fi], to = a[ti];
    const ball = [from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e];
    const b = B.map(([x, y], i) => i ? [x + (ball[0] - x) * .22, y + (ball[1] - y) * .3] : [x, y + (ball[1] - .5) * .3]);
    for (let c = 1; c < W - 1; c++) { g.set(1, c, '─', 'u'); g.set(20, c, '─', 'u'); }
    for (let r = 2; r < 20; r++) { g.set(r, 0, '│', 'u'); g.set(r, W - 1, '│', 'u'); g.set(r, 28, '│', 'u'); }
    g.set(1, 0, '┌', 'u'); g.set(1, W - 1, '┐', 'u'); g.set(20, 0, '└', 'u'); g.set(20, W - 1, '┘', 'u');
    g.set(1, 28, '┬', 'u'); g.set(20, 28, '┴', 'u');
    for (let q = 0; q < 6.28; q += .2) g.set(10.5 + 3 * Math.sin(q), 28 + 6 * Math.cos(q), '·', 'u');
    for (const [c0, c1, cc] of [[1, 8, 8], [47, 54, 47]]) {
      for (let c = c0; c <= c1; c++) { g.set(6, c, '─', 'u'); g.set(15, c, '─', 'u'); }
      for (let r = 7; r < 15; r++) g.set(r, cc, '│', 'u');
    }
    for (let r = 9; r <= 12; r++) { g.set(r, 0, '║', 'u'); g.set(r, W - 1, '║', 'u'); }
    const [fr, fc] = at(from), [tr, tc] = at(to);
    for (let s = 0; s <= 16; s++) g.set(fr + (tr - fr) * s / 16, fc + (tc - fc) * s / 16, '·', 'b');
    b.forEach(p => g.set(...at(p), 'x'));
    a.forEach(p => g.set(...at(p), 'o', 'b'));
    const [br_, bc_] = at(ball);
    g.set(br_, bc_ + 1, '●');
    g.set(tr, tc - 2, '[', 'i'); g.set(tr, tc + 2, ']', 'i');
    g.set(tr - 1, tc - 2, `#${ids[ti]} ${(.9 + .08 * Math.sin(t)).toFixed(2)}`, 'i');
    g.set(0, 1, 'match/tracker.py'); g.set(0, 19, `poss A ${55 + Math.round(4 * Math.sin(t * .1))}%`, 'b');
    g.set(0, 33, `passes ${180 + k}`, 'u'); g.set(0, 47, `xG 0.4${k % 10}`, 'i');
    g.set(21, 1, 'o team A · x team B · ● ball · [ ] tracked', 'u');
    pre.innerHTML = g.html();
  };
}

// F1: top-down circuit, two cars battling, racing line, live telemetry + speed trace
function f1Scene(pre) {
  const W = 96, H = 22, TAU = 2 * Math.PI;
  const P = s => [48 + 37 * Math.cos(s) + 5 * Math.cos(3 * s), 23 + 14 * Math.sin(s) + 3 * Math.sin(2 * s)];  // x in cols, y in half-rows
  const D1 = s => { const a = P(s - .01), b = P(s + .01); return [(b[0] - a[0]) / .02, (b[1] - a[1]) / .02]; };
  const curv = s => {
    const [x1, y1] = D1(s), a = D1(s - .01), b = D1(s + .01), x2 = (b[0] - a[0]) / .02, y2 = (b[1] - a[1]) / .02;
    return Math.abs(x1 * y2 - y1 * x2) / Math.pow(x1 * x1 + y1 * y1, 1.5);
  };
  const speed = s => 330 - Math.min(1, curv(s) * 8) * 190;
  // the track never changes: rasterise it once
  const pts = Array.from({ length: 360 }, (_, i) => P(i / 360 * TAU)), track = [];
  for (let r = 1; r < H - 1; r++) for (let c = 0; c < W; c++) {
    let d = 1e9;
    for (const [x, y] of pts) d = Math.min(d, Math.hypot(x - c, y - r * 2));
    if (d > 2.9 && d < 4.3) track.push([r, c, '·', 'u']);
  }
  let s1 = 0, s2 = -.25, last = 0;
  const trail = [], trace = [];
  return t => {
    const dt = Math.min(.1, Math.max(0, t - last)); last = t;
    const step = s => speed(s) * .09 * dt / Math.hypot(...D1(s));
    s1 += step(s1); s2 += step(s2) * (1 + .05 * Math.sin(t * .6));
    if (s2 > s1 - .04) s2 = s1 - .04;                                     // no overtaking through the car ahead
    const g = new Grid(W, H);
    for (const [r, c, ch, cls] of track) g.set(r, c, ch, cls);
    const [sx, sy] = P(0);
    g.set(sy / 2, sx - 3, '▚▞▚▞▚▞▚');                                     // start / finish
    const [x1, y1] = P(s1), [x2, y2] = P(s2);
    trail.push([x1, y1]); if (trail.length > 26) trail.shift();
    trail.forEach(([x, y], i) => g.set(y / 2, x, i > 16 ? '•' : '·', 'b'));
    g.set(y2 / 2, x2, '█'); g.set(y2 / 2 - 1, x2 + 1, 'P2', 'u');
    g.set(y1 / 2, x1, '█', 'b'); g.set(y1 / 2 - 1, x1 + 1, 'RT', 'b');
    const v = speed(s1), lap = 12 + Math.floor(s1 / TAU), sector = 1 + Math.floor(((s1 % TAU) + TAU) % TAU / (TAU / 3));
    trace.push(v); if (trace.length > 60) trace.shift();
    g.set(0, 1, 'f1/telemetry.py'); g.set(0, 20, `LAP ${lap}/58`, 'b'); g.set(0, 33, `S${sector}`, 'u');
    g.set(0, 39, `${Math.round(v)} km/h`); g.set(0, 52, `DRS ${v > 290 ? '●' : '○'}`, v > 290 ? 'i' : 'u');
    g.set(0, 62, `gap +${((s1 - s2) / TAU * 92).toFixed(3)}s`, 'u');
    g.set(H - 1, 1, 'speed ', 'u');
    g.set(H - 1, 7, trace.map(x => ' ▁▂▃▄▅▆▇█'[Math.max(0, Math.min(8, Math.round((x - 120) / 210 * 8)))]).join(''), 'i');
    pre.innerHTML = g.html();
  };
}

// 3D design: a spinning wireframe gear with near/far shading and CAD annotations
function gearScene(pre) {
  const W = 56, H = 22, T = 12, R1 = 5, R2 = 6.4, HUB = 1.8, h = 1.1, D = 22, K = 50;
  const outline = [];
  for (let i = 0; i < T; i++) for (let j = 0; j < 4; j++) {
    const a = (i + j / 4) / T * 2 * Math.PI, r = j === 1 || j === 2 ? R2 : R1;
    outline.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  const hub = Array.from({ length: 16 }, (_, i) => [HUB * Math.cos(i / 16 * 2 * Math.PI), HUB * Math.sin(i / 16 * 2 * Math.PI)]);
  return t => {
    const spin = t * .8, yaw = .35 + .25 * Math.sin(t * .35), pitch = .35;
    const tf = ([x, y, z]) => {
      let c = Math.cos(spin), s = Math.sin(spin); [x, y] = [x * c - y * s, x * s + y * c];
      c = Math.cos(yaw); s = Math.sin(yaw); [x, z] = [x * c + z * s, -x * s + z * c];
      c = Math.cos(pitch); s = Math.sin(pitch); [y, z] = [y * c - z * s, y * s + z * c];
      const o = 1 / (z + D);
      return [H / 2 - K * .5 * y * o, W / 2 + K * x * o, z];
    };
    const face = (loop, z) => loop.map(([x, y]) => tf([x, y, z]));
    const front = face(outline, h), back = face(outline, -h), hf = face(hub, h), hb = face(hub, -h);
    const near = front[0][2] < back[0][2];
    const g = new Grid(W, H);
    const ring = (q, cls) => q.forEach((p, i) => { const n = q[(i + 1) % q.length]; g.line(p[0], p[1], n[0], n[1], cls); });
    ring(near ? back : front, 'u'); ring(near ? hb : hf, 'u');                    // far face first, dim
    front.forEach((p, i) => { if (i % 4 === 1) g.line(p[0], p[1], back[i][0], back[i][1], 'u'); });
    ring(near ? front : back, ''); ring(near ? hf : hb, 'b');                     // near face on top
    const [cr, cc] = tf([0, 0, 0]);
    g.set(cr, cc, '+', 'b');
    g.set(0, 1, 'design/gear.step'); g.set(0, 33, `${T}T · m 1.1 · Ø${(2 * R2).toFixed(1)}`, 'u');
    g.set(H - 2, 12, '|<' + '─'.repeat(10) + ' Ø 12.8 ' + '─'.repeat(10) + '>|', 'i');
    g.set(H - 1, 1, `wireframe · spin ${Math.round(spin * 57.3) % 360}°`, 'u');
    pre.innerHTML = g.html();
  };
}

const scenes = { face: faceScene, greenhouse: greenhouseScene, library: libraryScene,
  car: carScene, drone: droneScene, robot: robotScene, torus: torusScene, football: footballScene,
  f1: f1Scene, gear: gearScene };

// 3D tilt toward the cursor on interest tiles and the info card
if (!reduced && matchMedia('(hover: hover)').matches) document.querySelectorAll('.tile, .neo').forEach(el => {
  el.addEventListener('pointermove', e => {
    const r = el.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - .5, y = (e.clientY - r.top) / r.height - .5;
    el.style.transform = `perspective(1100px) rotateX(${-y * 6}deg) rotateY(${x * 8}deg) translateY(-4px)`;
  });
  el.addEventListener('pointerleave', () => { el.style.transform = ''; });
});
document.querySelectorAll('[data-scene]').forEach(el => {
  const [a, b] = el.querySelectorAll('pre');
  animate(el, 12, scenes[el.dataset.scene](a, b));
});

/* ---------------- Scroll choreography ---------------- */

// Document position ignoring transforms (we move the cards ourselves)
const docBox = el => {
  let x = 0, y = 0;
  for (let n = el; n; n = n.offsetParent) { x += n.offsetLeft; y += n.offsetTop; }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
};

// A floor-standing workshop arm carries each project in from the side, sets it in its slot,
// opens its claw and pulls back. Scroll-linked, so scrolling up takes the project away again.
document.body.insertAdjacentHTML('beforeend', `
<svg class="arm" aria-hidden="true"><g class="arm-root">
  <ellipse cx="0" cy="2" rx="96" ry="9" fill="rgb(0 0 0 / .6)"/>
  <path d="M-74 -6 L-60 -40 H60 L74 -6 Z" fill="#1a1a1e" stroke="#4a4a52" stroke-width="1.5"/>
  <path d="M-54 -22 H54" style="stroke:var(--accent)" stroke-width="4" stroke-dasharray="10 7"/>
  <circle cx="-50" cy="-6" r="9" fill="#111113" stroke="#55555c" stroke-width="2"/>
  <circle cx="0" cy="-6" r="9" fill="#111113" stroke="#55555c" stroke-width="2"/>
  <circle cx="50" cy="-6" r="9" fill="#111113" stroke="#55555c" stroke-width="2"/>
  <rect x="-38" y="-92" width="76" height="54" rx="12" fill="#202024" stroke="#5a5a62" stroke-width="1.5"/>
  <path d="M-24 -52 H24" stroke="#3a3a40" stroke-width="2"/>
  <g class="j1">
    <rect class="seg seg1" x="-22" y="-23" height="46" rx="23"/>
    <rect class="piston" x="36" y="24" height="7" rx="3.5"/>
    <path class="groove seg1-groove" d="M30 0 H0"/>
    <circle r="33" fill="#18181b" stroke="#6a6a72" stroke-width="2"/>
    <circle r="12" fill="none" style="stroke:var(--accent)" stroke-width="3"/>
    <g class="j2">
      <rect class="seg seg2" x="-16" y="-17" height="34" rx="17"/>
      <circle r="26" fill="#18181b" stroke="#6a6a72" stroke-width="2"/>
      <circle r="8" style="fill:var(--accent)"/>
      <g class="j3">
        <circle r="18" fill="#18181b" stroke="#6a6a72" stroke-width="2"/>
        <rect x="8" y="-18" width="32" height="36" rx="8" fill="#232327" stroke="#6a6a72" stroke-width="1.5"/>
        <circle class="led" cx="26" cy="-8" r="3" fill="#3ddc84"/>
        <path class="fa" d="M38 -12 L64 -23 L86 -9 L79 -3 L63 -13 L40 -4 Z" fill="#2a2a2f" stroke="#9a968f" stroke-width="1.5"/>
        <path class="fb" d="M38 12 L64 23 L86 9 L79 3 L63 13 L40 4 Z" fill="#2a2a2f" stroke="#9a968f" stroke-width="1.5"/>
      </g>
    </g>
  </g>
</g></svg><div class="arm-tag" aria-hidden="true"></div>`);
const arm = document.querySelector('.arm'), armTag = document.querySelector('.arm-tag');
const armRoot = arm.querySelector('.arm-root'), J = s => arm.querySelector(s);
const SHOULDER = 88, TIP = 66, BITE = 14;      // shoulder height above floor; wrist→fingertip; how far the claw closes over the edge
const picks = reduced ? [] : [...document.querySelectorAll('[data-pick]')].map((el, i) => {
  const n = String(i + 1).padStart(2, '0'), slot = document.createElement('div');
  slot.className = 'slot'; slot.innerHTML = `<span>SLOT ${n} · ${el.dataset.pick}</span>`;
  document.body.append(slot);
  return { el, slot, n };
});

// 2-link IK in arm-local units (x toward the card, y up), elbow-up; ex = elbow x on screen.
// S scales the whole arm drawing; L, SHOULDER, TIP are in arm units.
let S = 1;
function ik(side, baseX, floorY, L, wx, wy) {
  const X = (wx - baseX) * side / S, Y = (floorY - wy) / S - SHOULDER;
  const d = Math.min(2 * L - .5, Math.max(1, Math.hypot(X, Y)));
  const a2 = Math.acos(Math.max(-1, Math.min(1, (d * d - 2 * L * L) / (2 * L * L))));
  const a1 = Math.atan2(Y, X) + Math.atan2(L * Math.sin(a2), L + L * Math.cos(a2));
  return { a1, a2, ex: baseX + side * S * L * Math.cos(a1) };
}

function drawArm(side, baseX, floorY, L, wx, wy, open, alpha) {
  const { a1, a2 } = ik(side, baseX, floorY, L, wx, wy);
  const r1 = -a1 * 180 / Math.PI, r2 = a2 * 180 / Math.PI;
  armRoot.setAttribute('transform', `translate(${baseX} ${floorY}) scale(${side * S} ${S})`);
  J('.j1').setAttribute('transform', `translate(0 ${-SHOULDER}) rotate(${r1})`);
  J('.j2').setAttribute('transform', `translate(${L} 0) rotate(${r2})`);
  J('.j3').setAttribute('transform', `translate(${L} 0) rotate(${90 - (r1 + r2)})`);   // claw points straight down
  J('.seg1').setAttribute('width', L + 44); J('.seg2').setAttribute('width', L + 32);
  J('.piston').setAttribute('width', L * .5); J('.seg1-groove').setAttribute('d', `M34 0 H${L - 30}`);
  J('.fa').setAttribute('transform', `rotate(${-open * 26} 38 -12)`);
  J('.fb').setAttribute('transform', `rotate(${open * 26} 38 12)`);
  arm.style.opacity = alpha;
}

function placePicks() {
  const vw = root.clientWidth, vh = innerHeight, L = 250;
  S = Math.max(.8, Math.min(1.7, vh * .42 / L));                       // arm size follows the viewport
  arm.setAttribute('width', vw); arm.setAttribute('height', vh);
  let active = null;
  for (const p of picks) {
    const { el, slot } = p, b = docBox(el), top = b.y - scrollY, left = b.x - scrollX;
    const k = Math.min(1, Math.max(0, (vh * .98 - top) / (vh * .85)));  // 0 = just below the fold, 1 = placed
    const side = left + b.w / 2 > vw / 2 ? -1 : 1;                        // arm comes from the nearer side
    const carry = ease(Math.min(1, k / .55)), off = 1 - carry;
    const dx = -side * 260 * off, dy = 120 * off;
    const g = Math.min(150, b.w * .25);                                   // grip point: top edge, near the arm's corner
    el.style.transformOrigin = `${side > 0 ? g : b.w - g}px 0px`;
    el.style.transform = k < 1 ? `translate(${dx}px, ${dy}px) rotate(${-side * 5 * off}deg)` : '';
    el.style.transition = k < 1 ? 'none' : '';
    el.style.opacity = Math.min(1, k * 4);
    el.style.setProperty('--lift', off);
    const show = k > 0 && k < 1;
    slot.style.display = show ? 'block' : 'none';
    if (show) {
      slot.style.transform = `translate(${left}px, ${top}px)`;
      slot.style.width = b.w + 'px'; slot.style.height = b.h + 'px';
      slot.style.opacity = off;
      if (!active) active = { p, k, side, left, top, b, dx, dy, g };
    }
  }
  if (!active) { arm.style.display = armTag.style.display = 'none'; return; }
  const { p, k, side, left, top, b, dx, dy, g } = active;
  const open = Math.min(1, Math.max(0, (k - .55) / .15)), back = ease(Math.max(0, (k - .7) / .3));
  let baseX = side > 0 ? Math.max(90 * S, left - 30) : Math.min(vw - 90 * S, left + b.w + 30);
  const floorY = vh - 6;
  let wx = (side > 0 ? left + g : left + b.w - g) + dx;                 // claw above the grip point,
  let wy = top + dy - (TIP - BITE) * S;                                 // fingertips closing over the top edge
  const restX = baseX + side * L * S * .5, restY = floorY - (SHOULDER + L * 1.4) * S;
  wx += (restX - wx) * back; wy += (restY - wy) * back;
  for (let i = 0; i < 4; i++) {                                         // roll the base inward until the elbow is on screen
    const ex = ik(side, baseX, floorY, L, wx, wy).ex, miss = side > 0 ? 40 - ex : ex - (vw - 40);
    if (miss <= 0) break;
    baseX += side * miss;
  }
  const alpha = Math.min(1, Math.max(0, (k - .12) / .1)) * (1 - Math.max(0, (back - .6) / .4));
  arm.style.display = armTag.style.display = 'block';
  drawArm(side, baseX, floorY, L, wx, wy, open, alpha);
  armTag.textContent = `ARM-01 · PICK ${p.n} → ${p.el.dataset.pick} · ${open < .05 ? 'carry' : back > 0 ? 'retract' : 'release'}`;
  armTag.style.transform = `translate(${side > 0 ? baseX - 70 * S : baseX + 70 * S - armTag.offsetWidth}px, ${floorY - 132 * S}px)`;
  armTag.style.opacity = alpha;
}

// F1 car: a track weaves down the page margins and swerves across between sections;
// the car drives along it as you scroll, lighting the track behind it.
const CAR = `<svg viewBox="-40 -125 80 250" aria-hidden="true">
  <defs><linearGradient id="cone" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#3ddc84" stop-opacity=".35"/><stop offset="1" stop-color="#3ddc84" stop-opacity="0"/></linearGradient></defs>
  <path class="lidar" d="M0 -36 L-30 -118 Q0 -128 30 -118 Z" fill="url(#cone)"/>
  <path d="M-12 -35h24v5h-24z" style="fill:var(--accent)"/>
  <rect x="-16" y="-28" width="7" height="13" rx="2" fill="#0d0d0f" stroke="#44444a"/>
  <rect x="9" y="-28" width="7" height="13" rx="2" fill="#0d0d0f" stroke="#44444a"/>
  <path d="M-2.5 -33 L2.5 -33 L4 -16 Q10 -10 10 2 L9 22 L-9 22 L-10 2 Q-10 -10 -4 -16 Z" fill="#f2efe9"/>
  <path d="M-1.2 -31 L1.2 -31 L1.8 21 L-1.8 21 Z" style="fill:var(--accent)"/>
  <ellipse cx="0" cy="-4" rx="3.8" ry="6.5" fill="#0b0b0c"/>
  <path d="M-4.5 -8 Q0 -15 4.5 -8" stroke="#6a6a72" stroke-width="1.6" fill="none"/>
  <rect x="-17" y="9" width="8" height="15" rx="2" fill="#0d0d0f" stroke="#44444a"/>
  <rect x="9" y="9" width="8" height="15" rx="2" fill="#0d0d0f" stroke="#44444a"/>
  <path d="M-13 24h26v6h-26z" style="fill:var(--accent)"/><path d="M-13 26h26" stroke="#0b0b0c"/>
</svg><span></span>`;
document.body.insertAdjacentHTML('beforeend', `<svg class="racetrack" aria-hidden="true"></svg><div class="f1" aria-hidden="true">${CAR}</div>`);
const trackSvg = document.querySelector('.racetrack'), car = document.querySelector('.f1');
const carBody = car.querySelector('svg'), carLabel = car.querySelector('span');
const SECTORS = ['#work', '#interests', '#about', '#contact'];
let lap = null;   // { pts: [{l, x, y}], total, done, secs } or null when hidden

function buildTrack() {
  const vw = root.clientWidth;
  trackSvg.style.height = '0';
  if (reduced || vw < 1280) { trackSvg.style.display = car.style.display = 'none'; lap = null; return; }
  const docH = root.scrollHeight, gut = ((vw - 1180) / 2 + 24) / 2, Lx = gut, Rx = vw - gut;
  const secs = SECTORS.map(s => docBox(document.querySelector(s)).y);
  let d = `M${Rx} 150`, kerbs = '', boards = '';
  secs.forEach((y, i) => {
    const from = i % 2 ? Lx : Rx, to = i % 2 ? Rx : Lx, y0 = y + 12, y1 = y + 108;
    const curve = `C${from} ${y0 + 60} ${to} ${y1 - 60} ${to} ${y1}`;
    d += ` L${from} ${y0} ${curve}`;
    kerbs += `M${from} ${y0} ${curve} `;
    const toward = to > from ? 1 : -1;     // sector board sits beside the track, on the inside of the bend
    boards += `<text x="${from + toward * 48}" y="${y0 - 6}" text-anchor="${toward > 0 ? 'start' : 'end'}">S${i + 1} · ${SECTORS[i].slice(1).toUpperCase()}</text>`;
  });
  const endY = docH - 130;
  d += ` L${Rx} ${endY}`;
  const flag = (x, y) => Array.from({ length: 8 }, (_, i) => `<rect x="${x - 16 + (i % 4) * 8}" y="${y + (i > 3 ? 4 : 0)}" width="8" height="4" fill="${(i + (i > 3)) % 2 ? '#f2efe9' : '#0b0b0c'}"/>`).join('');
  trackSvg.setAttribute('width', vw); trackSvg.setAttribute('height', docH);
  trackSvg.style.height = docH + 'px';
  trackSvg.innerHTML = `
    <path class="t-edge" d="${d}"/><path class="t-kerb-w" d="${kerbs}"/><path class="t-kerb" d="${kerbs}"/>
    <path class="t-asphalt" d="${d}"/><path class="t-center" d="${d}"/><path class="t-done" d="${d}"/>
    ${flag(Rx, 172)}<text x="${Rx}" y="196" text-anchor="middle">START</text>
    ${flag(Rx, endY - 22)}<text x="${Rx}" y="${endY + 8}" text-anchor="middle">FINISH</text>${boards}`;
  const path = trackSvg.querySelector('.t-asphalt'), total = path.getTotalLength(), pts = [];
  for (let l = 0; l <= total; l += 4) { const p = path.getPointAtLength(l); pts.push({ l, x: p.x, y: p.y }); }
  trackSvg.style.display = car.style.display = 'block';
  lap = { pts, total, done: trackSvg.querySelector('.t-done'), secs };
  driveCar();
}

let lastL = 0, lastT = 0, kmh = 0, idle;
function driveCar() {
  if (!lap) return;
  const { pts, total, done, secs } = lap, vh = innerHeight;
  const frac = scrollY / Math.max(1, root.scrollHeight - vh);
  const target = scrollY + vh * (.55 + .3 * frac);                    // reaches the finish at the bottom
  let lo = 0, hi = pts.length - 1;                                     // y only grows along the track
  while (lo < hi) { const m = (lo + hi) >> 1; pts[m].y < target ? lo = m + 1 : hi = m; }
  const p = pts[lo], a = pts[Math.max(0, lo - 3)], b = pts[Math.min(pts.length - 1, lo + 3)];
  const ang = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI + 90;
  car.style.transform = `translate(${p.x}px, ${p.y}px)`;
  carBody.style.transform = `rotate(${ang}deg)`;
  done.style.strokeDasharray = `${p.l} ${total}`;
  const now = performance.now(), v = Math.abs(p.l - lastL) / Math.max(16, now - lastT) * 1000;
  kmh += (Math.min(352, v * .45) - kmh) * .35; lastL = p.l; lastT = now;
  const sector = secs.filter(y => p.y > y).length;
  carLabel.textContent = `${sector ? 'S' + sector : 'GRID'} · ${Math.round(kmh)} km/h`;
  clearTimeout(idle);
  idle = setTimeout(() => { kmh = 0; carLabel.textContent = `${sector ? 'S' + sector : 'GRID'} · 0 km/h`; }, 300);
}
new ResizeObserver(() => buildTrack()).observe(document.body);

// Football: the ball is kicked into the goal as the contact section arrives
const goalScene = document.querySelector('.goal-scene');
const ball = goalScene.querySelector('.ball'), net = goalScene.querySelector('.net'), goalEl = goalScene.querySelector('.goal');
function kick() {
  const sec = goalScene.parentElement, r = sec.getBoundingClientRect(), vh = innerHeight;
  const p = reduced ? 1 : Math.min(1, Math.max(0, (vh * .95 - r.top) / (vh * .55)));
  const W = sec.clientWidth, H = sec.clientHeight, gb = goalEl.getBoundingClientRect();
  const ex = gb.left - r.left + gb.width * .5, ey = gb.top - r.top + gb.height * .55;
  const sx = W * .1, sy = H * .85, f = Math.min(1, p / .8), e = 1 - (1 - f) ** 2;
  const x = sx + (ex - sx) * e, y = sy + (ey - sy) * e - Math.sin(Math.PI * f) * H * .3;
  ball.style.transform = `translate(${x - 17}px, ${y - 17}px) rotate(${p * 900}deg) scale(${1 - .4 * e})`;
  const bulge = Math.max(0, (p - .8) / .2);
  net.style.transform = `scale(${1 + bulge * .08}, ${1 + bulge * .05})`;
  goalScene.classList.toggle('scored', p > .86);
}

let queued = false;
const onScroll = () => {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; placePicks(); driveCar(); kick(); });
};
addEventListener('scroll', onScroll, { passive: true });
addEventListener('resize', onScroll);
onScroll();

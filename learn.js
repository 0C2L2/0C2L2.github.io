// Learn (owner only): dated learning roadmaps on their own page — AI/ML + forward-deployed (roadmap.js) and Korean → TOPIK II level 5 (roadmap-ko.js).
// Each file pushes {id, title, proj, daily, tracks, lib, count, exams, units, lessons} onto window.ROADMAPS (generated, every link checked).
// Progress → roadmap_progress (lesson ids are unique across roadmaps); time → focus_sessions with project "<proj> · U#", so the planner's hour analytics include it.
// Strict: a day only counts for the streak when all its lessons were done on (or before) that day; late work earns half XP.
(() => {
  const A = window.App, RMS = window.ROADMAPS || [];
  if (!A || document.body.dataset.page !== 'learn' || !RMS.length) return;
  const { sb, esc, toast, barChart } = A;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const store = {
    get: (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const dayStart = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const todayStr = () => ymd(new Date());
  const fmt = (d, o) => d.toLocaleDateString('en', o);
  const short = d => fmt(parseYmd(d), { month: 'short', day: 'numeric' });
  const dur = m => m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`;
  const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const relDay = s => {
    const n = Math.round((parseYmd(s) - dayStart(new Date())) / 864e5);
    return n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : n === -1 ? 'Yesterday' : n < 0 ? `${-n}d overdue` : n < 7 ? fmt(parseYmd(s), { weekday: 'long' }) : short(s);
  };
  const tile = (k, v, s, cls = '') => `<div class="stat-tile ${cls}"><span class="stat-k">${k}</span><b>${v}</b><span class="stat-s">${s}</span></div>`;
  const sumMin = list => list.reduce((a, s) => a + s.minutes, 0);
  const rmMin = L => L.reduce((a, l) => a + l.m, 0);

  // ───────── data
  const all = {};   // lesson id → { l, R } across every roadmap (the timer can belong to another one)
  for (const R of RMS) for (const l of R.lessons) all[l.i] = { l, R };
  const params = new URLSearchParams(location.search);
  let RM, byDay, byId, kind;
  function use(id) {
    RM = RMS.find(R => R.id === id) || RMS[0]; store.set('rm-track', RM.id);
    byDay = {}; byId = {};
    for (const l of RM.lessons) { (byDay[l.d] ||= []).push(l); byId[l.i] = l; }
    kind = RM.lib[0][0];
  }
  use(params.get('r') || store.get('rm-track', 'ai'));
  let prog = new Map(), sessions = [], hasRm = false, hasTime = false, hasRemind = false, tags = new Set();
  let day = params.get('day'), open = null, shown = 0;
  let mode = store.get('rm-mode', 'path'), q = '';
  if (!byDay[day]) day = null;
  const KIND = { video: 'Video', paper: 'Paper', course: 'Course', read: 'Reading', practice: 'Practice', dsa: 'DSA', project: 'Project', review: 'Review',
    grammar: 'Grammar', writing: 'Writing', mock: 'Past paper', exam: 'TOPIK', vocab: 'Vocab' };
  const STATE = { perfect: 'Done on time', late: 'Done late', missed: 'Missed', today: 'Due today', locked: 'Upcoming' };
  const LEVEL = 600;   // XP per level (≈ 5 study days)
  const unitOf = n => RM.units[n - 1];
  const onTime = l => prog.has(l.i) && ymd(new Date(prog.get(l.i).done_at)) <= l.d;
  const xpOf = l => !prog.has(l.i) ? 0 : onTime(l) ? l.m : Math.round(l.m / 2);
  function dayState(d) {
    const L = byDay[d];
    if (!L) return 'none';
    if (L.every(onTime)) return 'perfect';
    if (L.every(l => prog.has(l.i))) return 'late';
    const t = todayStr();
    return d < t ? 'missed' : d === t ? 'today' : 'locked';
  }
  function streak() {
    let d = dayStart(new Date()), n = 0;
    if (dayState(ymd(d)) !== 'perfect') d = addDays(d, -1);   // today still open → count from yesterday
    while (dayState(ymd(d)) === 'perfect') { n++; d = addDays(d, -1); }
    return n;
  }
  const behind = () => RM.lessons.filter(l => l.d < todayStr() && !prog.has(l.i));

  async function load() {
    const [rp, ss, tk] = await Promise.all([
      sb.from('roadmap_progress').select('*'),
      sb.from('focus_sessions').select('*').like('project', '% · U%').order('started_at'),
      sb.from('tasks').select('id,tags').eq('kind', 'event')]);
    hasRm = !rp.error; prog = new Map((rp.data || []).map(p => [p.lesson_id, p]));
    hasTime = !ss.error; sessions = ss.data || [];
    tags = new Set((tk.data || []).flatMap(t => t.tags || []));
    hasRemind = !(await sb.from('tasks').select('remind_min').limit(1)).error;
  }

  // ───────── lesson timer (stopwatch per lesson; survives reloads and closing the tab)
  const TM = { id: null, since: null, acc: 0, ...store.get('rm-timer', {}) };   // since = running since (ms), null = paused
  const saveTM = () => store.set('rm-timer', TM);
  const elapsed = () => TM.acc + (TM.since ? Date.now() - TM.since : 0);
  const clock = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${s >= 3600 ? Math.floor(s / 3600) + ':' : ''}${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`; };
  const projOf = l => `${all[l.i].R.proj} · U${l.u}`;
  const mySessions = () => sessions.filter(s => (s.project || '').startsWith(`${RM.proj} · U`));
  async function logTime(l, minutes, source) {
    if (!hasTime) return false;
    const end = new Date(), row = { label: l.t, project: projOf(l), started_at: new Date(+end - minutes * 6e4).toISOString(), ended_at: end.toISOString(), minutes, source };
    const { data, error } = await sb.from('focus_sessions').insert(row).select().single();
    if (error) { toast(`Time not saved: ${error.message}`); return false; }
    sessions.push(data); return true;
  }
  async function stopTimer() {   // logs the tracked time (whole minutes), returns minutes logged
    const l = all[TM.id]?.l, m = Math.round(elapsed() / 6e4);
    Object.assign(TM, { id: null, since: null, acc: 0 }); saveTM();
    return l && m >= 1 && await logTime(l, m, 'timer') ? m : 0;
  }
  async function track(id) {
    if (TM.id === id) { if (TM.since) { TM.acc = elapsed(); TM.since = null; } else TM.since = Date.now(); saveTM(); return render(); }
    if (TM.id) { const m = await stopTimer(); if (m) toast(`Logged ${dur(m)} on the previous lesson`); }
    Object.assign(TM, { id, since: Date.now(), acc: 0 }); saveTM(); render();
  }
  function tick() {
    const mini = $('#rm-mini'), on = !!TM.id;
    if (!mini) return;
    mini.hidden = !on;
    if (on) mini.innerHTML = `<i class="${TM.since ? 'on' : ''}"></i>${clock(elapsed())} <span>${esc((all[TM.id]?.l.t || '').slice(0, 28))}</span>`;
    document.title = on ? `${clock(elapsed())} · Learn` : 'Learn — Rashid Tagaev';
  }

  // ───────── views
  function row(l, withDate = false) {
    const done = prog.has(l.i), late = !done && l.d < todayStr(), mine = TM.id === l.i;
    return `<div class="rm-row${done ? ' done' : ''}${late ? ' late' : ''}">
      <button type="button" class="rm-tick" data-done="${l.i}" aria-pressed="${done}" aria-label="${done ? 'Mark not done' : 'Mark done'}: ${esc(l.t)}"${hasRm ? '' : ' disabled'}></button>
      <div class="rm-main">
        ${l.l ? `<a href="${esc(l.l)}" target="_blank" rel="noopener">${esc(l.t)}</a>` : `<b>${esc(l.t)}</b>`}
        <span class="t-meta"><span class="rm-kind k-${l.k}">${KIND[l.k]}</span><span>${dur(l.m)}</span>${withDate || late ? `<span class="${late ? 'rm-due' : ''}">${relDay(l.d)}</span>` : ''}<span>U${l.u}</span>${done && !onTime(l) ? '<span>late · half XP</span>' : ''}</span>
        ${done ? `<input class="rm-note" data-note="${l.i}" value="${esc(prog.get(l.i).note || '')}" placeholder="One takeaway (optional)" aria-label="Takeaway" maxlength="2000" autocomplete="off">` : ''}
      </div>
      ${done ? `<span class="rm-xp">+${xpOf(l)} XP</span>` : `<button type="button" class="t-play${mine ? ' on' : ''}" data-track="${l.i}" title="${mine && TM.since ? 'Pause' : 'Track time on this'}" aria-label="Track time: ${esc(l.t)}">${mine && TM.since ? '❚❚' : '▶'}</button>`}
    </div>`;
  }
  function render() {
    const t = todayStr(), sel = day || (t < RM.start ? RM.start : t > RM.end ? RM.end : t);
    const xp = RM.lessons.reduce((a, l) => a + xpOf(l), 0), lvl = Math.floor(xp / LEVEL) + 1, into = xp % LEVEL;
    const L = byDay[t] || [], late = behind(), waitD = Math.round((parseYmd(RM.start) - dayStart(new Date())) / 864e5);
    $('#rm-date').textContent = fmt(new Date(), { weekday: 'long', month: 'long', day: 'numeric' });
    const exam = (RM.exams || []).find(([, d]) => d >= t);
    $('#rm-view').innerHTML = `${RMS.length > 1 ? `<div class="chips rm-tracks" role="group" aria-label="Roadmap">${RMS.map(R => `<button type="button" data-rm="${R.id}" aria-pressed="${R.id === RM.id}">${esc(R.title)}</button>`).join('')}</div>` : ''}
      <div class="toolbar rm-bar"><div class="chips">${[['path', 'Path'], ['library', 'Library'], ['progress', 'Progress']].map(([m, l]) => `<button type="button" data-mode="${m}" aria-pressed="${mode === m}">${l}</button>`).join('')}</div>
        ${exam ? `<span class="rm-exam">${esc(exam[0])} · ${fmt(parseYmd(exam[1]), { weekday: 'short', month: 'short', day: 'numeric' })} · <b>${Math.round((parseYmd(exam[1]) - dayStart(new Date())) / 864e5)} days</b></span>` : ''}
        ${tags.has(RM.tag) ? '<a class="btn btn-sm ghost" href="/planner">Study block is in your calendar</a>' : `<button type="button" class="btn btn-sm ghost" data-block>+ Daily ${dur(RM.daily)} block in calendar</button>`}</div>
      <div class="stats-row pl-stats">
        ${tile('Streak', `${streak()}d`, 'perfect days in a row')}
        <div class="stat-tile"><span class="stat-k">Level ${lvl}</span><b>${xp.toLocaleString('en')} XP</b><span class="stat-s">${LEVEL - into} XP to level ${lvl + 1}</span><i class="goal-bar" style="--p:${(100 * into / LEVEL).toFixed(1)}%"></i></div>
        ${waitD > 0 ? tile('Starts in', `${waitD}d`, fmt(parseYmd(RM.start), { weekday: 'short', month: 'short', day: 'numeric' })) : tile('Today', `${L.filter(l => prog.has(l.i)).length}/${L.length}`, `${dur(rmMin(L))} planned`)}
        ${tile('Behind', late.length, late.length ? `${dur(rmMin(late))} to catch up` : 'on schedule', late.length ? 'hot' : '')}
      </div>
      ${hasRm ? '' : '<p class="notice">Run <code>supabase/roadmap.sql</code> once in Supabase → SQL Editor, then reload, to save progress.</p>'}
      ${mode === 'library' ? vLibrary() : mode === 'progress' ? vProgress() : vPath(sel, late)}`;
    tick();
  }
  function vPath(sel, late) {
    const L = byDay[sel], u = unitOf(L[0].u), st = dayState(sel);
    shown = open ?? u.n;
    const card = `<section class="pl-card rm-day"><div class="card-h"><h3>${sel === todayStr() ? 'Today' : fmt(parseYmd(sel), { weekday: 'long', month: 'short', day: 'numeric' })} · Unit ${u.n}</h3><span class="rm-state s-${st}">${STATE[st]}</span></div>
      <p class="meta">${esc(u.t)}: ${esc(u.g)}</p>${L.map(l => row(l)).join('')}
      <p class="meta rm-sum">${dur(rmMin(L))} planned · up to ${rmMin(L)} XP</p></section>`;
    const over = late.length ? `<section class="pl-card"><div class="card-h"><h3>Overdue · clear these first</h3><span class="rm-due">${late.length}</span></div>
      ${late.slice(0, 6).map(l => row(l, true)).join('')}${late.length > 6 ? `<p class="meta">+ ${late.length - 6} more on earlier days (red on the path).</p>` : ''}</section>` : '';
    const units = RM.units.map(x => {
      const ls = RM.lessons.filter(l => l.u === x.n), dn = ls.filter(l => prog.has(l.i)).length, isOpen = x.n === shown;
      const days = isOpen ? Object.keys(byDay).filter(d => d >= x.s && d <= x.e) : [];
      return `<section class="rm-unit${isOpen ? ' open' : ''}${sel >= x.s && sel <= x.e ? ' cur' : ''}">
        <button type="button" class="rm-uhead" data-unit="${x.n}" aria-expanded="${isOpen}"><span class="rm-un">${x.n}</span><span class="rm-ut"><b>${esc(x.t)}</b><span class="t-meta"><span>${esc(RM.tracks[x.tr] || x.tr)}</span><span>${short(x.s)} – ${short(x.e)}</span><span>${dn}/${ls.length}</span></span></span><i class="rm-ubar" style="--p:${(100 * dn / ls.length).toFixed(1)}%"></i></button>
        ${isOpen ? `<p class="meta rm-goal">${esc(x.g)} Project: <b>${esc(x.p)}</b>.</p><div class="rm-nodes">${days.map((d, k) => {
          const s = dayState(d), dow = parseYmd(d).getDay();
          return `<button type="button" class="rm-node s-${s}${d === sel ? ' sel' : ''}" style="--x:${Math.round(Math.sin(k * .8) * 56)}px" data-day="${d}" aria-label="${fmt(parseYmd(d), { weekday: 'long', month: 'short', day: 'numeric' })}: ${STATE[s].toLowerCase()}" title="${fmt(parseYmd(d), { weekday: 'short', month: 'short', day: 'numeric' })} · ${STATE[s]}${dow === 6 || dow === 0 ? ' · project day' : ''}">${s === 'perfect' || s === 'late' ? '✓' : s === 'missed' ? '!' : dow === 6 ? '★' : parseYmd(d).getDate()}</button>`;
        }).join('')}</div>` : ''}</section>`;
    }).join('');
    return `<div class="rm-wrap"><div class="pl-col">${card}${over}</div><div class="rm-path">${units}</div></div>`;
  }
  function vLibrary() {
    const s = q.trim().toLowerCase(), study = RM.lib.map(x => x[0]);
    const list = RM.lessons.filter(l => (kind === 'all' ? study.includes(l.k) : l.k === kind) && (!s || l.t.toLowerCase().includes(s)));
    return `<section class="pl-card"><div class="task-bar"><div class="chips">${[...RM.lib, ['all', 'All']].map(([k, l]) => `<button type="button" data-kind="${k}" aria-pressed="${kind === k}">${l}</button>`).join('')}</div>
        <input data-q value="${esc(q)}" placeholder="Search the roadmap…" aria-label="Search the roadmap" autocomplete="off"></div>
      <p class="meta">${list.filter(l => prog.has(l.i)).length} of ${list.length} done</p>
      ${RM.units.map(u => { const ls = list.filter(l => l.u === u.n); return ls.length ? `<p class="grp">Unit ${u.n} · ${esc(u.t)}</p>${ls.map(l => row(l, true)).join('')}` : ''; }).join('') || '<p class="meta">Nothing matches.</p>'}</section>`;
  }
  function vProgress() {
    const t = todayStr(), due = RM.lessons.filter(l => l.d <= t), done = RM.lessons.filter(l => prog.has(l.i));
    const counted = RM.lessons.filter(l => l.k === RM.count[0]), w0 = parseYmd(RM.start), sessions = mySessions();
    const nw = Math.max(1, Math.min(RM.weeks, Math.floor((dayStart(new Date()) - w0) / 6048e5) + 1));
    const weekRows = Array.from({ length: nw }, (_, k) => {
      const s = ymd(addDays(w0, 7 * k)), e = ymd(addDays(w0, 7 * k + 6)), ls = RM.lessons.filter(l => l.d >= s && l.d <= e);
      return { label: `W${k + 1}`, tip: `Week ${k + 1} (${short(s)} – ${short(e)})`, v: ls.reduce((a, l) => a + xpOf(l), 0) };
    });
    const byU = RM.units.map(u => [u, sumMin(sessions.filter(s => s.project === `${RM.proj} · U${u.n}`))]).filter(x => x[1]), uMax = Math.max(1, ...byU.map(x => x[1]));
    const notes = done.filter(l => prog.get(l.i).note).sort((a, b) => prog.get(b.i).done_at.localeCompare(prog.get(a.i).done_at)).slice(0, 30);
    return `<div class="stats-row pl-stats">
        ${tile('Completed', `${Math.round(100 * done.length / RM.lessons.length)}%`, `${done.length} of ${RM.lessons.length} lessons`)}
        ${tile('On time', due.length ? `${Math.round(100 * due.filter(onTime).length / due.length)}%` : '–', 'of lessons due so far')}
        ${tile('Hours studied', dur(sumMin(sessions)), 'tracked on roadmap lessons')}
        ${tile(RM.count[1], `${counted.filter(l => prog.has(l.i)).length}/${counted.length}`, RM.count[2])}
      </div>
      <div class="pl-charts">
        <section class="pl-card wide"><h3>XP per week</h3>${barChart(weekRows, ' XP', Math.round(rmMin(RM.lessons) / RM.weeks), 1240)}</section>
        <section class="pl-card"><h3>Time by unit</h3>${byU.length ? byU.map(([u, m]) => `<div class="hbar"><span>U${u.n} ${esc(u.t)}</span><i style="--w:${(100 * m / uMax).toFixed(1)}%"></i><b>${dur(m)}</b></div>`).join('') : '<p class="meta">Press ▶ on a lesson to track time against its unit.</p>'}</section>
        <section class="pl-card"><h3>Progress by track</h3>${Object.entries(RM.tracks).map(([k, name]) => {
          const ls = RM.lessons.filter(l => unitOf(l.u).tr === k), d = ls.filter(l => prog.has(l.i)).length;
          return `<div class="hbar"><span>${name}</span><i style="--w:${(100 * d / ls.length).toFixed(1)}%"></i><b>${d}/${ls.length}</b></div>`;
        }).join('')}</section>
        <section class="pl-card wide"><h3>Takeaways</h3>${notes.length ? notes.map(l => `<div class="dl-row"><span>${esc(prog.get(l.i).note)}</span><b>${esc(l.t.slice(0, 44))}</b></div>`).join('') : '<p class="meta">Finished lessons get a one-line takeaway box. Your notes collect here.</p>'}</section>
      </div>`;
  }

  // ───────── actions
  async function toggle(id) {
    const l = all[id].l;
    if (prog.has(id)) {
      const { error } = await sb.from('roadmap_progress').delete().eq('lesson_id', id);
      if (error) return toast(error.message);
      prog.delete(id); toast('Marked not done'); return render();
    }
    let logged = '';
    if (TM.id === id) { const m = await stopTimer(); if (m) logged = ` · logged ${dur(m)}`; }
    else if (!sessions.some(s => s.label === l.t && ymd(new Date(s.started_at)) === todayStr()) && await logTime(l, l.m, 'manual')) logged = ` · logged ${dur(l.m)} (planned)`;
    const { data, error } = await sb.from('roadmap_progress').insert({ lesson_id: id }).select().single();
    if (error) return toast(error.message);
    prog.set(id, data);
    const left = (byDay[l.d] || []).filter(x => !prog.has(x.i)).length, s = dayState(l.d);
    toast(left ? `+${xpOf(l)} XP${logged} · ${left} more to finish the day` : s === 'perfect' ? `Day complete · ${streak()}-day streak${logged}` : `+${xpOf(l)} XP · day complete (late)${logged}`);
    render();
  }
  async function saveNote(id, note) {
    const { data, error } = await sb.from('roadmap_progress').update({ note: note || null }).eq('lesson_id', id).select().single();
    if (error) return toast(error.message);
    prog.set(id, data); toast('Takeaway saved');
  }
  async function addBlock() {
    const at = (prompt(`Daily ${dur(RM.daily)} ${RM.short} block in your planner calendar. Start time (HH:MM):`, RM.id === 'ko' ? '18:00' : '20:00') || '').trim();
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(at)) return at && toast('Use a time like 20:00');
    const first = todayStr() > RM.start ? todayStr() : RM.start, start = new Date(`${first}T${at.padStart(5, '0')}`), end = new Date(+start + RM.daily * 6e4);
    const row = { kind: 'event', title: `Study · ${RM.short}`, status: 'todo', priority: 2, start_at: start.toISOString(), end_at: end.toISOString(), repeat: 'daily', repeat_until: RM.end, tags: [RM.tag], notes: `The day’s lessons are on /learn?r=${RM.id}.` };
    if (hasRemind) {   // next occurrence that is still ahead, 10 minutes before
      let base = new Date(start);
      while (+base - 6e5 < Date.now()) base.setDate(base.getDate() + 1);
      Object.assign(row, { remind_min: 10, remind_at: new Date(+base - 6e5).toISOString() });
    }
    const { error } = await sb.from('tasks').insert(row);
    if (error) return toast(error.message);
    tags.add(RM.tag); toast(`Added to your calendar: every day ${at}–${hm(end)}${hasRemind ? ', reminder 10 min before' : ''}`); render();
  }

  function wire() {
    const r = $('#rm-view');
    r.addEventListener('click', async e => {
      const el = e.target.closest('button');
      if (!el) return;
      const d = el.dataset;
      if (d.rm) { use(d.rm); day = null; open = null; q = ''; history.replaceState(null, '', `?r=${RM.id}`); return render(); }
      if (d.mode) { mode = d.mode; store.set('rm-mode', mode); return render(); }
      if (d.day) { day = d.day; open = null; history.replaceState(null, '', `?r=${RM.id}&day=${d.day}`); return render(); }
      if (d.unit) { open = shown === +d.unit ? 0 : +d.unit; return render(); }
      if (d.kind) { kind = d.kind; return render(); }
      if (d.done) { el.disabled = true; return toggle(d.done).finally(() => { el.disabled = false; }); }
      if (d.track) return track(d.track);
      if ('block' in d) return addBlock();
    });
    r.addEventListener('change', e => { if (e.target.dataset.note) saveNote(e.target.dataset.note, e.target.value.trim()); });
    r.addEventListener('input', e => {
      if (!('q' in e.target.dataset)) return;
      q = e.target.value; render();
      const i = $('[data-q]'); i.focus(); i.setSelectionRange(q.length, q.length);
    });
    r.addEventListener('mousemove', e => {   // chart hover tips
      const g = e.target.closest?.('.chart [data-tip]'), chart = e.target.closest?.('.chart');
      $$('.chart .tip', r).forEach(t => { if (!g || !chart || !chart.contains(t)) t.hidden = true; });
      $$('.chart .hl', r).forEach(b => { if (b !== g) b.classList.remove('hl'); });
      if (!g || !chart) return;
      const tip = chart.querySelector('.tip'), box = chart.getBoundingClientRect();
      g.classList.add('hl'); tip.hidden = false; tip.textContent = g.dataset.tip;
      tip.style.left = `${Math.min(box.width - tip.offsetWidth, Math.max(0, e.clientX - box.left - tip.offsetWidth / 2))}px`;
      tip.style.top = `${Math.max(0, e.clientY - box.top - 44)}px`;
    });
    $('#rm-mini').addEventListener('click', () => TM.id && track(TM.id));   // pause / resume
    setInterval(tick, 500);
  }

  async function start() {
    $('#rm-gate').hidden = true; $('#learn').hidden = false;
    $('#rm-view').innerHTML = '<p class="meta">Loading…</p>';
    try { await load(); } catch (e) { $('#rm-view').innerHTML = `<p class="notice error">${esc(e.message || e)}</p>`; return; }
    wire(); render();
  }
  sb.auth.getSession().then(({ data }) => {
    if (data.session) start();
    else { $('#rm-gate').hidden = false; $('#learn').hidden = true; }
  });
})();

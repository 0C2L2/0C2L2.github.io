// Planner (owner only): today, calendar (month / week / day), tasks (list + board), notes, focus timer, analytics.
// Data lives in Supabase tables from supabase/planner.sql; app.js shares { sb, esc, md, toast } via window.App.
(() => {
  const A = window.App;
  if (!A || document.body.dataset.page !== 'planner') return;
  const { sb, esc, md, toast } = A;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const store = {
    get: (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };

  // ───────── dates (local time; weeks start on Monday)
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const dayStart = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const startOfWeek = d => addDays(dayStart(d), -((d.getDay() + 6) % 7));
  const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const todayStr = () => ymd(new Date());
  const fmt = (d, o) => d.toLocaleDateString('en', o);
  const dur = m => m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`;
  const hours = d => d.getHours() + d.getMinutes() / 60;
  const stepDate = (d, rep) => {   // next occurrence in local days (monthly keeps the day of month)
    const x = new Date(d);
    if (rep === 'daily') x.setDate(x.getDate() + 1);
    else if (rep === 'weekdays') do x.setDate(x.getDate() + 1); while (x.getDay() === 0 || x.getDay() === 6);
    else if (rep === 'weekly') x.setDate(x.getDate() + 7);
    else if (rep === 'monthly') x.setMonth(x.getMonth() + 1);
    return x;
  };
  const relDay = s => {
    const n = Math.round((parseYmd(s) - dayStart(new Date())) / 864e5);
    return n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : n === -1 ? 'Yesterday' : n < 0 ? `${-n}d overdue` : n < 7 ? fmt(parseYmd(s), { weekday: 'long' }) : fmt(parseYmd(s), { month: 'short', day: 'numeric' });
  };

  // ───────── state
  let tasks = [], notes = [], sessions = [], opps = [];
  let view = store.get('pl-view', 'today');
  let cal = { mode: store.get('pl-cal', 'week'), anchor: new Date() };
  let taskFilter = 'open', taskMode = store.get('pl-tasks', 'list'), taskTag = '', taskQ = '';
  let noteId = null, noteQ = '', statRange = 30;
  const root = () => $('#pl-view');
  const byId = id => tasks.find(t => t.id === id);
  const isOverdue = t => t.kind === 'task' && t.status !== 'done' && t.due_date && t.due_date < todayStr();
  let hasRemind = false;   // true once supabase/reminders.sql has added the reminder columns

  // when to notify: remind_min before the start (all-day items: before 09:00 that day); repeating events → the next one ahead
  function remindAt(t, after = new Date()) {
    if (!hasRemind || t.remind_min == null || t.status === 'done') return null;
    let base = t.start_at ? new Date(t.start_at) : t.due_date ? new Date(`${t.due_date}T09:00`) : null;
    if (!base) return null;
    const at = b => new Date(+b - t.remind_min * 6e4);
    if (t.kind === 'event' && t.repeat !== 'none') for (let i = 0; at(base) < after && i < 3000; i++) base = stepDate(base, t.repeat);
    if (t.repeat !== 'none' && t.repeat_until && ymd(base) > t.repeat_until) return null;
    return at(base) < after ? null : at(base).toISOString();
  }

  async function load() {
    const since = addDays(new Date(), -150).toISOString();
    const [t, n, f, o] = await Promise.all([
      sb.from('tasks').select('*').order('created_at'),
      sb.from('notes').select('*').order('updated_at', { ascending: false }),
      sb.from('focus_sessions').select('*').gte('started_at', since).order('started_at'),
      sb.from('opportunities').select('id,title,deadline,kind,status').order('deadline', { ascending: true, nullsFirst: false })]);
    const err = t.error || n.error || f.error || o.error;
    if (err) throw err;
    tasks = t.data; notes = n.data; sessions = f.data; opps = o.data;
    hasRemind = !(await sb.from('tasks').select('remind_min').limit(1)).error;
    hasTime = !(await sb.from('focus_sessions').select('project').limit(1)).error;
    await loadBookings();
  }

  // ───────── what lands on a given day: timed blocks + all-day items (tasks due, deadlines)
  function itemsOn(day) {
    const d0 = parseYmd(day), out = [];
    for (const t of tasks) {
      if (t.kind === 'event' && t.repeat !== 'none' && (t.start_at || t.due_date)) {
        const s = t.start_at ? new Date(t.start_at) : parseYmd(t.due_date), dow = d0.getDay();
        if (ymd(s) > day || (t.repeat_until && day > t.repeat_until)) continue;
        const hit = t.repeat === 'daily' || (t.repeat === 'weekdays' && dow > 0 && dow < 6)
          || (t.repeat === 'weekly' && dow === s.getDay()) || (t.repeat === 'monthly' && d0.getDate() === s.getDate());
        if (!hit) continue;
        if (!t.start_at) { out.push({ t, allDay: true }); continue; }
        const start = new Date(d0); start.setHours(s.getHours(), s.getMinutes());
        out.push({ t, start, end: new Date(+start + (t.end_at ? new Date(t.end_at) - s : 36e5)) });
      } else if (t.start_at) {
        const start = new Date(t.start_at);
        if (ymd(start) === day) out.push({ t, start, end: t.end_at ? new Date(t.end_at) : new Date(+start + (t.estimate_min || 60) * 6e4) });
      } else if (t.due_date === day) out.push({ t, allDay: true });
    }
    for (const o of opps) if (o.deadline === day) out.push({ dl: o, allDay: true });
    return out.sort((a, b) => (a.allDay ? 0 : +a.start) - (b.allDay ? 0 : +b.start));
  }
  const chip = (it, time) => it.dl
    ? `<a class="ev ev-dl" href="/opportunity?id=${it.dl.id}" title="Deadline: ${esc(it.dl.title)}">⚑ ${esc(it.dl.title)}</a>`
    : `<button type="button" class="ev ev-${it.t.kind} p${it.t.priority}${it.t.status === 'done' ? ' done' : ''}" data-open="${it.t.id}" draggable="true" data-dday="${it.t.id}" title="${esc(it.t.title)} · drag to another day">${time && it.start ? `<span>${hm(it.start)}</span>` : ''}${it.t.repeat !== 'none' ? '↻ ' : ''}${esc(it.t.title)}</button>`;

  // overlapping blocks sit side by side
  function layout(items) {
    const out = []; let group = [], end = 0;
    const flush = () => {
      const ends = [];
      const placed = group.map(i => { let c = ends.findIndex(e => e <= +i.start); if (c < 0) c = ends.push(0) - 1; ends[c] = +i.end; return { i, col: c }; });
      placed.forEach(p => out.push({ ...p, cols: ends.length }));
      group = [];
    };
    for (const i of items) { if (group.length && +i.start >= end) { flush(); end = 0; } group.push(i); end = Math.max(end, +i.end); }
    if (group.length) flush();
    return out;
  }

  // week / day / today time grid
  const HOUR = 46;
  function timeGrid(days, { head = true } = {}) {
    const all = days.map(itemsOn), timed = all.flat().filter(i => !i.allDay);
    let h0 = 8, h1 = 21;
    for (const i of timed) { h0 = Math.min(h0, Math.floor(hours(i.start))); h1 = Math.max(h1, Math.ceil(ymd(i.end) !== ymd(i.start) ? 24 : hours(i.end))); }
    const now = new Date(), nowDay = ymd(now), H = (h1 - h0) * HOUR;
    const cols = days.map((d, k) => {
      const blocks = layout(all[k].filter(i => !i.allDay)).map(({ i, col, cols }) => {
        const top = (hours(i.start) - h0) * HOUR, end = ymd(i.end) !== d ? 24 : hours(i.end);
        const h = Math.max(24, (end - hours(i.start)) * HOUR - 3);
        return `<button type="button" class="blk ev-${i.t.kind} p${i.t.priority}${i.t.status === 'done' ? ' done' : ''}" data-open="${i.t.id}" data-s="${+i.start}" data-e="${+i.end}" title="Drag to move · drag the bottom edge to resize"
          style="top:${top}px;height:${h}px;left:calc(${col} * 100% / ${cols});width:calc(100% / ${cols} - 4px)"><b>${i.t.repeat !== 'none' ? '↻ ' : ''}${esc(i.t.title)}</b><span>${hm(i.start)}–${hm(i.end)}</span><i class="rs" aria-hidden="true"></i></button>`;
      }).join('');
      const line = d === nowDay && hours(now) >= h0 && hours(now) < h1 ? `<i class="now" style="top:${(hours(now) - h0) * HOUR}px"></i>` : '';
      return { d, allDay: all[k].filter(i => i.allDay).map(i => chip(i)).join(''), body: `<div class="tg-col${d === nowDay ? ' is-today' : ''}" data-slot="${d}" data-h0="${h0}" style="height:${H}px">${blocks}${line}</div>` };
    });
    const labels = Array.from({ length: h1 - h0 }, (_, k) => `<span style="top:${k * HOUR}px">${pad(h0 + k)}:00</span>`).join('');
    return `<div class="tg" style="--n:${days.length}">
      ${head ? `<div class="tg-row tg-head"><span></span>${cols.map(c => `<button type="button" class="tg-day${c.d === nowDay ? ' is-today' : ''}" data-goto="${c.d}"><small>${fmt(parseYmd(c.d), { weekday: 'short' })}</small> ${parseYmd(c.d).getDate()}</button>`).join('')}</div>` : ''}
      <div class="tg-row tg-all"><span>all day</span>${cols.map(c => `<div data-newday="${c.d}">${c.allDay}</div>`).join('')}</div>
      <div class="tg-row tg-body"><div class="tg-hours" style="height:${H}px">${labels}</div>${cols.map(c => c.body).join('')}</div>
    </div>`;
  }

  function monthGrid(anchor) {
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1), start = startOfWeek(first);
    const weeks = Math.ceil(((first.getDay() + 6) % 7 + new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate()) / 7);
    const t = todayStr();
    const cells = Array.from({ length: weeks * 7 }, (_, k) => {
      const d = addDays(start, k), s = ymd(d), items = itemsOn(s);
      return `<div class="mc${d.getMonth() !== anchor.getMonth() ? ' other' : ''}${s === t ? ' is-today' : ''}" data-newday="${s}">
        <button type="button" class="mc-n" data-goto="${s}">${d.getDate()}</button>
        ${items.slice(0, 3).map(i => chip(i, true)).join('')}
        ${items.length > 3 ? `<button type="button" class="more" data-goto="${s}">+${items.length - 3} more</button>` : ''}</div>`;
    }).join('');
    const head = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(w => `<span>${w}</span>`).join('');
    return `<div class="month"><div class="month-head">${head}</div><div class="month-grid">${cells}</div></div>`;
  }

  // ───────── task rows
  const checklistOf = t => Array.isArray(t.checklist) ? t.checklist : [];
  function taskRow(t) {
    const cl = checklistOf(t), done = cl.filter(c => c.done).length, opp = opps.find(o => o.id === t.opportunity_id);
    const when = t.start_at ? `${relDay(ymd(new Date(t.start_at)))} ${hm(new Date(t.start_at))}` : t.due_date ? relDay(t.due_date) : '';
    return `<div class="trow p${t.priority}${t.status === 'done' ? ' done' : ''}${isOverdue(t) ? ' late' : ''}" data-id="${t.id}">
      <label class="tick"><input type="checkbox" data-done="${t.id}"${t.status === 'done' ? ' checked' : ''} aria-label="Done"><span></span></label>
      <button type="button" class="t-main" data-open="${t.id}">
        <b>${esc(t.title)}</b>
        <span class="t-meta">${when ? `<span class="due-t">${esc(when)}</span>` : ''}${t.priority === 1 ? '<span class="flag">High</span>' : ''}${t.status === 'doing' ? '<span class="doing">Doing</span>' : ''}${t.repeat !== 'none' ? `<span>↻ ${t.repeat}</span>` : ''}${t.remind_at ? '<span title="Reminder set">🔔</span>' : ''}${cl.length ? `<span>☑ ${done}/${cl.length}</span>` : ''}${t.estimate_min ? `<span>~${dur(t.estimate_min)}</span>` : ''}${opp ? `<span>⚑ ${esc(opp.title.split(' — ')[0])}</span>` : ''}${t.tags.map(g => `<span class="tag">#${esc(g)}</span>`).join('')}</span>
      </button>
      ${t.status !== 'done' ? `<button type="button" class="t-play" data-focus="${t.id}" title="Focus on this" aria-label="Start focus timer">▶</button>` : ''}
    </div>`;
  }

  // quick add: "Write SoP draft tomorrow 14:00 #kaist !1"
  function parseQuick(s) {
    const r = { tags: [], priority: 2, date: null, time: null };
    let x = ` ${s} `;
    x = x.replace(/\s#([\p{L}\d_-]+)/gu, (_, g) => { r.tags.push(g.toLowerCase()); return ' '; });
    x = x.replace(/\s!(1|2|3|high|low)(?=\s)/gi, (_, p) => { r.priority = { 1: 1, high: 1, 2: 2, 3: 3, low: 3 }[p.toLowerCase()]; return ' '; });
    x = x.replace(/\s(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?=\s)/i, (_, h, m, ap) => { h = +h % 12 + (ap.toLowerCase() === 'pm' ? 12 : 0); r.time = `${pad(h)}:${m || '00'}`; return ' '; });
    x = x.replace(/\s(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)(?=\s)/, (_, h, m) => { r.time = `${pad(+h)}:${m}`; return ' '; });
    const now = dayStart(new Date());
    const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    x = x.replace(/\s(today|tod|tonight|tomorrow|tmr|tmrw|next week|(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2})(?=\s)/i, (m0, w) => {
      w = w.toLowerCase();
      let d = null;
      if (/^(today|tod|tonight)$/.test(w)) d = now;
      else if (/^(tomorrow|tmr|tmrw)$/.test(w)) d = addDays(now, 1);
      else if (w === 'next week') d = addDays(startOfWeek(now), 7);
      else if (/^\d{4}-/.test(w)) d = parseYmd(w);
      else if (w.includes('/')) { const [m, dd] = w.split('/').map(Number); d = new Date(now.getFullYear(), m - 1, dd); if (d < now) d.setFullYear(d.getFullYear() + 1); }
      else { const k = days.indexOf(w.slice(0, 3)); if (k < 0 || !/^(mon|tue|wed|thu|fri|sat|sun)(day|s|sday|nesday|rsday|urday)?$/.test(w)) return m0; d = addDays(now, ((k - now.getDay() + 7) % 7) || 7); }
      r.date = ymd(d); return ' ';
    });
    r.title = x.replace(/\s+/g, ' ').trim();
    if (r.time && !r.date) r.date = todayStr();
    return r;
  }
  async function quickAdd(text) {
    const q = parseQuick(text);
    if (!q.title) return;
    const row = { kind: 'task', title: q.title, tags: q.tags, priority: q.priority, due_date: q.time ? null : q.date };
    if (q.time) row.start_at = new Date(`${q.date}T${q.time}`).toISOString();
    const { data, error } = await sb.from('tasks').insert(row).select().single();
    if (error) return toast(error.message);
    tasks.push(data); toast('Task added'); render();
  }

  const withRemind = (t, patch) => hasRemind ? { ...patch, remind_at: remindAt({ ...t, ...patch }) } : patch;
  async function setStatus(id, status) {
    const t = byId(id);
    if (status === 'done' && t.kind === 'task' && t.repeat !== 'none' && (t.due_date || t.start_at)) return completeRepeating(t);
    const patch = withRemind(t, { status, done_at: status === 'done' ? new Date().toISOString() : null });
    const { error } = await sb.from('tasks').update(patch).eq('id', id);
    if (error) { toast(error.message); return render(); }
    Object.assign(t, patch); render();
    if (status === 'done') toast('Done ✓');
  }

  // a repeating task: keep a finished copy for history, then move the task itself to its next date
  async function completeRepeating(t) {
    const now = new Date(), today = dayStart(now), cur = t.start_at ? new Date(t.start_at) : parseYmd(t.due_date);
    let next = stepDate(cur, t.repeat);
    if (dayStart(cur) <= today) while (dayStart(next) <= today) next = stepDate(next, t.repeat);   // overdue → skip to the next one after today
    const ended = !!(t.repeat_until && ymd(next) > t.repeat_until);
    const copy = { kind: 'task', title: t.title, notes: t.notes, priority: t.priority, tags: t.tags, opportunity_id: t.opportunity_id, estimate_min: t.estimate_min,
      due_date: t.due_date, start_at: t.start_at, end_at: t.end_at, checklist: checklistOf(t), status: 'done', done_at: now.toISOString() };
    const patch = ended ? withRemind(t, { status: 'done', done_at: now.toISOString() }) : withRemind(t, {
      status: 'todo', done_at: null, checklist: checklistOf(t).map(c => ({ ...c, done: false })),
      ...(t.start_at ? { start_at: next.toISOString(), end_at: t.end_at ? new Date(+next + (new Date(t.end_at) - cur)).toISOString() : null } : { due_date: ymd(next) }) });
    const [a, b] = await Promise.all([ended ? { data: null } : sb.from('tasks').insert(copy).select().single(), sb.from('tasks').update(patch).eq('id', t.id)]);
    if (a.error || b.error) { toast((a.error || b.error).message); return render(); }
    if (a.data) tasks.push(a.data);
    Object.assign(t, patch); render();
    toast(ended ? 'Done ✓ (that was the last one)' : `Done ✓ · next: ${relDay(ymd(next))}`);
  }

  // calendar moves: shift a timed item (a repeating event moves the whole series), or move an item to another day
  async function savePatch(t, patch, msg) {
    patch = withRemind(t, patch);
    const { error } = await sb.from('tasks').update(patch).eq('id', t.id);
    if (error) { toast(error.message); return render(); }
    Object.assign(t, patch); render(); toast(msg);
  }
  function shiftTimed(t, dStart, dEnd) {
    const s = new Date(t.start_at), e = t.end_at ? new Date(t.end_at) : new Date(+s + (t.estimate_min || 60) * 6e4);
    const ns = new Date(+s + dStart), ne = new Date(+e + dEnd);
    if (ne <= ns || (!dStart && !dEnd)) return render();
    return savePatch(t, { start_at: ns.toISOString(), end_at: ne.toISOString() }, t.repeat !== 'none' ? 'Moved · every repeat follows' : `Moved to ${fmt(ns, { weekday: 'short' })} ${hm(ns)}–${hm(ne)}`);
  }
  function moveDay(t, from, to) {
    const days = Math.round((parseYmd(to) - parseYmd(from)) / 864e5);
    if (!days) return;
    const shift = iso => { if (!iso) return null; const d = new Date(iso); d.setDate(d.getDate() + days); return d.toISOString(); };
    const patch = t.start_at ? { start_at: shift(t.start_at), end_at: shift(t.end_at) } : { due_date: ymd(addDays(parseYmd(t.due_date), days)) };
    return savePatch(t, patch, t.repeat !== 'none' ? 'Moved · every repeat follows' : `Moved to ${relDay(to)}`);
  }

  // ───────── views
  const tile = (k, v, s, cls = '') => `<div class="stat-tile ${cls}"><span class="stat-k">${k}</span><b>${v}</b><span class="stat-s">${s}</span></div>`;
  const quickForm = () => `<form class="quick" data-quick><input name="q" placeholder="Add a task… e.g. “SoP draft tomorrow 14:00 #kaist !1”" aria-label="Quick add task" autocomplete="off"><button class="btn btn-sm" type="submit">Add</button></form>`;
  const dateOf = x => x.start_at ? ymd(new Date(x.start_at)) : x.due_date;

  function vToday() {
    const t = todayStr(), now = new Date();
    const open = tasks.filter(x => x.kind === 'task' && x.status !== 'done');
    const overdue = open.filter(isOverdue), due = open.filter(x => dateOf(x) === t);
    const doneToday = tasks.filter(x => x.done_at && ymd(new Date(x.done_at)) === t).length;
    const todays = sessions.filter(s => ymd(new Date(s.started_at)) === t);
    const soon = opps.filter(o => o.deadline && o.deadline >= t && o.deadline <= ymd(addDays(now, 14)));
    const next = open.filter(x => dateOf(x) > t && dateOf(x) <= ymd(addDays(now, 7))).sort((a, b) => dateOf(a).localeCompare(dateOf(b)));
    return `
      <div class="stats-row pl-stats">
        ${tile('Done today', doneToday, `${open.length} open`)}
        ${tile('Tracked today', dur(todays.reduce((a, s) => a + s.minutes, 0)), `${todays.length} entr${todays.length === 1 ? 'y' : 'ies'}`)}
        ${tile('Overdue', overdue.length, overdue.length ? 'catch up first' : 'all clear', overdue.length ? 'hot' : '')}
        ${tile('Streak', `${streak()}d`, 'days in a row with progress')}
      </div>
      <div class="pl-today">
        <section class="pl-card"><div class="card-h"><h3>Schedule</h3><button type="button" class="btn btn-sm ghost" data-new="event" data-day="${t}">+ Event</button></div>${timeGrid([t], { head: false })}</section>
        <div class="pl-col">
          <section class="pl-card"><h3>Tasks</h3>${quickForm()}
            ${overdue.length ? `<p class="grp">Overdue</p>${overdue.map(taskRow).join('')}` : ''}
            <p class="grp">Today</p>${due.length ? due.map(taskRow).join('') : '<p class="meta">Nothing due today. Add one above.</p>'}
            ${next.length ? `<p class="grp">Next 7 days</p>${next.map(taskRow).join('')}` : ''}
          </section>
          <section class="pl-card"><h3>Deadlines · next 14 days</h3>${soon.length ? soon.map(o => `<a class="dl-row" href="/opportunity?id=${o.id}"><span>⚑ ${esc(o.title)}</span><b>${relDay(o.deadline)}</b></a>`).join('') : '<p class="meta">No opportunity deadlines in the next two weeks.</p>'}</section>
        </div>
      </div>`;
  }

  const weekDays = () => innerWidth < 700 ? 3 : 7;
  function vCalendar() {
    const a = cal.anchor;
    let label, body;
    if (cal.mode === 'month') { label = fmt(a, { month: 'long', year: 'numeric' }); body = monthGrid(a); }
    else if (cal.mode === 'week') {   // phones get 3 readable days instead of 7 squashed ones
      const n = weekDays(), s = n === 7 ? startOfWeek(a) : dayStart(a), e = addDays(s, n - 1);
      label = `${fmt(s, { month: 'short', day: 'numeric' })} – ${fmt(e, s.getMonth() === e.getMonth() ? { day: 'numeric' } : { month: 'short', day: 'numeric' })}, ${e.getFullYear()}`;
      body = timeGrid(Array.from({ length: n }, (_, k) => ymd(addDays(s, k))));
    } else { label = fmt(a, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }); body = timeGrid([ymd(a)]); }
    return `<div class="cal-bar">
        <div class="cal-nav"><button type="button" class="btn btn-sm ghost" data-cal="prev" aria-label="Previous">‹</button><button type="button" class="btn btn-sm ghost" data-cal="today">Today</button><button type="button" class="btn btn-sm ghost" data-cal="next" aria-label="Next">›</button><h2>${label}</h2></div>
        <div class="chips">${['month', 'week', 'day'].map(m => `<button type="button" data-calmode="${m}" aria-pressed="${cal.mode === m}">${m === 'week' && weekDays() === 3 ? '3 days' : m[0].toUpperCase() + m.slice(1)}</button>`).join('')}</div>
        <div class="cal-add"><button type="button" class="btn btn-sm ghost" data-new="task" data-day="${ymd(a)}">+ Task</button><button type="button" class="btn btn-sm" data-new="event" data-day="${ymd(a)}">+ Event</button></div>
      </div>
      <p class="meta cal-hint">Click an empty slot to add something there · <span class="lg lg-event"></span>event <span class="lg lg-task"></span>task <span class="lg lg-dl"></span>opportunity deadline</p>
      ${body}`;
  }

  function vTasks() {
    const t = todayStr(), wk = ymd(addDays(new Date(), 7));
    const all = tasks.filter(x => x.kind === 'task');
    const tags = [...new Set(all.flatMap(x => x.tags))].sort();
    const list = all.filter(x => (!taskTag || x.tags.includes(taskTag)) && (!taskQ || `${x.title} ${x.notes || ''} ${x.tags.join(' ')}`.toLowerCase().includes(taskQ)));
    const filt = {
      open: x => x.status !== 'done', today: x => x.status !== 'done' && dateOf(x) === t, upcoming: x => x.status !== 'done' && dateOf(x) > t,
      overdue: isOverdue, nodate: x => x.status !== 'done' && !dateOf(x), done: x => x.status === 'done',
    }[taskFilter];
    const shown = list.filter(filt);
    const sort = (a, b) => (dateOf(a) || '9999').localeCompare(dateOf(b) || '9999') || a.priority - b.priority;
    const groups = taskFilter === 'done'
      ? [['Completed', shown.sort((a, b) => (b.done_at || '').localeCompare(a.done_at || '')).slice(0, 60)]]
      : [['Overdue', shown.filter(isOverdue)], ['Today', shown.filter(x => dateOf(x) === t)], ['This week', shown.filter(x => dateOf(x) > t && dateOf(x) <= wk)],
         ['Later', shown.filter(x => dateOf(x) > wk)], ['No date', shown.filter(x => !dateOf(x))]].map(([h, xs]) => [h, xs.sort(sort)]);
    const listHtml = groups.filter(([, xs]) => xs.length).map(([h, xs]) => `<p class="grp">${h} <span>${xs.length}</span></p>${xs.map(taskRow).join('')}`).join('')
      || '<div class="empty-state"><b>Nothing here</b><span class="meta">Add a task above, or try another filter.</span></div>';
    const board = ['todo', 'doing', 'done'].map(st => {
      const xs = list.filter(x => x.status === st).sort(sort).slice(0, st === 'done' ? 30 : 200);
      return `<div class="kcol" data-drop="${st}"><p class="grp">${{ todo: 'To do', doing: 'Doing', done: 'Done' }[st]} <span>${xs.length}</span></p>
        ${xs.map(x => `<div class="kcard p${x.priority}" draggable="true" data-drag="${x.id}"><button type="button" data-open="${x.id}"><b>${esc(x.title)}</b>
          <span class="t-meta">${dateOf(x) ? `<span class="due-t">${relDay(dateOf(x))}</span>` : ''}${x.tags.map(g => `<span class="tag">#${esc(g)}</span>`).join('')}</span></button></div>`).join('')}</div>`;
    }).join('');
    return `<div class="pl-card">
      <div class="task-bar">${quickForm()}
        <div class="chips">${['list', 'board'].map(m => `<button type="button" data-tmode="${m}" aria-pressed="${taskMode === m}">${m === 'list' ? 'List' : 'Board'}</button>`).join('')}</div>
      </div>
      <div class="toolbar">
        ${taskMode === 'list' ? `<div class="chips">${[['open', 'Open'], ['today', 'Today'], ['upcoming', 'Upcoming'], ['overdue', 'Overdue'], ['nodate', 'No date'], ['done', 'Done']].map(([k, l]) => `<button type="button" data-tf="${k}" aria-pressed="${taskFilter === k}">${l}</button>`).join('')}</div>` : '<p class="meta">Drag cards between columns.</p>'}
        <select data-ttag aria-label="Filter by tag"><option value="">All tags</option>${tags.map(g => `<option${g === taskTag ? ' selected' : ''}>${esc(g)}</option>`).join('')}</select>
        <input type="search" data-tq value="${esc(taskQ)}" placeholder="Search tasks…" aria-label="Search tasks">
      </div>
      ${taskMode === 'list' ? `<div class="tlist">${listHtml}</div>` : `<div class="kanban">${board}</div>`}
    </div>`;
  }

  function vNotes() {
    const q = noteQ.toLowerCase();
    const list = notes.filter(n => !q || `${n.title} ${n.body} ${n.tags.join(' ')}`.toLowerCase().includes(q))
      .sort((a, b) => (b.pinned - a.pinned) || b.updated_at.localeCompare(a.updated_at));
    const n = notes.find(x => x.id === noteId);
    return `<div class="notes">
      <aside class="pl-card note-list">
        <div class="card-h"><input type="search" data-nq value="${esc(noteQ)}" placeholder="Search notes…" aria-label="Search notes"><button type="button" class="btn btn-sm" data-newnote>+ New</button></div>
        ${list.map(x => `<button type="button" class="note-item${x.id === noteId ? ' on' : ''}" data-note="${x.id}"><b>${x.pinned ? '📌 ' : ''}${esc(x.title || 'Untitled')}</b><span>${esc(x.body.replace(/[#*`>\-[\]]/g, '').slice(0, 80))}</span><small>${fmt(new Date(x.updated_at), { month: 'short', day: 'numeric' })}</small></button>`).join('') || '<p class="meta">No notes yet.</p>'}
      </aside>
      <section class="pl-card note-ed">${n ? `
        <div class="card-h"><input class="note-title" data-nf="title" value="${esc(n.title)}" placeholder="Title" aria-label="Note title">
          <div class="icon-btns"><button type="button" data-pin title="${n.pinned ? 'Unpin' : 'Pin'}" aria-label="Pin">${n.pinned ? '📌' : '📍'}</button><button type="button" data-preview title="Preview" aria-label="Toggle preview">👁</button><button type="button" class="danger" data-delnote title="Delete" aria-label="Delete note">✕</button></div></div>
        <input data-nf="tags" value="${esc(n.tags.join(', '))}" placeholder="tags, comma separated" aria-label="Tags">
        <textarea data-nf="body" placeholder="Write in markdown: # heading, - list, **bold**, [link](https://…)" aria-label="Note body">${esc(n.body)}</textarea>
        <article class="prose note-prev" hidden></article>
        <p class="meta note-state">Saved</p>` : '<div class="empty-state"><b>Pick a note</b><span class="meta">or create a new one.</span></div>'}
      </section></div>`;
  }

  // ───────── time tracking: stopwatch / pomodoro tracker, manual entries, log, timesheet. Timer state survives reloads.
  const CFG = () => ({ focus: 25, short: 5, long: 15, every: 4, ...store.get('pl-timer-cfg', {}) });
  const GOAL = () => ({ day: 6, week: 30, ...store.get('pl-goal', {}) });   // hours
  const T = { mode: 'watch', phase: 'focus', running: false, remaining: null, endsAt: null, startedAt: null, elapsed: 0, runSince: null, taskId: null, label: '', project: '', count: 0, ...store.get('pl-timer', {}) };
  const saveT = () => store.set('pl-timer', T);
  const phaseLen = () => CFG()[T.phase] * 6e4;
  const leftMs = () => T.mode === 'pomo' ? (T.running ? T.endsAt - Date.now() : (T.remaining ?? phaseLen())) : (T.elapsed + (T.running ? Date.now() - T.runSince : 0));
  const clock = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${s >= 3600 ? Math.floor(s / 3600) + ':' : ''}${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`; };
  const beep = () => { try { const c = new AudioContext(), o = c.createOscillator(), g = c.createGain(); o.connect(g); g.connect(c.destination); o.frequency.value = 880; g.gain.setValueAtTime(.2, c.currentTime); g.gain.exponentialRampToValueAtTime(.001, c.currentTime + .8); o.start(); o.stop(c.currentTime + .8); } catch (e) {} };
  const notify = msg => { beep(); toast(msg); try { if (Notification.permission === 'granted') new Notification('Planner', { body: msg }); } catch (e) {} };
  let hasTime = false;   // project + source columns exist (supabase/time.sql)
  const sday = s => ymd(new Date(s.started_at));
  const sumMin = list => list.reduce((a, s) => a + s.minutes, 0);
  const hmm = m => m ? `${Math.floor(m / 60)}:${pad(m % 60)}` : '';
  const projOf = s => s.project || (byId(s.task_id)?.tags[0] ? `#${byId(s.task_id).tags[0]}` : 'No project');
  const projects = () => [...new Set(sessions.map(s => s.project).filter(Boolean))].sort();
  const dayName = d => { const r = relDay(d); return r === 'Today' || r === 'Yesterday' ? r : fmt(parseYmd(d), { weekday: 'short', month: 'short', day: 'numeric' }); };
  // "1h 30m", "1.5h", "90", "90m", "1:30" → minutes
  const parseDur = s => {
    s = String(s || '').trim().toLowerCase();
    if (!s) return null;
    let m;
    if ((m = s.match(/^(\d+):(\d{1,2})$/))) return +m[1] * 60 + +m[2];
    if ((m = s.match(/^(\d+(?:\.\d+)?)\s*h(?:\s*(\d+)\s*m(?:in)?)?$/))) return Math.round(+m[1] * 60) + (+m[2] || 0);
    if ((m = s.match(/^(\d+)\s*(?:m|min)?$/))) return +m[1];
    return NaN;
  };

  async function logSession(start, end) {
    const minutes = Math.round((end - start) / 6e4);
    if (minutes < 1) return toast('Under a minute, so not logged');
    const row = { task_id: T.taskId || null, label: T.label.trim() || (byId(T.taskId)?.title ?? null), started_at: new Date(start).toISOString(), ended_at: new Date(end).toISOString(), minutes };
    if (hasTime) Object.assign(row, { project: (T.project || '').trim() || null, source: 'timer' });
    const { data, error } = await sb.from('focus_sessions').insert(row).select().single();
    if (error) return toast(`Could not save the time: ${error.message}`);
    sessions.push(data); toast(`Logged ${dur(minutes)}`);
  }
  const timer = {
    start() {
      try { if (Notification.permission === 'default') Notification.requestPermission(); } catch (e) {}
      if (T.mode === 'pomo') { const left = T.remaining ?? phaseLen(); if (T.phase === 'focus' && !T.startedAt) T.startedAt = Date.now(); T.endsAt = Date.now() + left; T.remaining = null; }
      else { T.runSince = Date.now(); if (!T.startedAt) T.startedAt = Date.now(); }
      T.running = true; saveT(); render();
    },
    pause() {
      if (T.mode === 'pomo') T.remaining = T.endsAt - Date.now(); else T.elapsed += Date.now() - T.runSince;
      T.running = false; saveT(); render();
    },
    reset() { Object.assign(T, { phase: 'focus', running: false, remaining: null, endsAt: null, startedAt: null, elapsed: 0, runSince: null }); saveT(); render(); },
    async finish() {   // stopwatch: stop and save; pomodoro: end this block now (logs the focus so far)
      const end = Date.now();
      if (T.mode === 'watch') { const ms = leftMs(); if (T.startedAt) await logSession(end - ms, end); return timer.reset(); }
      if (T.phase === 'focus' && T.startedAt) { await logSession(T.startedAt, end); T.count++; }
      return timer.next(false);
    },
    next(auto) {
      T.phase = T.phase === 'focus' ? (T.count && T.count % CFG().every === 0 ? 'long' : 'short') : 'focus';
      Object.assign(T, { remaining: null, startedAt: null, running: false, endsAt: null });
      if (auto && T.phase !== 'focus') timer.start(); else { saveT(); render(); }
    },
  };
  let ending = false;
  async function tick() {
    if (T.running && T.mode === 'pomo' && Date.now() >= T.endsAt && !ending) {
      ending = true;
      const wasFocus = T.phase === 'focus';
      T.running = false;
      if (wasFocus) { await logSession(T.startedAt || T.endsAt - phaseLen(), T.endsAt); T.count++; notify('Focus block done. Take a break.'); }
      else notify('Break over. Ready for the next focus block?');
      timer.next(wasFocus);
      ending = false;
    }
    const ms = leftMs(), active = T.running || (T.mode === 'pomo' ? T.remaining !== null : T.elapsed > 0);
    const what = T.mode === 'pomo' && T.phase !== 'focus' ? 'Break' : (T.label.trim() || byId(T.taskId)?.title || (T.mode === 'pomo' ? 'Focus' : 'Tracking'));
    const mini = $('#mini-timer');
    if (mini) { mini.hidden = !active; mini.innerHTML = `<i class="${T.running ? 'on' : ''}"></i>${clock(ms)} <span>${esc(what.slice(0, 28))}</span>`; }
    document.title = active ? `${clock(ms)} · ${what} — Planner` : 'Planner — Rashid Tagaev';
    const big = $('#t-clock');
    if (big) big.textContent = clock(ms);
    const bar = $('#t-bar');
    if (bar) bar.style.setProperty('--p', `${(100 * (1 - Math.min(1, Math.max(0, ms / phaseLen())))).toFixed(2)}%`);
  }

  let timeMode = store.get('pl-time', 'log'), sheetAnchor = new Date(), logDays = 14;
  const goalTile = (k, m, goalH, sub) => {
    const p = goalH ? Math.min(100, 100 * m / (goalH * 60)) : 0;
    return `<div class="stat-tile${p >= 100 ? ' met' : ''}"><span class="stat-k">${k}</span><b>${dur(m)}</b><span class="stat-s">${sub}</span>${goalH ? `<i class="goal-bar" style="--p:${p.toFixed(1)}%" title="${Math.round(p)}% of ${goalH}h"></i>` : ''}</div>`;
  };
  function vFocus() {
    const c = CFG(), g = GOAL(), t = todayStr(), wk0 = ymd(startOfWeek(new Date()));
    const week = sessions.filter(s => sday(s) >= wk0), today = sumMin(sessions.filter(s => sday(s) === t)), weekMin = sumMin(week);
    const daysIn = (new Date().getDay() + 6) % 7 + 1;
    const byP = {}; for (const s of week) byP[projOf(s)] = (byP[projOf(s)] || 0) + s.minutes;
    const top = Object.entries(byP).sort((a, b) => b[1] - a[1])[0];
    const open = tasks.filter(x => x.kind === 'task' && x.status !== 'done');
    const pomo = T.mode === 'pomo', phase = { focus: 'Focus', short: 'Short break', long: 'Long break' }[T.phase];
    return `
      <section class="pl-card tracker">
        <input class="tr-desc" data-tdesc value="${esc(T.label)}" placeholder="What are you working on?" aria-label="What are you working on" autocomplete="off">
        ${hasTime ? `<input class="tr-proj" data-tproj list="proj-list" value="${esc(T.project || '')}" placeholder="Project" aria-label="Project" autocomplete="off">` : ''}
        <select class="tr-task" data-ttask aria-label="Task"><option value="">No task</option>${open.map(x => `<option value="${x.id}"${x.id === T.taskId ? ' selected' : ''}>${esc(x.title)}</option>`).join('')}</select>
        <div class="chips tr-mode">${[['watch', 'Stopwatch'], ['pomo', 'Pomodoro']].map(([m, l]) => `<button type="button" data-tmodeset="${m}" aria-pressed="${T.mode === m}"${T.running ? ' disabled' : ''}>${l}</button>`).join('')}</div>
        <b id="t-clock" class="tr-clock">${clock(leftMs())}</b>
        <div class="tr-btns">
          <button type="button" class="btn${T.running ? ' ghost' : ''}" data-timer="${T.running ? 'pause' : 'start'}">${T.running ? '❚❚ Pause' : '▶ Start'}</button>
          <button type="button" class="btn${T.running ? '' : ' ghost'}" data-timer="finish">${pomo && T.phase !== 'focus' ? 'Skip break' : '■ Stop'}</button>
          <button type="button" class="btn ghost" data-timer="reset" title="Discard without saving" aria-label="Discard">✕</button>
        </div>
        ${pomo ? `<div class="tr-pomo"><span>${phase} · ${T.count} block${T.count === 1 ? '' : 's'} done · long break every ${c.every}</span><i id="t-bar"></i></div>` : ''}
      </section>
      <datalist id="proj-list">${projects().map(p => `<option value="${esc(p)}">`).join('')}</datalist>
      <div class="stats-row pl-stats">
        ${goalTile('Today', today, g.day, `goal ${g.day}h`)}
        ${goalTile('This week', weekMin, g.week, `goal ${g.week}h`)}
        ${tile('Daily average', dur(Math.round(weekMin / daysIn)), 'this week so far')}
        ${tile('Top project', top ? esc(top[0]) : '–', top ? `${dur(top[1])} this week` : 'nothing tracked yet')}
      </div>
      <section class="pl-card">
        <div class="time-bar">
          <div class="chips">${[['log', 'Time log'], ['sheet', 'Timesheet']].map(([m, l]) => `<button type="button" data-timemode="${m}" aria-pressed="${timeMode === m}">${l}</button>`).join('')}</div>
          <div class="actions"><button type="button" class="btn btn-sm" data-addentry>+ Add time manually</button><button type="button" class="btn btn-sm ghost" data-export>Export CSV</button></div>
        </div>
        ${timeMode === 'sheet' ? vSheet() : vLog()}
      </section>
      <details class="pl-card t-cfg"><summary>Goals &amp; Pomodoro settings</summary>
        <div class="cfg-grid">
          <label>Daily goal (hours) <input type="number" min="0.5" max="24" step="0.5" data-goal="day" value="${g.day}"></label>
          <label>Weekly goal (hours) <input type="number" min="1" max="120" step="1" data-goal="week" value="${g.week}"></label>
          ${[['focus', 'Focus block (min)'], ['short', 'Short break (min)'], ['long', 'Long break (min)'], ['every', 'Long break every']].map(([k, l]) => `<label>${l} <input type="number" min="1" max="${k === 'every' ? 12 : 180}" data-cfg="${k}" value="${c[k]}"></label>`).join('')}
        </div>
      </details>
      ${hasTime ? '' : '<p class="notice">Run <code>supabase/time.sql</code> once to add projects and mark manual entries.</p>'}`;
  }
  const entryRow = s => {
    const task = byId(s.task_id), title = s.label || task?.title || 'Untitled';
    return `<div class="entry">
      <span class="en-time">${hm(new Date(s.started_at))}–${hm(new Date(s.ended_at))}</span>
      <button type="button" class="en-main" data-editentry="${s.id}"><b>${esc(title)}</b><span class="t-meta">${s.project ? `<span class="proj">${esc(s.project)}</span>` : ''}${task && task.title !== title ? `<span>☑ ${esc(task.title)}</span>` : ''}${s.source === 'manual' ? '<span>manual</span>' : ''}</span></button>
      <em class="en-dur">${dur(s.minutes)}</em>
      <div class="icon-btns"><button type="button" data-cont="${s.id}" title="Continue: start the timer with this" aria-label="Continue">▶</button><button type="button" class="danger" data-delentry="${s.id}" title="Delete" aria-label="Delete">✕</button></div>
    </div>`;
  };
  function vLog() {
    const byDay = {};
    for (const s of sessions.slice().sort((a, b) => b.started_at.localeCompare(a.started_at))) (byDay[sday(s)] ||= []).push(s);
    const days = Object.keys(byDay).sort().reverse();
    if (!days.length) return '<div class="empty-state"><b>No time tracked yet</b><span class="meta">Start the timer above, or add time manually.</span></div>';
    return days.slice(0, logDays).map(d => `<div class="log-day"><p class="grp">${dayName(d)} <span>${dur(sumMin(byDay[d]))}</span></p>${byDay[d].map(entryRow).join('')}</div>`).join('')
      + (days.length > logDays ? '<button type="button" class="btn btn-sm ghost more-days" data-moredays>Show older days</button>' : '');
  }
  function vSheet() {
    const s0 = startOfWeek(sheetAnchor), days = Array.from({ length: 7 }, (_, k) => ymd(addDays(s0, k))), t = todayStr(), g = GOAL();
    const rows = {};
    for (const s of sessions) { const k = days.indexOf(sday(s)); if (k >= 0) (rows[projOf(s)] ||= Array(7).fill(0))[k] += s.minutes; }
    const names = Object.keys(rows).sort((a, b) => rows[b].reduce((x, y) => x + y) - rows[a].reduce((x, y) => x + y));
    const colSum = k => names.reduce((a, n) => a + rows[n][k], 0), all = days.reduce((a, _, k) => a + colSum(k), 0);
    const e = addDays(s0, 6);
    return `<div class="sheet-nav"><button type="button" class="btn btn-sm ghost" data-sheet="-1" aria-label="Previous week">‹</button><button type="button" class="btn btn-sm ghost" data-sheet="0">This week</button><button type="button" class="btn btn-sm ghost" data-sheet="1" aria-label="Next week">›</button>
        <b>${fmt(s0, { month: 'short', day: 'numeric' })} – ${fmt(e, { month: 'short', day: 'numeric' })}</b><span class="meta">${dur(all)} of ${g.week}h goal</span></div>
      <div class="sheet-wrap"><table class="sheet">
        <thead><tr><th>Project</th>${days.map(d => `<th class="${d === t ? 'is-today' : ''}">${fmt(parseYmd(d), { weekday: 'short' })}<small>${parseYmd(d).getDate()}</small></th>`).join('')}<th>Total</th></tr></thead>
        <tbody>${names.length ? names.map(n => `<tr><td>${esc(n)}</td>${rows[n].map((m, k) => `<td class="${days[k] === t ? 'is-today' : ''}">${hmm(m)}</td>`).join('')}<td><b>${hmm(rows[n].reduce((a, b) => a + b))}</b></td></tr>`).join('')
          : `<tr><td colspan="9" class="meta">Nothing tracked this week.</td></tr>`}</tbody>
        <tfoot><tr><td>Total</td>${days.map((d, k) => { const m = colSum(k); return `<td class="${d === t ? 'is-today' : ''}${m >= g.day * 60 ? ' met' : ''}" title="${m >= g.day * 60 ? 'Daily goal met' : ''}">${hmm(m) || '–'}</td>`; }).join('')}<td><b>${hmm(all) || '0:00'}</b></td></tr></tfoot>
      </table></div>`;
  }
  function exportCsv() {
    const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = ['date,start,end,minutes,hours,description,project,task,source'];
    for (const s of sessions.slice().sort((a, b) => a.started_at.localeCompare(b.started_at))) {
      const a = new Date(s.started_at), b = new Date(s.ended_at);
      lines.push([ymd(a), hm(a), hm(b), s.minutes, (s.minutes / 60).toFixed(2), q(s.label), q(s.project), q(byId(s.task_id)?.title), s.source || 'timer'].join(','));
    }
    const url = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    Object.assign(document.createElement('a'), { href: url, download: `time-entries-${todayStr()}.csv` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast(`Exported ${sessions.length} entries (last 150 days)`);
  }

  // manual entry / edit dialog
  const edlg = $('#entry-dialog'), ef = $('#entry-form');
  function openEntry(s = null) {
    ef.reset();
    const now = new Date(), q = 15 * 6e4, end = s ? new Date(s.ended_at) : new Date(Math.floor(+now / q) * q), start = s ? new Date(s.started_at) : new Date(+end - 36e5);
    ef.elements.id.value = s?.id || '';
    ef.elements.label.value = s?.label || '';
    ef.elements.project.value = s?.project || '';
    ef.elements.project.closest('label').hidden = !hasTime;
    ef.elements.task_id.innerHTML = '<option value="">No task</option>' + tasks.filter(x => x.kind === 'task' && (x.status !== 'done' || x.id === s?.task_id)).map(x => `<option value="${x.id}">${esc(x.title)}</option>`).join('');
    ef.elements.task_id.value = s?.task_id || '';
    ef.elements.date.value = ymd(start);
    ef.elements.start.value = hm(start);
    ef.elements.end.value = hm(end);
    ef.elements.duration.value = dur(Math.round((end - start) / 6e4));
    $('#entry-list').innerHTML = projects().map(p => `<option value="${esc(p)}">`).join('');
    $('#entry-h').textContent = s ? 'Edit time entry' : 'Add time manually';
    $('#entry-del').hidden = !s;
    $('#entry-msg').textContent = '';
    edlg.showModal();
    if (!s) ef.elements.label.focus();
  }
  ef.addEventListener('input', e => {   // keep end and duration in step with each other
    const f = ef.elements, st = f.start.value;
    if (!st) return;
    const base = new Date(`2000-01-01T${st}`);
    if (e.target === f.duration) { const m = parseDur(f.duration.value); if (m > 0) f.end.value = hm(new Date(+base + m * 6e4)); }
    else if ((e.target === f.end || e.target === f.start) && f.end.value) { let m = (new Date(`2000-01-01T${f.end.value}`) - base) / 6e4; if (m <= 0) m += 1440; f.duration.value = dur(m); }
  });
  ef.addEventListener('submit', async e => {
    e.preventDefault();
    const f = ef.elements, id = f.id.value, msg = $('#entry-msg');
    const start = new Date(`${f.date.value}T${f.start.value}`);
    let end = f.end.value ? new Date(`${f.date.value}T${f.end.value}`) : null;
    if (end && end <= start) end = addDays(end, 1);   // e.g. 23:00 – 01:00
    if (!end) { const m = parseDur(f.duration.value); if (!(m > 0)) { msg.textContent = 'Give an end time or a duration like 1h 30m.'; return; } end = new Date(+start + m * 6e4); }
    const minutes = Math.round((end - start) / 6e4);
    if (minutes < 1 || minutes > 1440) { msg.textContent = 'An entry must be between 1 minute and 24 hours.'; return; }
    const row = { label: f.label.value.trim() || null, task_id: f.task_id.value || null, started_at: start.toISOString(), ended_at: end.toISOString(), minutes };
    if (hasTime) { row.project = f.project.value.trim() || null; if (!id) row.source = 'manual'; }
    const { data, error } = await (id ? sb.from('focus_sessions').update(row).eq('id', id) : sb.from('focus_sessions').insert(row)).select().single();
    if (error) { msg.textContent = error.message; return; }
    if (id) Object.assign(sessions.find(s => s.id === id), data); else sessions.push(data);
    edlg.close(); toast(id ? 'Entry saved' : `Added ${dur(minutes)}`); render();
  });
  $('#entry-del').addEventListener('click', async () => {
    const id = ef.elements.id.value;
    if (!id || !confirm('Delete this time entry?')) return;
    const { error } = await sb.from('focus_sessions').delete().eq('id', id);
    if (error) { $('#entry-msg').textContent = error.message; return; }
    sessions = sessions.filter(s => s.id !== id); edlg.close(); toast('Entry deleted'); render();
  });

  // ───────── analytics
  function streak() {
    const active = new Set([...tasks.filter(x => x.done_at).map(x => ymd(new Date(x.done_at))), ...sessions.map(sday)]);
    let n = 0, d = dayStart(new Date());
    if (!active.has(ymd(d))) d = addDays(d, -1);   // a quiet morning doesn't break yesterday's streak
    while (active.has(ymd(d))) { n++; d = addDays(d, -1); }
    return n;
  }
  const num = v => String(+(+v).toFixed(2));
  // single series, one hue, rounded data-ends on the baseline, hover tips, optional dashed goal line
  function barChart(rows, unit, goal = 0, W = 680) {
    const Hh = 170, L = 34, B = 24, T0 = 14, max = Math.max(goal * 1.1, ...rows.map(r => r.v), unit === ' h' ? 1 : 4);
    const step = [.25, .5, 1, 2, 5, 10, 15, 20, 30, 60, 120, 240].find(s => max / s <= 4) || Math.ceil(max / 4), top = Math.ceil(max / step) * step;
    const y = v => T0 + (Hh - T0 - B) * (1 - v / top), bw = (W - L) / rows.length, w = Math.max(2, Math.min(26, bw * .62));
    const every = Math.ceil(rows.length / 10);
    const grid = Array.from({ length: Math.round(top / step) + 1 }, (_, k) => k * step).map(v => `<line x1="${L}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${num(v)}</text>`).join('');
    const bars = rows.map((r, k) => {
      const x = L + bw * k + (bw - w) / 2, y0 = y(0), y1 = y(r.v), rr = Math.min(4, w / 2, y0 - y1);
      const path = r.v > 0 ? `<path d="M${x},${y0}V${y1 + rr}Q${x},${y1} ${x + rr},${y1}H${x + w - rr}Q${x + w},${y1} ${x + w},${y1 + rr}V${y0}Z"/>` : '';
      return `<g class="bar" data-tip="${esc(r.tip)}: ${num(r.v)}${unit}">${path}<rect class="hit" x="${L + bw * k}" y="${T0}" width="${bw}" height="${Hh - T0 - B}"/>${k % every === 0 ? `<text x="${x + w / 2}" y="${Hh - 6}" text-anchor="middle">${esc(r.label)}</text>` : ''}</g>`;
    }).join('');
    const goalLine = goal ? `<line class="goal-line" x1="${L}" x2="${W}" y1="${y(goal)}" y2="${y(goal)}"/><text class="goal-lbl" x="${W}" y="${y(goal) - 5}" text-anchor="end">goal ${num(goal)}${unit.trim()}</text>` : '';
    return `<div class="chart"><svg viewBox="0 0 ${W} ${Hh}" role="img"><g class="grid">${grid}</g><line class="base" x1="${L}" x2="${W}" y1="${y(0)}" y2="${y(0)}"/>${bars}${goalLine}</svg><div class="tip" hidden></div></div>`;
  }
  // last 12 weeks, one square per day; sequential single-hue ramp (more time = deeper accent)
  function heatmap() {
    const weeks = 20, s0 = addDays(startOfWeek(new Date()), -7 * (weeks - 1)), t = todayStr(), per = {};
    for (const s of sessions) per[sday(s)] = (per[sday(s)] || 0) + s.minutes;
    const lvl = m => !m ? 0 : m < 60 ? 1 : m < 120 ? 2 : m < 240 ? 3 : 4;
    let cells = '';
    for (let k = 0; k < weeks * 7; k++) {
      const d = ymd(addDays(s0, k)), m = per[d] || 0;
      cells += d > t ? '<i class="fut"></i>' : `<i class="l${lvl(m)}" data-tip="${fmt(parseYmd(d), { weekday: 'short', month: 'short', day: 'numeric' })}: ${m ? dur(m) : 'nothing'}"></i>`;
    }
    const months = Array.from({ length: weeks }, (_, w) => { const d = addDays(s0, 7 * w); return d.getDate() <= 7 ? `<span style="grid-column:${w + 1}">${fmt(d, { month: 'short' })}</span>` : ''; }).join('');
    return `<div class="chart heat-wrap"><div class="heat-days"><span></span><span>Mon</span><span></span><span>Wed</span><span></span><span>Fri</span><span></span><span></span></div>
      <div><div class="heat-months">${months}</div><div class="heat">${cells}</div></div><div class="tip" hidden></div></div>
      <p class="heat-legend">Less <i class="l0"></i><i class="l1"></i><i class="l2"></i><i class="l3"></i><i class="l4"></i> More <span>· under 1h, 1–2h, 2–4h, 4h+</span></p>`;
  }
  function vStats() {
    const g = GOAL(), days = Array.from({ length: statRange }, (_, k) => ymd(addDays(new Date(), k - statRange + 1)));
    const from = days[0];
    const done = tasks.filter(x => x.done_at && ymd(new Date(x.done_at)) >= from);
    const sess = sessions.filter(s => sday(s) >= from);
    const total = sumMin(sess), activeDays = new Set(sess.map(sday)).size;
    const dated = done.filter(x => x.due_date);
    const onTime = dated.length ? Math.round(100 * dated.filter(x => ymd(new Date(x.done_at)) <= x.due_date).length / dated.length) : null;
    const label = d => statRange <= 7 ? fmt(parseYmd(d), { weekday: 'short' }) : `${parseYmd(d).getMonth() + 1}/${parseYmd(d).getDate()}`;
    const perDay = fn => days.map(d => ({ label: label(d), tip: fmt(parseYmd(d), { weekday: 'short', month: 'short', day: 'numeric' }), v: fn(d) }));
    const doneRows = perDay(d => done.filter(x => ymd(new Date(x.done_at)) === d).length);
    const minDay = d => sumMin(sess.filter(s => sday(s) === d));
    const hourRows = perDay(d => +(minDay(d) / 60).toFixed(1));
    const goalDays = days.filter(d => minDay(d) >= g.day * 60).length;
    // when you work: minutes split into the clock hours they actually covered
    const byHour = Array(24).fill(0);
    for (const s of sess) for (let a = +new Date(s.started_at), b = +new Date(s.ended_at); a < b;) { const h = new Date(a), next = Math.min(b, +new Date(h.getFullYear(), h.getMonth(), h.getDate(), h.getHours() + 1)); byHour[h.getHours()] += (next - a) / 6e4; a = next; }
    const hourOfDay = byHour.map((m, h) => ({ label: `${h}`, tip: `${pad(h)}:00–${pad((h + 1) % 24)}:00`, v: +(m / 60).toFixed(1) }));
    // last 8 weeks
    const w0 = startOfWeek(new Date());
    const weekRows = Array.from({ length: 8 }, (_, k) => { const s = addDays(w0, -7 * (7 - k)), e = ymd(addDays(s, 6)); return { label: `${s.getMonth() + 1}/${s.getDate()}`, tip: `Week of ${fmt(s, { month: 'short', day: 'numeric' })}`, v: +(sumMin(sessions.filter(x => sday(x) >= ymd(s) && sday(x) <= e)) / 60).toFixed(1) }; });
    const byP = {};
    for (const s of sess) byP[projOf(s)] = (byP[projOf(s)] || 0) + s.minutes;
    const pRows = Object.entries(byP).sort((a, b) => b[1] - a[1]).slice(0, 8), pMax = Math.max(1, ...pRows.map(r => r[1]));
    return `<div class="toolbar"><div class="chips">${[7, 30, 90].map(n => `<button type="button" data-range="${n}" aria-pressed="${statRange === n}">Last ${n} days</button>`).join('')}</div></div>
      <div class="stats-row pl-stats">
        ${tile('Hours tracked', dur(total), `${dur(Math.round(total / Math.max(1, activeDays)))} per working day`)}
        ${tile('Daily goal met', `${goalDays}/${statRange}`, `days with ${g.day}h or more`)}
        ${tile('Tasks done', done.length, onTime === null ? `${(done.length / statRange).toFixed(1)} per day` : `${onTime}% on time`)}
        ${tile('Streak', `${streak()}d`, `${tasks.filter(isOverdue).length} overdue now`)}
      </div>
      <div class="pl-charts">
        <section class="pl-card wide"><h3>Hours per day</h3>${barChart(hourRows, ' h', g.day, 1240)}</section>
        <section class="pl-card"><h3>Activity · last 20 weeks</h3>${heatmap()}</section>
        <section class="pl-card"><h3>Time by project</h3>${pRows.length ? pRows.map(([n, m]) => `<div class="hbar"><span>${esc(n)}</span><i style="--w:${(100 * m / pMax).toFixed(1)}%"></i><b>${dur(m)} · ${Math.round(100 * m / total)}%</b></div>`).join('') : '<p class="meta">Track time with a project to see the split.</p>'}</section>
        <section class="pl-card"><h3>When you work</h3>${barChart(hourOfDay, ' h')}</section>
        <section class="pl-card"><h3>Weekly hours · last 8 weeks</h3>${barChart(weekRows, ' h', g.week)}</section>
        <section class="pl-card"><h3>Tasks completed per day</h3>${barChart(doneRows, '')}</section>
        <section class="pl-card"><h3>As a table</h3><details><summary class="meta">Show daily numbers</summary><table class="dtable"><thead><tr><th>Day</th><th>Hours</th><th>Tasks done</th></tr></thead><tbody>
          ${days.map((d, k) => [d, k]).reverse().map(([d, k]) => `<tr><td>${fmt(parseYmd(d), { weekday: 'short', month: 'short', day: 'numeric' })}</td><td>${dur(minDay(d))}</td><td>${doneRows[k].v}</td></tr>`).join('')}
        </tbody></table></details></section>
      </div>`;
  }

  // ───────── bookings (public "book a call" page → calls land here and in the calendar)
  let bookings = [], bset = null, hasBook = false;
  async function loadBookings() {
    const [b, s] = await Promise.all([sb.from('bookings').select('*').order('start_at'), sb.from('booking_settings').select('*').eq('id', 1).maybeSingle()]);
    hasBook = !b.error && !s.error && !!s.data;
    bookings = b.data || []; bset = s.data;
  }
  const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const MEET = { google_meet: 'Google Meet', zoom: 'Zoom', teams: 'Microsoft Teams', kakaotalk: 'KakaoTalk', phone: 'Phone call', in_person: 'In person' };
  const needsLink = b => !['phone', 'in_person'].includes(b.meet || 'google_meet');
  // a ready-to-send email: the meeting details are filled in, you only paste the link
  const mailFor = b => {
    const s = new Date(b.start_at), when = `${fmt(s, { weekday: 'long', month: 'long', day: 'numeric' })}, ${hm(s)}–${hm(new Date(b.end_at))} (${Intl.DateTimeFormat().resolvedOptions().timeZone} time)`;   // printed in this device's zone, so label it that way
    const kind = MEET[b.meet] || 'Online call', first = b.name.split(' ')[0];
    const body = [`Hi ${first},`, '', `Thanks for booking a call. Here are the details:`, '', `When: ${when}`, `Where: ${kind}`,
      needsLink(b) ? 'Link: ' : b.meet === 'phone' ? `I'll call you at ${b.phone}.` : `Place: ${bset?.in_person_place || ''}`,
      '', 'See you then,', 'Rashid'].join('\n');
    return `mailto:${encodeURIComponent(b.email)}?subject=${encodeURIComponent(`${kind}: our call on ${fmt(s, { weekday: 'short', month: 'short', day: 'numeric' })} at ${hm(s)}`)}&body=${encodeURIComponent(body)}`;
  };
  const bookRow = b => {
    const s = new Date(b.start_at), live = b.status === 'confirmed' && Date.parse(b.end_at) > Date.now(), link = needsLink(b);
    return `<div class="bk-row${b.status === 'cancelled' ? ' cancelled' : ''}${live && link && !b.link_sent ? ' todo' : ''}">
      <div class="bk-time"><b>${fmt(s, { weekday: 'short', month: 'short', day: 'numeric' })}</b><span>${hm(s)}–${hm(new Date(b.end_at))} · ${b.minutes} min</span></div>
      <div class="bk-who"><b>${esc(b.name)}</b><a href="mailto:${esc(b.email)}">${esc(b.email)}</a>
        <span class="t-meta"><span class="proj">${esc(MEET[b.meet] || 'Google Meet')}</span>${b.phone ? `<a href="tel:${esc(b.phone)}">${esc(b.phone)}</a>` : ''}${live && link ? (b.link_sent ? '<span class="sent">✓ link sent</span>' : '<span class="flag">link not sent yet</span>') : ''}</span>
        ${b.note ? `<p>${esc(b.note)}</p>` : ''}</div>
      <div class="actions">${b.status === 'cancelled' ? '<span class="lock">cancelled</span>' : ''}${live ? `<a class="btn btn-sm${link && !b.link_sent ? '' : ' ghost'}" href="${esc(mailFor(b))}">${link ? 'Email link' : 'Email'}</a>${link ? `<button type="button" class="btn btn-sm ghost" data-bklink="${b.id}">${b.link_sent ? 'Mark not sent' : 'Mark link sent'}</button>` : ''}<button type="button" class="btn btn-sm ghost" data-bkcancel="${b.id}">Cancel</button>` : ''}</div>
    </div>`;
  };
  function vBook() {
    if (!hasBook) return '<p class="notice">Run <code>supabase/booking.sql</code> in Supabase → SQL Editor once to turn on the booking page, then reload.</p>';
    const S = bset, link = new URL('/book', location.href).href, now = Date.now();
    const up = bookings.filter(b => b.status === 'confirmed' && Date.parse(b.end_at) > now);
    const past = bookings.filter(b => !up.includes(b)).reverse().slice(0, 30);
    const hours = S.hours || {};
    return `
      <section class="pl-card bk-share">
        <div><h3>Your booking page</h3><p class="meta">${S.enabled ? 'Open: anyone with the link can book a call.' : 'Closed: switch it on in the settings below.'}</p></div>
        <code>${esc(link)}</code>
        <div class="actions"><button type="button" class="btn btn-sm" data-copylink="${esc(link)}">Copy link</button><a class="btn btn-sm ghost" href="/book" target="_blank" rel="noopener">Open ↗</a></div>
      </section>
      <section class="pl-card"><h3>Upcoming calls · ${up.length}</h3>${up.length ? up.map(bookRow).join('') : '<p class="meta">No calls booked yet. Share your link with friends and coworkers.</p>'}</section>
      <form class="pl-card bk-set" data-bookset>
        <div class="card-h"><h3>Settings</h3><label class="switch-row"><input type="checkbox" name="enabled"${S.enabled ? ' checked' : ''}> Booking page open</label></div>
        <div class="bk-set-grid">
          <label class="full">Title <input name="title" maxlength="80" value="${esc(S.title)}"></label>
          <label class="full">Intro <textarea name="intro" rows="2" maxlength="400">${esc(S.intro)}</textarea></label>
          <fieldset class="full"><legend>Call lengths</legend>${[15, 20, 30, 45, 60, 90].map(n => `<label class="check"><input type="checkbox" name="dur" value="${n}"${S.durations.includes(n) ? ' checked' : ''}> ${n} min</label>`).join('')}</fieldset>
          <fieldset class="full"><legend>Weekly hours (${esc(S.tz)})</legend><div class="bk-hours">${WD.map((w, i) => { const r = (hours[i + 1] || [])[0]; return `<div class="bk-hour"><label class="check"><input type="checkbox" name="on${i + 1}"${r ? ' checked' : ''}> ${w}</label><input type="time" name="from${i + 1}" value="${r ? r[0] : '10:00'}" aria-label="${w} from"><span>–</span><input type="time" name="to${i + 1}" value="${r ? r[1] : '18:00'}" aria-label="${w} until"></div>`; }).join('')}</div></fieldset>
          <label>Minimum notice (hours) <input name="notice" type="number" min="0" max="336" value="${S.min_notice_min / 60}"></label>
          <label>Book up to (days ahead) <input name="days" type="number" min="1" max="90" value="${S.max_days}"></label>
          <label>Buffer between calls (min) <input name="buffer" type="number" min="0" max="120" value="${S.buffer_min}"></label>
          <label>Time zone <input name="tz" value="${esc(S.tz)}" list="tz-list"><datalist id="tz-list"><option value="Asia/Seoul"><option value="Asia/Tashkent"><option value="Asia/Almaty"><option value="Europe/London"><option value="America/New_York"></datalist></label>
          <fieldset class="full"><legend>Ways to meet (people pick one; you email the link)</legend>${Object.entries(MEET).map(([k, l]) => `<label class="check"><input type="checkbox" name="meet" value="${k}"${(S.meet_options || ['google_meet', 'zoom']).includes(k) ? ' checked' : ''}> ${l}</label>`).join('')}</fieldset>
          <label class="full">In-person place (shown when someone picks “In person”) <input name="place" maxlength="160" value="${esc(S.in_person_place || '')}" placeholder="e.g. Inha University, Hi-Tech Center lobby"></label>
        </div>
        <div class="actions"><button class="btn" type="submit">Save settings</button><span class="meta">Times already on your calendar are blocked automatically.</span></div>
      </form>
      ${past.length ? `<details class="pl-card"><summary class="meta">Past and cancelled · ${past.length}</summary>${past.map(bookRow).join('')}</details>` : ''}`;
  }
  async function saveBookSettings(form) {
    const f = form.elements, hours = {};
    for (let i = 1; i <= 7; i++) hours[i] = f[`on${i}`].checked && f[`from${i}`].value < f[`to${i}`].value ? [[f[`from${i}`].value, f[`to${i}`].value]] : [];
    const durations = [...form.querySelectorAll('[name=dur]:checked')].map(x => +x.value);
    if (!durations.length) return toast('Pick at least one call length');
    const meet_options = [...form.querySelectorAll('[name=meet]:checked')].map(x => x.value);
    if (!meet_options.length) return toast('Pick at least one way to meet');
    try { new Intl.DateTimeFormat('en', { timeZone: f.tz.value.trim() }); } catch (e) { return toast('Unknown time zone, e.g. Asia/Seoul'); }
    const row = { enabled: f.enabled.checked, title: f.title.value.trim() || 'Book a call', intro: f.intro.value.trim(), durations, hours, tz: f.tz.value.trim(),
      min_notice_min: Math.round(Math.max(0, +f.notice.value) * 60), max_days: Math.min(90, Math.max(1, +f.days.value)), buffer_min: Math.min(120, Math.max(0, +f.buffer.value)),
      meet_options, in_person_place: f.place.value.trim() || null };
    const { data, error } = await sb.from('booking_settings').update(row).eq('id', 1).select().single();
    if (error) return toast(error.message);
    bset = data; toast(row.enabled ? 'Saved · booking page is open' : 'Saved · booking page is closed'); render();
  }

  // ───────── render + events
  const VIEWS = { today: vToday, calendar: vCalendar, tasks: vTasks, notes: vNotes, focus: vFocus, stats: vStats, book: vBook };
  function render() {
    if (!VIEWS[view]) view = 'today';
    $$('[data-v]').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === view));
    $('#pl-date').textContent = fmt(new Date(), { weekday: 'long', month: 'long', day: 'numeric' });
    const prev = root().querySelector('.tg-body')?.scrollTop;
    root().innerHTML = VIEWS[view]();
    const body = root().querySelector('.tg-body');
    if (body) body.scrollTop = prev ?? Math.max(0, (new Date().getHours() - 8) * HOUR - 40);
    tick();
  }
  const go = v => { view = v; store.set('pl-view', v); render(); };

  // task / event dialog
  const dlg = $('#task-dialog'), tf = $('#task-form');
  function openTask(t = {}, preset = {}) {
    tf.reset();
    const kind = t.kind || preset.kind || 'task', s = t.start_at ? new Date(t.start_at) : null, e = t.end_at ? new Date(t.end_at) : null;
    tf.elements.id.value = t.id || '';
    tf.querySelector(`[name=kind][value=${kind}]`).checked = true;
    tf.elements.title.value = t.title || '';
    tf.elements.date.value = s ? ymd(s) : (t.due_date || preset.day || '');
    tf.elements.start.value = s ? hm(s) : (preset.start || '');
    tf.elements.end.value = e ? hm(e) : (preset.end || '');
    tf.elements.status.value = t.status || 'todo';
    tf.elements.priority.value = String(t.priority || 2);
    tf.elements.repeat.value = t.repeat || 'none';
    tf.elements.repeat_until.value = t.repeat_until || '';
    tf.elements.remind_min.value = t.remind_min ?? '';
    tf.elements.remind_min.closest('label').hidden = !hasRemind;
    tf.elements.estimate_min.value = t.estimate_min || '';
    tf.elements.tags.value = (t.tags || []).join(', ');
    tf.elements.opportunity_id.innerHTML = '<option value="">None</option>' + opps.map(o => `<option value="${o.id}">${esc(o.title)}</option>`).join('');
    tf.elements.opportunity_id.value = t.opportunity_id || '';
    tf.elements.checklist.value = checklistOf(t).map(c => `${c.done ? '[x] ' : ''}${c.text}`).join('\n');
    tf.elements.notes.value = t.notes || '';
    $('#task-h').textContent = t.id ? `Edit ${kind}` : `New ${kind}`;
    $('#task-del').hidden = !t.id;
    $('#task-msg').textContent = '';
    syncKind();
    dlg.showModal();
    if (!t.id) tf.elements.title.focus();
  }
  function syncKind() {
    const ev = tf.querySelector('[name=kind]:checked').value === 'event';
    $$('.ev-only', tf).forEach(x => { x.hidden = !ev; });
    $$('.task-only', tf).forEach(x => { x.hidden = ev; });
    if (!tf.elements.id.value) $('#task-h').textContent = ev ? 'New event' : 'New task';
  }
  $$('[name=kind]', tf).forEach(r => r.addEventListener('change', syncKind));
  $$('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
  tf.addEventListener('submit', async e => {
    e.preventDefault();
    const f = tf.elements, kind = tf.querySelector('[name=kind]:checked').value, id = f.id.value;
    const date = f.date.value || null, st = f.start.value, en = f.end.value;
    if (kind === 'event' && !date) { $('#task-msg').textContent = 'An event needs a date.'; return; }
    if (en && !st) { $('#task-msg').textContent = 'Add a start time too.'; return; }
    if (st && !date) { $('#task-msg').textContent = 'Add a date for the start time.'; return; }
    const start = date && st ? new Date(`${date}T${st}`) : null;
    let end = start && en ? new Date(`${date}T${en}`) : null;
    if (end && end <= start) end = addDays(end, 1);   // e.g. 23:00 – 01:00
    const prev = id ? byId(id) : null;
    // ticking "done" on a repeating task in here behaves like the checkbox: log it and move to the next date
    const finishing = kind === 'task' && f.status.value === 'done' && date && f.repeat.value !== 'none' && prev?.status !== 'done';
    const status = kind === 'event' || finishing ? 'todo' : f.status.value;
    const row = {
      kind, title: f.title.value.trim(), status, priority: +f.priority.value,
      due_date: start ? null : date, start_at: start && start.toISOString(), end_at: end && end.toISOString(),
      repeat: date ? f.repeat.value : 'none',
      repeat_until: date && f.repeat.value !== 'none' ? (f.repeat_until.value || null) : null,
      estimate_min: f.estimate_min.value ? +f.estimate_min.value : null,
      tags: f.tags.value.split(',').map(x => x.trim().replace(/^#/, '').toLowerCase()).filter(Boolean),
      opportunity_id: f.opportunity_id.value || null,
      checklist: f.checklist.value.split('\n').map(l => l.trim()).filter(Boolean).map(l => ({ done: /^\[x\]\s*/i.test(l), text: l.replace(/^\[[ x]?\]\s*/i, '') })),
      notes: f.notes.value.trim() || null,
      done_at: status === 'done' ? (prev?.done_at || new Date().toISOString()) : null,
    };
    if (hasRemind) { row.remind_min = f.remind_min.value === '' ? null : +f.remind_min.value; row.remind_at = remindAt(row); }
    const { data, error } = await (id ? sb.from('tasks').update(row).eq('id', id) : sb.from('tasks').insert(row)).select().single();
    if (error) { $('#task-msg').textContent = error.message; return; }
    if (id) Object.assign(prev, data); else tasks.push(data);
    dlg.close();
    if (finishing) return completeRepeating(byId(data.id));
    toast(id ? 'Saved' : kind === 'event' ? 'Event added' : 'Task added'); render();
  });
  $('#task-del').addEventListener('click', async () => {
    const id = tf.elements.id.value;
    if (!id || !confirm('Delete this for good?')) return;
    const { error } = await sb.from('tasks').delete().eq('id', id);
    if (error) { $('#task-msg').textContent = error.message; return; }
    tasks = tasks.filter(t => t.id !== id); dlg.close(); toast('Deleted'); render();
  });

  // notes autosave
  let noteTimer = null;
  async function saveNote(n) {
    const { data, error } = await sb.from('notes').update({ title: n.title, body: n.body, tags: n.tags, pinned: n.pinned }).eq('id', n.id).select().single();
    const s = $('.note-state');
    if (error) { if (s) s.textContent = `Not saved: ${error.message}`; return; }
    Object.assign(n, data);
    if (s) s.textContent = 'Saved';
  }
  const keepFocus = sel => { const i = $(sel); if (!i) return; const p = i.value.length; i.focus(); i.setSelectionRange(p, p); };

  function wire() {
    $$('[data-v]').forEach(b => b.addEventListener('click', () => go(b.dataset.v)));
    $('#mini-timer').addEventListener('click', () => go('focus'));
    const r = root();
    // calendar blocks: drag to move (15-min steps, across days), drag the bottom edge to resize. Pointer events → mouse + touch.
    let drag = null, justDragged = false;
    r.addEventListener('pointerdown', e => {
      const blk = e.target.closest('.blk'), t = blk && byId(blk.dataset.open);
      if (!t || e.button !== 0) return;
      drag = { blk, t, x0: e.clientX, y0: e.clientY, top: blk.offsetTop, h: blk.offsetHeight, resize: !!e.target.closest('.rs'), moved: false };
    });
    addEventListener('pointermove', e => {
      if (!drag) return;
      const dy = e.clientY - drag.y0, q = HOUR / 4, snap = px => Math.round(px / q) * q;
      if (!drag.moved && Math.hypot(e.clientX - drag.x0, dy) < 6) return;
      if (!drag.moved) { drag.moved = true; drag.blk.classList.add('dragging'); }
      e.preventDefault();
      if (drag.resize) { drag.blk.style.height = `${Math.max(q, snap(drag.h + 3 + dy)) - 3}px`; return; }
      const col = $$('.tg-col', r).find(c => { const b = c.getBoundingClientRect(); return e.clientX >= b.left && e.clientX < b.right; }) || drag.blk.parentElement;
      if (col !== drag.blk.parentElement) col.append(drag.blk);
      Object.assign(drag.blk.style, { left: '0', width: 'calc(100% - 4px)', top: `${Math.max(0, snap(drag.top + dy))}px` });
    });
    addEventListener('pointerup', () => {
      const d = drag; drag = null;
      if (!d || !d.moved) return;
      justDragged = true; setTimeout(() => { justDragged = false; }, 0);   // swallow the click that follows the drag
      const s = +d.blk.dataset.s, en = +d.blk.dataset.e, col = d.blk.parentElement;
      if (d.resize) return shiftTimed(d.t, 0, s + (parseFloat(d.blk.style.height) + 3) / HOUR * 36e5 - en);
      const ns = parseYmd(col.dataset.slot);
      ns.setMinutes(Math.round((+col.dataset.h0 + parseFloat(d.blk.style.top) / HOUR) * 60));
      shiftTimed(d.t, +ns - s, +ns - s);
    });
    addEventListener('pointercancel', () => { if (drag) { drag = null; render(); } });

    r.addEventListener('click', async e => {
      if (justDragged) return;
      const el = e.target.closest('button, a, [data-slot], [data-newday]');
      if (!el || el.tagName === 'A') return;
      const d = el.dataset;
      if (d.open) return openTask(byId(d.open));
      if (d.goto) { cal = { mode: 'day', anchor: parseYmd(d.goto) }; store.set('pl-cal', 'day'); return go('calendar'); }
      if (d.new) return openTask({}, { kind: d.new, day: d.day });
      if (d.cal) {
        const a = cal.anchor, k = d.cal === 'prev' ? -1 : 1;
        cal.anchor = d.cal === 'today' ? new Date() : cal.mode === 'month' ? new Date(a.getFullYear(), a.getMonth() + k, 1) : addDays(a, cal.mode === 'week' ? weekDays() * k : k);
        return render();
      }
      if (d.calmode) { cal.mode = d.calmode; store.set('pl-cal', cal.mode); return render(); }
      if (d.tmode) { taskMode = d.tmode; store.set('pl-tasks', taskMode); return render(); }
      if (d.tf) { taskFilter = d.tf; return render(); }
      if (d.range) { statRange = +d.range; return render(); }
      if (d.focus) { T.taskId = d.focus; T.label = ''; saveT(); go('focus'); if (!T.running) timer.start(); return; }
      // time tracking
      if ('addentry' in d) return openEntry();
      if (d.editentry) return openEntry(sessions.find(s => s.id === d.editentry));
      if (d.cont) {
        const s = sessions.find(x => x.id === d.cont);
        if (T.running) await timer.finish();
        Object.assign(T, { mode: 'watch', label: s.label || '', project: s.project || '', taskId: s.task_id || null });
        return timer.start();
      }
      if (d.delentry) {
        if (!confirm('Delete this time entry?')) return;
        const { error } = await sb.from('focus_sessions').delete().eq('id', d.delentry);
        if (error) return toast(error.message);
        sessions = sessions.filter(s => s.id !== d.delentry); toast('Entry deleted'); return render();
      }
      if (d.timemode) { timeMode = d.timemode; store.set('pl-time', timeMode); return render(); }
      if (d.sheet !== undefined) { sheetAnchor = +d.sheet ? addDays(sheetAnchor, 7 * +d.sheet) : new Date(); return render(); }
      if ('moredays' in d) { logDays += 14; return render(); }
      if ('export' in d) return exportCsv();
      // bookings
      if (d.copylink) { await navigator.clipboard.writeText(d.copylink); return toast('Booking link copied'); }
      if (d.bklink) {
        const b = bookings.find(x => x.id === d.bklink), link_sent = !b.link_sent;
        const { error } = await sb.from('bookings').update({ link_sent }).eq('id', b.id);
        if (error) return toast(error.message);
        b.link_sent = link_sent; toast(link_sent ? `Marked: link sent to ${b.name}` : 'Marked as not sent'); return render();
      }
      if (d.bkcancel) {
        const b = bookings.find(x => x.id === d.bkcancel);
        if (!b || !confirm(`Cancel the call with ${b.name}? Let them know by email too.`)) return;
        const { error } = await sb.from('bookings').update({ status: 'cancelled', cancelled_at: new Date().toISOString() }).eq('id', b.id);
        if (error) return toast(error.message);
        if (b.task_id) { await sb.from('tasks').delete().eq('id', b.task_id); tasks = tasks.filter(t => t.id !== b.task_id); }
        Object.assign(b, { status: 'cancelled' }); toast('Call cancelled'); return render();
      }
      if (d.timer) return timer[d.timer]();
      if (d.tmodeset) { if (T.running) return; T.mode = d.tmodeset; return timer.reset(); }
      if (d.note) { noteId = d.note; return render(); }
      if ('newnote' in d) {
        const { data, error } = await sb.from('notes').insert({ title: '', body: '' }).select().single();
        if (error) return toast(error.message);
        notes.unshift(data); noteId = data.id; render(); $('.note-title')?.focus(); return;
      }
      const n = notes.find(x => x.id === noteId);
      if ('pin' in d && n) { n.pinned = !n.pinned; await saveNote(n); return render(); }
      if ('preview' in d) { const p = $('.note-prev'), ta = $('[data-nf=body]'); p.innerHTML = md(ta.value); p.hidden = !p.hidden; ta.hidden = !p.hidden; return; }
      if ('delnote' in d && n && confirm('Delete this note?')) {
        const { error } = await sb.from('notes').delete().eq('id', n.id);
        if (error) return toast(error.message);
        notes = notes.filter(x => x.id !== n.id); noteId = null; toast('Note deleted'); return render();
      }
      // empty calendar space: a half-hour slot (week/day) or a day (month cell, all-day row)
      if (el !== e.target) return;
      if (d.slot) {
        const hr = +d.h0 + Math.floor((e.offsetY / HOUR) * 2) / 2, h = Math.floor(hr), m = hr % 1 ? '30' : '00';
        return openTask({}, { kind: 'event', day: d.slot, start: `${pad(h)}:${m}`, end: `${pad(Math.min(23, h + 1))}:${m}` });
      }
      if (d.newday) return openTask({}, { kind: 'task', day: d.newday });
    });
    r.addEventListener('change', e => {
      const d = e.target.dataset;
      if (d.done) return setStatus(d.done, e.target.checked ? 'done' : 'todo');
      if ('ttag' in d) { taskTag = e.target.value; return render(); }
      if ('ttask' in d) { T.taskId = e.target.value || null; if (!T.label.trim()) T.label = ''; return saveT(); }
      if (d.goal) { const g = store.get('pl-goal', {}); g[d.goal] = Math.max(.5, +e.target.value || 1); store.set('pl-goal', g); return render(); }
      if (d.cfg) {
        const c = store.get('pl-timer-cfg', {}); c[d.cfg] = Math.max(1, +e.target.value || 1); store.set('pl-timer-cfg', c);
        if (!T.running) { T.remaining = null; saveT(); }
        return render();
      }
    });
    r.addEventListener('input', e => {
      const d = e.target.dataset;
      if ('tdesc' in d) { T.label = e.target.value; saveT(); return; }      // the running timer picks these up when it stops
      if ('tproj' in d) { T.project = e.target.value; saveT(); return; }
      if ('tq' in d) { taskQ = e.target.value.trim().toLowerCase(); render(); return keepFocus('[data-tq]'); }
      if ('nq' in d) { noteQ = e.target.value; render(); return keepFocus('[data-nq]'); }
      if (d.nf) {
        const n = notes.find(x => x.id === noteId);
        if (!n) return;
        n[d.nf] = d.nf === 'tags' ? e.target.value.split(',').map(x => x.trim()).filter(Boolean) : e.target.value;
        if (d.nf === 'title') { const b = $('.note-item.on b'); if (b) b.textContent = `${n.pinned ? '📌 ' : ''}${n.title || 'Untitled'}`; }
        $('.note-state').textContent = 'Saving…';
        clearTimeout(noteTimer); noteTimer = setTimeout(() => saveNote(n), 700);
      }
    });
    r.addEventListener('submit', e => {
      if (e.target.matches('[data-bookset]')) { e.preventDefault(); return saveBookSettings(e.target); }
      if (!e.target.matches('[data-quick]')) return;
      e.preventDefault();
      const v = e.target.elements.q.value.trim();
      if (v) quickAdd(v);
    });
    // drag & drop: board cards between columns; calendar chips (month cells, all-day row) between days
    r.addEventListener('dragstart', e => {
      const c = e.target.closest?.('[data-drag]'), ch = e.target.closest?.('[data-dday]');
      if (c) { e.dataTransfer.setData('text/plain', c.dataset.drag); c.classList.add('dragging'); }
      else if (ch) { e.dataTransfer.setData('text/plain', `day:${ch.dataset.dday}|${ch.closest('[data-newday]')?.dataset.newday || ''}`); ch.classList.add('dragging'); }
    });
    r.addEventListener('dragend', e => e.target.closest?.('[data-drag], [data-dday]')?.classList.remove('dragging'));
    const dropZone = e => e.target.closest?.('[data-drop], [data-newday]');
    r.addEventListener('dragover', e => { const z = dropZone(e); if (z) { e.preventDefault(); z.classList.add('over'); } });
    r.addEventListener('dragleave', e => dropZone(e)?.classList.remove('over'));
    r.addEventListener('drop', e => {
      const z = dropZone(e);
      if (!z) return;
      e.preventDefault(); z.classList.remove('over');
      const v = e.dataTransfer.getData('text/plain');
      if (z.dataset.drop && !v.startsWith('day:')) { const t = byId(v); if (t && t.status !== z.dataset.drop) setStatus(v, z.dataset.drop); }
      if (z.dataset.newday && v.startsWith('day:')) { const [id, from] = v.slice(4).split('|'), t = byId(id); if (t && from) moveDay(t, from, z.dataset.newday); }
    });
    // chart hover tips
    r.addEventListener('mousemove', e => {
      const g = e.target.closest?.('.chart [data-tip]'), chart = e.target.closest?.('.chart');
      $$('.chart .tip', r).forEach(t => { if (!g || !chart || !chart.contains(t)) t.hidden = true; });
      $$('.chart .hl', r).forEach(b => { if (b !== g) b.classList.remove('hl'); });
      if (!g || !chart) return;
      const tip = chart.querySelector('.tip'), box = chart.getBoundingClientRect();
      g.classList.add('hl'); tip.hidden = false; tip.textContent = g.dataset.tip;
      tip.style.left = `${Math.min(box.width - tip.offsetWidth, Math.max(0, e.clientX - box.left - tip.offsetWidth / 2))}px`;
      tip.style.top = `${Math.max(0, e.clientY - box.top - 44)}px`;
    });
    // keyboard: n = new task, 1–6 = views (not while typing)
    addEventListener('keydown', e => {
      if (e.target.closest('input, textarea, select, dialog') || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'n') { e.preventDefault(); openTask(); }
      const k = '1234567'.indexOf(e.key);
      if (k >= 0 && e.key) go(Object.keys(VIEWS)[k]);
    });
    setInterval(tick, 500);
    let wasNarrow = weekDays() === 3;   // re-lay the calendar when crossing the phone/desktop width
    addEventListener('resize', () => { const n = weekDays() === 3; if (n !== wasNarrow) { wasNarrow = n; if (view === 'calendar') render(); } });
    setInterval(() => { if ($('.now') && !dlg.open && !document.activeElement?.matches('input, textarea')) render(); }, 6e4);   // move the "now" line
  }

  // ───────── reminders on this device (Web Push; sent by the send-reminders Edge Function)
  const VAPID_PUBLIC = 'BAw-O2sJD5Gy8R-JBWyX_Ykog43JrH4V_XmvRXD3EM38aUxZkQafn41Uuv89c12-lR73Ai4x4C0dKsC1FilU2T4';
  const pushOk = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const b64bytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
  async function pushSub() { try { const reg = await navigator.serviceWorker.getRegistration(); return reg ? await reg.pushManager.getSubscription() : null; } catch (e) { return null; } }
  async function pushUi() {
    const ok = pushOk(), sub = ok ? await pushSub() : null;
    $('#push-btn').textContent = sub ? '🔔 Reminders on' : '🔕 Reminders off';
    $('#push-state').textContent = !hasRemind ? 'Run supabase/reminders.sql first (see the setup steps).'
      : !ok ? 'This browser can’t receive push notifications. On iPhone, add the site to the Home Screen first.'
      : sub ? 'On for this device. Set a reminder in any task or event.'
      : Notification.permission === 'denied' ? 'Notifications are blocked for this site. Allow them in the browser’s site settings.' : 'Off for this device.';
    $('#push-on').hidden = !ok || !!sub || !hasRemind; $('#push-off').hidden = !sub; $('#push-test').hidden = !sub;
    $('#push-private').closest('label').hidden = !ok || !!sub || !hasRemind;
    if (hasRemind) drawDevices(sub && sub.endpoint);
  }
  const deviceName = ua => {
    const b = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    const o = /iPhone|iPad/.test(ua) ? 'iPhone / iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
    return o ? `${b} on ${o}` : b;
  };
  // every device that gets reminders: hide titles per device, or remove one you no longer use (e.g. a uni PC)
  async function drawDevices(mine) {
    const box = $('#push-devices');
    const { data, error } = await sb.from('push_subs').select('endpoint,device,private,created_at').order('created_at');
    if (error) { box.innerHTML = `<p class="meta">${esc(error.message)}</p>`; return; }
    box.innerHTML = data.length ? data.map((d, i) => `<div class="dev">
        <div><b>${esc(deviceName(d.device || ''))}</b>${d.endpoint === mine ? '<em>this device</em>' : ''}<span class="meta">since ${fmt(new Date(d.created_at), { month: 'short', day: 'numeric', year: 'numeric' })}</span></div>
        <label class="dev-priv" title="Notifications on that device say only “You have a reminder”"><input type="checkbox" data-devpriv="${i}"${d.private ? ' checked' : ''}> Hide titles</label>
        <button type="button" class="btn btn-sm ghost" data-devrm="${i}">Remove</button></div>`).join('')
      : '<p class="meta">No devices have reminders on.</p>';
    box.onchange = async e => {
      const i = e.target.dataset.devpriv;
      if (i === undefined) return;
      const { error: err } = await sb.from('push_subs').update({ private: e.target.checked }).eq('endpoint', data[i].endpoint);
      toast(err ? err.message : e.target.checked ? 'Titles hidden on that device' : 'Titles shown on that device');
    };
    box.onclick = async e => {
      const i = e.target.closest('[data-devrm]')?.dataset.devrm;
      if (i === undefined) return;
      if (data[i].endpoint === mine) return pushOff();
      const { error: err } = await sb.from('push_subs').delete().eq('endpoint', data[i].endpoint);
      toast(err ? err.message : 'Device removed; it gets no more reminders'); pushUi();
    };
  }
  async function pushOn() {
    try {
      if (await Notification.requestPermission() !== 'granted') return pushUi();
      const reg = await navigator.serviceWorker.register('sw.js');
      await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64bytes(VAPID_PUBLIC) });
      const j = sub.toJSON();
      const { error } = await sb.from('push_subs').upsert({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, device: navigator.userAgent.slice(0, 160), private: $('#push-private').checked });
      if (error) { await sub.unsubscribe(); throw error; }
      toast('Reminders on for this device');
    } catch (e) { toast(`Could not turn on reminders: ${e.message || e}`); }
    pushUi();
  }
  async function pushOff() {
    const sub = await pushSub();
    if (sub) { await sb.from('push_subs').delete().eq('endpoint', sub.endpoint); await sub.unsubscribe(); }
    toast('Reminders off for this device'); pushUi();
  }
  async function pushTest() {
    const { data, error } = await sb.functions.invoke('send-reminders?test=1', { body: {} });
    toast(error ? `Test failed: ${error.message}. Is the send-reminders function deployed with its secrets?` : `Test sent to ${data.sent} device${data.sent === 1 ? '' : 's'}`);
  }

  // ───────── start (owner only)
  async function start() {
    $('#pl-gate').hidden = true; $('#planner').hidden = false;
    $('#pl-view').innerHTML = '<p class="meta">Loading…</p>';
    try { await load(); }
    catch (e) {
      $('#pl-view').innerHTML = /relation|does not exist|schema cache|Could not find/i.test(e.message || '')
        ? '<p class="notice">The planner tables are not set up yet. Run <code>supabase/planner.sql</code> in Supabase → SQL Editor, then reload.</p>'
        : `<p class="notice error">${esc(e.message || e)}</p>`;
      return;
    }
    wire(); render();
    const pd = $('#push-dialog');
    $('#push-btn').hidden = false;
    $('#push-btn').addEventListener('click', () => { pushUi(); pd.showModal(); });
    $('#push-on').addEventListener('click', pushOn);
    $('#push-off').addEventListener('click', pushOff);
    $('#push-test').addEventListener('click', pushTest);
    pushUi();
  }
  sb.auth.getSession().then(({ data }) => {
    if (data.session) start();
    else { $('#pl-gate').hidden = false; $('#planner').hidden = true; }
  });
  window.__planner = { parseQuick, itemsOn, layout };   // for quick checks in the console
})();

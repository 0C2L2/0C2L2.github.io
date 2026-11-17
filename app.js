// Opportunities board, opportunity pages, admin dashboard and "get a file by code".
// Backend: Supabase (schema in supabase/schema.sql). Each page sets <body data-page="…">.
(() => {
  // ── Paste from Supabase → Project Settings → API. The anon key is public by design;
  //    row-level security in schema.sql decides what it can do.
  const SUPABASE_URL = 'https://nzlqbwdaxkpmkgjipqjy.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im56bHFid2RheGtwbWtnamlwcWp5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ0NzM2NjYsImV4cCI6MjExMDA0OTY2Nn0.kDsLcnOrQRw-x6zA7Z3mfy5inXStN2ywIlWhQvI5qxk';

  const $ = (s, el = document) => el.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const page = document.body.dataset.page;
  const main = $('main');
  // Surface unexpected script errors on the page instead of failing silently
  const showErr = msg => {
    let n = $('#js-error');
    if (!n) { main.insertAdjacentHTML('afterbegin', '<p id="js-error" class="notice error"></p>'); n = $('#js-error'); }
    n.textContent = `Something went wrong: ${msg}. Try reloading the page (Ctrl+Shift+R).`;
  };
  addEventListener('error', e => showErr(e.message));
  addEventListener('unhandledrejection', e => showErr((e.reason && e.reason.message) || e.reason));

  const sb = SUPABASE_URL && SUPABASE_ANON_KEY && window.supabase
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;
  if (!sb) {
    main.insertAdjacentHTML('afterbegin', '<p class="notice">Backend not connected yet: add the Supabase URL and anon key at the top of <code>app.js</code>.</p>');
    return;
  }

  // ── small helpers
  const fmtDate = d => d ? new Date(d + 'T00:00:00').toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  const daysLeft = d => d ? Math.ceil((new Date(d + 'T23:59:59') - Date.now()) / 864e5) : null;
  const dueChip = d => {
    const n = daysLeft(d);
    if (n === null) return '';
    const cls = n < 0 ? 'past' : n <= 7 ? 'soon' : '';
    const txt = n < 0 ? `closed ${fmtDate(d)}` : n === 0 ? 'due today' : `${n} day${n > 1 ? 's' : ''} left · ${fmtDate(d)}`;
    return `<span class="due ${cls}">${txt}</span>`;
  };
  const fmtSize = b => b == null ? '' : b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`;
  const KIND = { opportunity: 'Opportunity', lab: 'Lab', event: 'Event', post: 'Post' };
  const SECTIONS = { experience: 'Experience', project: 'Projects', education: 'Education', skill: 'Skills', certification: 'Certifications', award: 'Awards', language: 'Languages' };
  const isAdmin = async () => !!(await sb.auth.getSession()).data.session;   // RLS enforces the real check
  const fail = (el, e) => { el.innerHTML = `<p class="notice error">${esc(e.message || e)}</p>`; };

  // tiny, escaped markdown: # headings, **bold**, *italic*, `code`, [links](https://…), - lists
  const md = src => {
    const inline = s => esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    const out = [];
    let list = null;
    for (const line of String(src || '').split(/\r?\n/)) {
      const li = line.match(/^\s*[-*]\s+(.*)/), h = line.match(/^(#{1,3})\s+(.*)/);
      if (li) { (list ||= []).push(`<li>${inline(li[1])}</li>`); continue; }
      if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; }
      if (h) out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`);
      else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
    }
    if (list) out.push(`<ul>${list.join('')}</ul>`);
    return out.join('');
  };

  const card = (o, admin) => `
    <a class="op card" href="/opportunity?id=${o.id}">
      <div class="op-top"><span class="kind kind-${o.kind}">${KIND[o.kind]}</span>${o.is_public ? '' : '<span class="lock">private</span>'}${admin ? `<span class="status st-${o.status}">${o.status}</span>` : ''}</div>
      <h3>${esc(o.title)}</h3>
      <p class="meta">${esc([o.org, o.location].filter(Boolean).join(' · '))}</p>
      ${o.summary ? `<p class="op-sum">${esc(o.summary)}</p>` : ''}
      <div class="op-foot">${dueChip(o.deadline)}${(o.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>
    </a>`;

  // ───────────────────────── /opportunities.html
  async function board() {
    const list = $('#list'), q = $('#q');
    const admin = await isAdmin();
    if (admin) $('#new-link').hidden = false;
    const { data, error } = await sb.from('opportunities')
      .select('id,title,kind,org,location,deadline,status,tags,summary,is_public')
      .order('deadline', { ascending: true, nullsFirst: false });
    if (error) return fail(list, error);
    let kind = 'all';
    const draw = () => {
      const term = q.value.trim().toLowerCase();
      const rows = data.filter(o => (kind === 'all' || o.kind === kind) &&
        (!term || [o.title, o.org, o.location, o.summary, ...(o.tags || [])].join(' ').toLowerCase().includes(term)));
      if (!rows.length) { list.innerHTML = '<p class="empty">Nothing here yet.</p>'; return; }
      if (kind !== 'lab') { list.innerHTML = rows.map(o => card(o, admin)).join(''); return; }
      const uni = o => (o.org || 'Other').split(' · ')[0];   // labs: one heading per university
      const unis = [...new Set(rows.map(uni))].sort();
      list.innerHTML = unis.map(u => `<h2 class="uni-h">${esc(u)} <span>${rows.filter(o => uni(o) === u).length}</span></h2>`
        + rows.filter(o => uni(o) === u).map(o => card(o, admin)).join('')).join('');
    };
    document.querySelectorAll('[data-kind]').forEach(b => b.addEventListener('click', () => {
      kind = b.dataset.kind;
      document.querySelectorAll('[data-kind]').forEach(x => x.setAttribute('aria-pressed', x === b));
      draw();
    }));
    q.addEventListener('input', draw);
    draw();
  }

  // ───────────────────────── /opportunity.html?id=…
  async function detail() {
    const box = $('#detail'), id = new URLSearchParams(location.search).get('id');
    if (!id) return fail(box, 'No opportunity selected.');
    const [{ data: o, error }, admin] = await Promise.all([
      sb.from('opportunities').select('*').eq('id', id).maybeSingle(), isAdmin()]);
    if (error) return fail(box, error);
    if (!o) return fail(box, 'This opportunity is private or no longer exists.');
    document.title = `${o.title} — Rashid Tagaev`;
    box.innerHTML = `
      <p class="kicker">${KIND[o.kind]}${o.is_public ? '' : ' · private'}</p>
      <h1 class="sub-h1">${esc(o.title)}</h1>
      <p class="lead">${esc([o.org, o.location].filter(Boolean).join(' · '))}</p>
      <div class="op-foot">${dueChip(o.deadline)}${admin ? `<span class="status st-${o.status}">${o.status}</span>` : ''}${(o.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>
      <div class="actions">
        ${o.url ? `<a class="btn" href="${esc(o.url)}" target="_blank" rel="noopener">Open listing ↗</a>` : ''}
        ${admin ? `<a class="btn ghost" href="/admin#edit=${o.id}">Edit</a>` : ''}
      </div>
      ${o.summary ? `<p class="big-sum">${esc(o.summary)}</p>` : ''}
      <article class="prose">${md(o.body)}</article>
      <p class="meta">Updated ${new Date(o.updated_at).toLocaleDateString('en', { dateStyle: 'medium' })}</p>`;
    if (admin) kit(o);
  }

  // ───────────────────────── /get.html (no login)
  function getFile() {
    const form = $('#code-form'), input = $('#code'), out = $('#result');
    input.addEventListener('input', () => { input.value = input.value.replace(/\D/g, '').slice(0, 6); });
    form.addEventListener('submit', async e => {
      e.preventDefault();
      out.innerHTML = '<p class="meta">Looking up…</p>';
      const { data, error } = await sb.rpc('redeem_code', { p_code: input.value });
      if (error) return fail(out, error);
      if (!data || !data.length) return fail(out, 'No file with that code. Check the digits and try again.');
      const f = data[0];
      const url = sb.storage.from('files').getPublicUrl(f.path, { download: f.name }).data.publicUrl;
      out.innerHTML = `<div class="file-found card"><p class="kicker">File found</p><h3>${esc(f.name)}</h3>
        <p class="meta">${fmtSize(f.size)}</p><a class="btn" href="${esc(url)}">Download</a></div>`;
      location.assign(url);
    });
    const pre = new URLSearchParams(location.search).get('code');
    if (pre && /^\d{6}$/.test(pre)) { input.value = pre; form.requestSubmit(); }
  }

  // ───────────────────────── /admin.html
  const ICON = {
    edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M14 6l4 4"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
    copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg>',
    link: '<svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1"/><path d="M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1"/></svg>',
    refresh: '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2 6"/><path d="M20 4v7h-7"/></svg>',
    off: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M6.5 6.5l11 11"/></svg>',
  };
  const STATUS = ['interested', 'applied', 'interview', 'offer', 'rejected', 'done'];
  const ACTIVE = ['applied', 'interview', 'offer'];
  const fmtDay = t => new Date(t).toLocaleDateString('en', { month: 'short', day: 'numeric' });
  const toast = text => {
    const t = $('#toast');
    t.textContent = text; t.classList.add('show');
    clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove('show'), 1800);
  };

  async function admin() {
    const login = $('#login'), dash = $('#dash');
    let ops = [], files = [], prof = [], opFilter = 'all';
    const loadFiles = fileManager({ rows: $('#file-rows'), drop: $('#drop'), pick: $('#pick'), msg: $('#up-msg'), browse: true,
      after: fs => { files = fs; stats(); } });

    // Render from the session the auth callback hands us. Never await other sb.auth calls inside
    // that callback: supabase-js holds its auth lock there, and getSession() would deadlock sign-in.
    let shownFor = null;
    const render = session => {
      const key = session ? session.user.id : '';
      login.hidden = !!session; dash.hidden = !session;
      if (session && shownFor !== key) { $('#who').textContent = session.user.email; loadOps(); loadFiles(); loadProf(); }
      shownFor = key;
    };
    sb.auth.onAuthStateChange((event, session) => { setTimeout(() => render(session), 0); });
    try { $('#email').value = localStorage.getItem('admin-email') || ''; } catch (e) {}
    $('#login-form').addEventListener('submit', async e => {
      e.preventDefault();
      const email = $('#email').value.trim(), msg = $('#login-msg');
      msg.textContent = 'Signing in…';
      const slow = setTimeout(() => { msg.textContent = 'Still waiting for Supabase… check your connection, or reload and try again.'; }, 12000);
      const { error } = await sb.auth.signInWithPassword({ email, password: $('#password').value });
      clearTimeout(slow);
      if (error) { msg.textContent = error.message === 'Invalid login credentials' ? 'Wrong email or password.' : error.message; return; }
      try { localStorage.setItem('admin-email', email); } catch (e) {}
      msg.textContent = '';
      $('#password').value = '';
    });
    $('#pw-form').addEventListener('submit', async e => {
      e.preventDefault();
      const { error } = await sb.auth.updateUser({ password: $('#new-password').value });
      $('#pw-msg').textContent = error ? error.message : 'Password updated.';
      if (!error) $('#new-password').value = '';
    });
    // signing out leaves nothing behind on this computer: reminders off here, planner state cleared
    const cleanup = async () => {
      try {
        const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
        const sub = reg && await reg.pushManager.getSubscription();
        if (sub) { await sb.from('push_subs').delete().eq('endpoint', sub.endpoint); await sub.unsubscribe(); }
        if (reg) await reg.unregister();
      } catch (e) {}
      try { Object.keys(localStorage).filter(k => k.startsWith('pl-')).forEach(k => localStorage.removeItem(k)); } catch (e) {}
    };
    $('#logout').addEventListener('click', async () => { await cleanup(); await sb.auth.signOut(); render(null); });
    // forgot to sign out on a university PC? this revokes every saved sign-in, everywhere
    $('#logout-all').addEventListener('click', async () => {
      if (!confirm('Sign out on every computer and phone, including this one?\nOther devices are locked out within an hour at the latest.')) return;
      await cleanup();
      const { error } = await sb.auth.signOut({ scope: 'global' });
      if (error) return alert(error.message);
      render(null);
    });
    document.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => {
      document.querySelectorAll('[data-tab]').forEach(x => x.setAttribute('aria-pressed', x === b));
      document.querySelectorAll('.tab').forEach(t => { t.hidden = t.id !== b.dataset.tab; });
    }));

    // overview tiles + sidebar counts
    const stats = () => {
      const soon = ops.filter(o => { const n = daysLeft(o.deadline); return n !== null && n >= 0 && n <= 7; }).length;
      const active = ops.filter(o => ACTIVE.includes(o.status)).length;
      const downloads = files.reduce((s, f) => s + f.downloads, 0);
      $('#n-ops').textContent = ops.length;
      $('#n-files').textContent = files.length;
      $('#stats').innerHTML = [
        ['Tracking', ops.length, `${ops.filter(o => o.is_public).length} on public board`, ''],
        ['Due this week', soon, soon ? 'deadlines within 7 days' : 'nothing urgent', soon ? 'hot' : ''],
        ['In progress', active, 'applied · interview · offer', ''],
        ['Files shared', files.filter(f => f.code).length, `${downloads} download${downloads === 1 ? '' : 's'} total`, ''],
      ].map(([k, v, s, cls]) => `<div class="stat-tile ${cls}"><span class="stat-k">${k}</span><b>${v}</b><span class="stat-s">${s}</span></div>`).join('');
    };

    // ── opportunities
    const dlg = $('#op-dialog'), f = $('#op-form');
    const drawOps = () => {
      const term = $('#op-q').value.trim().toLowerCase();
      const rows = ops.filter(o => {
        const n = daysLeft(o.deadline);
        if (opFilter === 'soon' && !(n !== null && n >= 0 && n <= 14)) return false;
        if (opFilter === 'active' && !ACTIVE.includes(o.status)) return false;
        if (opFilter === 'private' && o.is_public) return false;
        if (opFilter === 'lab' && o.kind !== 'lab') return false;
        return !term || [o.title, o.org, o.location, ...(o.tags || [])].join(' ').toLowerCase().includes(term);
      });
      $('#op-rows').innerHTML = rows.length ? rows.map(o => `
        <div class="op-row">
          <span class="op-bar bar-${o.kind}" title="${KIND[o.kind]}"></span>
          <div class="op-main">
            <a class="op-title" href="/opportunity?id=${o.id}">${esc(o.title)}</a>
            <span class="meta">${KIND[o.kind]}${o.org ? ' · ' + esc(o.org) : ''}${o.location ? ' · ' + esc(o.location) : ''}</span>
          </div>
          <div class="op-due">${dueChip(o.deadline) || '<span class="meta">no deadline</span>'}</div>
          <select class="status-sel st-${o.status}" data-status="${o.id}" aria-label="Status">${STATUS.map(s => `<option${s === o.status ? ' selected' : ''}>${s}</option>`).join('')}</select>
          <label class="switch" title="Show on public board"><input type="checkbox" data-pub="${o.id}"${o.is_public ? ' checked' : ''} aria-label="Public"><span></span></label>
          <div class="icon-btns"><button data-edit="${o.id}" title="Edit" aria-label="Edit">${ICON.edit}</button><button class="danger" data-del="${o.id}" title="Delete" aria-label="Delete">${ICON.trash}</button></div>
        </div>`).join('')
        : `<div class="empty-state"><b>${ops.length ? 'No matches' : 'No opportunities yet'}</b><span class="meta">${ops.length ? 'Try another filter or search.' : 'Click “New” to add your first one.'}</span></div>`;
    };
    async function loadOps() {
      const { data, error } = await sb.from('opportunities').select('*').order('deadline', { ascending: true, nullsFirst: false });
      if (error) return fail($('#op-rows'), error);
      ops = data; drawOps(); stats();
      const m = location.hash.match(/^#edit=([0-9a-f-]{36})$/);
      if (m) { history.replaceState(null, '', location.pathname); openOp(ops.find(o => o.id === m[1])); }
    }
    function openOp(o = {}) {
      f.reset();
      f.elements.id.value = o.id || '';
      for (const k of ['title', 'org', 'location', 'url', 'deadline', 'summary', 'body']) f.elements[k].value = o[k] || '';
      f.elements.kind.value = o.kind || 'opportunity';
      f.elements.status.value = o.status || 'interested';
      f.elements.tags.value = (o.tags || []).join(', ');
      f.elements.is_public.checked = !!o.is_public;
      $('#op-title').textContent = o.id ? 'Edit opportunity' : 'New opportunity';
      $('#op-msg').textContent = '';
      dlg.showModal();
    }
    $('#new-op').addEventListener('click', () => openOp());
    document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
    $('#op-q').addEventListener('input', drawOps);
    document.querySelectorAll('[data-f]').forEach(b => b.addEventListener('click', () => {
      opFilter = b.dataset.f;
      document.querySelectorAll('[data-f]').forEach(x => x.setAttribute('aria-pressed', x === b));
      drawOps();
    }));
    $('#op-rows').addEventListener('click', async e => {
      const ed = e.target.closest('[data-edit]'), del = e.target.closest('[data-del]');
      if (ed) openOp(ops.find(o => o.id === ed.dataset.edit));
      if (del && confirm('Delete this opportunity? This cannot be undone.')) {
        const { error } = await sb.from('opportunities').delete().eq('id', del.dataset.del);
        if (error) return alert(error.message);
        toast('Deleted'); loadOps();
      }
    });
    $('#op-rows').addEventListener('change', async e => {   // inline status / visibility edits
      const s = e.target.closest('[data-status]'), p = e.target.closest('[data-pub]');
      const id = s ? s.dataset.status : p && p.dataset.pub;
      if (!id) return;
      const patch = s ? { status: s.value } : { is_public: p.checked };
      const { error } = await sb.from('opportunities').update(patch).eq('id', id);
      if (error) { alert(error.message); return loadOps(); }
      Object.assign(ops.find(o => o.id === id), patch);
      drawOps(); stats();
      toast(s ? `Status: ${patch.status}` : patch.is_public ? 'Now public' : 'Now private');
    });
    f.addEventListener('submit', async e => {
      e.preventDefault();
      const v = k => f.elements[k].value.trim() || null;
      const row = {
        title: v('title'), kind: f.elements.kind.value, org: v('org'), location: v('location'), url: v('url'),
        deadline: v('deadline'), status: f.elements.status.value,
        tags: f.elements.tags.value.split(',').map(t => t.trim()).filter(Boolean),
        summary: v('summary'), body: f.elements.body.value || null, is_public: f.elements.is_public.checked,
      };
      const id = f.elements.id.value;
      const { error } = await (id ? sb.from('opportunities').update(row).eq('id', id) : sb.from('opportunities').insert(row));
      if (error) { $('#op-msg').textContent = error.message; return; }
      dlg.close(); toast(id ? 'Saved' : 'Added'); loadOps();
    });

    // ── master profile (what every CV picks from)
    const idlg = $('#item-dialog'), itf = $('#item-form');
    const drawProf = () => {
      $('#n-prof').textContent = prof.length;
      $('#prof-rows').innerHTML = Object.entries(SECTIONS).map(([k, h]) => {
        const xs = prof.filter(p => p.section === k);
        return xs.length ? `<h3 class="prof-h">${h}</h3>` + xs.map(p => `
          <div class="prof-row">
            <div><b>${esc(p.title)}</b><span class="meta">${esc([p.subtitle, p.place, p.dates].filter(Boolean).join(' · '))}${p.bullets.length ? ` · ${p.bullets.length} bullet${p.bullets.length > 1 ? 's' : ''}` : ''}</span></div>
            <div class="icon-btns"><button data-iedit="${p.id}" title="Edit" aria-label="Edit">${ICON.edit}</button><button class="danger" data-idel="${p.id}" title="Delete" aria-label="Delete">${ICON.trash}</button></div>
          </div>`).join('') : '';
      }).join('') || '<div class="empty-state"><b>No profile items yet</b></div>';
    };
    async function loadProf() {
      const { data, error } = await sb.from('profile_items').select('*').order('sort');
      if (error) return fail($('#prof-rows'), error);
      prof = data; drawProf();
    }
    const openItem = (p = {}) => {
      itf.reset();
      for (const k of ['id', 'title', 'subtitle', 'place', 'dates']) itf.elements[k].value = p[k] || '';
      itf.elements.section.value = p.section || 'project';
      itf.elements.bullets.value = (p.bullets || []).join('\n');
      itf.elements.tags.value = (p.tags || []).join(', ');
      $('#item-msg').textContent = '';
      idlg.showModal();
    };
    $('#new-item').addEventListener('click', () => openItem());
    $('#prof-rows').addEventListener('click', async e => {
      const ed = e.target.closest('[data-iedit]'), del = e.target.closest('[data-idel]');
      if (ed) openItem(prof.find(p => p.id === ed.dataset.iedit));
      if (del && confirm('Delete this item? CVs that use it will drop it.')) {
        const { error } = await sb.from('profile_items').delete().eq('id', del.dataset.idel);
        if (error) return alert(error.message);
        toast('Deleted'); loadProf();
      }
    });
    itf.addEventListener('submit', async e => {
      e.preventDefault();
      const v = k => itf.elements[k].value.trim() || null, id = itf.elements.id.value;
      const row = {
        section: itf.elements.section.value, title: v('title'), subtitle: v('subtitle'), place: v('place'), dates: v('dates'),
        bullets: itf.elements.bullets.value.split('\n').map(s => s.trim()).filter(Boolean),
        tags: itf.elements.tags.value.split(',').map(t => t.trim()).filter(Boolean),
      };
      if (!id) row.sort = prof.reduce((m, p) => Math.max(m, p.sort), 0) + 1;
      const { error } = await (id ? sb.from('profile_items').update(row).eq('id', id) : sb.from('profile_items').insert(row));
      if (error) { $('#item-msg').textContent = error.message; return; }
      idlg.close(); toast(id ? 'Saved' : 'Added'); loadProf();
    });
  }

  // ── zip reader: central directory + DecompressionStream('deflate-raw'); no library. Stored / deflated entries, UTF-8 or
  //    legacy (Korean Windows = CP949) names. ponytail: no ZIP64 / encryption; a 50 MB upload cap makes ZIP64 moot.
  // zip-start
  async function readZip(buf) {
    const v = new DataView(buf), u8 = new Uint8Array(buf);
    let e = buf.byteLength - 22;
    while (e >= 0 && v.getUint32(e, true) !== 0x06054b50) e--;   // end-of-central-directory record (a comment may follow it)
    if (e < 0) throw new Error('This is not a valid zip file.');
    const count = v.getUint16(e + 10, true);
    let p = v.getUint32(e + 16, true);
    if (p === 0xffffffff || count === 0xffff) throw new Error('ZIP64 archives are not supported.');
    const name = (bytes, utf8) => {
      if (!utf8) { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (err) { return new TextDecoder('euc-kr').decode(bytes); } }
      return new TextDecoder().decode(bytes);
    };
    const out = [];
    for (let i = 0; i < count; i++) {
      if (v.getUint32(p, true) !== 0x02014b50) throw new Error('The zip file is damaged.');
      const flags = v.getUint16(p + 8, true), method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true), usize = v.getUint32(p + 24, true);
      const nlen = v.getUint16(p + 28, true), xlen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true), lho = v.getUint32(p + 42, true);
      const n = name(u8.subarray(p + 46, p + 46 + nlen), flags & 0x800);
      p += 46 + nlen + xlen + clen;
      const at = lho + 30 + v.getUint16(lho + 26, true) + v.getUint16(lho + 28, true);
      out.push({
        name: n, dir: n.endsWith('/'), size: usize, encrypted: !!(flags & 1),
        async read() {
          const c = u8.subarray(at, at + csize);
          if (flags & 1) throw new Error(`${n} is password-protected.`);
          if (method === 0) return c.slice();
          if (method !== 8) throw new Error(`${n}: unsupported compression (method ${method}).`);
          return new Uint8Array(await new Response(new Blob([c]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
        },
      });
    }
    return out;
  }
  // zip-end

  // ── file list + uploads. browse: true = the admin Files tab as a file manager (folders, move, copy, unzip);
  //    otherwise a flat list (each opportunity's kit shows only its files)
  const shareUrl = code => new URL(`/get?code=${code}`, location.href).href;
  const fileUrl = x => sb.storage.from('files').getPublicUrl(x.path, { download: x.name }).data.publicUrl;
  const ext = n => (n.includes('.') ? n.split('.').pop() : 'file').slice(0, 4).toUpperCase();
  const MIME = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', html: 'text/html', zip: 'application/zip', mp4: 'video/mp4', mp3: 'audio/mpeg',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', py: 'text/x-python', ipynb: 'application/json' };
  const mimeOf = n => MIME[(n.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';
  const storeName = n => `${crypto.randomUUID()}/${n.replace(/[^\w.\- ]+/g, '_') || 'file'}`;
  const FOLDER_IC = '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';

  function fileManager({ rows, drop, pick, msg, opp = null, browse = false, after = () => {} }) {
    let files = [], folders = [], cwd = null, canBrowse = browse;
    const sel = new Set();                                                     // 'f:<id>' or 'd:<id>'
    const dirOf = id => folders.find(f => f.id === id);
    const kids = id => folders.filter(f => (f.parent_id || null) === id).sort((a, b) => a.name.localeCompare(b.name));
    const inDir = id => files.filter(f => (f.folder_id || null) === id);
    const below = id => { const out = [id]; for (let i = 0; i < out.length; i++) out.push(...kids(out[i]).map(f => f.id)); return out; };   // a folder + all its subfolders
    const path = id => { const out = []; for (let d = dirOf(id); d; d = dirOf(d.parent_id)) out.unshift(d); return out; };
    const say = html => { msg.innerHTML = html; };

    const fileCard = x => `
      <div class="file-card${x.code ? '' : ' off'}${sel.has('f:' + x.id) ? ' sel' : ''}"${canBrowse ? ` draggable="true" data-drag="f:${x.id}"` : ''}>
        ${canBrowse ? `<label class="pick-box"><input type="checkbox" data-sel="f:${x.id}"${sel.has('f:' + x.id) ? ' checked' : ''} aria-label="Select ${esc(x.name)}"></label>` : ''}
        <span class="file-ic">${esc(ext(x.name))}</span>
        <div class="file-info">
          <a href="${esc(fileUrl(x))}" title="Download">${esc(x.name)}</a>
          <span class="meta">${fmtSize(x.size)} · ${fmtDay(x.created_at)} · ${x.downloads} download${x.downloads === 1 ? '' : 's'}</span>
        </div>
        ${x.code
          ? `<button class="code-pill" data-copy="${x.code}" title="Copy code">${x.code.slice(0, 3)}<span>${x.code.slice(3)}</span>${ICON.copy}</button>`
          : '<span class="lock">sharing off</span>'}
        <div class="icon-btns">
          ${canBrowse && /\.zip$/i.test(x.name) ? `<button class="unzip" data-unzip="${x.id}" title="Extract into a folder" aria-label="Unzip">Unzip</button>` : ''}
          ${canBrowse ? `<button data-ren="f:${x.id}" title="Rename" aria-label="Rename">${ICON.edit}</button>` : ''}
          ${x.code ? `<button data-link="${x.code}" title="Copy share link" aria-label="Copy share link">${ICON.link}</button>` : ''}
          <button data-regen="${x.id}" title="${x.code ? 'New code' : 'Turn sharing on'}" aria-label="${x.code ? 'New code' : 'Turn sharing on'}">${ICON.refresh}</button>
          ${x.code ? `<button data-revoke="${x.id}" title="Turn sharing off" aria-label="Turn sharing off">${ICON.off}</button>` : ''}
          <button class="danger" data-del="f:${x.id}" title="Delete" aria-label="Delete">${ICON.trash}</button>
        </div>
      </div>`;
    const folderCard = d => `
      <div class="file-card folder${sel.has('d:' + d.id) ? ' sel' : ''}" draggable="true" data-drag="d:${d.id}" data-dropdir="${d.id}">
        <label class="pick-box"><input type="checkbox" data-sel="d:${d.id}"${sel.has('d:' + d.id) ? ' checked' : ''} aria-label="Select ${esc(d.name)}"></label>
        <span class="file-ic dir">${FOLDER_IC}</span>
        <div class="file-info"><button type="button" class="dir-open" data-open="${d.id}">${esc(d.name)}</button><span class="meta">${kids(d.id).length + inDir(d.id).length} item${kids(d.id).length + inDir(d.id).length === 1 ? '' : 's'}</span></div>
        <div class="icon-btns"><button data-ren="d:${d.id}" title="Rename" aria-label="Rename">${ICON.edit}</button><button class="danger" data-del="d:${d.id}" title="Delete folder" aria-label="Delete folder">${ICON.trash}</button></div>
      </div>`;
    const draw = () => {
      if (!canBrowse) {
        rows.innerHTML = files.length ? files.map(fileCard).join('') : '<div class="empty-state"><b>No files yet</b><span class="meta">Drop one above to get a 6-digit code.</span></div>';
        return;
      }
      const dirs = kids(cwd), here = inDir(cwd), ids = [...dirs.map(d => 'd:' + d.id), ...here.map(f => 'f:' + f.id)], n = sel.size;
      rows.innerHTML = `
        <div class="fm-bar">
          <nav class="crumbs" aria-label="Folder path"><button type="button" data-open="" data-dropdir="">Files</button>${path(cwd).map(c => `<span aria-hidden="true">/</span><button type="button" data-open="${c.id}" data-dropdir="${c.id}">${esc(c.name)}</button>`).join('')}</nav>
          <div class="fm-actions">${n ? `<span class="meta">${n} selected</span><button type="button" class="btn btn-sm ghost" data-act="move">Move to…</button><button type="button" class="btn btn-sm ghost" data-act="copy">Copy to…</button><button type="button" class="btn btn-sm ghost fm-danger" data-act="delete">Delete</button><button type="button" class="btn btn-sm ghost" data-act="clear">Clear</button>` : ''}<button type="button" class="btn btn-sm" data-act="mkdir">+ New folder</button></div>
        </div>
        ${ids.length ? `<label class="sel-all"><input type="checkbox" data-selall${ids.every(i => sel.has(i)) ? ' checked' : ''}> Select all</label>${dirs.map(folderCard).join('')}${here.map(fileCard).join('')}`
          : `<div class="empty-state"><b>${cwd ? 'This folder is empty' : 'No files yet'}</b><span class="meta">Upload above (files land in the folder you are in), or drag files here.</span></div>`}`;
    };
    async function load() {
      let q = sb.from('files').select('*').order('created_at', { ascending: false });
      if (opp) q = q.eq('opportunity_id', opp);
      const [{ data, error }, fo] = await Promise.all([q, browse ? sb.from('folders').select('*').order('name') : { data: [] }]);
      if (error) return fail(rows, error);
      files = data;
      canBrowse = browse && !fo.error;
      folders = fo.data || [];
      if (cwd && !dirOf(cwd)) cwd = null;
      for (const k of [...sel]) if (!(k[0] === 'f' ? files.some(f => 'f:' + f.id === k) : folders.some(d => 'd:' + d.id === k))) sel.delete(k);
      draw(); after(files);
      if (browse && fo.error) say('Run <code>supabase/folders.sql</code> once to turn on folders, move, copy and unzip.');
    }

    // ── operations
    const pickFolder = (title, blocked = []) => new Promise(resolve => {     // a small dialog with the folder tree
      const dlg = document.createElement('dialog');
      dlg.className = 'op-dialog fm-dlg';
      const tree = (id, depth) => kids(id).map(d => `<label class="fm-opt" style="--d:${depth}"><input type="radio" name="to" value="${d.id}"${blocked.includes(d.id) ? ' disabled' : ''}> ${FOLDER_IC}<span>${esc(d.name)}</span></label>${tree(d.id, depth + 1)}`).join('');
      dlg.innerHTML = `<form class="op-form" method="dialog"><div class="dialog-head full"><h2>${title}</h2><button class="x-btn" value="" aria-label="Close">✕</button></div>
        <div class="full fm-tree"><label class="fm-opt" style="--d:0"><input type="radio" name="to" value="root" checked> ${FOLDER_IC}<span>Files (top level)</span></label>${tree(null, 1)}</div>
        <div class="full dialog-actions"><button class="btn ghost" value="">Cancel</button><button class="btn" value="ok">${title.split(' ')[0]} here</button></div></form>`;
      document.body.append(dlg);
      dlg.addEventListener('close', () => { const ok = dlg.returnValue === 'ok', v = dlg.querySelector('[name=to]:checked')?.value; dlg.remove(); resolve(ok ? (v === 'root' ? null : v) : undefined); });
      dlg.showModal();
    });
    const split = keys => ({ fileIds: keys.filter(k => k[0] === 'f').map(k => k.slice(2)), dirIds: keys.filter(k => k[0] === 'd').map(k => k.slice(2)) });
    async function moveTo(keys, target) {
      const { fileIds, dirIds } = split(keys);
      if (dirIds.some(id => below(id).includes(target))) return toast('A folder can’t go inside itself.');
      const res = await Promise.all([
        fileIds.length ? sb.from('files').update({ folder_id: target }).in('id', fileIds) : {},
        dirIds.length ? sb.from('folders').update({ parent_id: target }).in('id', dirIds) : {}]);
      const err = res.find(r => r.error);
      if (err) return toast(err.error.message);
      sel.clear(); toast(`Moved ${keys.length} item${keys.length === 1 ? '' : 's'} to ${target ? dirOf(target).name : 'Files'}`); load();
    }
    async function copyFile(x, target) {
      const to = storeName(x.name);
      const { error: se } = await sb.storage.from('files').copy(x.path, to);
      if (se) throw se;
      const { error } = await sb.from('files').insert({ name: x.name, path: to, size: x.size, mime: x.mime, folder_id: target, opportunity_id: x.opportunity_id || null });
      if (error) { await sb.storage.from('files').remove([to]); throw error; }
    }
    async function copyFolder(d, target, rename) {
      const { data: nd, error } = await sb.from('folders').insert({ name: rename ? `${d.name} copy` : d.name, parent_id: target }).select().single();
      if (error) throw error;
      for (const x of inDir(d.id)) await copyFile(x, nd.id);
      for (const k of kids(d.id)) await copyFolder(k, nd.id, false);
    }
    async function copyTo(keys, target) {
      const { fileIds, dirIds } = split(keys);
      if (dirIds.some(id => below(id).includes(target))) return toast('A folder can’t be copied into itself.');
      try {
        say('Copying…');
        for (const id of fileIds) await copyFile(files.find(f => f.id === id), target);
        for (const id of dirIds) { const d = dirOf(id); await copyFolder(d, target, (d.parent_id || null) === target); }
        sel.clear(); say(''); toast(`Copied ${keys.length} item${keys.length === 1 ? '' : 's'} (copies get their own codes)`);
      } catch (e) { say(esc(e.message)); }
      load();
    }
    async function remove(keys) {
      const { fileIds, dirIds } = split(keys), allDirs = dirIds.flatMap(below);
      const doomed = files.filter(f => fileIds.includes(f.id) || allDirs.includes(f.folder_id));
      const what = `${doomed.length} file${doomed.length === 1 ? '' : 's'}${dirIds.length ? ` and ${allDirs.length} folder${allDirs.length === 1 ? '' : 's'}` : ''}`;
      if (!confirm(`Delete ${what} for good? Their share codes stop working.`)) return;
      for (let i = 0; i < doomed.length; i += 100) {
        const { error } = await sb.storage.from('files').remove(doomed.slice(i, i + 100).map(f => f.path));
        if (error) return toast(error.message);
      }
      const res = await Promise.all([
        doomed.length ? sb.from('files').delete().in('id', doomed.map(f => f.id)) : {},
        dirIds.length ? sb.from('folders').delete().in('id', dirIds) : {}]);   // subfolders go with them (on delete cascade)
      const err = res.find(r => r.error);
      if (err) return toast(err.error.message);
      sel.clear(); toast(`Deleted ${what}`); load();
    }
    async function rename(key) {
      const isDir = key[0] === 'd', id = key.slice(2), cur = isDir ? dirOf(id).name : files.find(f => f.id === id).name;
      const name = (prompt(`New name for “${cur}”`, cur) || '').trim();
      if (!name || name === cur) return;
      if (name.length > 200 || /[\\/]/.test(name)) return toast('Names can’t contain / or \\.');
      const { error } = await sb.from(isDir ? 'folders' : 'files').update({ name }).eq('id', id);
      if (error) return toast(error.message);
      toast('Renamed'); load();
    }
    async function unzip(x) {
      try {
        say(`Opening ${esc(x.name)}…`);
        const { data: blob, error } = await sb.storage.from('files').download(x.path);
        if (error) throw error;
        const entries = (await readZip(await blob.arrayBuffer()))
          .filter(en => !/(^|\/)(__MACOSX|\.DS_Store$|Thumbs\.db$)/i.test(en.name))
          .map(en => ({ ...en, parts: en.name.split('/').filter(s => s && s !== '.' && s !== '..') }))
          .filter(en => en.parts.length);
        const fileEntries = entries.filter(en => !en.dir);
        if (!fileEntries.length) throw new Error('The zip is empty.');
        if (fileEntries.length > 2000) throw new Error('That zip has more than 2,000 files; split it up first.');
        const { data: base, error: fe } = await sb.from('folders').insert({ name: x.name.replace(/\.zip$/i, ''), parent_id: x.folder_id || null }).select().single();
        if (fe) throw fe;
        const made = { '': base.id };
        const dirFor = async parts => {                                       // create a/b/c on demand, reuse when seen
          let key = '';
          for (const part of parts) {
            const next = key ? `${key}/${part}` : part;
            if (!made[next]) {
              const { data: d, error: de } = await sb.from('folders').insert({ name: part.slice(0, 120), parent_id: made[key] }).select().single();
              if (de) throw de;
              made[next] = d.id;
            }
            key = next;
          }
          return made[key];
        };
        for (const en of entries.filter(en2 => en2.dir)) await dirFor(en.parts);
        let done = 0, skipped = 0;
        for (const en of fileEntries) {
          say(`Extracting ${done + skipped + 1} of ${fileEntries.length}: ${esc(en.parts.at(-1))}`);
          if (en.size > 50 * 1048576 || en.encrypted) { skipped++; continue; }
          const leaf = en.parts.at(-1), folder = await dirFor(en.parts.slice(0, -1)), to = storeName(leaf), type = mimeOf(leaf);
          const { error: ue } = await sb.storage.from('files').upload(to, new Blob([await en.read()], { type }), { contentType: type });
          if (ue) throw ue;
          const { error: ie } = await sb.from('files').insert({ name: leaf, path: to, size: en.size, mime: type, folder_id: folder });
          if (ie) { await sb.storage.from('files').remove([to]); throw ie; }
          done++;
        }
        cwd = base.id;
        say(`Unzipped <strong>${done}</strong> file${done === 1 ? '' : 's'} into <strong>${esc(base.name)}</strong>${skipped ? ` · skipped ${skipped} (over 50 MB or password-protected)` : ''}.`);
        toast(`Unzipped ${x.name}`);
      } catch (e) { say(`Couldn’t unzip: ${esc(e.message || e)}`); }
      load();
    }

    // ── events
    rows.addEventListener('click', async e => {
      const b = e.target.closest('button');
      if (!b) return;
      const d = b.dataset;
      if (d.open !== undefined) { cwd = d.open || null; sel.clear(); return draw(); }
      if (d.copy) { await navigator.clipboard.writeText(d.copy); toast(`Code ${d.copy} copied`); }
      if (d.link) { await navigator.clipboard.writeText(shareUrl(d.link)); toast('Share link copied'); }
      if (d.regen) {
        const { error } = await sb.rpc('regenerate_code', { p_id: d.regen });
        if (error) return alert(error.message);
        toast('New code issued'); load();
      }
      if (d.revoke && confirm('Turn off sharing? The current code will stop working.')) {
        const { error } = await sb.from('files').update({ code: null }).eq('id', d.revoke);
        if (error) return alert(error.message);
        toast('Sharing off'); load();
      }
      if (d.del) return remove([d.del]);
      if (d.ren) return rename(d.ren);
      if (d.unzip) return unzip(files.find(f => f.id === d.unzip));
      if (d.act === 'clear') { sel.clear(); return draw(); }
      if (d.act === 'delete') return remove([...sel]);
      if (d.act === 'mkdir') {
        const name = (prompt('Folder name') || '').trim();
        if (!name) return;
        if (name.length > 120 || /[\\/]/.test(name)) return toast('Folder names can’t contain / or \\.');
        const { error } = await sb.from('folders').insert({ name, parent_id: cwd });
        if (error) return toast(error.message);
        toast(`Folder “${name}” created`); return load();
      }
      if (d.act === 'move' || d.act === 'copy') {
        const keys = [...sel], blocked = split(keys).dirIds.flatMap(below);
        const target = await pickFolder(d.act === 'move' ? 'Move to' : 'Copy to', blocked);
        if (target === undefined) return;
        return d.act === 'move' ? moveTo(keys, target) : copyTo(keys, target);
      }
    });
    rows.addEventListener('dblclick', e => { const c = e.target.closest('.folder'); if (c && !e.target.closest('button, input')) { cwd = c.dataset.dropdir; sel.clear(); draw(); } });
    rows.addEventListener('change', e => {
      const d = e.target.dataset;
      if (d.sel) { e.target.checked ? sel.add(d.sel) : sel.delete(d.sel); return draw(); }
      if ('selall' in d) { const ids = [...kids(cwd).map(x => 'd:' + x.id), ...inDir(cwd).map(x => 'f:' + x.id)]; ids.forEach(i => (e.target.checked ? sel.add(i) : sel.delete(i))); return draw(); }
    });
    // drag items onto a folder card or a breadcrumb to move them (a selected item drags the whole selection)
    rows.addEventListener('dragstart', e => {
      const c = e.target.closest?.('[data-drag]');
      if (!c) return;
      const keys = sel.has(c.dataset.drag) ? [...sel] : [c.dataset.drag];
      e.dataTransfer.setData('application/x-fm', JSON.stringify(keys));
      e.dataTransfer.effectAllowed = 'move';
    });
    rows.addEventListener('dragover', e => {
      const t = e.target.closest?.('[data-dropdir]');
      if (t && e.dataTransfer.types.includes('application/x-fm')) { e.preventDefault(); t.classList.add('over'); }
    });
    rows.addEventListener('dragleave', e => e.target.closest?.('[data-dropdir]')?.classList.remove('over'));
    rows.addEventListener('drop', e => {
      const t = e.target.closest?.('[data-dropdir]');
      if (!t || !e.dataTransfer.types.includes('application/x-fm')) return;
      e.preventDefault(); t.classList.remove('over');
      const keys = JSON.parse(e.dataTransfer.getData('application/x-fm')), target = t.dataset.dropdir || null;
      if (keys.includes('d:' + target)) return;
      moveTo(keys, target);
    });

    const upload = async list => {
      const into = canBrowse ? cwd : null;
      for (const file of list) {
        say(`Uploading ${esc(file.name)}${into ? ` into ${esc(dirOf(into).name)}` : ''}…`);
        if (file.size > 50 * 1048576) { say(`${esc(file.name)} is over the 50 MB limit.`); continue; }
        const path = storeName(file.name);
        const { error: se } = await sb.storage.from('files').upload(path, file, { contentType: file.type || undefined });
        if (se) { say(esc(se.message)); continue; }
        const row = { name: file.name, path, size: file.size, mime: file.type || null, opportunity_id: opp };
        if (into) row.folder_id = into;
        const { data, error } = await sb.from('files').insert(row).select('code').single();
        if (error) { await sb.storage.from('files').remove([path]); say(esc(error.message)); continue; }
        say(`Uploaded <strong>${esc(file.name)}</strong>. Code <span class="code">${data.code}</span>${canBrowse && /\.zip$/i.test(file.name) ? ' · press <b>Unzip</b> on it to extract' : ''}`);
        toast(`${file.name} uploaded`);
      }
      load();
    };
    pick.addEventListener('change', () => { upload([...pick.files]); pick.value = ''; });
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); upload([...e.dataTransfer.files]); });
    return load;
  }

  // ───────────────────────── application kit (admin only, under each opportunity)
  const CONTACT = 'Incheon, South Korea · rashidtagaev01@gmail.com · github.com/0C2L2 · linkedin.com/in/rashid-tagaev · 0c2l2.github.io';
  const GROUPS = [['Relevant Experience', ['experience', 'project']], ['Education', ['education']], ['Skills', ['skill']],
    ['Certifications', ['certification']], ['Awards', ['award']], ['Languages', ['language']]];
  const groupOf = sec => GROUPS.findIndex(g => g[1].includes(sec));

  // the CV page, laid out like the PDF CV: name, contact line, then ruled sections
  const cvHTML = (cv, prof) => {
    const byId = new Map(prof.map(p => [p.id, p]));
    const sel = cv.items.filter(i => byId.has(i.id)).map(i => ({ ...byId.get(i.id), bullets: i.bullets || [] }));
    const row = (l, r) => `<div class="cv-row"><span>${l}</span><b>${esc(r || '')}</b></div>`;
    const entry = x => `<div class="cv-entry">${row(`<b>${esc(x.title)}</b>`, x.place)}${x.subtitle || x.dates ? row(`<i>${esc(x.subtitle || '')}</i>`, x.dates) : ''}${x.bullets.length ? `<ul>${x.bullets.map(b => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}</div>`;
    const line = x => `<li>${esc(x.title)}${x.subtitle ? ` · ${esc(x.subtitle)}` : ''}${x.dates ? ` (${esc(x.dates)})` : ''}</li>`;
    const body = GROUPS.map(([h, secs], g) => {
      const xs = sel.filter(x => secs.includes(x.section));
      if (!xs.length) return '';
      const inner = g < 2 ? xs.map(entry).join('')
        : g === 5 ? `<p>${xs.map(x => esc(x.title)).join(' · ')}</p>`
        : `<ul${g === 2 ? ' class="cv-cols"' : ''}>${xs.map(line).join('')}</ul>`;
      return `<section><h2>${h}</h2>${inner}</section>`;
    }).join('');
    return `<header><h1>Tagaev Rashid</h1>${cv.headline ? `<p class="cv-hl">${esc(cv.headline)}</p>` : ''}<p>${CONTACT}</p></header>`
      + (cv.summary ? `<section><h2>Summary</h2><p>${esc(cv.summary)}</p></section>` : '') + body;
  };

  async function kit(o) {
    const box = $('#kit');
    const [k, p] = await Promise.all([
      sb.from('app_kits').select('*').eq('opportunity_id', o.id).maybeSingle(),
      sb.from('profile_items').select('*').order('sort')]);
    box.hidden = false;
    if (k.error || p.error) return fail(box, k.error || p.error);
    const prof = p.data, master = new Map(prof.map(x => [x.id, x]));
    const kt = k.data || { cv: {} };
    const cv = { headline: kt.cv.headline || '', summary: kt.cv.summary || '', items: kt.cv.items || [] };
    box.innerHTML = `
      <div class="kit-head">
        <div><p class="kicker">Application kit · only you see this</p><h2>Email, CV &amp; files</h2></div>
        <div class="chips" role="group" aria-label="Kit section">
          <button data-kt="k-email" aria-pressed="true">Email</button><button data-kt="k-cv" aria-pressed="false">CV</button><button data-kt="k-files" aria-pressed="false">Files <span id="k-n"></span></button>
        </div>
      </div>
      <div id="k-email" class="ktab">
        <form id="mail" class="stack-form mail-form">
          <label>To <input name="to" type="email" placeholder="Not found yet: apply through the form or the listing"></label>
          <label>Subject <input name="subject"></label>
          <label>Body <textarea name="body" rows="18"></textarea></label>
          <div class="actions">
            <button class="btn" type="submit">Save</button>
            <button id="copy-body" class="btn ghost" type="button">Copy text</button>
            <a id="gmail" class="btn ghost" target="_blank" rel="noopener">Open in Gmail ↗</a>
            <span class="kit-state" aria-live="polite"></span>
          </div>
          <p class="meta">Attach the CV PDF (CV tab → Save as PDF) before you send.</p>
        </form>
      </div>
      <div id="k-cv" class="ktab" hidden>
        <div class="cv-build">
          <div class="cv-edit">
            <label>Headline <input id="cv-headline"></label>
            <label>Summary <textarea id="cv-summary" rows="4"></textarea></label>
            <div id="cv-pick"></div>
            <div class="actions cv-actions">
              <button id="cv-save" class="btn" type="button">Save</button>
              <button id="cv-print" class="btn ghost" type="button">Save as PDF</button>
              <span class="kit-state" aria-live="polite"></span>
            </div>
          </div>
          <div class="cv-side">
            <p id="cv-over" class="notice error" hidden>Runs past one page. Drop a bullet or an item.</p>
            <div id="cv-preview" class="cv-preview"><div id="cv-page" class="cv-page"></div></div>
          </div>
        </div>
      </div>
      <div id="k-files" class="ktab" hidden>
        <label id="k-drop" class="drop">
          <input id="k-pick" type="file" multiple hidden>
          <svg viewBox="0 0 24 24"><path d="M12 16V4M7 9l5-5 5 5M4 16v4h16v-4"/></svg>
          <strong>Drop files for this application</strong>
          <span class="meta">Cover letter, transcript, portfolio… each gets a 6-digit code</span>
        </label>
        <p id="k-msg" class="meta" aria-live="polite"></p>
        <div id="k-rows" class="file-list"></div>
      </div>`;
    box.querySelectorAll('[data-kt]').forEach(b => b.addEventListener('click', () => {
      box.querySelectorAll('[data-kt]').forEach(x => x.setAttribute('aria-pressed', x === b));
      box.querySelectorAll('.ktab').forEach(t => { t.hidden = t.id !== b.dataset.kt; });
    }));

    // save state: one row per opportunity holds both the email and the CV
    let dirty = false;
    const state = t => box.querySelectorAll('.kit-state').forEach(s => { s.textContent = t; });
    const touch = () => { dirty = true; state('Unsaved changes'); };
    addEventListener('beforeunload', e => { if (dirty) e.preventDefault(); });
    const m = $('#mail').elements;
    const save = async () => {
      const { error } = await sb.from('app_kits').upsert({
        opportunity_id: o.id, email_to: m.to.value.trim() || null, email_subject: m.subject.value, email_body: m.body.value, cv });
      if (error) return alert(error.message);
      dirty = false; state('Saved'); toast('Kit saved');
    };

    // email
    const enc = encodeURIComponent;
    const gmail = () => { $('#gmail').href = `https://mail.google.com/mail/?view=cm&fs=1&to=${enc(m.to.value.trim())}&su=${enc(m.subject.value)}&body=${enc(m.body.value)}`; };
    m.to.value = kt.email_to || ''; m.subject.value = kt.email_subject || ''; m.body.value = kt.email_body || '';
    gmail();
    $('#mail').addEventListener('input', () => { gmail(); touch(); });
    $('#mail').addEventListener('submit', e => { e.preventDefault(); save(); });
    $('#copy-body').addEventListener('click', async () => { await navigator.clipboard.writeText(m.body.value); toast('Email text copied'); });

    // CV builder: tick items, reorder within a section, edit bullets; the preview follows
    const pick = $('#cv-pick'), pg = $('#cv-page'), pv = $('#cv-preview');
    const preview = () => {
      pg.innerHTML = cvHTML(cv, prof);
      $('#cv-over').hidden = pg.scrollHeight / pg.scrollWidth <= 1123 / 794 + .002;   // A4 at 96 dpi
    };
    const drawPick = () => {
      const open = new Set([...pick.querySelectorAll('details[open] textarea')].map(t => t.dataset.bul));
      pick.innerHTML = GROUPS.map(([h, secs]) => {
        const on = cv.items.filter(i => master.has(i.id) && secs.includes(master.get(i.id).section));
        const off = prof.filter(x => secs.includes(x.section) && !cv.items.some(i => i.id === x.id));
        const label = (x, checked) => `<label><input type="checkbox" data-pick="${x.id}"${checked ? ' checked' : ''}><span><b>${esc(x.title)}</b>${x.subtitle ? `<span class="meta">${esc(x.subtitle)}</span>` : ''}</span></label>`;
        return `<fieldset class="pick-group"><legend>${h} · ${on.length}/${on.length + off.length}</legend>` + on.map((i, n) => {
          const x = master.get(i.id), extra = x.bullets.map((b, j) => [b, j]).filter(([b]) => !i.bullets.includes(b));
          return `<div class="pick-row on">${label(x, true)}
            <div class="icon-btns"><button type="button" data-mv="-1" data-id="${x.id}" aria-label="Move up"${n ? '' : ' disabled'}>↑</button><button type="button" data-mv="1" data-id="${x.id}" aria-label="Move down"${n < on.length - 1 ? '' : ' disabled'}>↓</button></div>
            ${x.bullets.length ? `<details${open.has(x.id) ? ' open' : ''}><summary>${i.bullets.length} of ${x.bullets.length} bullets · edit</summary>
              <textarea data-bul="${x.id}" rows="${Math.max(4, i.bullets.length * 2 + 1)}" aria-label="Bullets, one per line">${esc(i.bullets.join('\n'))}</textarea>
              ${extra.map(([b, j]) => `<button type="button" class="addb" data-addb="${x.id}" data-b="${j}">+ ${esc(b)}</button>`).join('')}</details>` : ''}
          </div>`;
        }).join('') + off.map(x => `<div class="pick-row">${label(x, false)}</div>`).join('') + '</fieldset>';
      }).join('');
    };
    $('#cv-headline').value = cv.headline; $('#cv-summary').value = cv.summary;
    $('#cv-headline').addEventListener('input', e => { cv.headline = e.target.value; touch(); preview(); });
    $('#cv-summary').addEventListener('input', e => { cv.summary = e.target.value; touch(); preview(); });
    pick.addEventListener('change', e => {
      const id = e.target.dataset.pick;
      if (!id) return;
      if (e.target.checked) cv.items.push({ id, bullets: [...master.get(id).bullets] });
      else cv.items = cv.items.filter(i => i.id !== id);
      touch(); drawPick(); preview();
    });
    pick.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.mv) {   // swap with the neighbour in the same CV section
        const g = groupOf(master.get(b.dataset.id).section);
        const idx = cv.items.flatMap((it, n) => master.has(it.id) && groupOf(master.get(it.id).section) === g ? [n] : []);
        const at = idx.indexOf(cv.items.findIndex(i => i.id === b.dataset.id)), a = idx[at], z = idx[at + +b.dataset.mv];
        [cv.items[a], cv.items[z]] = [cv.items[z], cv.items[a]];
      } else if (b.dataset.addb) {
        cv.items.find(i => i.id === b.dataset.addb).bullets.push(master.get(b.dataset.addb).bullets[+b.dataset.b]);
      } else return;
      touch(); drawPick(); preview();
    });
    pick.addEventListener('input', e => {
      const id = e.target.dataset.bul;
      if (!id) return;
      cv.items.find(i => i.id === id).bullets = e.target.value.split('\n').map(s => s.trim()).filter(Boolean);
      touch(); preview();
    });
    new ResizeObserver(() => { if (pv.clientWidth) { pv.style.setProperty('--s', pv.clientWidth / 794); preview(); } }).observe(pv);
    $('#cv-save').addEventListener('click', save);
    $('#cv-print').addEventListener('click', () => {   // the CV alone in a new tab → browser print → Save as PDF
      const w = open('', '_blank');
      if (!w) return alert('Allow pop-ups for this site to save the PDF.');
      const name = `Rashid_Tagaev_CV_${o.title.split(/[—–(]/)[0].trim().replace(/\W+/g, '_')}`;
      w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(name)}</title>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
        <link rel="stylesheet" href="${new URL('style.css', location.href).href}"></head>
        <body class="cv-sheet"><div class="cv-page">${cvHTML(cv, prof)}</div>
        <script>onload = () => document.fonts.ready.then(() => setTimeout(print, 100));<\/script></body></html>`);
      w.document.close();
    });
    drawPick(); preview();

    // files that belong to this opportunity
    fileManager({ rows: $('#k-rows'), drop: $('#k-drop'), pick: $('#k-pick'), msg: $('#k-msg'), opp: o.id,
      after: fs => { $('#k-n').textContent = fs.length || ''; } })();
  }

  // ───────────────────────── /book.html (public: book a call, like Calendly)
  async function book() {
    const box = $('#book'), qs = new URLSearchParams(location.search), myTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const p2 = n => String(n).padStart(2, '0'), localYmd = d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
    const tm = d => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const longDay = d => d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
    const rpcErr = e => (e && e.message || String(e)).replace(/^.*?:\s(?=[A-Z])/, '');
    if (qs.get('cancel')) return cancelView(qs.get('cancel'));

    const { data: S, error } = await sb.rpc('get_booking_page');
    if (error || !S || !S.enabled) {
      box.innerHTML = `<div class="card book-closed"><p class="kicker">Book a call</p><h1 class="sub-h1">Booking is <em>closed</em> right now</h1>
        <p class="lead">You can still reach me by email: <a href="mailto:rashidtagaev01@gmail.com">rashidtagaev01@gmail.com</a></p></div>`;
      return;
    }
    // a wall-clock time in the owner's zone → an instant (handles any IANA zone, DST included)
    const offset = t => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: S.tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(t)).map(x => [x.type, x.value])); return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(t / 6e4) * 6e4; };
    const zoned = (y, m, d, h, mi) => { const g = Date.UTC(y, m, d, h, mi); return new Date(g - offset(g - offset(g))); };
    const today = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: S.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map(x => [x.type, x.value]));
    let dur = S.durations.includes(30) ? 30 : S.durations[0], busy = [], day = null, month = null, picked = null, done = null;
    const MEET = { google_meet: ['Google Meet', '📹'], zoom: ['Zoom', '💻'], teams: ['Microsoft Teams', '🟦'], kakaotalk: ['KakaoTalk', '💬'], phone: ['Phone call', '📞'], in_person: ['In person', '🤝'] };
    const options = (S.meet_options && S.meet_options.length ? S.meet_options : ['google_meet']).filter(k => MEET[k]);
    let meet = options[0];
    const loadBusy = async () => {
      const { data } = await sb.rpc('busy_slots', { p_from: new Date().toISOString(), p_to: new Date(Date.now() + (S.max_days + 1) * 864e5).toISOString() });
      busy = (data || []).map(b => [Date.parse(b.start_at), Date.parse(b.end_at)]);
    };
    // every free start time, grouped by the visitor's own calendar day
    const slotsByDay = () => {
      const out = {}, step = dur >= 30 ? 30 : 15, earliest = Date.now() + S.min_notice_min * 6e4, latest = Date.now() + S.max_days * 864e5, buf = S.buffer_min * 6e4;
      for (let k = 0; k <= S.max_days; k++) {
        const base = new Date(Date.UTC(+today.year, +today.month - 1, +today.day + k)), y = base.getUTCFullYear(), m = base.getUTCMonth(), d = base.getUTCDate();
        for (const [a, b] of (S.hours[base.getUTCDay() || 7] || [])) {
          const [ah, am] = a.split(':').map(Number), [bh, bm] = b.split(':').map(Number);
          for (let t = ah * 60 + am; t + dur <= bh * 60 + bm; t += step) {
            const s = zoned(y, m, d, Math.floor(t / 60), t % 60), e = +s + dur * 6e4;
            if (+s < earliest || +s > latest || busy.some(([bs, be]) => bs < e + buf && be > +s - buf)) continue;
            (out[localYmd(s)] ||= []).push(s);
          }
        }
      }
      return out;
    };

    const info = () => `<aside class="card book-info">
        <span class="book-avatar">R</span>
        <p class="kicker">Rashid Tagaev</p>
        <h1>${esc(S.title)}</h1>
        <p class="lead">${esc(S.intro)}</p>
        <div class="chips" role="group" aria-label="Call length">${S.durations.map(n => `<button type="button" data-dur="${n}" aria-pressed="${n === dur}"${picked || done ? ' disabled' : ''}>${n} min</button>`).join('')}</div>
        <p class="book-fact"><span aria-hidden="true">📹</span> ${options.map(k => MEET[k][0]).join(' · ')}</p>
        <p class="book-fact"><span aria-hidden="true">🌐</span> Times are in your time zone (${esc(myTz)})</p>
      </aside>`;
    const picker = () => {
      const slots = slotsByDay(), days = Object.keys(slots).sort();
      if (!day || !slots[day]) day = days[0] || null;
      if (!month) month = day ? new Date(`${day}T00:00`) : new Date();
      const first = new Date(month.getFullYear(), month.getMonth(), 1), lead = (first.getDay() + 6) % 7, count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
      const cells = Array.from({ length: lead }, () => '<span></span>').join('') + Array.from({ length: count }, (_, i) => {
        const ds = localYmd(new Date(month.getFullYear(), month.getMonth(), i + 1)), n = (slots[ds] || []).length;
        return `<button type="button" class="bk-day${ds === day ? ' on' : ''}" data-day="${ds}"${n ? '' : ' disabled'} aria-label="${ds}${n ? `, ${n} times free` : ', nothing free'}">${i + 1}</button>`;
      }).join('');
      const list = day ? slots[day].map(s => `<button type="button" class="bk-slot" data-slot="${+s}">${tm(s)}</button>`).join('') : '';
      return `<div class="bk-cal">
          <div class="bk-month"><button type="button" class="x-btn" data-mon="-1" aria-label="Previous month">‹</button><b>${month.toLocaleDateString([], { month: 'long', year: 'numeric' })}</b><button type="button" class="x-btn" data-mon="1" aria-label="Next month">›</button></div>
          <div class="bk-grid">${['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map(w => `<span class="bk-wd">${w}</span>`).join('')}${cells}</div>
        </div>
        <div class="bk-times">${day ? `<p class="bk-times-h">${longDay(new Date(`${day}T00:00`))}</p><div class="bk-slots">${list}</div>`
          : `<p class="meta">No free times in the next ${S.max_days} days. Email me at <a href="mailto:rashidtagaev01@gmail.com">rashidtagaev01@gmail.com</a>.</p>`}</div>`;
    };
    const form = () => `<form class="bk-form stack-form" id="bk-form">
        <button type="button" class="back bk-back" data-back>← Pick another time</button>
        <p class="bk-when">📅 <b>${longDay(picked)}</b> · ${tm(picked)}–${tm(new Date(+picked + dur * 6e4))} <span class="meta">(${dur} min)</span></p>
        <fieldset class="bk-meet"><legend>How should we meet?</legend>
          ${options.map(k => `<label class="bk-opt"><input type="radio" name="meet" value="${k}"${k === meet ? ' checked' : ''}><span><i aria-hidden="true">${MEET[k][1]}</i>${MEET[k][0]}</span></label>`).join('')}
        </fieldset>
        <p class="meta bk-meet-hint" id="bk-hint">${meetHint(meet)}</p>
        <label>Your name <input name="name" required minlength="2" maxlength="80" autocomplete="name"></label>
        <label>Email <input name="email" type="email" required maxlength="120" autocomplete="email"></label>
        <label id="bk-phone"${meet === 'phone' ? '' : ' hidden'}>Phone number <input name="phone" type="tel" maxlength="25" autocomplete="tel" placeholder="+82 10 1234 5678"${meet === 'phone' ? ' required' : ''}></label>
        <label>What would you like to talk about? <span class="meta">(optional)</span><textarea name="note" rows="4" maxlength="1000"></textarea></label>
        <button class="btn btn-wide" type="submit">Confirm booking</button>
        <p class="meta" id="bk-msg" aria-live="polite"></p>
      </form>`;
    function meetHint(k) {
      if (k === 'phone') return 'I’ll call you at the number you enter below.';
      if (k === 'in_person') return S.in_person_place ? `We’ll meet at: ${esc(S.in_person_place)}` : 'I’ll email you the place to meet.';
      return `I’ll email you the ${MEET[k][0]} link before the call.`;
    }
    const where = b => b.meet === 'phone' ? `Phone call (${b.phone})` : b.meet === 'in_person' ? `In person${b.place ? `: ${b.place}` : ''}` : `${b.meet_label} (link by email)`;
    const ics = b => {
      const z = d => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''), t = s => String(s || '').replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
      return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//0c2l2.github.io//book//EN', 'BEGIN:VEVENT', `UID:${b.id}@0c2l2.github.io`, `DTSTAMP:${z(Date.now())}`, `DTSTART:${z(b.start_at)}`, `DTEND:${z(b.end_at)}`,
        'SUMMARY:Call with Rashid Tagaev', `DESCRIPTION:${t([where(b), `Cancel: ${b.cancelUrl}`].join('\n'))}`, `LOCATION:${t(where(b))}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    };
    const confirmation = () => {
      const s = new Date(done.start_at), e = new Date(done.end_at), z = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
      const w = where(done), icon = (MEET[done.meet] || MEET.google_meet)[1];
      const next = done.meet === 'phone' ? `I’ll call you at <b>${esc(done.phone)}</b>.`
        : done.meet === 'in_person' ? (done.place ? `We’ll meet at <b>${esc(done.place)}</b>.` : `I’ll email the meeting place to <b>${esc(done.email)}</b>.`)
        : `I’ll email the <b>${esc(done.meet_label)}</b> link to <b>${esc(done.email)}</b> before the call.`;
      const gcal = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent('Call with Rashid Tagaev')}&dates=${z(s)}/${z(e)}&details=${encodeURIComponent(`${w}\n\nCancel: ${done.cancelUrl}`)}&location=${encodeURIComponent(w)}`;
      return `<div class="bk-done">
          <span class="bk-check" aria-hidden="true">✓</span>
          <h2>You're booked</h2>
          <p class="bk-when">📅 <b>${longDay(s)}</b> · ${tm(s)}–${tm(e)}</p>
          <p class="book-fact">${icon} ${esc(done.meet_label)} · ${next}</p>
          <div class="actions"><a class="btn" href="${gcal}" target="_blank" rel="noopener">Add to Google Calendar</a><button type="button" class="btn ghost" data-ics>Download .ics</button></div>
          <div class="notice"><b>Save this link</b> to cancel later: <a href="${esc(done.cancelUrl)}">${esc(done.cancelUrl)}</a> <button type="button" class="btn btn-sm ghost" data-copycancel>Copy</button></div>
        </div>`;
    };
    const draw = () => { box.innerHTML = `${info()}<div class="card book-main${picked || done ? ' narrow' : ''}">${done ? confirmation() : picked ? form() : picker()}</div>`; };

    box.addEventListener('click', async e => {
      const b = e.target.closest('button');
      if (!b) return;
      const d = b.dataset;
      if (d.dur) { dur = +d.dur; day = null; month = null; return draw(); }
      if (d.mon) { month = new Date(month.getFullYear(), month.getMonth() + +d.mon, 1); return draw(); }
      if (d.day) { day = d.day; return draw(); }
      if (d.slot) { picked = new Date(+d.slot); draw(); return $('#bk-form [name=name]')?.focus(); }
      if ('back' in d) { picked = null; return draw(); }
      if ('ics' in d) {
        const url = URL.createObjectURL(new Blob([ics(done)], { type: 'text/calendar' }));
        Object.assign(document.createElement('a'), { href: url, download: 'call-with-rashid.ics' }).click();
        return setTimeout(() => URL.revokeObjectURL(url), 2000);
      }
      if ('copycancel' in d) { await navigator.clipboard.writeText(done.cancelUrl); b.textContent = 'Copied'; }
    });
    box.addEventListener('change', e => {   // meeting option → hint, and ask for a phone number only for phone calls
      if (e.target.name !== 'meet') return;
      meet = e.target.value;
      $('#bk-hint').innerHTML = meetHint(meet);
      const ph = $('#bk-phone'); ph.hidden = meet !== 'phone'; ph.querySelector('input').required = meet === 'phone';
    });
    box.addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target.elements, msg = $('#bk-msg'), btn = e.target.querySelector('[type=submit]');
      btn.disabled = true; msg.textContent = 'Booking…';
      const { data, error: err } = await sb.rpc('book_slot', { p_start: picked.toISOString(), p_minutes: dur, p_name: f.name.value, p_email: f.email.value, p_note: f.note.value, p_meet: meet, p_phone: meet === 'phone' ? f.phone.value : null });
      btn.disabled = false;
      if (err) {
        msg.textContent = rpcErr(err);
        if (/taken|too soon|outside/i.test(err.message)) { await loadBusy(); setTimeout(() => { picked = null; draw(); }, 2200); }
        return;
      }
      done = { ...data, cancelUrl: new URL(`/book?cancel=${data.cancel_token}`, location.href).href };
      draw();
    });
    box.innerHTML = '<p class="meta">Loading free times…</p>';
    await loadBusy();
    draw();

    async function cancelView(token) {
      const { data: b, error: err } = await sb.rpc('booking_by_token', { p_token: token });
      if (err || !b) { box.innerHTML = '<div class="card book-closed"><h1 class="sub-h1">Booking not found</h1><p class="lead">Check the link, or email me.</p></div>'; return; }
      const s = new Date(b.start_at), past = s < new Date();
      box.innerHTML = `<div class="card book-closed"><p class="kicker">Your booking</p><h1 class="sub-h1">${esc(b.name)}, ${b.status === 'cancelled' ? 'this call is <em>cancelled</em>' : past ? 'this call has <em>passed</em>' : 'cancel your call?'}</h1>
        <p class="bk-when">📅 <b>${longDay(s)}</b> · ${tm(s)}–${tm(new Date(b.end_at))} (${b.minutes} min${b.meet_label ? ` · ${esc(b.meet_label)}` : ''})</p>
        ${b.status === 'confirmed' && !past ? '<div class="actions"><button type="button" class="btn" id="bk-cancel">Cancel this call</button><a class="btn ghost" href="/book">Book a different time</a></div><p class="meta" id="bk-msg" aria-live="polite"></p>' : '<a class="btn" href="/book">Book a new time</a>'}</div>`;
      $('#bk-cancel')?.addEventListener('click', async () => {
        const { error: e2 } = await sb.rpc('cancel_booking', { p_token: token });
        if (e2) { $('#bk-msg').textContent = rpcErr(e2); return; }
        cancelView(token);
      });
    }
  }

  window.App = { sb, esc, md, toast };   // shared with planner.js
  ({ board, detail, getFile, admin, book })[page]?.();
})();

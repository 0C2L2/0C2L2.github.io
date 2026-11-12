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
  const KIND = { opportunity: 'Opportunity', event: 'Event', post: 'Post' };
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
    <a class="op card" href="opportunity.html?id=${o.id}">
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
      list.innerHTML = rows.length ? rows.map(o => card(o, admin)).join('') : '<p class="empty">Nothing here yet.</p>';
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
        ${admin ? `<a class="btn ghost" href="admin.html#edit=${o.id}">Edit</a>` : ''}
      </div>
      ${o.summary ? `<p class="big-sum">${esc(o.summary)}</p>` : ''}
      <article class="prose">${md(o.body)}</article>
      <p class="meta">Updated ${new Date(o.updated_at).toLocaleDateString('en', { dateStyle: 'medium' })}</p>`;
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
    let ops = [], files = [], opFilter = 'all';

    const show = async () => {
      const { data: { session } } = await sb.auth.getSession();
      login.hidden = !!session; dash.hidden = !session;
      if (session) { $('#who').textContent = session.user.email; loadOps(); loadFiles(); }
    };
    try { $('#email').value = localStorage.getItem('admin-email') || ''; } catch (e) {}
    $('#login-form').addEventListener('submit', async e => {
      e.preventDefault();
      const email = $('#email').value.trim(), msg = $('#login-msg');
      msg.textContent = 'Signing in…';
      const { error } = await sb.auth.signInWithPassword({ email, password: $('#password').value });
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
    $('#logout').addEventListener('click', async () => { await sb.auth.signOut(); show(); });
    sb.auth.onAuthStateChange(() => show());
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
        return !term || [o.title, o.org, o.location, ...(o.tags || [])].join(' ').toLowerCase().includes(term);
      });
      $('#op-rows').innerHTML = rows.length ? rows.map(o => `
        <div class="op-row">
          <span class="op-bar bar-${o.kind}" title="${KIND[o.kind]}"></span>
          <div class="op-main">
            <a class="op-title" href="opportunity.html?id=${o.id}">${esc(o.title)}</a>
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
    document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => dlg.close()));
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

    // ── files
    const shareUrl = code => new URL(`get.html?code=${code}`, location.href).href;
    const fileUrl = x => sb.storage.from('files').getPublicUrl(x.path, { download: x.name }).data.publicUrl;
    const ext = n => (n.includes('.') ? n.split('.').pop() : 'file').slice(0, 4).toUpperCase();
    const drawFiles = () => {
      $('#file-rows').innerHTML = files.length ? files.map(x => `
        <div class="file-card${x.code ? '' : ' off'}">
          <span class="file-ic">${esc(ext(x.name))}</span>
          <div class="file-info">
            <a href="${esc(fileUrl(x))}" title="Download">${esc(x.name)}</a>
            <span class="meta">${fmtSize(x.size)} · ${fmtDay(x.created_at)} · ${x.downloads} download${x.downloads === 1 ? '' : 's'}</span>
          </div>
          ${x.code
            ? `<button class="code-pill" data-copy="${x.code}" title="Copy code">${x.code.slice(0, 3)}<span>${x.code.slice(3)}</span>${ICON.copy}</button>`
            : '<span class="lock">sharing off</span>'}
          <div class="icon-btns">
            ${x.code ? `<button data-link="${x.code}" title="Copy share link" aria-label="Copy share link">${ICON.link}</button>` : ''}
            <button data-regen="${x.id}" title="${x.code ? 'New code' : 'Turn sharing on'}" aria-label="${x.code ? 'New code' : 'Turn sharing on'}">${ICON.refresh}</button>
            ${x.code ? `<button data-revoke="${x.id}" title="Turn sharing off" aria-label="Turn sharing off">${ICON.off}</button>` : ''}
            <button class="danger" data-rm="${x.id}" data-path="${esc(x.path)}" title="Delete" aria-label="Delete">${ICON.trash}</button>
          </div>
        </div>`).join('')
        : '<div class="empty-state"><b>No files yet</b><span class="meta">Drop one above to get a 6-digit code.</span></div>';
    };
    async function loadFiles() {
      const { data, error } = await sb.from('files').select('*').order('created_at', { ascending: false });
      if (error) return fail($('#file-rows'), error);
      files = data; drawFiles(); stats();
    }
    $('#file-rows').addEventListener('click', async e => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.copy) { await navigator.clipboard.writeText(b.dataset.copy); toast(`Code ${b.dataset.copy} copied`); }
      if (b.dataset.link) { await navigator.clipboard.writeText(shareUrl(b.dataset.link)); toast('Share link copied'); }
      if (b.dataset.regen) {
        const { error } = await sb.rpc('regenerate_code', { p_id: b.dataset.regen });
        if (error) return alert(error.message);
        toast('New code issued'); loadFiles();
      }
      if (b.dataset.revoke && confirm('Turn off sharing? The current code will stop working.')) {
        const { error } = await sb.from('files').update({ code: null }).eq('id', b.dataset.revoke);
        if (error) return alert(error.message);
        toast('Sharing off'); loadFiles();
      }
      if (b.dataset.rm && confirm('Delete this file for good?')) {
        const { error: se } = await sb.storage.from('files').remove([b.dataset.path]);
        const { error: de } = se ? { error: se } : await sb.from('files').delete().eq('id', b.dataset.rm);
        if (se || de) return alert((se || de).message);
        toast('File deleted'); loadFiles();
      }
    });
    const upload = async list => {
      const msg = $('#up-msg');
      for (const file of list) {
        msg.textContent = `Uploading ${file.name}…`;
        if (file.size > 50 * 1048576) { msg.textContent = `${file.name} is over the 50 MB limit.`; continue; }
        const path = `${crypto.randomUUID()}/${file.name.replace(/[^\w.\- ]+/g, '_')}`;
        const { error: se } = await sb.storage.from('files').upload(path, file, { contentType: file.type || undefined });
        if (se) { msg.textContent = se.message; continue; }
        const { data, error } = await sb.from('files').insert({ name: file.name, path, size: file.size, mime: file.type || null }).select('code').single();
        if (error) { await sb.storage.from('files').remove([path]); msg.textContent = error.message; continue; }
        msg.innerHTML = `Uploaded <strong>${esc(file.name)}</strong>. Code <span class="code">${data.code}</span>`;
        toast(`${file.name} uploaded`);
      }
      loadFiles();
    };
    const drop = $('#drop'), pick = $('#pick');
    pick.addEventListener('change', () => { upload([...pick.files]); pick.value = ''; });
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); upload([...e.dataTransfer.files]); });

    show();
  }

  ({ board, detail, getFile, admin })[page]?.();
})();

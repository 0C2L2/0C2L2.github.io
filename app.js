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
  async function admin() {
    const login = $('#login'), dash = $('#dash');
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
      $('#pw-msg').textContent = error ? error.message : 'Password updated. Use it next time you sign in.';
      if (!error) $('#new-password').value = '';
    });
    $('#logout').addEventListener('click', async () => { await sb.auth.signOut(); show(); });
    sb.auth.onAuthStateChange(() => show());
    document.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => {
      document.querySelectorAll('[data-tab]').forEach(x => x.setAttribute('aria-pressed', x === b));
      document.querySelectorAll('.tab').forEach(t => { t.hidden = t.id !== b.dataset.tab; });
    }));

    // opportunities CRUD
    const dlg = $('#op-dialog'), f = $('#op-form');
    let ops = [];
    async function loadOps() {
      const box = $('#op-rows');
      const { data, error } = await sb.from('opportunities').select('*').order('deadline', { ascending: true, nullsFirst: false });
      if (error) return fail(box, error);
      ops = data;
      box.innerHTML = data.length ? data.map(o => `
        <tr><td><a href="opportunity.html?id=${o.id}">${esc(o.title)}</a><div class="meta">${esc(o.org || '')}</div></td>
          <td>${KIND[o.kind]}</td><td>${o.deadline ? fmtDate(o.deadline) : '—'}</td>
          <td><span class="status st-${o.status}">${o.status}</span></td>
          <td>${o.is_public ? 'public' : '<span class="lock">private</span>'}</td>
          <td class="row-actions"><button data-edit="${o.id}">Edit</button><button class="danger" data-del="${o.id}">Delete</button></td></tr>`).join('')
        : '<tr><td colspan="6" class="empty">No opportunities yet. Click “New”.</td></tr>';
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
    $('#op-cancel').addEventListener('click', () => dlg.close());
    $('#op-rows').addEventListener('click', async e => {
      const ed = e.target.closest('[data-edit]'), del = e.target.closest('[data-del]');
      if (ed) openOp(ops.find(o => o.id === ed.dataset.edit));
      if (del && confirm('Delete this opportunity? This cannot be undone.')) {
        const { error } = await sb.from('opportunities').delete().eq('id', del.dataset.del);
        error ? alert(error.message) : loadOps();
      }
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
      dlg.close(); loadOps();
    });

    // files
    const shareUrl = code => new URL(`get.html?code=${code}`, location.href).href;
    async function loadFiles() {
      const box = $('#file-rows');
      const { data, error } = await sb.from('files').select('*').order('created_at', { ascending: false });
      if (error) return fail(box, error);
      box.innerHTML = data.length ? data.map(x => `
        <tr><td><a href="${esc(sb.storage.from('files').getPublicUrl(x.path, { download: x.name }).data.publicUrl)}">${esc(x.name)}</a>
            <div class="meta">${fmtSize(x.size)} · ${new Date(x.created_at).toLocaleDateString('en', { dateStyle: 'medium' })} · ${x.downloads} downloads</div></td>
          <td>${x.code ? `<span class="code">${x.code}</span>` : '<span class="lock">sharing off</span>'}</td>
          <td class="row-actions">
            ${x.code ? `<button data-copy="${x.code}">Copy code</button><button data-link="${x.code}">Copy link</button>` : ''}
            <button data-regen="${x.id}">${x.code ? 'New code' : 'Turn on'}</button>
            ${x.code ? `<button data-revoke="${x.id}">Revoke</button>` : ''}
            <button class="danger" data-rm="${x.id}" data-path="${esc(x.path)}">Delete</button></td></tr>`).join('')
        : '<tr><td colspan="3" class="empty">No files yet. Drop one above.</td></tr>';
    }
    $('#file-rows').addEventListener('click', async e => {
      const b = e.target.closest('button');
      if (!b) return;
      const flash = t => { const old = b.textContent; b.textContent = t; setTimeout(() => { b.textContent = old; }, 1200); };
      if (b.dataset.copy) { await navigator.clipboard.writeText(b.dataset.copy); flash('Copied'); }
      if (b.dataset.link) { await navigator.clipboard.writeText(shareUrl(b.dataset.link)); flash('Copied'); }
      if (b.dataset.regen) { const { error } = await sb.rpc('regenerate_code', { p_id: b.dataset.regen }); error ? alert(error.message) : loadFiles(); }
      if (b.dataset.revoke && confirm('Turn off sharing? The current code will stop working.')) {
        const { error } = await sb.from('files').update({ code: null }).eq('id', b.dataset.revoke);
        error ? alert(error.message) : loadFiles();
      }
      if (b.dataset.rm && confirm('Delete this file for good?')) {
        const { error: se } = await sb.storage.from('files').remove([b.dataset.path]);
        const { error: de } = se ? { error: se } : await sb.from('files').delete().eq('id', b.dataset.rm);
        (se || de) ? alert((se || de).message) : loadFiles();
      }
    });
    const upload = async files => {
      const msg = $('#up-msg');
      for (const file of files) {
        msg.textContent = `Uploading ${file.name}…`;
        if (file.size > 50 * 1048576) { msg.textContent = `${file.name} is over the 50 MB limit.`; continue; }
        const path = `${crypto.randomUUID()}/${file.name.replace(/[^\w.\- ]+/g, '_')}`;
        const { error: se } = await sb.storage.from('files').upload(path, file, { contentType: file.type || undefined });
        if (se) { msg.textContent = se.message; continue; }
        const { data, error } = await sb.from('files').insert({ name: file.name, path, size: file.size, mime: file.type || null }).select('code').single();
        if (error) { await sb.storage.from('files').remove([path]); msg.textContent = error.message; continue; }
        msg.innerHTML = `Uploaded <strong>${esc(file.name)}</strong> · code <span class="code">${data.code}</span>`;
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

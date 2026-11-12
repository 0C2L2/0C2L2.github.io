// Colour theme dots + light/dark/system toggle, shared by every page.
// Each page's <head> applies the saved choice before first paint; this wires the buttons.
(() => {
  const root = document.documentElement;

  const themeBtns = document.querySelectorAll('[data-t]');
  const markTheme = () => themeBtns.forEach(b => b.setAttribute('aria-pressed', b.dataset.t === (root.dataset.theme || 'violet')));
  themeBtns.forEach(b => b.addEventListener('click', () => {
    if (b.dataset.t === 'violet') delete root.dataset.theme; else root.dataset.theme = b.dataset.t;
    try { localStorage.setItem('theme', b.dataset.t); } catch (e) {}
    markTheme();
  }));
  markTheme();

  const MODES = ['system', 'light', 'dark'];
  const MODE_ICONS = {
    system: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
    light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  };
  const modeBtns = document.querySelectorAll('.mode');
  const showMode = () => {
    const m = root.dataset.mode || 'system';
    modeBtns.forEach(b => { b.innerHTML = MODE_ICONS[m]; b.setAttribute('aria-label', `Colour mode: ${m} (click to change)`); b.title = `${m[0].toUpperCase() + m.slice(1)} mode`; });
  };
  modeBtns.forEach(b => b.addEventListener('click', () => {
    const next = MODES[(MODES.indexOf(root.dataset.mode || 'system') + 1) % MODES.length];
    if (next === 'system') delete root.dataset.mode; else root.dataset.mode = next;
    try { localStorage.setItem('mode', next); } catch (e) {}
    showMode();
  }));
  showMode();
})();

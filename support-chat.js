// Chat support pou kliyan yo: ikòn flotan + fenèt popup. SÈLMAN TÈKS (pa gen bouton foto, pa gen upload).
// Li parèt sèlman si kliyan an konekte (si sèvè a reponn 401/403, anyen pa parèt).
(function () {
  if (window.__scLoaded) return; window.__scLoaded = true;
  const T = {
    ht: { title: 'Support', sub: 'Nou la pou ede w', hello: 'Bonjou! Ekri mesaj ou a la a, yon ajan ap reponn ou le pli vit posib.', ph: 'Ekri mesaj ou...', send: 'Voye', close: 'Fèmen', open: 'Louvri chat support', textOnly: 'Sèlman tèks. Pa voye modpas, PIN oswa kòd ou.', err: 'Pa ka voye. Eseye ankò.', many: 'Twòp mesaj. Tann yon ti moman.', load: 'Pa ka chaje mesaj yo.', you: 'Ou', team: 'Support' },
    fr: { title: 'Support', sub: 'Nous sommes là pour vous aider', hello: 'Bonjour ! Écrivez votre message ici, un agent vous répondra dès que possible.', ph: 'Écrivez votre message...', send: 'Envoyer', close: 'Fermer', open: 'Ouvrir le chat support', textOnly: 'Texte uniquement. N’envoyez jamais mot de passe, PIN ou codes.', err: 'Envoi impossible. Réessayez.', many: 'Trop de messages. Patientez un instant.', load: 'Impossible de charger les messages.', you: 'Vous', team: 'Support' },
    en: { title: 'Support', sub: 'We’re here to help', hello: 'Hi! Type your message here and an agent will reply as soon as possible.', ph: 'Type your message...', send: 'Send', close: 'Close', open: 'Open support chat', textOnly: 'Text only. Never share your password, PIN or codes.', err: 'Could not send. Try again.', many: 'Too many messages. Please wait a moment.', load: 'Could not load messages.', you: 'You', team: 'Support' },
    es: { title: 'Soporte', sub: 'Estamos para ayudarte', hello: '¡Hola! Escribe tu mensaje aquí y un agente responderá lo antes posible.', ph: 'Escribe tu mensaje...', send: 'Enviar', close: 'Cerrar', open: 'Abrir chat de soporte', textOnly: 'Solo texto. Nunca compartas tu contraseña, PIN o códigos.', err: 'No se pudo enviar. Inténtalo de nuevo.', many: 'Demasiados mensajes. Espera un momento.', load: 'No se pudieron cargar los mensajes.', you: 'Tú', team: 'Soporte' }
  };
  const t = () => T[window.LANG] || T[(document.documentElement.lang || 'ht').slice(0, 2)] || T.ht;

  const css = `
#sc-fab{position:fixed;right:1rem;bottom:calc(1rem + env(safe-area-inset-bottom,0px));z-index:45;width:3.4rem;height:3.4rem;border-radius:50%;border:0;cursor:pointer;background:linear-gradient(135deg,#F1C40F,#D4AF37 60%,#996515);color:#000;box-shadow:0 6px 20px rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;font-family:inherit}
#sc-fab:focus-visible{outline:3px solid #fff;outline-offset:2px}
#sc-fab svg{width:1.55rem;height:1.55rem}
#sc-badge{position:absolute;top:-.25rem;right:-.25rem;min-width:1.2rem;height:1.2rem;padding:0 .3rem;border-radius:999px;background:#dc2626;color:#fff;font-size:.7rem;font-weight:800;display:none;align-items:center;justify-content:center;border:2px solid #090a0f;box-sizing:content-box}
#sc-panel{position:fixed;z-index:80;right:1rem;bottom:calc(1rem + env(safe-area-inset-bottom,0px));width:22.5rem;max-width:calc(100vw - 2rem);height:32rem;max-height:calc(100dvh - 2rem);display:none;flex-direction:column;background:#12141d;color:#e5e7eb;border:1px solid rgba(212,175,55,.3);border-radius:1.1rem;box-shadow:0 14px 50px rgba(0,0,0,.65);font-family:Inter,-apple-system,Roboto,Arial,sans-serif;overflow:hidden}
#sc-panel.open{display:flex;animation:sc-in .16s ease-out}
.sc-h{display:flex;align-items:center;gap:.6rem;padding:.8rem 1rem;background:#171a26;border-bottom:1px solid rgba(255,255,255,.08)}
.sc-h b{font-size:.95rem;display:block;line-height:1.2}.sc-h span{font-size:.72rem;color:#9ca3af}
.sc-x{margin-left:auto;background:none;border:0;color:#9ca3af;font-size:1.7rem;line-height:1;cursor:pointer;padding:.1rem .4rem;border-radius:.5rem}
.sc-x:focus-visible,.sc-send:focus-visible{outline:2px solid #D4AF37}
.sc-log{flex:1;overflow-y:auto;padding:.9rem;display:flex;flex-direction:column;gap:.5rem;overscroll-behavior:contain}
.sc-m{max-width:82%;padding:.5rem .75rem;border-radius:1rem;font-size:.88rem;line-height:1.4;white-space:pre-wrap;overflow-wrap:anywhere}
.sc-m.me{align-self:flex-end;background:#D4AF37;color:#000;border-bottom-right-radius:.25rem}
.sc-m.them{align-self:flex-start;background:#1f2333;border-bottom-left-radius:.25rem}
.sc-m.sys{align-self:center;background:transparent;color:#9ca3af;font-size:.78rem;text-align:center;max-width:92%}
.sc-m small{display:block;font-size:.65rem;opacity:.65;margin-top:.2rem}
.sc-err{color:#f87171;font-size:.76rem;padding:0 1rem .3rem;min-height:1.1rem}
.sc-f{padding:.65rem .75rem calc(.65rem + env(safe-area-inset-bottom,0px));border-top:1px solid rgba(255,255,255,.08);background:#12141d}
.sc-row{display:flex;gap:.5rem;align-items:flex-end}
.sc-in{flex:1;resize:none;max-height:7rem;min-height:2.5rem;background:#0a0b10;color:#fff;border:1px solid rgba(255,255,255,.18);border-radius:.8rem;padding:.6rem .7rem;font:inherit;font-size:1rem;line-height:1.3}
.sc-in:focus{outline:2px solid #D4AF37;border-color:transparent}
.sc-send{background:#D4AF37;color:#000;border:0;border-radius:.8rem;padding:.65rem .9rem;font-weight:700;font-size:.85rem;cursor:pointer;font-family:inherit}
.sc-send:disabled{opacity:.5;cursor:default}
.sc-note{font-size:.68rem;color:#6b7280;margin:.4rem .1rem 0}
@media(max-width:480px){#sc-panel{right:0;left:0;bottom:0;width:100%;max-width:100%;height:100dvh;max-height:100dvh;border-radius:0;border:0}}
@keyframes sc-in{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
@media(prefers-reduced-motion:reduce){#sc-panel.open{animation:none}}`;

  let fab, panel, log, input, sendBtn, errEl, badge, uid = '', lastId = 0, seenId = 0, isOpen = false, timer = null, sending = false;
  const ids = new Set();
  const seenKey = () => 'sc_seen_' + uid;
  const getSeen = () => { try { return parseInt(localStorage.getItem(seenKey()) || '0', 10) || 0; } catch { return 0; } };
  const setSeen = (n) => { seenId = n; try { localStorage.setItem(seenKey(), String(n)); } catch { /* pa grav */ } };

  async function api(method, url, body) {
    const r = await fetch(url, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const d = await r.json().catch(() => ({}));
    return { status: r.status, ok: r.ok, data: d };
  }

  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  const toBottom = () => { log.scrollTop = log.scrollHeight; };
  function fmt(iso) { try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } }

  function addMsg(m) {
    if (ids.has(m.id)) return false;
    ids.add(m.id); if (m.id > lastId) lastId = m.id;
    const mine = m.sender === 'user';
    const b = el('div', 'sc-m ' + (mine ? 'me' : 'them'));
    b.appendChild(document.createTextNode(m.body));                 // textContent: pa gen HTML/XSS
    b.appendChild(el('small', '', (mine ? t().you : t().team) + ' · ' + fmt(m.createdAt)));
    log.appendChild(b);
    return true;
  }

  function updateBadge() {
    const n = isOpen ? 0 : unreadCount;
    badge.textContent = n > 9 ? '9+' : String(n);
    badge.style.display = n > 0 ? 'flex' : 'none';
    fab.setAttribute('aria-label', t().open + (n ? ` (${n})` : ''));
  }
  let unreadCount = 0;

  async function poll(first) {
    if (document.hidden && !first) return;
    let r;
    try { r = await api('GET', '/api/support/messages?after=' + lastId); } catch { return; }
    if (r.status === 401 || r.status === 403) return teardown();
    if (!r.ok) { if (isOpen && first) errEl.textContent = t().load; return; }
    const wasBottom = atBottom();
    let added = 0;
    for (const m of r.data.messages || []) { if (addMsg(m)) { added++; if (m.sender !== 'user' && m.id > seenId && !isOpen) unreadCount++; } }
    if (isOpen) { if (added && wasBottom) toBottom(); if (lastId > seenId) setSeen(lastId); unreadCount = 0; if (first) toBottom(); }
    updateBadge();
  }
  const schedule = () => { clearTimeout(timer); timer = setTimeout(async () => { await poll(false); schedule(); }, isOpen ? 4000 : 30000); };

  function setOpen(v) {
    isOpen = v;
    panel.classList.toggle('open', v);
    fab.style.display = v ? 'none' : 'flex';                          // ikòn nan kache pandan popup la louvri (pa kouvri bouton Voye)
    fab.setAttribute('aria-expanded', String(v));
    if (v) {
      errEl.textContent = '';
      unreadCount = 0; if (lastId > seenId) setSeen(lastId); updateBadge();
      toBottom(); setTimeout(() => input.focus(), 50);
      poll(false); schedule();
    } else { fab.focus(); schedule(); }
  }

  async function send() {
    if (sending) return;
    const body = input.value.trim();
    if (!body) return;
    sending = true; sendBtn.disabled = true; errEl.textContent = '';
    try {
      const r = await api('POST', '/api/support/messages', { body });
      if (r.status === 401 || r.status === 403) return teardown();
      if (!r.ok) { errEl.textContent = r.status === 429 ? t().many : (r.data && r.data.error) || t().err; return; }
      addMsg(r.data.message); input.value = ''; autoGrow(); toBottom(); setSeen(lastId);
    } catch { errEl.textContent = t().err; }
    finally { sending = false; sendBtn.disabled = false; input.focus(); }
  }
  function autoGrow() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 112) + 'px'; }
  function teardown() { clearTimeout(timer); if (fab) fab.remove(); if (panel) panel.remove(); }

  function build() {
    const st = el('style'); st.textContent = css; document.head.appendChild(st);
    fab = el('button', ''); fab.id = 'sc-fab'; fab.type = 'button';
    fab.setAttribute('aria-haspopup', 'dialog'); fab.setAttribute('aria-controls', 'sc-panel'); fab.setAttribute('aria-expanded', 'false');
    fab.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.3 8.7 8.7 0 0 1-3.6-.8L3 21l1.9-4.9A8.2 8.2 0 0 1 3 11.5 8.5 8.5 0 0 1 12 3a8.5 8.5 0 0 1 9 8.5z"/></svg>';
    badge = el('span', ''); badge.id = 'sc-badge'; fab.appendChild(badge);
    const nav = document.querySelector('nav.fixed');                // pa kouvri nav anba a sou dashboard
    if (nav) fab.style.bottom = `calc(${Math.ceil(nav.getBoundingClientRect().height) + 20}px + env(safe-area-inset-bottom,0px))`;

    panel = el('div', ''); panel.id = 'sc-panel'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'false');
    const h = el('div', 'sc-h'); const hb = el('div'); hb.appendChild(el('b', '', t().title)); hb.appendChild(el('span', '', t().sub));
    const x = el('button', 'sc-x', '×'); x.type = 'button'; x.setAttribute('aria-label', t().close);
    h.appendChild(hb); h.appendChild(x);
    log = el('div', 'sc-log'); log.setAttribute('role', 'log'); log.setAttribute('aria-live', 'polite');
    log.appendChild(el('div', 'sc-m sys', t().hello));
    errEl = el('div', 'sc-err'); errEl.setAttribute('role', 'alert');
    const f = el('div', 'sc-f'); const row = el('div', 'sc-row');
    input = el('textarea', 'sc-in'); input.rows = 1; input.maxLength = 1000; input.placeholder = t().ph; input.setAttribute('aria-label', t().ph);
    input.setAttribute('autocomplete', 'off'); input.setAttribute('enterkeyhint', 'send');
    sendBtn = el('button', 'sc-send', t().send); sendBtn.type = 'button';
    row.appendChild(input); row.appendChild(sendBtn); f.appendChild(row); f.appendChild(el('p', 'sc-note', t().textOnly));
    panel.appendChild(h); panel.appendChild(log); panel.appendChild(errEl); panel.appendChild(f);
    document.body.appendChild(fab); document.body.appendChild(panel);

    fab.addEventListener('click', () => setOpen(!isOpen));
    x.addEventListener('click', () => setOpen(false));
    sendBtn.addEventListener('click', send);
    input.addEventListener('input', autoGrow);
    input.addEventListener('keydown', (e) => {
      // Òdinatè: Enter voye (Shift+Enter = liy nouvo). Telefòn: Enter = liy nouvo, bouton "Voye" voye.
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !matchMedia('(pointer:coarse)').matches) { e.preventDefault(); send(); }
    });
    panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } });
    for (const ev of ['dragover', 'drop']) panel.addEventListener(ev, (e) => e.preventDefault()); // pa gen fichye/imaj
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(false); });
  }

  async function init() {
    let r;
    try { r = await api('GET', '/api/support/messages'); } catch { return; }
    if (!r.ok) return;                                              // pa konekte, oswa staff: anyen pa parèt
    uid = String(r.data.userId || ''); seenId = getSeen();
    build();
    for (const m of r.data.messages || []) { addMsg(m); if (m.sender !== 'user' && m.id > seenId) unreadCount++; }
    updateBadge(); schedule();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();

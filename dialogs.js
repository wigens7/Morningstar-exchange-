// Fenèt konfimasyon / antre done andedan paj la (ranplase confirm(), prompt(), alert() navigatè a).
// Itilizasyon (andedan yon fonksyon async):
//   if (!(await uiConfirm('Mesaj', { ok: 'Efase', danger: true }))) return;
//   const v = await uiPrompt('Rezon:', '', { min: 10, multiline: true });   // retounen tèks oswa null si anile
//   await uiAlert('Mesaj');
(function () {
  const L = {
    ht: { ok: 'Konfime', cancel: 'Anile', close: 'OK', fieldMin: (n) => `Ekri omwen ${n} karaktè.`, fieldReq: 'Ranpli chan an.', fieldNum: 'Antre yon nimewo valid.' },
    fr: { ok: 'Confirmer', cancel: 'Annuler', close: 'OK', fieldMin: (n) => `Écrivez au moins ${n} caractères.`, fieldReq: 'Remplissez ce champ.', fieldNum: 'Entrez un nombre valide.' },
    en: { ok: 'Confirm', cancel: 'Cancel', close: 'OK', fieldMin: (n) => `Write at least ${n} characters.`, fieldReq: 'This field is required.', fieldNum: 'Enter a valid number.' },
    es: { ok: 'Confirmar', cancel: 'Cancelar', close: 'OK', fieldMin: (n) => `Escribe al menos ${n} caracteres.`, fieldReq: 'Este campo es obligatorio.', fieldNum: 'Ingresa un número válido.' }
  };
  const lbl = () => L[window.LANG] || L.ht;

  const css = `
.ud-ov{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,.72);padding:0;animation:ud-f .12s ease-out}
.ud-sheet{width:100%;max-width:26rem;background:#12141d;color:#e5e7eb;border:1px solid rgba(212,175,55,.25);border-radius:1.25rem 1.25rem 0 0;padding:1.25rem 1.25rem calc(1.25rem + env(safe-area-inset-bottom,0px));font-family:Inter,-apple-system,Roboto,Arial,sans-serif;box-shadow:0 -10px 40px rgba(0,0,0,.5);animation:ud-u .16s ease-out}
.ud-msg{font-size:.95rem;line-height:1.45;white-space:pre-line;word-break:break-word;margin:0 0 .9rem}
.ud-in{width:100%;box-sizing:border-box;background:#0a0b10;border:1px solid rgba(255,255,255,.18);border-radius:.8rem;padding:.75rem;color:#fff;font-size:1rem;font-family:inherit;resize:vertical}
.ud-in:focus{outline:2px solid #D4AF37;border-color:transparent}
.ud-err{color:#f87171;font-size:.78rem;margin:.4rem 0 0;min-height:1em}
.ud-row{display:flex;gap:.6rem;margin-top:1rem}
.ud-btn{flex:1;border:0;border-radius:.8rem;padding:.8rem .5rem;font-size:.9rem;font-weight:700;cursor:pointer;font-family:inherit}
.ud-btn.c{background:rgba(255,255,255,.08);color:#e5e7eb;border:1px solid rgba(255,255,255,.14)}
.ud-btn.o{background:#D4AF37;color:#000}
.ud-btn.d{background:#dc2626;color:#fff}
.ud-btn:focus-visible{outline:2px solid #fff;outline-offset:2px}
@media(min-width:640px){.ud-ov{align-items:center}.ud-sheet{border-radius:1.25rem;padding-bottom:1.25rem}}
@keyframes ud-f{from{opacity:0}to{opacity:1}}
@keyframes ud-u{from{transform:translateY(24px);opacity:.6}to{transform:none;opacity:1}}
@media(prefers-reduced-motion:reduce){.ud-ov,.ud-sheet{animation:none}}`;

  let styled = false, chain = Promise.resolve();
  function ensureStyle() {
    if (styled) return;
    const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s); styled = true;
  }

  // Yon sèl fenèt alafwa (si gen plizyè, yo rete nan fil)
  function show(o) {
    const run = () => new Promise((resolve) => {
      ensureStyle();
      const prevFocus = document.activeElement;
      const ov = document.createElement('div'); ov.className = 'ud-ov';
      const sh = document.createElement('div'); sh.className = 'ud-sheet';
      sh.setAttribute('role', o.alert ? 'alertdialog' : 'dialog'); sh.setAttribute('aria-modal', 'true');
      const msg = document.createElement('p'); msg.className = 'ud-msg'; msg.textContent = String(o.message == null ? '' : o.message); // textContent: pa gen HTML/XSS
      sh.appendChild(msg);
      let input = null, err = null;
      if (o.input) {
        input = document.createElement(o.multiline ? 'textarea' : 'input');
        input.className = 'ud-in';
        if (o.multiline) input.rows = 3; else input.type = 'text';
        if (o.numeric) input.inputMode = 'decimal';
        if (o.max) input.maxLength = o.max;
        if (o.placeholder) input.placeholder = o.placeholder;
        input.value = o.value == null ? '' : String(o.value);
        input.setAttribute('aria-label', msg.textContent);
        err = document.createElement('p'); err.className = 'ud-err'; err.setAttribute('role', 'alert');
        sh.appendChild(input); sh.appendChild(err);
      }
      const row = document.createElement('div'); row.className = 'ud-row';
      const mk = (cls, text) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'ud-btn ' + cls; b.textContent = text; return b; };
      const cancelBtn = o.alert ? null : mk('c', o.cancel || lbl().cancel);
      const okBtn = mk(o.danger ? 'd' : 'o', o.ok || (o.alert ? lbl().close : lbl().ok));
      if (cancelBtn) row.appendChild(cancelBtn);
      row.appendChild(okBtn); sh.appendChild(row); ov.appendChild(sh);

      const prevOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
      let done = false;
      const finish = (val) => {
        if (done) return; done = true;
        document.removeEventListener('keydown', onKey, true);
        ov.remove(); document.body.style.overflow = prevOverflow;
        try { prevFocus && prevFocus.focus && prevFocus.focus(); } catch { /* pa grav */ }
        resolve(val);
      };
      const cancelVal = o.input ? null : (o.alert ? undefined : false);
      const submit = () => {
        if (!o.input) return finish(o.alert ? undefined : true);
        const v = input.value;
        const t = v.trim();
        if (o.numeric) {
          if (!t || !isFinite(Number(t.replace(',', '.'))) ) { err.textContent = lbl().fieldNum; input.focus(); return; }
          return finish(t.replace(',', '.'));
        }
        if (o.min && t.length < o.min) { err.textContent = lbl().fieldMin(o.min); input.focus(); return; }
        if (o.required && !t) { err.textContent = lbl().fieldReq; input.focus(); return; }
        finish(v);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(cancelVal); }
        else if (e.key === 'Enter' && !(o.multiline && e.target === input) && e.target !== cancelBtn) { e.preventDefault(); submit(); }
        else if (e.key === 'Tab') { // kenbe fokis andedan fenèt la
          const f = [...sh.querySelectorAll('input,textarea,button')];
          const i = f.indexOf(document.activeElement);
          if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
          else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
        }
      };
      document.addEventListener('keydown', onKey, true);
      ov.addEventListener('mousedown', (e) => { if (e.target === ov && !o.alert) finish(cancelVal); });
      okBtn.addEventListener('click', submit);
      if (cancelBtn) cancelBtn.addEventListener('click', () => finish(cancelVal));
      document.body.appendChild(ov);
      setTimeout(() => { (input || (o.danger && cancelBtn) || okBtn).focus(); if (input && input.select) input.select(); }, 30);
    });
    const p = chain.then(run, run);
    chain = p.catch(() => {});
    return p;
  }

  // confirm: retounen true/false. Si danger=true, bouton prensipal la rouj epi fokis la sou "Anile".
  window.uiConfirm = (message, opts = {}) => show({ message, ...opts });
  // prompt: retounen tèks (menm vid si required pa mete) oswa null si anile. opts: value, min, max, multiline, numeric, required, placeholder
  window.uiPrompt = (message, value = '', opts = {}) => show({ message, input: true, value, ...opts });
  window.uiAlert = (message, opts = {}) => show({ message, alert: true, ...opts });
})();

/**
 * Preferences dialog (gear button in the header).
 *
 * The server sends { type: 'preferences', data } on connect and whenever a
 * setting changes on any screen; app.js forwards it to receive().
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    open: $('btnPreferences'),
    dialog: $('preferencesDialog'),
    form: $('preferencesForm'),
    enabled: $('prefStatusEnabled'),
    portMode: $('prefStatusPortMode'),
    port: $('prefStatusPort'),
    portRow: $('prefStatusPortRow'),
    uiPort: $('prefStatusUiPort'),
    state: $('prefStatusState'),
    urls: $('prefStatusUrls'),
    error: $('prefError'),
    save: $('btnPrefSave'),
    close: $('btnPrefClose')
  };
  if (!els.dialog) return;

  let current = null;
  let dirty = false;

  function fill() {
    if (!current) return;
    const s = current.statusApi;
    els.enabled.checked = s.enabled;
    els.portMode.value = s.port ? 'own' : 'ui';
    els.port.value = s.port || '';
    els.uiPort.textContent = s.uiPort || '';
    syncControls();
  }

  function syncControls() {
    const on = els.enabled.checked;
    els.portMode.disabled = !on;
    els.portRow.hidden = !on || els.portMode.value !== 'own';
  }

  function renderState() {
    if (!current) return;
    const s = current.statusApi;
    els.state.className = 'pref-state';
    if (!s.enabled) {
      els.state.textContent = 'Off. Other tools get "not found".';
    } else if (s.error) {
      els.state.classList.add('is-error');
      els.state.textContent = `${s.error}. Still available on the web page's port (${s.uiPort}).`;
    } else if (s.listeningPort) {
      els.state.classList.add('is-ok');
      els.state.textContent = `On, on port ${s.listeningPort} and on the web page's port (${s.uiPort}).`;
    } else {
      els.state.classList.add('is-ok');
      els.state.textContent = `On, on the web page's port (${s.uiPort}).`;
    }
    els.urls.textContent = '';
    for (const url of s.urls || []) {
      const li = document.createElement('li');
      const code = document.createElement('code');
      code.textContent = url;
      li.appendChild(code);
      els.urls.appendChild(li);
    }
    els.urls.hidden = !(s.urls || []).length;
  }

  function receive(data) {
    current = data;
    renderState();
    if (!els.dialog.open || !dirty) fill();
  }

  function showError(text) {
    els.error.textContent = text || '';
    els.error.hidden = !text;
  }

  function save() {
    const wantsOwnPort = els.enabled.checked && els.portMode.value === 'own';
    const body = { statusApi: { enabled: els.enabled.checked } };
    if (els.enabled.checked) {
      if (wantsOwnPort) {
        const port = Number(els.port.value);
        if (!Number.isInteger(port) || port < 1 || port > 65535) return showError('Enter a port number from 1 to 65535.');
        body.statusApi.port = port;
      } else {
        body.statusApi.port = null;
      }
    }
    showError('');
    els.save.disabled = true;
    fetch('/api/preferences', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then((res) => res.json().then((json) => ({ ok: res.ok, json })))
      .then(({ ok, json }) => {
        if (!ok) return showError(json.error || 'Could not save.');
        dirty = false;
        receive(json);
      })
      .catch(() => showError('Not connected to the bridge; nothing was saved.'))
      .finally(() => (els.save.disabled = false));
  }

  els.open.addEventListener('click', () => {
    dirty = false;
    showError('');
    fill();
    renderState();
    els.dialog.showModal();
  });
  els.close.addEventListener('click', () => els.dialog.close());
  els.dialog.addEventListener('click', (e) => {
    if (e.target === els.dialog) els.dialog.close(); // click on the backdrop
  });
  for (const input of [els.enabled, els.portMode, els.port]) {
    input.addEventListener('input', () => {
      dirty = true;
      syncControls();
    });
  }
  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    save();
  });

  window.DantePreferences = { receive };
})();

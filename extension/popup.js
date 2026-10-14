(() => {
  'use strict';

  const { sanitizeSettings } = globalThis.SPMCore;
  const $ = (id) => document.getElementById(id);
  const POLL_MS = 700;

  let settings = sanitizeSettings(null);

  const save = (patch) => {
    settings = sanitizeSettings(Object.assign({}, settings, patch));
    chrome.storage.local.set({ settings });
  };

  const renderForm = () => {
    $('enabled').checked = settings.enabled;
    for (const r of document.querySelectorAll('input[name="mode"]')) r.checked = r.value === settings.mode;
    if (document.activeElement !== $('trackName')) $('trackName').value = settings.trackName;
    $('rounding').value = settings.rounding;
    $('timing').value = settings.timing;
    if (document.activeElement !== $('delayMin')) $('delayMin').value = settings.delayMin;
    if (document.activeElement !== $('delayMax')) $('delayMax').value = settings.delayMax;
    $('copyOptions').hidden = settings.mode !== 'copy';
    $('averageOptions').hidden = settings.mode !== 'average';
  };

  // ---------- form events ----------

  $('enabled').addEventListener('change', (e) => save({ enabled: e.target.checked }));
  for (const r of document.querySelectorAll('input[name="mode"]')) {
    r.addEventListener('change', () => {
      save({ mode: r.value });
      renderForm();
    });
  }
  $('trackName').addEventListener('input', (e) => save({ trackName: e.target.value }));
  $('rounding').addEventListener('change', (e) => save({ rounding: e.target.value }));
  $('timing').addEventListener('change', (e) => save({ timing: e.target.value }));
  for (const id of ['delayMin', 'delayMax']) {
    $(id).addEventListener('change', () => {
      save({ delayMin: $('delayMin').value, delayMax: $('delayMax').value });
      $('delayMin').value = settings.delayMin;
      $('delayMax').value = settings.delayMax;
    });
  }

  // ---------- status ----------

  const timeOf = (ms) => new Date(ms).toLocaleTimeString('ru-RU');
  const show = (v) => (v === 'cof' ? '☕' : v);

  const setStatus = (text, kind, details) => {
    const line = $('statusLine');
    line.textContent = text;
    line.className = 'status-line' + (kind ? ' ' + kind : '');
    const box = $('details');
    box.textContent = '';
    for (const d of details || []) {
      if (!d) continue;
      const div = document.createElement('div');
      div.textContent = d;
      box.appendChild(div);
    }
  };

  const renderPeople = (state) => {
    const list = $('people');
    list.textContent = '';
    const names = $('names');
    names.textContent = '';
    const people = (state && state.participants) || [];
    $('peopleBlock').hidden = !people.length;
    if (!people.length) return;
    $('revealState').textContent = state.revealed ? 'карты открыты' : 'карты скрыты';

    const sorted = people.slice().sort((a, b) => (a.isSelf - b.isSelf) || a.name.localeCompare(b.name, 'ru'));
    const seen = new Set();
    for (const p of sorted) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = p.name + (p.isSelf ? ' (вы)' : '');
      const vote = document.createElement('span');
      vote.className = 'vote' + (p.vote == null ? ' none' : '');
      vote.textContent = p.vote == null ? '—' : show(p.vote);
      li.append(name, vote);
      if (p.isTracked) li.classList.add('tracked');
      if (!p.isSelf) {
        li.classList.add('pick');
        li.title = 'Копировать голос этого участника';
        li.addEventListener('click', () => {
          save({ trackName: p.name, mode: 'copy' });
          $('trackName').value = p.name;
          renderForm();
          poll();
        });
        if (!seen.has(p.name)) {
          seen.add(p.name);
          const opt = document.createElement('option');
          opt.value = p.name;
          names.appendChild(opt);
        }
      }
      list.appendChild(li);
    }
  };

  const renderState = (state) => {
    renderPeople(state);
    if (!state) {
      setStatus('Нет связи со страницей', 'warn', [
        'Откройте комнату на scrumpoker-online.org в этой вкладке.',
        'Если она уже открыта — обновите страницу (F5): расширение подключается при загрузке.',
      ]);
      return;
    }
    if (!state.roomId) return setStatus('Откройте комнату', 'warn', ['Адрес вида …/room/12345678/scrum-poker']);
    if (!state.inRoom) return setStatus('Войдите в комнату', 'warn', [`Комната ${state.roomId}: карты для голосования пока не видны.`]);
    if (!state.source) {
      return setStatus(
        state.firebaseSeen ? 'Жду данные комнаты…' : 'Нет данных комнаты',
        'warn',
        state.firebaseSeen ? [] : ['Обновите страницу (F5), чтобы расширение подключилось к данным комнаты.'],
      );
    }

    const d = state.decision || {};
    const details = [];
    details.push(`Комната ${state.roomId} · ${state.source === 'ws' ? 'данные Firebase' : 'данные из таблицы (резервный режим)'}`);
    details.push(`Ваш голос: ${state.myVote == null ? 'нет' : show(state.myVote)}`);
    if (d.info) details.push(d.info);
    if (state.lastAction && state.lastAction.roomId === state.roomId) {
      const a = state.lastAction;
      details.push(`Последнее действие: ${timeOf(a.at)} — карта ${show(a.value)}${a.confirmed ? ' ✓' : ''}`);
    }

    if (!state.settings.enabled) return setStatus('Выключено — только наблюдение', '', details);
    if (d.problem) return setStatus(d.problem, 'warn', details);
    if (d.target == null) return setStatus('Жду голос…', '', details);

    const t = show(d.target);
    if (state.myVote != null && state.myVote.trim() === String(d.target).trim()) return setStatus(`Стоит ${t} ✓`, 'ok', details);
    if (state.blocked) {
      return setStatus(
        `Страница не принимает клик (цель ${t})`,
        'err',
        details.concat('Закройте окно согласия на cookies или другой диалог на странице — после этого голос поставится сам.'),
      );
    }
    if (state.gaveUp) return setStatus(`Не удалось поставить ${t}`, 'err', details.concat('Нажмите «Синхронизировать сейчас», чтобы попробовать снова.'));
    if (state.manualOverride) {
      return setStatus(`Вы выбрали карту вручную (цель ${t})`, 'warn', details.concat('Расширение не перебивает ручной выбор, пока цель не изменится.'));
    }
    if (state.waitingReveal) return setStatus(`Поставлю ${t} после вскрытия карт`, '', details);
    return setStatus(`Ставлю ${t}…`, '', details);
  };

  // ---------- polling the active tab ----------

  let tabId = null;

  const request = (type) =>
    new Promise((resolve) => {
      if (tabId == null) return resolve(null);
      try {
        chrome.tabs.sendMessage(tabId, { type }, (res) => {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(res && res.ok ? res : null);
        });
      } catch (_) {
        resolve(null);
      }
    });

  const poll = async () => renderState(await request('spm:getState'));

  $('resync').addEventListener('click', async () => renderState(await request('spm:resync')));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) {
      settings = sanitizeSettings(changes.settings.newValue);
      renderForm();
    }
  });

  (async () => {
    const res = await chrome.storage.local.get('settings');
    settings = sanitizeSettings(res.settings);
    renderForm();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab ? tab.id : null;
    await poll();
    setInterval(poll, POLL_MS);
  })();
})();

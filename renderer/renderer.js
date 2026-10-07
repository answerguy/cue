/* cue renderer — UI state, mic capture, IPC, streaming render. */
(function () {
  const { icon } = window.ICONS;
  const cue = window.cue; // exposed by preload
  const $ = (s) => document.querySelector(s);
  const isWindows = cue.platform === 'win32';
  const isMac = cue.platform === 'darwin';

  // Disable all native Chromium tooltips globally so no floating dialogs pop up
  // outside the protected window during screen sharing.
  function stripTitles(root = document) {
    if (!root || !root.querySelectorAll) return;
    if (root.hasAttribute && root.hasAttribute('title')) {
      const t = root.getAttribute('title');
      if (t && !root.hasAttribute('aria-label')) root.setAttribute('aria-label', t);
      root.removeAttribute('title');
    }
    const elements = root.querySelectorAll('[title]');
    for (const el of elements) {
      const t = el.getAttribute('title');
      if (t && !el.hasAttribute('aria-label')) el.setAttribute('aria-label', t);
      el.removeAttribute('title');
    }
  }

  try {
    const origSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      if (name && typeof name === 'string' && name.toLowerCase() === 'title') {
        if (value && !this.hasAttribute('aria-label')) {
          origSetAttribute.call(this, 'aria-label', value);
        }
        return;
      }
      return origSetAttribute.apply(this, arguments);
    };

    Object.defineProperty(HTMLElement.prototype, 'title', {
      get() {
        return this.getAttribute('aria-label') || '';
      },
      set(val) {
        if (val && !this.hasAttribute('aria-label')) {
          this.setAttribute('aria-label', val);
        }
        this.removeAttribute('title');
      },
      configurable: true,
      enumerable: true
    });
  } catch (err) {
    console.warn('[cue] could not install title interceptor', err);
  }

  const titleObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'attributes' && m.attributeName === 'title' && m.target) {
        m.target.removeAttribute('title');
      } else if (m.type === 'childList') {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1) stripTitles(node);
        }
      }
    }
  });
  if (document.documentElement) {
    titleObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['title'],
      childList: true,
      subtree: true
    });
  }
  stripTitles(document);

  // Disable native context menu globally so right-clicking never spawns an OS window
  window.addEventListener('contextmenu', (e) => e.preventDefault());

  // In-DOM confirm dialog so confirmation prompts never open a native Win32 dialog
  function showConfirmDialog({ title = 'Confirm', message = '', confirmText = 'OK', cancelText = 'Cancel', danger = false } = {}) {
    return new Promise((resolve) => {
      let scrim = document.getElementById('confirm-scrim');
      if (!scrim) {
        scrim = document.createElement('div');
        scrim.id = 'confirm-scrim';
        scrim.className = 'confirm-scrim hidden';
        document.body.appendChild(scrim);
      }
      scrim.innerHTML = `
        <div class="confirm-dialog">
          <div class="confirm-title">${esc(title)}</div>
          <div class="confirm-message">${esc(message)}</div>
          <div class="confirm-buttons">
            <button type="button" class="confirm-cancel">${esc(cancelText)}</button>
            <button type="button" class="confirm-ok ${danger ? 'danger' : ''}">${esc(confirmText)}</button>
          </div>
        </div>
      `;
      scrim.classList.remove('hidden');
      function cleanup(result) {
        scrim.classList.add('hidden');
        scrim.innerHTML = '';
        resolve(result);
      }
      scrim.querySelector('.confirm-cancel').onclick = () => cleanup(false);
      scrim.querySelector('.confirm-ok').onclick = () => cleanup(true);
      scrim.onclick = (e) => { if (e.target === scrim) cleanup(false); };
    });
  }

  // ---- Custom in-DOM select dropdowns ----
  // Native <select> elements spawn Win32 popup menus that bypass setContentProtection.
  // We keep the native <select> in the DOM for compatibility with all scripts and tests,
  // but hide it from pointer events and render a 100% in-DOM dropdown menu.
  let activeCustomDropdown = null;

  function closeAllCustomSelects() {
    if (activeCustomDropdown) {
      activeCustomDropdown.close();
      activeCustomDropdown = null;
    }
  }

  function setupCustomSelect(select) {
    if (!select || select._hasCustomSelect) return;
    select._hasCustomSelect = true;

    select.classList.add('s-select-native-hidden');
    select.setAttribute('tabindex', '-1');
    select.setAttribute('aria-hidden', 'true');

    const wrapper = document.createElement('div');
    wrapper.className = 'custom-select-wrap' + (select.classList.contains('compact') ? ' compact' : '');

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 's-select custom-select-trigger' + (select.classList.contains('compact') ? ' compact' : '');
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');

    const labelSpan = document.createElement('span');
    labelSpan.className = 'custom-select-label';

    const chevron = document.createElement('span');
    chevron.className = 'custom-select-chevron';
    chevron.textContent = '▾';

    trigger.append(labelSpan, chevron);

    const menu = document.createElement('div');
    menu.className = 'custom-select-menu hidden';
    menu.setAttribute('role', 'listbox');

    if (select.parentNode) {
      select.parentNode.insertBefore(wrapper, select);
      wrapper.appendChild(select);
      wrapper.appendChild(trigger);
    }
    document.body.appendChild(menu);

    function updateLabel() {
      const selectedOption = select.selectedOptions && select.selectedOptions[0];
      const text = selectedOption ? selectedOption.textContent : (select.value || '');
      labelSpan.textContent = text;
      trigger.setAttribute('aria-label', text);
    }

    function buildOptions() {
      menu.innerHTML = '';
      const options = Array.from(select.options);
      for (const opt of options) {
        const item = document.createElement('div');
        item.className = 'custom-select-option' + (opt.value === select.value ? ' selected' : '');
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', opt.value === select.value ? 'true' : 'false');
        item.dataset.value = opt.value;
        item.textContent = opt.textContent;

        item.addEventListener('click', (e) => {
          e.stopPropagation();
          select.value = opt.value;
          updateLabel();
          closeMenu();
          select.dispatchEvent(new Event('change', { bubbles: true }));
          select.dispatchEvent(new Event('input', { bubbles: true }));
          trigger.focus();
        });

        menu.appendChild(item);
      }
    }

    function positionMenu() {
      const rect = trigger.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom - 10;
      const spaceAbove = rect.top - 10;
      const width = Math.max(rect.width, 240);
      menu.style.width = `${width}px`;
      menu.style.left = `${Math.min(rect.left, window.innerWidth - width - 10)}px`;

      if (spaceBelow < 200 && spaceAbove > spaceBelow) {
        menu.style.maxHeight = `${Math.min(260, spaceAbove)}px`;
        menu.style.bottom = `${window.innerHeight - rect.top + 4}px`;
        menu.style.top = 'auto';
      } else {
        menu.style.maxHeight = `${Math.min(260, spaceBelow)}px`;
        menu.style.top = `${rect.bottom + 4}px`;
        menu.style.bottom = 'auto';
      }
    }

    function openMenu() {
      if (activeCustomDropdown && activeCustomDropdown !== instance) {
        closeAllCustomSelects();
      }
      buildOptions();
      positionMenu();
      menu.classList.remove('hidden');
      trigger.setAttribute('aria-expanded', 'true');
      activeCustomDropdown = instance;

      const selectedItem = menu.querySelector('.custom-select-option.selected');
      if (selectedItem) {
        selectedItem.scrollIntoView({ block: 'nearest' });
      }
    }

    function closeMenu() {
      menu.classList.add('hidden');
      trigger.setAttribute('aria-expanded', 'false');
      if (activeCustomDropdown === instance) {
        activeCustomDropdown = null;
      }
    }

    const instance = { close: closeMenu, update: updateLabel };

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      if (menu.classList.contains('hidden')) {
        openMenu();
      } else {
        closeMenu();
      }
    });

    trigger.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (menu.classList.contains('hidden')) {
          openMenu();
        } else {
          const items = Array.from(menu.querySelectorAll('.custom-select-option'));
          const currentIdx = items.findIndex((it) => it.classList.contains('selected') || it.classList.contains('highlighted'));
          let nextIdx = currentIdx;
          if (e.key === 'ArrowDown') nextIdx = Math.min(items.length - 1, currentIdx + 1);
          if (e.key === 'ArrowUp') nextIdx = Math.max(0, currentIdx - 1);
          if (nextIdx >= 0 && nextIdx < items.length) {
            items.forEach((it) => it.classList.remove('highlighted'));
            items[nextIdx].classList.add('highlighted');
            items[nextIdx].scrollIntoView({ block: 'nearest' });
            if (e.key === 'Enter' || e.key === ' ') {
              items[nextIdx].click();
            }
          }
        }
      } else if (e.key === 'Escape' && !menu.classList.contains('hidden')) {
        e.preventDefault();
        closeMenu();
      }
    });

    // Intercept .value setter on the select element so programmatic changes update the custom label
    const proto = HTMLSelectElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc) {
      Object.defineProperty(select, 'value', {
        get() {
          return desc.get.call(this);
        },
        set(val) {
          desc.set.call(this, val);
          updateLabel();
        },
        configurable: true
      });
    }

    // Observe changes to the native <select> options or attributes
    const observer = new MutationObserver(() => {
      updateLabel();
      if (!menu.classList.contains('hidden')) {
        buildOptions();
        positionMenu();
      }
    });
    observer.observe(select, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'selected'] });

    // Initial label sync
    updateLabel();
  }

  document.addEventListener('pointerdown', (e) => {
    if (activeCustomDropdown && !e.target.closest('.custom-select-wrap') && !e.target.closest('.custom-select-menu')) {
      closeAllCustomSelects();
    }
  });
  window.addEventListener('scroll', closeAllCustomSelects, true);
  window.addEventListener('resize', closeAllCustomSelects);

  // Initialize existing selects and watch for dynamically added ones
  document.querySelectorAll('select').forEach(setupCustomSelect);
  const selectObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType === 1) {
          if (node.tagName === 'SELECT') setupCustomSelect(node);
          else if (node.querySelectorAll) node.querySelectorAll('select').forEach(setupCustomSelect);
        }
      }
    }
  });
  if (document.documentElement) {
    selectObserver.observe(document.documentElement, { childList: true, subtree: true });
  }
  const quitButton = $('#quit-btn');
  quitButton.addEventListener('click', () => cue.quit());
  quitButton.setAttribute('aria-label', isMac ? 'Quit cue (⌘⇧X)' : 'Quit cue (Ctrl+Shift+X)');

  // ---- paint icons -------------------------------------------------------
  $('#logo-btn').innerHTML = icon('badge-question-mark', { size: 16 });
  $('#tb-settings-btn').innerHTML = icon('settings', { size: 16 });
  $('.tb-hide .chev').innerHTML = icon('chevron-down', { size: 14 });
  $('#opacity-btn .ic').innerHTML = icon('eclipse', { size: 14 });
  $('#quit-btn').innerHTML = icon('x', { size: 14 });
  document.querySelector('.act[data-mode="assist"] .ic').innerHTML = icon('monitor', { size: 16 });
  document.querySelector('.act[data-mode="say"] .ic').innerHTML = icon('wand-sparkles', { size: 16 });
  document.querySelector('.act[data-mode="recap"] .ic').innerHTML = icon('refresh-cw', { size: 16 });
  const prev4IC = document.querySelector('.act[data-mode="previous4"] .ic');
  if (prev4IC) prev4IC.innerHTML = icon('message-square-text', { size: 16 });
  const hrActIC = document.querySelector('.act[data-mode="hr"] .ic');
  if (hrActIC) hrActIC.innerHTML = icon('message-circle', { size: 16 });
  const leetcodeIC = document.querySelector('.act[data-mode="leetcode"] .ic');
  if (leetcodeIC) leetcodeIC.innerHTML = icon('code', { size: 16 });
  $('#smart-toggle .ic').innerHTML = icon('zap', { size: 14 });
  $('#more-btn').innerHTML = icon('more-horizontal', { size: 18 });
  $('#send-btn').innerHTML = icon('play', { size: 15 });
  const clearIC = document.querySelector('#clear-transcript-btn .ic');
  if (clearIC) clearIC.innerHTML = icon('trash-2', { size: 15 });
  const focusBtnIC = document.querySelector('#focus-btn .ic');
  if (focusBtnIC) focusBtnIC.innerHTML = icon('shield', { size: 14 });

  function setSessionButton(active) {
    const btn = $('#stop-btn');
    const ic = btn.querySelector('.ic');
    const label = btn.querySelector('.tb-stop-label');
    const hint = btn.querySelector('#stop-shortcut-hint');
    btn.classList.toggle('active', active);
    if (ic) ic.innerHTML = active
      ? icon('square', { size: 14 })
      : icon('play', { size: 14, filled: false });
    if (label) label.textContent = active ? 'End session' : 'Start session';
    const title = active ? 'End session' : 'Start session';
    const keyHint = hint ? ` (${hint.textContent})` : ' (Alt+Y)';
    btn.setAttribute('aria-label', title + keyHint);
  }
  setSessionButton(false);

  // ---- state -------------------------------------------------------------
  let settings = null;
  // Redacted view of the publik API state (never the key), from main via
  // cue.publikState() at boot and the publik:state push thereafter.
  let publikState = null;
  let whisperOverview = null;
  let busy = false;
  let aiEl = null;       // current streaming <div class="ai-text">
  let caretEl = null;
  let responseCount = 0;
  const MAX_RESPONSES = 20;

  const messages = $('#messages');

  function esc(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // minimal, safe markdown: fenced code, bullets, inline code, bold, paragraphs
  function renderMarkdown(text) {
    const lines = text.split('\n');
    let html = '', inCode = false, inList = false, buf = [];
    const flushP = () => { if (buf.length) { html += '<p>' + inline(buf.join(' ')) + '</p>'; buf = []; } };
    const inline = (s) => esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    for (const raw of lines) {
      const line = raw;
      if (/^```/.test(line.trim())) {
        if (!inCode) { flushP(); if (inList) { html += '</ul>'; inList = false; } html += '<pre><code>'; inCode = true; }
        else { html += '</code></pre>'; inCode = false; }
        continue;
      }
      if (inCode) { html += esc(line) + '\n'; continue; }
      if (/^\s*[-*]\s+/.test(line)) { flushP(); if (!inList) { html += '<ul>'; inList = true; } html += '<li>' + inline(line.replace(/^\s*[-*]\s+/, '')) + '</li>'; continue; }
      if (line.trim() === '') { flushP(); if (inList) { html += '</ul>'; inList = false; } continue; }
      buf.push(line.trim());
    }
    flushP(); if (inList) html += '</ul>'; if (inCode) html += '</code></pre>';
    return html;
  }

  let retryingGroup = null;

  function clearMessages() { messages.innerHTML = ''; aiEl = null; caretEl = null; retryingGroup = null; }

  function addUserBubble(text) {
    const b = document.createElement('div');
    b.className = 'user-bubble';
    b.textContent = text;
    messages.appendChild(b);
  }

  function startAi(small) {
    let group = messages.querySelector('.response-group:last-child');
    if (!group) {
      group = document.createElement('div');
      group.className = 'response-group';
      messages.appendChild(group);
    }
    aiEl = document.createElement('div');
    aiEl.className = 'ai-text' + (small ? ' small' : '');
    aiEl.dataset.raw = '';
    caretEl = document.createElement('span');
    caretEl.className = 'ai-caret';
    aiEl.appendChild(caretEl);
    group.appendChild(aiEl);
  }

  function appendToken(t) {
    if (!aiEl) startAi(false);
    aiEl.dataset.raw += t;
    const span = document.createElement('span');
    span.className = 'w';
    span.textContent = t;
    // Guard: caretEl must be a child of aiEl
    if (caretEl && caretEl.parentNode === aiEl) {
      aiEl.insertBefore(span, caretEl);
    } else {
      aiEl.appendChild(span);
    }
  }

  function showIteration(group, index) {
    if (!group._iterations || index < 0 || index >= group._iterations.length) return;
    group._currentIterationIndex = index;
    const iter = group._iterations[index];
    const ai = group.querySelector('.ai-text');
    if (ai) {
      ai.dataset.raw = iter.raw;
      ai.innerHTML = renderMarkdown(iter.raw);
      ai.classList.toggle('error', !!iter.isError);
    }
    // Update pagination controls
    const pagination = group.querySelector('.resp-pagination');
    if (pagination) {
      const pageNum = pagination.querySelector('.resp-page-num');
      if (pageNum) pageNum.textContent = `${index + 1}/${group._iterations.length}`;
      const prevBtn = pagination.querySelector('.resp-act-prev');
      if (prevBtn) {
        prevBtn.disabled = (index <= 0);
        prevBtn.classList.toggle('disabled', index <= 0);
      }
      const nextBtn = pagination.querySelector('.resp-act-next');
      if (nextBtn) {
        nextBtn.disabled = (index >= group._iterations.length - 1);
        nextBtn.classList.toggle('disabled', index >= group._iterations.length - 1);
      }
    }
    // Update retry button label
    const retryBtn = group.querySelector('.resp-act-retry');
    if (retryBtn) {
      retryBtn.setAttribute('aria-label', iter.isError ? 'Retry failed prompt (Alt+R)' : 'Retry prompt (Alt+R)');
    }
  }

  function getActiveResponseGroup() {
    if (retryingGroup && retryingGroup.isConnected) return retryingGroup;
    const groups = messages.querySelectorAll('.response-group');
    if (!groups.length) return null;
    return groups[groups.length - 1];
  }

  function goToPreviousAnswer(targetGroup) {
    const group = targetGroup || getActiveResponseGroup();
    if (!group) return;
    if (group._iterations && group._iterations.length > 1 && group._currentIterationIndex > 0) {
      showIteration(group, group._currentIterationIndex - 1);
      return;
    }
    const allGroups = Array.from(messages.querySelectorAll('.response-group'));
    const idx = allGroups.indexOf(group);
    if (idx > 0) {
      const prevGroup = allGroups[idx - 1];
      prevGroup.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      showToast('Previous answer', 1000);
    } else {
      showToast('First answer reached', 1200);
    }
  }

  function goToNextAnswer(targetGroup) {
    const group = targetGroup || getActiveResponseGroup();
    if (!group) return;
    if (group._iterations && group._iterations.length > 1 && group._currentIterationIndex < group._iterations.length - 1) {
      showIteration(group, group._currentIterationIndex + 1);
      return;
    }
    const allGroups = Array.from(messages.querySelectorAll('.response-group'));
    const idx = allGroups.indexOf(group);
    if (idx >= 0 && idx < allGroups.length - 1) {
      const nextGroup = allGroups[idx + 1];
      nextGroup.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      showToast('Next answer', 1000);
    } else {
      showToast('Latest answer reached', 1200);
    }
  }

  function createResponseActions(group, rawText, isError) {
    const wrap = document.createElement('div');
    wrap.className = 'response-actions';
    wrap.setAttribute('role', 'toolbar');
    wrap.setAttribute('aria-label', 'Response actions');

    if (!group._iterations) {
      group._iterations = [];
    }
    if (rawText != null) {
      const last = group._iterations[group._iterations.length - 1];
      if (!last || last.raw !== rawText || last.isError !== isError) {
        group._iterations.push({ raw: rawText, isError: !!isError });
        group._currentIterationIndex = group._iterations.length - 1;
      }
    }
    if (group._currentIterationIndex == null || group._currentIterationIndex < 0) {
      group._currentIterationIndex = Math.max(0, group._iterations.length - 1);
    }

    // 0. Version Pagination with previous (Alt+E) and next (Alt+T) answer
    const pagination = document.createElement('div');
    pagination.className = 'resp-pagination';

    const prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.className = 'resp-act-btn resp-act-prev' + (group._currentIterationIndex <= 0 ? ' disabled' : '');
    prevBtn.setAttribute('aria-label', 'Previous iteration (Alt+E)');
    prevBtn.innerHTML = `<span class="resp-act-icon">${icon('chevron-left', { size: 13, stroke: 2 })}</span><span class="resp-act-hint">Alt+E</span>`;
    if (group._currentIterationIndex <= 0) prevBtn.disabled = true;

    const pageNum = document.createElement('span');
    pageNum.className = 'resp-page-num';
    pageNum.textContent = `${group._currentIterationIndex + 1}/${Math.max(1, group._iterations.length)}`;

    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'resp-act-btn resp-act-next' + (group._currentIterationIndex >= group._iterations.length - 1 ? ' disabled' : '');
    nextBtn.setAttribute('aria-label', 'Next iteration (Alt+T)');
    nextBtn.innerHTML = `<span class="resp-act-icon">${icon('chevron-right', { size: 13, stroke: 2 })}</span><span class="resp-act-hint">Alt+T</span>`;
    if (group._currentIterationIndex >= group._iterations.length - 1) nextBtn.disabled = true;

    prevBtn.addEventListener('click', () => {
      goToPreviousAnswer(group);
    });

    nextBtn.addEventListener('click', () => {
      goToNextAnswer(group);
    });

    pagination.appendChild(prevBtn);
    pagination.appendChild(pageNum);
    pagination.appendChild(nextBtn);
    wrap.appendChild(pagination);

    // 1. Retry Button with Alt+R hint below it
    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'resp-act-btn resp-act-retry';
    const currentIsError = group._iterations[group._currentIterationIndex] ? group._iterations[group._currentIterationIndex].isError : isError;
    retryBtn.setAttribute('aria-label', currentIsError ? 'Retry failed prompt (Alt+R)' : 'Retry prompt (Alt+R)');
    retryBtn.innerHTML = `<span class="resp-act-icon">${icon('rotate-cw', { size: 14, stroke: 1.8 })}</span><span class="resp-act-hint">Alt+R</span>`;

    retryBtn.addEventListener('click', () => {
      if (busy) {
        showToast('Please wait for the current response to finish', 2000);
        return;
      }
      retryResponse(group);
    });

    // 2. Copy Button
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'resp-act-btn resp-act-copy';
    copyBtn.setAttribute('aria-label', 'Copy response');
    copyBtn.innerHTML = `<span class="resp-act-icon">${icon('copy', { size: 14, stroke: 1.8 })}</span><span class="resp-act-hint">Copy</span>`;

    let copyResetTimer = null;
    copyBtn.addEventListener('click', () => {
      const currentIter = (group._iterations && group._iterations[group._currentIterationIndex]) ? group._iterations[group._currentIterationIndex].raw : '';
      const textToCopy = currentIter || rawText || (group.querySelector('.ai-text') ? group.querySelector('.ai-text').innerText : '');
      if (!textToCopy) return;
      navigator.clipboard.writeText(textToCopy).then(() => {
        copyBtn.classList.add('copied');
        copyBtn.innerHTML = `<span class="resp-act-icon">${icon('check', { size: 14, stroke: 2 })}</span><span class="resp-act-hint">Copied</span>`;
        showToast('Copied to clipboard', 1800);
        clearTimeout(copyResetTimer);
        copyResetTimer = setTimeout(() => {
          copyBtn.classList.remove('copied');
          copyBtn.innerHTML = `<span class="resp-act-icon">${icon('copy', { size: 14, stroke: 1.8 })}</span><span class="resp-act-hint">Copy</span>`;
        }, 1500);
      }).catch(() => {
        showToast('Failed to copy', 1800);
      });
    });

    // 3. Autotype Button
    const autotypeBtn = document.createElement('button');
    autotypeBtn.type = 'button';
    autotypeBtn.className = 'resp-act-btn resp-act-autotype';
    autotypeBtn.setAttribute('aria-label', 'Autotype response (Alt+A)');
    autotypeBtn.innerHTML = `<span class="resp-act-icon">${icon('keyboard', { size: 14, stroke: 1.8 })}</span><span class="resp-act-hint">Alt+A</span>`;
    autotypeBtn.addEventListener('click', () => {
      const currentIter = (group._iterations && group._iterations[group._currentIterationIndex]) ? group._iterations[group._currentIterationIndex].raw : '';
      const textToType = currentIter || rawText || (group.querySelector('.ai-text') ? group.querySelector('.ai-text').innerText : '');
      toggleAutotyper(textToType);
    });

    wrap.appendChild(retryBtn);
    wrap.appendChild(copyBtn);
    wrap.appendChild(autotypeBtn);

    return wrap;
  }

  function retryResponse(group) {
    if (busy) {
      showToast('Please wait for the current response to finish', 2000);
      return;
    }
    const mode = group.dataset.mode || 'ask';
    const text = group.dataset.text || '';
    retryingGroup = group;

    const retryBtn = group.querySelector('.resp-act-retry');
    if (retryBtn) retryBtn.classList.add('spinning');

    let textEl = group.querySelector('.ai-text');
    if (!textEl) {
      textEl = document.createElement('div');
      textEl.className = 'ai-text' + (group.dataset.small === 'true' ? ' small' : '');
      group.appendChild(textEl);
    } else {
      textEl.classList.remove('error');
    }
    textEl.dataset.raw = '';
    textEl.innerHTML = '';
    caretEl = document.createElement('span');
    caretEl.className = 'ai-caret';
    textEl.appendChild(caretEl);
    aiEl = textEl;

    const actionsEl = group.querySelector('.response-actions');
    if (actionsEl) actionsEl.remove();

    showToast('Retrying...', 1500);
    runMode(mode, text);
  }

  function finalizeAi(isError = false) {
    if (!aiEl) return;
    const raw = aiEl.dataset.raw || '';
    aiEl.innerHTML = renderMarkdown(raw);
    if (isError) {
      aiEl.classList.add('error');
    } else if (raw && typeof cue.autotypeSetText === 'function') {
      cue.autotypeSetText(raw);
    }
    const group = aiEl.closest('.response-group');
    if (group) {
      const oldActions = group.querySelector('.response-actions');
      if (oldActions) oldActions.remove();
      const actions = createResponseActions(group, raw, isError);
      group.appendChild(actions);
    }
    aiEl = null;
    caretEl = null;
    retryingGroup = null;
  }

  let busyFailsafe = null;
  function setBusy(v) {
    busy = v;
    $('#send-btn').classList.toggle('busy', v);
    clearTimeout(busyFailsafe);
    // Failsafe: main has a 25s stream watchdog that always sends llm:done/llm:error, but if a
    // terminal event is ever lost the whole UI stays frozen — self-clear after a generous window.
    if (v) busyFailsafe = setTimeout(() => { busy = false; $('#send-btn').classList.toggle('busy', false); }, 40000);
  }

  // ---- transcript helpers ------------------------------------------------
  // NOTE: The old transcript-list element was renamed to ts-list.
  // These helpers are now deprecated but kept for compatibility.
  // The main sidebar uses appendTranscriptHistoryTurn() instead.
  let transcriptInterimEl = null;

  // FIX #1: Updated to use ts-list instead of non-existent transcript-list

  function clearTranscriptInterim() {
    if (transcriptInterimEl) {
      transcriptInterimEl.remove();
      transcriptInterimEl = null;
    }
  }

  // ---- toast helper ------------------------------------------------------
  // FIX #7: Toast queue system — ensures latest toast wins cleanly without stacking
  let toastTimer = null;
  let toastFadeTimer = null;
  function showToast(message, ms) {
    let el = document.getElementById('toast');
    const panelWrap = document.getElementById('panel-wrap');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      if (panelWrap) panelWrap.appendChild(el);
      else document.body.appendChild(el);
    }
    // Clear any pending timers to prevent overlap
    clearTimeout(toastTimer);
    clearTimeout(toastFadeTimer);
    // Immediately update content (no stacking)
    el.textContent = message;

    // Guard against window bottom clipping: if panel-wrap reaches near the bottom of the window,
    // dock toast inside panel-wrap at the bottom so it is never clipped off-screen.
    if (panelWrap) {
      const wrapRect = panelWrap.getBoundingClientRect();
      if (wrapRect.bottom + 48 > window.innerHeight) {
        el.style.top = 'auto';
        el.style.bottom = '12px';
      } else {
        el.style.top = '';
        el.style.bottom = '';
      }
    }

    el.classList.add('show');
    toastTimer = setTimeout(() => {
      el.classList.remove('show');
    }, ms);
  }

  // ---- actions -----------------------------------------------------------
  function runMode(mode, text) {
    if (busy) return;
    setBusy(true);
    cue.ask({ mode, text: text || '' });
  }

  document.querySelectorAll('.act').forEach((btn) => {
    btn.addEventListener('click', () => {
      retryingGroup = null;
      runMode(btn.dataset.mode, '');
    });
  });

  const input = $('#input');
  const placeholder = $('#placeholder');
  const composer = $('#composer');
  const clearInputBtn = $('#clear-input-btn');
  const caretMirror = $('#stealth-caret-mirror');
  const caretMirrorText = $('#stealth-caret-text');
  const caretMirrorAfter = $('#stealth-caret-after');
  const stealthCaretEl = $('#stealth-caret');
  const stealthIndicator = $('#stealth-indicator');

  // ========== QUIET MODE ==========
  const quietContainer = $('#quiet-container');
  const quietInputBox = $('#quiet-input-box');
  const quietInput = $('#quiet-input');
  const quietCaretMirror = $('#quiet-caret-mirror');
  const quietCaretText = $('#quiet-caret-text');
  const quietOutputBox = $('#quiet-output-box');
  const quietOutputText = $('#quiet-output-text');

  let isQuietMode = false;
  let preQuietOpacity = null;
  let quietCurrentPrompt = '';
  let quietCurrentOutput = '';
  let quietStealthCaretPos = 0;
  let isQuietSelectAll = false;

  function syncQuietInput() {
    if (!quietInput) return;
    quietInput.style.height = 'auto';
    const nextH = Math.max(18, Math.min(quietInput.scrollHeight, 160));
    quietInput.style.height = nextH + 'px';
    syncQuietCaret();
  }

  function syncQuietCaret() {
    if (!quietCaretText || !quietInput) return;
    const pos = Math.max(0, Math.min(quietInput.value.length, quietStealthCaretPos));
    quietCaretText.textContent = quietInput.value.slice(0, pos);
    if (quietCaretMirror) {
      quietCaretMirror.scrollTop = quietInput.scrollTop;
    }
  }

  function clearQuietOutput() {
    quietCurrentOutput = '';
    if (quietOutputText) quietOutputText.innerHTML = '';
    if (quietOutputBox) quietOutputBox.classList.add('hidden');
    if (quietInputBox) quietInputBox.classList.remove('hidden');
    if (quietInput) {
      quietInput.value = '';
      quietStealthCaretPos = 0;
      isQuietSelectAll = false;
      syncQuietInput();
    }
  }

  function sendQuiet(text) {
    const query = (text != null ? text : (quietInput ? quietInput.value : '')).trim();
    if (!query) return;
    quietCurrentPrompt = query;
    if (quietInput) {
      quietInput.value = '';
      quietStealthCaretPos = 0;
      isQuietSelectAll = false;
      syncQuietInput();
    }
    if (quietInputBox) quietInputBox.classList.add('hidden');
    if (quietOutputBox) quietOutputBox.classList.remove('hidden');
    if (quietOutputText) quietOutputText.innerHTML = '<span class="quiet-loading">…</span>';
    quietCurrentOutput = '';
    runMode('quiet', query);
  }

  function toggleQuietMode(force) {
    const next = force != null ? force : !isQuietMode;
    if (next === isQuietMode) return;
    isQuietMode = next;
    document.body.classList.toggle('quiet-mode', isQuietMode);
    if (quietContainer) {
      quietContainer.classList.toggle('hidden', !isQuietMode);
    }
    if (isQuietMode) {
      preQuietOpacity = currentOpacityValue != null ? currentOpacityValue : (settings && settings.opacity != null ? settings.opacity : 1);
      applyOpacity(0.05, false);
      clearQuietOutput();
      showToast('Quiet mode ON · Alt+C to type', 2000);
    } else {
      if (preQuietOpacity !== null) {
        applyOpacity(preQuietOpacity, true);
        preQuietOpacity = null;
      }
      showToast('Quiet mode OFF', 2000);
    }
  }

  let quietBoxWidth = 360;
  function resizeQuietBox(delta) {
    if (!delta) return;
    const step = 50;
    const minW = 200;
    const maxW = 720;
    const prevW = quietBoxWidth;
    quietBoxWidth = Math.max(minW, Math.min(maxW, quietBoxWidth + (delta > 0 ? step : -step)));
    document.documentElement.style.setProperty('--quiet-w', `${quietBoxWidth}px`);
    if (isQuietMode) {
      const action = quietBoxWidth > prevW ? 'Wider' : quietBoxWidth < prevW ? 'Narrower' : (delta > 0 ? 'Max width' : 'Min width');
      showToast(`Quiet mode: ${quietBoxWidth}px (${action})`, 1000);
    }
  }

  cue.on('quiet:resize', (data) => {
    const delta = (data && typeof data.delta === 'number') ? data.delta : (data === -1 ? -1 : 1);
    resizeQuietBox(delta);
  });

  cue.on('quiet:toggle', () => toggleQuietMode());

  if (quietInput) {
    quietInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendQuiet();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        clearQuietOutput();
        return;
      }
      if (e.altKey && (e.key === 'q' || e.key === 'Q')) {
        e.preventDefault();
        toggleQuietMode();
        return;
      }
      if (e.altKey && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        toggleAutotyper();
        return;
      }
      if (e.altKey && (e.key === '+' || e.key === '=' || e.key === 'Add') && (!e.ctrlKey || (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph'))) && !e.metaKey) {
        e.preventDefault();
        resizeQuietBox(1);
        return;
      }
      if (e.altKey && (e.key === '-' || e.key === '_' || e.key === 'Subtract') && (!e.ctrlKey || (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph'))) && !e.metaKey) {
        e.preventDefault();
        resizeQuietBox(-1);
        return;
      }
      if (((e.altKey && (!e.ctrlKey || (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph')))) || (e.ctrlKey && !e.altKey && !e.shiftKey)) && (e.key === 'o' || e.key === 'O') && !e.metaKey) {
        e.preventDefault();
        changeOpacityBy(-5);
        return;
      }
      if (((e.altKey && (!e.ctrlKey || (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph')))) || (e.ctrlKey && !e.altKey && !e.shiftKey)) && (e.key === 'p' || e.key === 'P') && !e.metaKey) {
        e.preventDefault();
        changeOpacityBy(5);
        return;
      }
      if (e.altKey && (e.key === 'x' || e.key === 'X')) {
        e.preventDefault();
        toggleAltX();
        return;
      }
    });

    quietInput.addEventListener('input', () => {
      quietStealthCaretPos = quietInput.selectionStart || quietInput.value.length;
      syncQuietInput();
    });
  }

  if (quietInputBox) {
    quietInputBox.addEventListener('click', () => {
      if (quietInput && document.activeElement !== quietInput) {
        quietInput.focus();
      }
    });
  }

  // ========== NO-FOCUS (STEALTH) MODE ==========
  let isNoFocusMode = true;
  let temporaryFocusActive = false;
  let isStealthTypingActive = false;
  let isTransparencyMode = true;
  let lastStealthNotified = false;
  let lastTransparencyNotified = true;
  let stealthCaretPos = -1;
  let isStealthSelectAll = false;

  function getStealthCaretPos() {
    const len = input.value.length;
    if (stealthCaretPos < 0 || stealthCaretPos > len) {
      stealthCaretPos = len;
    }
    return stealthCaretPos;
  }

  function setStealthCaretPos(pos) {
    const len = input.value.length;
    stealthCaretPos = Math.max(0, Math.min(len, pos));
    try {
      input.setSelectionRange(stealthCaretPos, stealthCaretPos);
    } catch (_) {}
  }

  function isInsideInputArea(target) {
    if (!target) return false;
    const el = target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
    return Boolean(el && typeof el.closest === 'function' && (el.closest('#input-area') || el.closest('#quiet-container')));
  }

  function activateStealthTyping() {
    if (!isStealthTypingActive) {
      if (typeof cue.stealthSet === 'function') {
        cue.stealthSet(true).catch(() => {});
      } else if (typeof cue.stealthToggle === 'function') {
        cue.stealthToggle().catch(() => {});
      }
    }
  }

  function deactivateStealthTyping() {
    isStealthSelectAll = false;
    if (isStealthTypingActive) {
      if (typeof cue.stealthSet === 'function') {
        cue.stealthSet(false).catch(() => {});
      } else if (typeof cue.stealthToggle === 'function') {
        cue.stealthToggle().catch(() => {});
      }
    }
  }

  function syncCaretMirror() {
    if (!caretMirrorText) return;
    const val = input.value || '';
    if (isStealthSelectAll && val.length > 0) {
      caretMirrorText.textContent = val;
      caretMirrorText.classList.add('selected');
      if (caretMirrorAfter) caretMirrorAfter.textContent = '';
      if (stealthCaretEl) stealthCaretEl.style.display = 'none';
      if (caretMirror) caretMirror.scrollTop = input.scrollTop;
      return;
    }

    caretMirrorText.classList.remove('selected');
    if (stealthCaretEl) stealthCaretEl.style.display = '';

    const pos = getStealthCaretPos();
    let before = val.slice(0, pos);
    let after = val.slice(pos);

    if (before.endsWith('\n')) {
      before += '\u200B';
    }

    caretMirrorText.textContent = before;
    if (caretMirrorAfter) {
      caretMirrorAfter.textContent = after;
    }
    if (caretMirror) {
      caretMirror.scrollTop = input.scrollTop;
    }
  }

  function updateDeleteButton() {
    if (!clearInputBtn) return;
    const hasText = Boolean(input.value && input.value.length > 0);
    if (isStealthTypingActive) {
      clearInputBtn.classList.remove('hidden');
      clearInputBtn.classList.toggle('empty', !hasText);
    } else {
      clearInputBtn.classList.toggle('hidden', !hasText);
      clearInputBtn.classList.remove('empty');
    }
  }

  function clearComposerInput() {
    input.value = '';
    stealthCaretPos = 0;
    isStealthSelectAll = false;
    inputFromSTT = false;
    lastSTTValue = '';
    composer.classList.remove('stt-filling', 'stt-dimmed', 'stt-ready', 'stt-accumulating');
    syncPlaceholder();
    updateSendButtonState();
  }

  if (clearInputBtn) {
    clearInputBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      clearComposerInput();
    });
  }

  function updatePlaceholder() {
    const altKey = isWindows ? 'Alt' : '⌥';
    const ctrlKey = isWindows ? 'Ctrl' : '⌘';
    if (isTransparencyMode && isStealthTypingActive) {
      placeholder.innerHTML = `<span style="color:#93c5fd;font-weight:600">⚡ Stealth + Click-Through</span> · Arrow keys navigate · Enter sends · ${altKey}+C / ${altKey}+V`;
    } else if (isTransparencyMode) {
      placeholder.innerHTML = `<span style="color:#60a5fa;font-weight:600">⚡ Transparent click-through</span> · Arrow keys scroll · ${altKey}+C to type · ${altKey}+V exits`;
    } else if (isStealthTypingActive) {
      placeholder.innerHTML = `<span style="color:#86efac;font-weight:600">⚡ Stealth typing active</span> · Arrow keys navigate · Enter sends · Esc/${altKey}+C exits`;
    } else if (isNoFocusMode) {
      placeholder.innerHTML = `No-focus mode active · <span class="keycap">${altKey}</span><span class="keycap">C</span> to type · <span class="keycap">${ctrlKey}</span><span class="keycap">⇧</span><span class="keycap">F</span> toggle`;
    } else if (isWindows) {
      placeholder.innerHTML = 'Ask about your screen or conversation, or <span class="keycap">Ctrl</span><span class="keycap">⇧</span><span class="keycap">⏎</span> for Smart assist';
    } else {
      placeholder.innerHTML = 'Ask about your screen or conversation, or <span class="keycap">⌘</span><span class="keycap">⇧</span><span class="keycap">⏎</span> for Smart assist';
    }
    syncPlaceholder();
  }

  function setNoFocusUI(active) {
    isNoFocusMode = Boolean(active);
    const btn = $('#focus-btn');
    if (btn) {
      btn.classList.toggle('active', isNoFocusMode);
      const label = btn.querySelector('.tb-focus-label');
      if (label) {
        label.textContent = isNoFocusMode ? 'No-focus ON' : 'No-focus';
      }
      const toggleKey = isWindows ? 'Ctrl+Shift+F' : '⌘⇧F';
      btn.setAttribute('aria-label', isNoFocusMode
        ? `No-focus mode active · Click to turn off (${toggleKey})`
        : `Toggle no-focus mode (${toggleKey})`);
    }
    updatePlaceholder();
  }

  // Initialize placeholder and button to default active state immediately
  setNoFocusUI(true);

  // Initialize transparency mode styling and indicator for default ON state
  document.body.classList.toggle('transparency-mode', isTransparencyMode);
  if (stealthIndicator) {
    stealthIndicator.classList.toggle('hidden', !isStealthTypingActive && !isTransparencyMode);
    const pillText = stealthIndicator.querySelector('.stealth-pill-text');
    if (pillText) {
      if (isStealthTypingActive && isTransparencyMode) pillText.textContent = 'Stealth + Click-Through';
      else if (isStealthTypingActive) pillText.textContent = 'Stealth';
      else if (isTransparencyMode) pillText.textContent = 'Click-Through';
    }
  }

  // ========== INTERVIEWER PILL & SMART BUFFER SYSTEM ==========
  const interviewerPill = document.getElementById('interviewer-pill');
  const ipText = document.getElementById('ip-text');
  const ipAnswerBtn = document.getElementById('ip-answer-btn');
  const ipInsertBtn = document.getElementById('ip-insert-btn');
  const ipDismissBtn = document.getElementById('ip-dismiss-btn');

  let stagedInterviewerQuestion = '';
  let pillAccumulateTimer = null;
  let pillSoftClearTimer = null;
  let pillUserSpeechStart = null;

  // Track whether the current input text came from STT (via Insert or restore)
  let inputFromSTT = false;
  let sttFillTimer = null;
  let questionFinalizeTimer = null;
  let softClearTimer = null;
  let userSpeechStart = null;

  // Question history for undo (Ctrl+Z)
  const questionHistory = [];
  const MAX_QUESTION_HISTORY = 10;

  // ---- Question completeness detection ----
  function isLikelyCompleteQuestion(text) {
    const trimmed = (text || '').trim();
    
    // Must be substantial (not just filler words)
    if (trimmed.length < 12) return false;
    
    // High confidence: ends with question mark
    if (/\?$/.test(trimmed)) return true;
    
    // High confidence: behavioral interview patterns (these are complete even without ?)
    const behavioralPatterns = [
      /tell me about a time/i,
      /give me an example/i,
      /describe a (situation|time|project|challenge)/i,
      /walk me through/i,
      /can you (tell|describe|explain|share)/i,
      /what (was|were|is|are) your/i,
      /how (did|do|would) you/i,
      /why (did|do|are|should)/i,
      /what (did|do|would) you/i,
      /tell me about yourself/i,
      /tell me about your/i,
      /what.{1,30}(biggest|greatest|most|hardest|proudest)/i,
      /have you ever/i
    ];
    if (behavioralPatterns.some(p => p.test(trimmed))) return true;
    
    // Medium confidence: question starters with substantial content
    const questionStarters = /^(what|how|why|when|where|who|which|tell|describe|explain|can|could|would|should|have|did|do|is|are|was|were)/i;
    if (questionStarters.test(trimmed) && trimmed.length > 25) return true;
    
    // Medium confidence: ends with common question endings
    if (/(about that|for us|to us|with you|for you|about it|to share|you handle|you approach|your experience|your background)\s*$/i.test(trimmed)) return true;
    
    return false;
  }

  // ---- Get question confidence level ----
  function getQuestionConfidence(text) {
    const trimmed = (text || '').trim();
    if (trimmed.length < 8) return 'low';
    if (/\?$/.test(trimmed)) return 'high';
    if (isLikelyCompleteQuestion(trimmed)) return 'medium';
    if (trimmed.length > 20) return 'accumulating';
    return 'low';
  }

  // ---- Update visual state based on question readiness ----
  // Batch class updates to avoid flicker
  function updateQuestionReadyState() {
    const text = input.value;
    const confidence = getQuestionConfidence(text);
    
    const shouldBeReady = confidence === 'high' || confidence === 'medium';
    const shouldBeAccumulating = confidence === 'accumulating';
    
    const isReady = composer.classList.contains('stt-ready');
    const isAccumulating = composer.classList.contains('stt-accumulating');
    
    if (shouldBeReady !== isReady || shouldBeAccumulating !== isAccumulating) {
      composer.classList.remove('stt-ready', 'stt-accumulating');
      if (shouldBeReady) {
        composer.classList.add('stt-ready');
      } else if (shouldBeAccumulating) {
        composer.classList.add('stt-accumulating');
      }
    }
    
    updateSendButtonState();
  }
  
  // Send button visual "ready" state
  function updateSendButtonState() {
    const sendBtn = document.getElementById('send-btn');
    if (!sendBtn) return;
    
    const hasText = input.value.trim().length > 0;
    const isReady = composer.classList.contains('stt-ready');
    const hasStaged = Boolean(!hasText && stagedInterviewerQuestion);
    
    sendBtn.classList.toggle('ready', (hasText && isReady) || hasStaged);
    sendBtn.classList.toggle('has-text', hasText || hasStaged);
    sendBtn.classList.toggle('has-staged', hasStaged);
  }

  // ---- Save question to history for undo ----
  function saveToQuestionHistory(text) {
    if (!text || text.trim().length < 5) return;
    
    // Don't save duplicates
    const last = questionHistory[questionHistory.length - 1];
    if (last && last.text === text.trim()) return;
    
    questionHistory.push({
      text: text.trim(),
      timestamp: Date.now()
    });
    
    // Keep only recent history
    while (questionHistory.length > MAX_QUESTION_HISTORY) {
      questionHistory.shift();
    }
  }

  // ---- Prompt history for Alt+W ----
  let promptHistory = [];
  let promptHistoryIndex = -1;

  function restorePreviousPrompt() {
    if (promptHistory.length === 0) {
      const bubbles = messages.querySelectorAll('.user-bubble');
      bubbles.forEach((b) => {
        const t = (b.textContent || '').trim();
        if (t && !promptHistory.includes(t)) promptHistory.push(t);
      });
    }
    if (promptHistory.length === 0) {
      showToast('No previous prompt', 1500);
      return;
    }
    if (promptHistoryIndex < 0 || promptHistoryIndex >= promptHistory.length) {
      promptHistoryIndex = promptHistory.length - 1;
    } else if (promptHistoryIndex > 0) {
      promptHistoryIndex--;
    }
    const text = promptHistory[promptHistoryIndex];
    input.value = text;
    // CRITICAL: Must not touch the status of Alt+C (stealth typing mode)
    if (isStealthTypingActive) {
      setStealthCaretPos(text.length);
    }
    syncPlaceholder();
    updateSendButtonState();
    updateDeleteButton();
    syncCaretMirror();
    showToast('Previous prompt restored', 1200);
  }

  // ---- Restore last question from history (Ctrl+Z) ----
  function restoreLastQuestion() {
    const last = questionHistory.pop();
    if (last) {
      stagedInterviewerQuestion = last.text;
      showInterviewerPill(last.text);
      showToast('Question restored to pill', 1500);
      return true;
    }
    showToast('No question to restore', 1500);
    return false;
  }

  // ---- Show Interviewer Pill with text ----
  function showInterviewerPill(text) {
    if (!interviewerPill || !ipText) return;
    ipText.textContent = text;
    interviewerPill.classList.remove('hidden', 'ip-dimmed');
    interviewerPill.classList.add('ip-accumulating');
    ipText.scrollTop = ipText.scrollHeight;
    
    clearTimeout(pillAccumulateTimer);
    pillAccumulateTimer = setTimeout(() => {
      if (interviewerPill) interviewerPill.classList.remove('ip-accumulating');
    }, 1800);

    updateSendButtonState();
  }

  // ---- Show live interim words in interviewer pill ----
  function showInterviewerPillInterim(interimText) {
    if (!interviewerPill || !ipText) return;
    const combined = stagedInterviewerQuestion 
      ? stagedInterviewerQuestion + ' ' + interimText 
      : interimText;
    ipText.textContent = combined;
    interviewerPill.classList.remove('hidden', 'ip-dimmed');
    interviewerPill.classList.add('ip-accumulating');
    ipText.scrollTop = ipText.scrollHeight;
  }

  // ---- Accumulate incoming speech from interviewer (Them channel) ----
  function accumulateInterviewerQuestion(text) {
    if (!text || text.trim().length === 0) return;
    cancelPillSoftClear();
    
    const incoming = text.trim();
    if (stagedInterviewerQuestion) {
      stagedInterviewerQuestion += ' ' + incoming;
    } else {
      stagedInterviewerQuestion = incoming;
    }
    
    showInterviewerPill(stagedInterviewerQuestion);
  }

  // ---- Dismiss Interviewer Pill ----
  function dismissInterviewerPill() {
    stagedInterviewerQuestion = '';
    clearTimeout(pillAccumulateTimer);
    clearTimeout(pillSoftClearTimer);
    pillUserSpeechStart = null;
    if (interviewerPill) {
      interviewerPill.classList.add('hidden');
      interviewerPill.classList.remove('ip-dimmed', 'ip-accumulating');
    }
    if (ipText) ipText.textContent = '';
    updateSendButtonState();
  }

  // ---- Answer Interviewer Question directly ----
  function answerInterviewerQuestion() {
    if (!stagedInterviewerQuestion) return;
    const q = stagedInterviewerQuestion.trim();
    saveToQuestionHistory(q);
    dismissInterviewerPill();
    deactivateStealthTyping();
    runMode('answerThis', q);
  }

  // ---- Insert Interviewer Question into Input box without destroying typed text ----
  function insertInterviewerQuestion() {
    if (!stagedInterviewerQuestion) return;
    const q = stagedInterviewerQuestion.trim();
    
    if (isStealthTypingActive) {
      // In stealth typing mode, insert at stealth caret position
      const val = input.value || '';
      if (isStealthSelectAll) {
        input.value = q;
        isStealthSelectAll = false;
        setStealthCaretPos(q.length);
      } else {
        const pos = getStealthCaretPos();
        const before = val.slice(0, pos);
        const after = val.slice(pos);
        const prefixSpace = (before.length > 0 && !before.endsWith(' ') && !before.endsWith('\n')) ? ' ' : '';
        const suffixSpace = (after.length > 0 && !after.startsWith(' ') && !after.startsWith('\n')) ? ' ' : '';
        const insertion = prefixSpace + q + suffixSpace;
        input.value = before + insertion + after;
        setStealthCaretPos(pos + insertion.length);
      }
      syncCaretMirror();
    } else {
      // Standard input textarea
      const val = input.value || '';
      const start = input.selectionStart != null ? input.selectionStart : val.length;
      const end = input.selectionEnd != null ? input.selectionEnd : val.length;
      const before = val.slice(0, start);
      const after = val.slice(end);
      const prefixSpace = (before.length > 0 && !before.endsWith(' ') && !before.endsWith('\n')) ? ' ' : '';
      const suffixSpace = (after.length > 0 && !after.startsWith(' ') && !after.startsWith('\n')) ? ' ' : '';
      const insertion = prefixSpace + q + suffixSpace;
      input.value = before + insertion + after;
      const newCursor = start + insertion.length;
      try {
        input.setSelectionRange(newCursor, newCursor);
      } catch (_) {}
    }
    
    // If input was empty before, mark as from STT so answering logic still recognizes it
    if (!input.value.trim() || input.value.trim() === q) {
      inputFromSTT = true;
      lastSTTValue = input.value;
    }
    
    dismissInterviewerPill();
    syncPlaceholder();
    updateSendButtonState();
    updateDeleteButton();
    if (!isStealthTypingActive && !isNoFocusMode) {
      input.focus();
    }
  }

  // ---- Soft clear: Dim interviewer pill when user speaks, clear after >2s sustained speech ----
  function softClearInterviewerPill() {
    if (!stagedInterviewerQuestion) return;
    const now = Date.now();
    if (!pillUserSpeechStart) {
      pillUserSpeechStart = now;
    }
    if (interviewerPill) {
      interviewerPill.classList.add('ip-dimmed');
    }
    clearTimeout(pillSoftClearTimer);
    pillSoftClearTimer = setTimeout(() => {
      const speechDuration = pillUserSpeechStart ? Date.now() - pillUserSpeechStart : 0;
      if (speechDuration > 2000) {
        saveToQuestionHistory(stagedInterviewerQuestion);
        dismissInterviewerPill();
      }
    }, 800);
  }

  // ---- Cancel soft clear when interviewer resumes talking ----
  function cancelPillSoftClear() {
    pillUserSpeechStart = null;
    clearTimeout(pillSoftClearTimer);
    if (interviewerPill) {
      interviewerPill.classList.remove('ip-dimmed');
    }
  }

  // Pill action button handlers
  if (ipAnswerBtn) {
    ipAnswerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      answerInterviewerQuestion();
    });
  }
  if (ipInsertBtn) {
    ipInsertBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      insertInterviewerQuestion();
    });
  }
  if (ipDismissBtn) {
    ipDismissBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dismissInterviewerPill();
    });
  }

  // Autotyper toggle function
  async function toggleAutotyper(targetText) {
    let textToUse = targetText;
    if (!textToUse && isQuietMode) {
      textToUse = quietCurrentOutput;
    }
    if (!textToUse) {
      const group = getActiveResponseGroup();
      if (group) {
        textToUse = (group._iterations && group._iterations[group._currentIterationIndex])
          ? group._iterations[group._currentIterationIndex].raw
          : (group.querySelector('.ai-text') ? group.querySelector('.ai-text').dataset.raw || group.querySelector('.ai-text').innerText : '');
      }
    }
    if (typeof cue.autotypeToggle === 'function') {
      const status = await cue.autotypeToggle(textToUse);
      if (status === 'typing') {
        showToast('⚡ Autotyping started... (Alt+A to pause)', 2500);
      } else if (status === 'paused') {
        showToast('⏸️ Autotyping paused (Alt+A to resume)', 2500);
      } else if (status === 'idle') {
        if (!textToUse) {
          showToast('No prompt output to autotype', 2000);
        }
      }
    }
  }

  cue.on('autotype:state', (s) => {
    if (!s) return;
    if (s.status === 'idle' && s.total > 0 && s.index >= s.total) {
      showToast('✓ Autotyping complete', 2200);
    }
  });

  // Global IPC events for STT actions from stealth hook (Alt+A / Alt+I)
  cue.on('stt:answer-question', () => {
    if (isQuietMode) {
      toggleAutotyper();
      return;
    }
    if (stagedInterviewerQuestion) {
      answerInterviewerQuestion();
    } else {
      toggleAutotyper();
    }
  });
  cue.on('stt:insert-question', () => {
    if (isQuietMode) return;
    if (stagedInterviewerQuestion) {
      insertInterviewerQuestion();
    }
  });

  // Legacy compatibility wrappers (keeps existing call-sites safe)
  function autoFillInputFromSTT(text) {
    accumulateInterviewerQuestion(text);
  }
  function softClearSTTFill() {
    softClearInterviewerPill();
  }
  function cancelSoftClear() {
    cancelPillSoftClear();
  }

  // ---- Hard clear (called when user explicitly clears or types) ----
  function hardClearSTTFill(showUndoHint = false) {
    const hadContent = input.value.trim().length > 0;
    saveToQuestionHistory(input.value);
    input.value = '';
    inputFromSTT = false;
    lastSTTValue = '';
    userSpeechStart = null;
    composer.classList.remove('stt-filling', 'stt-dimmed', 'stt-ready', 'stt-accumulating');
    clearTimeout(softClearTimer);
    clearTimeout(questionFinalizeTimer);
    clearTimeout(sttFillTimer);
    clearInputInterim();
    dismissInterviewerPill();
    syncPlaceholder();
    updateSendButtonState();
    
    if (showUndoHint && hadContent) {
      const undoHint = isWindows ? 'Ctrl+Z to undo' : '⌘Z to undo';
      showToast(`Cleared · ${undoHint}`, 2000);
    }
  }

  function syncPlaceholder() {
    placeholder.classList.toggle('hidden', input.value.length > 0 || document.activeElement === input);
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
    syncCaretMirror();
    updateDeleteButton();
    if (caretMirror) caretMirror.scrollTop = input.scrollTop;
  }
  input.addEventListener('scroll', () => {
    if (caretMirror) caretMirror.scrollTop = input.scrollTop;
  });
  
  // FIX #6: Track last STT value to detect substantial edits vs minor corrections
  let lastSTTValue = '';
  
  input.addEventListener('input', () => {
    const currentValue = input.value;
    
    // FIX #5: Clear interim text when user starts typing
    clearInputInterim();
    
    // FIX #6: Only detach from STT mode if edit is substantial
    // Minor corrections (typo fixes, small additions) should keep STT mode
    if (inputFromSTT && lastSTTValue) {
      const lengthDiff = Math.abs(currentValue.length - lastSTTValue.length);
      const isCleared = currentValue.trim().length === 0;
      const isSubstantialChange = lengthDiff > lastSTTValue.length * 0.3 || isCleared;
      
      if (isSubstantialChange) {
        // User made a major change — detach from STT mode
        saveToQuestionHistory(lastSTTValue);
        inputFromSTT = false;
        lastSTTValue = '';
        composer.classList.remove('stt-filling', 'stt-dimmed', 'stt-ready', 'stt-accumulating');
        clearTimeout(softClearTimer);
        clearTimeout(questionFinalizeTimer);
      }
      // Minor edits: keep inputFromSTT = true, just update visual state
    } else if (!inputFromSTT) {
      // User typing from scratch — standard behavior
      composer.classList.remove('stt-filling', 'stt-dimmed', 'stt-ready', 'stt-accumulating');
    }
    
    syncPlaceholder();
    updateSendButtonState(); // FIX #9: Update send button on input change
  });
  input.addEventListener('focus', () => {
    if (isNoFocusMode && !temporaryFocusActive) {
      input.blur();
      activateStealthTyping();
      return;
    }
    composer.classList.add('focused');
    placeholder.classList.add('hidden');
  });
  input.addEventListener('blur', () => {
    composer.classList.remove('focused');
    if (temporaryFocusActive) {
      temporaryFocusActive = false;
      if (typeof cue.nofocusSet === 'function') cue.nofocusSet(true).catch(() => {});
    }
    syncPlaceholder();
  });
  $('#input-area').addEventListener('click', () => {
    if (isNoFocusMode && !temporaryFocusActive) {
      activateStealthTyping();
      return;
    }
    input.focus();
  });

  function triggerHrMode() {
    retryingGroup = null;
    let text = input.value.trim();
    deactivateStealthTyping();
    if (temporaryFocusActive) {
      input.blur();
      temporaryFocusActive = false;
      if (typeof cue.nofocusSet === 'function') cue.nofocusSet(true).catch(() => {});
    }

    // Strip /hr prefix or suffix if present
    const hrStartRegex = /^\/hr\b/i;
    const hrEndRegex = /\/hr$/i;
    if (hrStartRegex.test(text)) {
      text = text.replace(hrStartRegex, '').trim();
    } else if (hrEndRegex.test(text)) {
      text = text.replace(hrEndRegex, '').trim();
    }

    if (!text && stagedInterviewerQuestion) {
      text = stagedInterviewerQuestion.text || '';
    }

    if (text) {
      saveToQuestionHistory(text);
      if (!promptHistory.length || promptHistory[promptHistory.length - 1] !== text) {
        promptHistory.push(text);
      }
      promptHistoryIndex = -1;
    }

    input.value = '';
    inputFromSTT = false;
    lastSTTValue = '';
    userSpeechStart = null;
    composer.classList.remove('stt-filling', 'stt-dimmed', 'stt-ready', 'stt-accumulating');
    clearTimeout(softClearTimer);
    clearTimeout(questionFinalizeTimer);
    clearTimeout(sttFillTimer);
    dismissInterviewerPill();
    syncPlaceholder();
    updateSendButtonState();

    runMode('hr', text);
  }

  function send() {
    retryingGroup = null;
    let text = input.value.trim();
    deactivateStealthTyping();
    if (temporaryFocusActive) {
      input.blur();
      temporaryFocusActive = false;
      if (typeof cue.nofocusSet === 'function') cue.nofocusSet(true).catch(() => {});
    }

    let isHrMode = false;
    const hrStartRegex = /^\/hr\b/i;
    const hrEndRegex = /\/hr$/i;
    if (hrStartRegex.test(text)) {
      isHrMode = true;
      text = text.replace(hrStartRegex, '').trim();
    } else if (hrEndRegex.test(text)) {
      isHrMode = true;
      text = text.replace(hrEndRegex, '').trim();
    }

    if (!text) {
      if (stagedInterviewerQuestion) {
        if (isHrMode) {
          text = stagedInterviewerQuestion.text || '';
        } else {
          answerInterviewerQuestion();
          return;
        }
      } else if (!isHrMode) {
        runMode('assist', '');
        return;
      }
    }
    const wasFromSTT = inputFromSTT;
    
    // Save to history before clearing (in case user wants to redo)
    if (text) {
      saveToQuestionHistory(text);
      if (!promptHistory.length || promptHistory[promptHistory.length - 1] !== text) {
        promptHistory.push(text);
      }
      promptHistoryIndex = -1;
    }
    
    input.value = '';
    inputFromSTT = false;
    lastSTTValue = ''; // FIX #6: Clear tracked STT value
    userSpeechStart = null;
    composer.classList.remove('stt-filling', 'stt-dimmed', 'stt-ready', 'stt-accumulating');
    clearTimeout(softClearTimer);
    clearTimeout(questionFinalizeTimer);
    clearTimeout(sttFillTimer);
    dismissInterviewerPill();
    syncPlaceholder();
    updateSendButtonState(); // FIX #9
    
    if (isHrMode) {
      runMode('hr', text);
    } else {
      runMode(wasFromSTT ? 'answerThis' : 'ask', text);
    }
  }
  $('#send-btn').addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    // Alt+A: Answer staged interviewer question OR toggle autotyper
    if (e.altKey && (e.key === 'a' || e.key === 'A') && (!e.ctrlKey || (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph'))) && !e.metaKey) {
      if (stagedInterviewerQuestion) {
        e.preventDefault();
        answerInterviewerQuestion();
        return;
      }
      e.preventDefault();
      toggleAutotyper();
      return;
    }
    // Alt+U: Insert staged interviewer question into input box at caret
    if (e.altKey && (e.key === 'u' || e.key === 'U') && (!e.ctrlKey || (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph'))) && !e.metaKey) {
      if (stagedInterviewerQuestion) {
        e.preventDefault();
        insertInterviewerQuestion();
        return;
      }
    }
    // Alt+Q: Run recap / toggle quiet mode
    if (e.altKey && (e.key === 'q' || e.key === 'Q') && (!e.ctrlKey || (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph'))) && !e.metaKey) {
      e.preventDefault();
      toggleQuietMode();
      // runMode('recap', '');
      return;
    }
    // Alt+G: Run HR mode
    if (e.altKey && (e.key === 'g' || e.key === 'G') && (!e.ctrlKey || (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph'))) && !e.metaKey) {
      e.preventDefault();
      triggerHrMode();
      return;
    }
    // Ctrl+H (Cmd+H): Run LeetCode mode
    if ((e.ctrlKey || e.metaKey) && (e.key === 'h' || e.key === 'H') && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      runMode('leetcode', '');
      return;
    }
    // Alt+W: Bring back previous prompt in input box
    if (e.altKey && (e.key === 'w' || e.key === 'W') && (!e.ctrlKey || (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph'))) && !e.metaKey) {
      e.preventDefault();
      restorePreviousPrompt();
      return;
    }
    // Alt+E: Go to previous answer
    if (e.altKey && (e.key === 'e' || e.key === 'E') && (!e.ctrlKey || (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph'))) && !e.metaKey) {
      e.preventDefault();
      goToPreviousAnswer();
      return;
    }
    // Alt+R: Retry prompt
    if (e.altKey && (e.key === 'r' || e.key === 'R') && (!e.ctrlKey || (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph'))) && !e.metaKey) {
      e.preventDefault();
      const group = getActiveResponseGroup();
      if (!group) {
        showToast('No prompt to retry', 1500);
        return;
      }
      if (busy) {
        showToast('Please wait for the current response to finish', 2000);
        return;
      }
      retryResponse(group);
      return;
    }
    // Alt+O / Ctrl+O: Reduce opacity
    if ((e.altKey && (e.key === 'o' || e.key === 'O') && (!e.ctrlKey || (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph'))) && !e.metaKey) ||
        (e.ctrlKey && (e.key === 'o' || e.key === 'O') && !e.altKey && !e.shiftKey && !e.metaKey)) {
      e.preventDefault();
      changeOpacityBy(-5);
      return;
    }
    // Alt+P / Ctrl+P: Increase opacity
    if ((e.altKey && (e.key === 'p' || e.key === 'P') && (!e.ctrlKey || (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph'))) && !e.metaKey) ||
        (e.ctrlKey && (e.key === 'p' || e.key === 'P') && !e.altKey && !e.shiftKey && !e.metaKey)) {
      e.preventDefault();
      changeOpacityBy(5);
      return;
    }
    // Alt+X: Completely hide or restore Cue
    if (e.altKey && (e.key === 'x' || e.key === 'X')) {
      e.preventDefault();
      toggleAltX();
      return;
    }
    // Alt+I / J / K / L: Move window Up / Left / Down / Right
    if (e.altKey && (!e.ctrlKey || (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph'))) && !e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === 'i' || k === 'j' || k === 'k' || k === 'l') {
        e.preventDefault();
        const dir = k === 'i' ? 'up' : k === 'j' ? 'left' : k === 'k' ? 'down' : 'right';
        if (typeof cue.windowMove === 'function') cue.windowMove(dir);
        return;
      }
    }
    // Alt+B: Explain terms from last 4 messages (previous4)
    if (e.altKey && (e.key === 'b' || e.key === 'B') && (!e.ctrlKey || (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph'))) && !e.metaKey) {
      e.preventDefault();
      runMode('previous4', '');
      return;
    }
    // Alt+N: Toggle transcription history sidebar
    if (e.altKey && (e.key === 'n' || e.key === 'N') && (!e.ctrlKey || (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph'))) && !e.metaKey) {
      e.preventDefault();
      toggleSidebar();
      return;
    }
    // Alt+H: Toggle hide/collapse
    if (e.altKey && (e.key === 'h' || e.key === 'H') && (!e.ctrlKey || (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph'))) && !e.metaKey) {
      e.preventDefault();
      toggleHide();
      return;
    }
    // Alt+T: Go to next answer
    if (e.altKey && (e.key === 't' || e.key === 'T') && (!e.ctrlKey || (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph'))) && !e.metaKey) {
      e.preventDefault();
      goToNextAnswer();
      return;
    }
    // Alt+Y: Toggle transcription
    if (e.altKey && (e.key === 'y' || e.key === 'Y') && (!e.ctrlKey || (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph'))) && !e.metaKey) {
      e.preventDefault();
      toggleTranscription();
      return;
    }
    // Alt+M: Toggle model between configured models
    if (e.altKey && (e.key === 'm' || e.key === 'M') && (!e.ctrlKey || (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph'))) && !e.metaKey) {
      e.preventDefault();
      toggleModel();
      return;
    }
    // Alt+S: Toggle smart mode (smart/fast)
    if (e.altKey && (e.key === 's' || e.key === 'S') && (!e.ctrlKey || (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph'))) && !e.metaKey) {
      e.preventDefault();
      toggleSmartMode();
      return;
    }
    // Tab: insert staged interviewer question into input box at caret
    if (e.key === 'Tab' && stagedInterviewerQuestion && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      insertInterviewerQuestion();
      return;
    }
    // Ctrl+Z / Cmd+Z: restore last question if input is empty
    if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !input.value.trim()) {
      e.preventDefault();
      restoreLastQuestion();
      return;
    }
    // Escape: clear the input (with undo hint) or dismiss staged question or exit temporary typing focus
    if (e.key === 'Escape') {
      if (input.value.trim()) {
        e.preventDefault();
        hardClearSTTFill(true); // FIX #10: Show undo hint
      } else if (stagedInterviewerQuestion) {
        e.preventDefault();
        dismissInterviewerPill();
      }
      if (temporaryFocusActive) {
        input.blur();
        temporaryFocusActive = false;
        if (typeof cue.nofocusSet === 'function') cue.nofocusSet(true).catch(() => {});
      }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); send(); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      runMode(e.shiftKey ? 'assist' : 'say', '');
    }
  });
  
  // FIX #13: Global keyboard shortcut for force-answer (Ctrl+Shift+A / Cmd+Shift+A), STT Answer (Alt+A), STT Insert (Alt+I), and Tab to insert
  document.addEventListener('keydown', (e) => {
    // Alt + + / =: Widen quiet box
    if (e.altKey && (e.key === '+' || e.key === '=' || e.key === 'Add') && (!e.ctrlKey || (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph'))) && !e.metaKey) {
      e.preventDefault();
      resizeQuietBox(1);
      return;
    }
    // Alt + - / _: Narrow quiet box
    if (e.altKey && (e.key === '-' || e.key === '_' || e.key === 'Subtract') && (!e.ctrlKey || (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph'))) && !e.metaKey) {
      e.preventDefault();
      resizeQuietBox(-1);
      return;
    }
    // Alt+X: Completely hide or restore Cue
    if (e.altKey && (e.key === 'x' || e.key === 'X') && (!e.ctrlKey || (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph'))) && !e.metaKey) {
      e.preventDefault();
      toggleAltX();
      return;
    }
    // Alt+A: Answer staged interviewer question OR toggle autotyper
    if (e.altKey && (e.key === 'a' || e.key === 'A') && (!e.ctrlKey || (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph'))) && !e.metaKey) {
      if (isQuietMode) {
        e.preventDefault();
        toggleAutotyper();
        return;
      }
      if (stagedInterviewerQuestion) {
        e.preventDefault();
        answerInterviewerQuestion();
        return;
      }
      e.preventDefault();
      toggleAutotyper();
      return;
    }
    // Alt+U: Insert staged interviewer question into input box
    if (e.altKey && (e.key === 'u' || e.key === 'U') && (!e.ctrlKey || (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph'))) && !e.metaKey) {
      if (isQuietMode) return;
      if (stagedInterviewerQuestion) {
        e.preventDefault();
        insertInterviewerQuestion();
        return;
      }
    }
    // Alt+Q: Run recap / toggle quiet mode
    if (e.altKey && (e.key === 'q' || e.key === 'Q') && (!e.ctrlKey || (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph'))) && !e.metaKey) {
      e.preventDefault();
      toggleQuietMode();
      // runMode('recap', '');
      return;
    }
    // Alt+G: Run HR mode
    if (e.altKey && (e.key === 'g' || e.key === 'G') && (!e.ctrlKey || (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph'))) && !e.metaKey) {
      if (isQuietMode) return;
      e.preventDefault();
      triggerHrMode();
      return;
    }
    // Ctrl+H (Cmd+H): Run LeetCode mode
    if ((e.ctrlKey || e.metaKey) && (e.key === 'h' || e.key === 'H') && !e.altKey && !e.shiftKey) {
      if (isQuietMode) return;
      e.preventDefault();
      runMode('leetcode', '');
      return;
    }
    // Alt+W: Bring back previous prompt in input box
    if (e.altKey && (e.key === 'w' || e.key === 'W') && (!e.ctrlKey || (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph'))) && !e.metaKey) {
      e.preventDefault();
      if (isQuietMode) {
        if (quietCurrentPrompt) {
          clearQuietOutput();
          quietInput.value = quietCurrentPrompt;
          quietStealthCaretPos = quietCurrentPrompt.length;
          syncQuietInput();
          showToast('Previous prompt restored', 1200);
        } else {
          showToast('No previous prompt', 1500);
        }
        return;
      }
      restorePreviousPrompt();
      return;
    }
    // Alt+E: Go to previous answer
    if (e.altKey && (e.key === 'e' || e.key === 'E') && (!e.ctrlKey || (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph'))) && !e.metaKey) {
      if (isQuietMode) return;
      e.preventDefault();
      goToPreviousAnswer();
      return;
    }
    // Alt+R: Retry prompt
    if (e.altKey && (e.key === 'r' || e.key === 'R') && (!e.ctrlKey || (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph'))) && !e.metaKey) {
      e.preventDefault();
      if (isQuietMode) {
        if (busy) {
          showToast('Please wait for current response to finish', 2000);
          return;
        }
        if (quietCurrentPrompt) {
          sendQuiet(quietCurrentPrompt);
        } else {
          showToast('No prompt to retry', 1500);
        }
        return;
      }
      const group = getActiveResponseGroup();
      if (!group) {
        showToast('No prompt to retry', 1500);
        return;
      }
      if (busy) {
        showToast('Please wait for the current response to finish', 2000);
        return;
      }
      retryResponse(group);
      return;
    }
    // Alt+O / Ctrl+O: Reduce opacity
    if ((e.altKey && (e.key === 'o' || e.key === 'O') && (!e.ctrlKey || (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph'))) && !e.metaKey) ||
        (e.ctrlKey && (e.key === 'o' || e.key === 'O') && !e.altKey && !e.shiftKey && !e.metaKey)) {
      e.preventDefault();
      changeOpacityBy(-5);
      return;
    }
    // Alt+P / Ctrl+P: Increase opacity
    if ((e.altKey && (e.key === 'p' || e.key === 'P') && (!e.ctrlKey || (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph'))) && !e.metaKey) ||
        (e.ctrlKey && (e.key === 'p' || e.key === 'P') && !e.altKey && !e.shiftKey && !e.metaKey)) {
      e.preventDefault();
      changeOpacityBy(5);
      return;
    }
    // Alt+I / J / K / L: Move window Up / Left / Down / Right
    if (e.altKey && (!e.ctrlKey || (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph'))) && !e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === 'i' || k === 'j' || k === 'k' || k === 'l') {
        e.preventDefault();
        const dir = k === 'i' ? 'up' : k === 'j' ? 'left' : k === 'k' ? 'down' : 'right';
        if (typeof cue.windowMove === 'function') cue.windowMove(dir);
        return;
      }
    }
    // Alt+B: Explain terms from last 4 messages (previous4)
    if (e.altKey && (e.key === 'b' || e.key === 'B') && (!e.ctrlKey || (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph'))) && !e.metaKey) {
      if (isQuietMode) return;
      e.preventDefault();
      runMode('previous4', '');
      return;
    }
    // Alt+N: Toggle transcription history sidebar
    if (e.altKey && (e.key === 'n' || e.key === 'N') && (!e.ctrlKey || (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph'))) && !e.metaKey) {
      if (isQuietMode) return;
      e.preventDefault();
      toggleSidebar();
      return;
    }
    // Alt+H: Toggle hide/collapse
    if (e.altKey && (e.key === 'h' || e.key === 'H') && (!e.ctrlKey || (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph'))) && !e.metaKey) {
      e.preventDefault();
      toggleHide();
      return;
    }
    // Alt+T: Go to next answer
    if (e.altKey && (e.key === 't' || e.key === 'T') && (!e.ctrlKey || (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph'))) && !e.metaKey) {
      if (isQuietMode) return;
      e.preventDefault();
      goToNextAnswer();
      return;
    }
    // Alt+Y: Toggle transcription
    if (e.altKey && (e.key === 'y' || e.key === 'Y') && (!e.ctrlKey || (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph'))) && !e.metaKey) {
      e.preventDefault();
      toggleTranscription();
      return;
    }
    // Alt+M: Toggle model between configured models
    if (e.altKey && (e.key === 'm' || e.key === 'M') && (!e.ctrlKey || (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph'))) && !e.metaKey) {
      e.preventDefault();
      toggleModel();
      return;
    }
    // Alt+S: Toggle smart mode (smart/fast)
    if (e.altKey && (e.key === 's' || e.key === 'S') && (!e.ctrlKey || (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph'))) && !e.metaKey) {
      e.preventDefault();
      toggleSmartMode();
      return;
    }
    // Tab when interviewer question is staged and focus is not already inside another text input
    if (e.key === 'Tab' && stagedInterviewerQuestion && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      if (document.activeElement !== input && document.activeElement && document.activeElement.tagName !== 'TEXTAREA' && document.activeElement.tagName !== 'INPUT') {
        e.preventDefault();
        insertInterviewerQuestion();
        return;
      }
    }
    // Ctrl+Shift+A / Cmd+Shift+A: Force answer current question immediately
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      if (input.value.trim()) {
        send();
      } else if (stagedInterviewerQuestion) {
        answerInterviewerQuestion();
      } else if (inputFromSTT || composer.classList.contains('stt-filling')) {
        // Even if question seems incomplete, force send
        send();
      } else {
        showToast('No question to answer', 1500);
      }
    }
  });
  
  // FIX #4: Add accessibility label with keyboard shortcuts to send button
  const sendBtn = document.getElementById('send-btn');
  if (sendBtn) {
    const forceKey = isWindows ? 'Ctrl+Shift+A' : '⌘⇧A';
    sendBtn.setAttribute('aria-label', `Send · ${forceKey} to force answer`);
  }

  // Smart toggle (Alt+S)
  const smartBtn = $('#smart-toggle');
  let lastSmartToggleTime = 0;
  async function toggleSmartMode() {
    const now = Date.now();
    if (now - lastSmartToggleTime < 200) return;
    lastSmartToggleTime = now;
    if (!settings) return;
    settings.smart = !settings.smart;
    if (smartBtn) smartBtn.classList.toggle('on', settings.smart);
    try {
      await cue.settingsSet({ smart: settings.smart });
    } catch (_) {}
    showToast(settings.smart ? 'Smart mode ON' : 'Fast mode ON', 1500);
  }
  if (smartBtn) smartBtn.addEventListener('click', toggleSmartMode);
  cue.on('smart:toggle', toggleSmartMode);

  // Model toggle (Alt+M)
  const PROVIDER_NAMES = {
    gemini: 'Gemini',
    groq: 'Groq',
    cerebras: 'Cerebras',
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    custom: 'Custom',
    ollama: 'Ollama',
    minimax: 'MiniMax',
    deepseek: 'DeepSeek',
    azure: 'Azure AI Foundry',
    publik: 'publik API'
  };

  let lastModelToggleTime = 0;
  async function toggleModel() {
    const now = Date.now();
    if (now - lastModelToggleTime < 200) return;
    lastModelToggleTime = now;
    if (!settings) return;

    const list = Array.isArray(settings.modelToggle) && settings.modelToggle.length >= 4
      ? settings.modelToggle
      : ['gemini', 'groq', 'custom', 'ollama'];

    const currentIndex = list.indexOf(settings.provider);
    const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % list.length : 0;
    const nextProvider = list[nextIndex] || list[0] || 'gemini';
    settings.provider = nextProvider;

    try {
      await cue.settingsSet({ provider: nextProvider });
    } catch (_) {}

    // Update settings UI if present
    document.querySelectorAll('#provider-seg button').forEach((x) => {
      x.classList.toggle('on', x.dataset.provider === nextProvider);
    });
    updateCustomProviderFields();
    const m = settings.models[settings.provider] || { fast: '', smart: '' };
    const fastInput = $('#model-fast');
    const smartInput = $('#model-smart');
    if (fastInput) fastInput.value = m.fast;
    if (smartInput) smartInput.value = m.smart;
    const statusEl = $('#s-status');
    if (statusEl) statusEl.textContent = statusText();
    updateSmartTooltip();

    const displayName = PROVIDER_NAMES[nextProvider] || nextProvider;
    showToast(`Model: ${displayName}`, 1500);
    updateModelIndicator();
  }
  cue.on('model:toggle', toggleModel);

  function getModelIndicatorLabel(provider) {
    const shortNames = {
      gemini: 'Gemini',
      custom: 'Custom',
      groq: 'Groq',
      ollama: 'Ollama',
      cerebras: 'Cerebras',
      openai: 'OpenAI',
      anthropic: 'Anthropic',
      minimax: 'MiniMax',
      deepseek: 'DeepSeek',
      azure: 'Azure',
      publik: 'publik'
    };
    return shortNames[provider] || (PROVIDER_NAMES[provider] || provider);
  }

  function updateModelIndicator() {
    const el = document.getElementById('model-indicator');
    if (!el || !settings) return;
    const provider = settings.provider || 'gemini';
    const label = getModelIndicatorLabel(provider);
    el.textContent = label;
    el.setAttribute('title', `Current model: ${label} (Click or Alt+M to switch)`);
    el.setAttribute('aria-label', `Current model: ${label}`);
  }

  const modelIndicatorEl = document.getElementById('model-indicator');
  if (modelIndicatorEl) {
    modelIndicatorEl.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleModel();
    });
  }

  // Hide / collapse
  let reopenSidebarOnExpand = false;
  function toggleHide() {
    const collapsed = $('#panel-wrap').classList.toggle('collapsed');
    const btn = $('#hide-btn');
    btn.classList.toggle('collapsed', collapsed);
    const label = btn.querySelector('.tb-hide-label');
    const text = collapsed ? 'Show' : 'Hide';
    if (label) label.textContent = text;
    btn.setAttribute('aria-label', text);
    if (collapsed) {
      deactivateStealthTyping();
      reopenSidebarOnExpand = sidebarOpen;
      if (sidebarOpen) hideSidebar();
    } else if (reopenSidebarOnExpand) {
      showSidebar();
    }
  }
  $('#hide-btn').addEventListener('click', toggleHide);
  cue.on('hide:toggle', toggleHide);

  // Deactivate stealth typing when clicking anywhere in the app outside the text box
  document.addEventListener('pointerdown', (e) => {
    if (isStealthTypingActive && !isInsideInputArea(e.target)) {
      deactivateStealthTyping();
    }
  }, true);

  document.addEventListener('click', (e) => {
    if (isStealthTypingActive && !isInsideInputArea(e.target)) {
      deactivateStealthTyping();
    }
  }, true);

  const OPACITY_MIN = 0.0;
  let currentOpacityValue = 1.0;
  let isAltXHidden = false;
  let preAltXOpacity = null;

  function clampOpacity(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 1;
    return Math.min(1, Math.max(OPACITY_MIN, Math.round(n * 100) / 100));
  }
  function opacityToPercent(value) { return Math.round(clampOpacity(value) * 100); }
  function persistOpacitySoon() {
    clearTimeout(persistOpacitySoon.timer);
    persistOpacitySoon.timer = setTimeout(() => {
      if (!settings || isQuietMode || isAltXHidden) return;
      cue.settingsSet({ opacity: currentOpacityValue }).then((next) => {
        if (next) {
          const target = currentOpacityValue;
          settings = next;
          settings.opacity = target;
        }
      }).catch(() => {});
    }, 400);
  }
  function changeOpacityBy(deltaPercent) {
    if (isAltXHidden && deltaPercent > 0) {
      // If hidden by Alt+X and increasing opacity (Alt+P / Ctrl+P), increase normally from 0 (+5% at a time)
      isAltXHidden = false;
      preAltXOpacity = null;
    }
    const currentPercent = opacityToPercent(currentOpacityValue);
    const nextPercent = Math.min(100, Math.max(0, currentPercent + deltaPercent));
    applyOpacity(nextPercent / 100, !isQuietMode);
  }
  function applyOpacity(value, persist) {
    const opacity = clampOpacity(value);
    currentOpacityValue = opacity;
    if (opacity > 0) {
      isAltXHidden = false;
    }
    const percent = opacityToPercent(opacity);
    if (!isQuietMode && !isAltXHidden && settings) settings.opacity = opacity;
    document.documentElement.style.setProperty('--cue-opacity', String(opacity));
    const tb = $('#tb-opacity-slider');
    const tbVal = $('#tb-opacity-value');
    const s = $('#s-opacity-slider');
    const sVal = $('#s-opacity-value');
    if (tb) tb.value = String(percent);
    if (tbVal) tbVal.textContent = percent + '%';
    if (s) s.value = String(percent);
    if (sVal) sVal.textContent = percent + '%';
    if (persist && !isQuietMode && !isAltXHidden) persistOpacitySoon();
  }

  function toggleAltX(force) {
    if (force == null) {
      if (isAltXHidden || currentOpacityValue === 0) {
        force = false;
      } else {
        force = true;
      }
    }
    const nextHidden = force;
    if (nextHidden) {
      if (currentOpacityValue > 0) {
        preAltXOpacity = currentOpacityValue;
      } else if (preAltXOpacity == null || preAltXOpacity <= 0) {
        preAltXOpacity = isQuietMode ? 0.05 : (settings && settings.opacity > 0 ? settings.opacity : 0.8);
      }
      isAltXHidden = true;
      applyOpacity(0.0, false);
      showToast('Cue hidden (Alt+X to show)', 1200);
    } else {
      isAltXHidden = false;
      let restore = preAltXOpacity;
      if (restore == null || restore <= 0) {
        restore = isQuietMode ? 0.05 : (settings && settings.opacity > 0 ? settings.opacity : 0.8);
      }
      preAltXOpacity = null;
      applyOpacity(restore, !isQuietMode);
      showToast(`Cue visible (${opacityToPercent(restore)}%)`, 1200);
    }
  }

  cue.on('alt-x:toggle', () => toggleAltX());
  function toggleOpacityPopover(force) {
    const pop = $('#opacity-popover');
    const btn = $('#opacity-btn');
    if (!pop || !btn) return;
    const open = force != null ? force : pop.classList.contains('hidden');
    pop.classList.toggle('hidden', !open);
    btn.classList.toggle('on', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    document.getElementById('app').classList.toggle('opacity-open', open);
  }
  $('#opacity-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleOpacityPopover();
  });
  document.addEventListener('click', (e) => {
    const wrap = document.querySelector('.tb-opacity-wrap');
    if (wrap && !wrap.contains(e.target)) toggleOpacityPopover(false);
  });
  ['tb-opacity-slider', 's-opacity-slider'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => applyOpacity(Number(el.value) / 100, true));
    el.addEventListener('change', () => applyOpacity(Number(el.value) / 100, true));
  });
  cue.on('opacity:step', ({ delta }) => {
    if (typeof delta === 'number') {
      changeOpacityBy(delta);
    }
  });

  cue.on('response:retry', () => {
    if (isQuietMode) {
      if (busy) {
        showToast('Please wait for current response to finish', 2000);
        return;
      }
      if (quietCurrentPrompt) {
        sendQuiet(quietCurrentPrompt);
      } else {
        showToast('No prompt to retry', 1500);
      }
      return;
    }
    const group = getActiveResponseGroup();
    if (!group) {
      showToast('No prompt to retry', 1500);
      return;
    }
    if (busy) {
      showToast('Please wait for the current response to finish', 2000);
      return;
    }
    retryResponse(group);
  });

  cue.on('prompt:previous', () => {
    if (isQuietMode) {
      if (quietCurrentPrompt) {
        clearQuietOutput();
        quietInput.value = quietCurrentPrompt;
        quietStealthCaretPos = quietCurrentPrompt.length;
        syncQuietInput();
        showToast('Previous prompt restored', 1200);
      } else {
        showToast('No previous prompt', 1500);
      }
      return;
    }
    restorePreviousPrompt();
  });

  cue.on('response:previous', () => {
    if (isQuietMode) return;
    goToPreviousAnswer();
  });

  cue.on('response:next', () => {
    if (isQuietMode) return;
    goToNextAnswer();
  });

  // Toggle transcription (start/stop listening). Kick off system-audio capture straight from the click so
  // the user-gesture is fresh for getDisplayMedia (loopback capture needs it).
  let lastTranscriptionToggleTime = 0;
  async function toggleTranscription() {
    const now = Date.now();
    if (now - lastTranscriptionToggleTime < 300) return;
    lastTranscriptionToggleTime = now;
    const turningOn = !$('#stop-btn').classList.contains('active');
    if (turningOn) {
      // startSystemAudio may fail (user cancels, no permission) — that's OK,
      // mic will still work and capture will toggle regardless
      try { await startSystemAudio(); } catch (_) { /* handled inside startSystemAudio */ }
    }
    const active = await cue.captureToggle();
    if (turningOn && !active) stopSystemAudio();
  }
  $('#stop-btn').addEventListener('click', toggleTranscription);
  cue.on('transcription:toggle', toggleTranscription);

  const focusBtn = $('#focus-btn');
  if (focusBtn) {
    focusBtn.addEventListener('click', async () => {
      if (typeof cue.nofocusToggle === 'function') {
        const active = await cue.nofocusToggle();
        setNoFocusUI(active);
        showToast(active ? 'No-focus mode ON: window will not steal focus' : 'No-focus mode OFF: normal window focus', 2000);
      }
    });
  }

  // Transcript toggle removed — sidebar now auto-opens with listening

  // Clear transcript
  const clearTranscriptBtn = document.getElementById('clear-transcript-btn');
  if (clearTranscriptBtn) {
    clearTranscriptBtn.addEventListener('click', async () => {
      await cue.clearTranscript();
      // Also clear the floating interim bar
      if (interimEl) { interimEl.textContent = ''; interimEl.classList.remove('show'); }
      transcriptInterimEl = null;
      clearTranscriptInterim();
      clearInputInterim();
      clearTranscriptSidebar();
      dismissInterviewerPill();
      if (messages) { messages.innerHTML = ''; responseCount = 0; }
      questionHistory.length = 0;
      // Only a question auto-filled from the transcript goes; anything the user typed stays.
      if (inputFromSTT) hardClearSTTFill();
      showToast('Transcript cleared.', 2500);
    });
  }

  // ---- capture: mic (renderer side) — uses AudioWorklet (modern, off-main-thread) ----
  let audioCtx = null, micStream = null, micWorklet = null;
  // Generation counter: startMic() awaits getUserMedia, so a second call (or a
  // stopMic()) can land mid-flight. Each start bumps the generation and bails
  // if it is no longer current, otherwise two capture pipelines end up feeding
  // the "you" channel at once — every slice of speech arrives twice, which the
  // transcriber can't make sense of — and the orphaned one keeps the mic hot.
  let micGen = 0;
  async function startMic() {
    if (micStream) return;
    const gen = ++micGen;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: 16000
        }
      });
      if (gen !== micGen || micStream) {
        // Superseded while we were waiting: another start won, or a stop came in.
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      micStream = stream;
      // getUserMedia can resolve with a stream that has no usable audio track
      // (e.g. a virtual/placeholder device, or a device that was unplugged
      // between permission grant and capture start). Fail loudly here instead
      // of silently wiring up an AudioWorklet to nothing — that produces the
      // "cue never hears me, no error shown" symptom with no diagnostic at all.
      const [track] = micStream.getAudioTracks();
      if (!track) {
        micStream.getTracks().forEach((t) => t.stop());
        micStream = null;
        showStatus('No microphone audio track was available. Check Windows Sound settings for a working default input device, then try again.');
        return;
      }
      cue.log('mic stream started: track=' + (track.label || '(no label — permission may be stale)') + ' muted=' + track.muted);
      audioCtx = new AudioContext({ sampleRate: 16000 });

      // Use AudioWorklet for low-latency, off-main-thread processing
      try {
        await audioCtx.audioWorklet.addModule('audio-worklet-processor.js');
        const source = audioCtx.createMediaStreamSource(micStream);
        micWorklet = new AudioWorkletNode(audioCtx, 'cue-audio-processor');
        micWorklet.port.onmessage = (e) => {
          cue.micPcm(e.data);
        };
        source.connect(micWorklet);
        // Don't connect to destination — we just capture, don't play
        cue.log('mic AudioWorklet processor attached');
      } catch (workletErr) {
        // Fallback to ScriptProcessor if AudioWorklet fails (shouldn't happen in Electron 33+)
        cue.log('AudioWorklet failed, falling back to ScriptProcessor: ' + workletErr.message);
        const micNode = audioCtx.createMediaStreamSource(micStream);
        const micProc = audioCtx.createScriptProcessor(4096, 1, 1);
        const sink = audioCtx.createGain(); sink.gain.value = 0;
        micNode.connect(micProc); micProc.connect(sink); sink.connect(audioCtx.destination);
        micProc.onaudioprocess = (e) => {
          const f = e.inputBuffer.getChannelData(0);
          const out = new Int16Array(f.length);
          for (let i = 0; i < f.length; i++) { const s = Math.max(-1, Math.min(1, f[i])); out[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
          cue.micPcm(out.buffer);
        };
        micWorklet = { _legacy: true, proc: micProc, node: micNode, sink };
      }
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      const name = err && err.name;
      cue.log('mic error: ' + name + ' — ' + message);
      // getUserMedia's DOMException.name is the reliable signal here — the
      // .message text varies by Chromium version and isn't meant for users.
      // Distinguishing "no device" from "denied" from "in use elsewhere"
      // turns one generic dead end into three different next actions.
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        showStatus('No microphone was found. Plug one in, or pick a default input device in your OS sound settings, then try again.');
      } else if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
        showStatus(isWindows
          ? 'Microphone permission was denied. Settings → Privacy & security → Microphone → allow cue, then try again.'
          : 'Microphone permission was denied. System Settings → Privacy & Security → Microphone → allow cue, then try again.');
      } else if (name === 'NotReadableError' || name === 'TrackStartError') {
        showStatus('The microphone could not be started — another application may be using it exclusively. Close other apps using the mic and try again.');
      } else {
        showStatus('Microphone capture could not be started. Check your mic permissions and try again.');
      }
    }
  }
  function stopMic() {
    micGen++; // invalidate any startMic() still waiting on getUserMedia
    if (micWorklet) {
      if (micWorklet._legacy) {
        micWorklet.proc.disconnect(); micWorklet.proc.onaudioprocess = null;
        micWorklet.node.disconnect(); micWorklet.sink.disconnect();
      } else {
        micWorklet.disconnect();
      }
      micWorklet = null;
    }
    if (audioCtx) { audioCtx.close(); audioCtx = null; }
    if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  }

  // ---- capture: system/meeting audio (getDisplayMedia loopback, in cue's process) ----
  let sysStream = null, sysCtx = null, sysWorklet = null, sysStarting = false;
  async function startSystemAudio() {
    // Called both from the stop-btn click (fresh user gesture for getDisplayMedia) and from the
    // capture:state handler. getDisplayMedia is async, so `if (sysStream) return` alone loses the
    // race and can open a second loopback stream that is then orphaned.
    if (sysStream || sysStarting) return;
    // macOS: asking for meeting audio means asking for a display-capture session, and
    // that session puts the OS screen-recording indicator on the menu bar for the whole
    // call. Default to staying invisible; the user opts in in Settings > Audio.
    if (isMac && !(settings && settings.meetingAudio)) {
      cue.log('system audio: meeting audio is off on macOS -- no display-capture session opened');
      showStatus('Meeting audio is off, so cue stays invisible. macOS shows a screen-recording indicator whenever an app captures system audio; turn Meeting audio on in Settings \u203a Audio if you want the other side transcribed.');
      return;
    }
    sysStarting = true;
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
      cue.log('system audio unavailable: getDisplayMedia not supported');
      showStatus('Meeting audio capture is not available on this device build.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });

      stream.getVideoTracks().forEach((t) => t.stop()); // we only want the audio
      const tracks = stream.getAudioTracks();
      if (!tracks.length) {
        cue.log('system audio: no loopback track on this platform');
        stream.getTracks().forEach((t) => t.stop());
        showStatus(cue.platform === 'win32'
          ? 'No system-audio loopback track detected. Make sure "Share audio" is checked in the screen share dialog, and that your audio device is not in exclusive mode.'
          : 'No system-audio loopback track detected. Meeting audio needs macOS 14.4+ — your screen and microphone still work.');
        return;
      }
      sysStream = stream;
      sysCtx = new AudioContext({ sampleRate: 16000 });

      // Use AudioWorklet for system audio too
      try {
        await sysCtx.audioWorklet.addModule('audio-worklet-processor.js');
        const source = sysCtx.createMediaStreamSource(new MediaStream(tracks));
        sysWorklet = new AudioWorkletNode(sysCtx, 'cue-audio-processor');
        sysWorklet.port.onmessage = (e) => {
          cue.systemPcm(e.data);
        };
        source.connect(sysWorklet);
        cue.log('system audio: AudioWorklet capturing loopback');
      } catch (workletErr) {
        // Fallback to ScriptProcessor
        cue.log('system audio AudioWorklet failed, using ScriptProcessor: ' + workletErr.message);
        const sysNode = sysCtx.createMediaStreamSource(new MediaStream(tracks));
        const sysProc = sysCtx.createScriptProcessor(4096, 1, 1);
        const sink = sysCtx.createGain(); sink.gain.value = 0;
        sysNode.connect(sysProc); sysProc.connect(sink); sink.connect(sysCtx.destination);
        sysProc.onaudioprocess = (e) => {
          const f = e.inputBuffer.getChannelData(0);
          const out = new Int16Array(f.length);
          for (let i = 0; i < f.length; i++) { const s = Math.max(-1, Math.min(1, f[i])); out[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
          cue.systemPcm(out.buffer);
        };
        sysWorklet = { _legacy: true, proc: sysProc, node: sysNode, sink };
      }
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      cue.log('system audio error: ' + message);
      showStatus('Meeting audio could not be started. Grant screen/audio access to cue and try again.');
    } finally {
      sysStarting = false;
    }
  }
  function stopSystemAudio() {
    if (sysWorklet) {
      if (sysWorklet._legacy) {
        sysWorklet.proc.disconnect(); sysWorklet.proc.onaudioprocess = null;
        sysWorklet.node.disconnect(); sysWorklet.sink.disconnect();
      } else {
        sysWorklet.disconnect();
      }
      sysWorklet = null;
    }
    if (sysCtx) { sysCtx.close(); sysCtx = null; }
    if (sysStream) { sysStream.getTracks().forEach((t) => t.stop()); sysStream = null; }
  }

  // ---- STT / VAD status helpers ------------------------------------------
  // Live dot states: 'off' | 'idle' | 'speaking' | 'transcribing'
  function setLiveDotState(dotState) {
    const dot = document.getElementById('live-dot');
    if (!dot) return;
    dot.classList.remove('off', 'idle', 'speaking', 'transcribing');
    dot.classList.add(dotState);
    const labels = {
      off:          'Not listening',
      idle:         'Listening — silence detected',
      speaking:     'Speech detected',
      transcribing: 'Transcribing…'
    };
    dot.setAttribute('aria-label', labels[dotState] || '');
  }

  let sttState = 'disconnected';

  const STT_LABELS = {
    disconnected: 'Transcription off',
    connecting: 'Starting transcription…',
    loading: 'Starting transcription…',
    streaming: 'Transcription running',
    batch: 'Transcription running',
    local: 'Transcription running',
    stopping: 'Stopping transcription…',
    error: 'Transcription error'
  };

  function setSttState(state) {
    sttState = state;
    const label = document.getElementById('stt-status');
    if (!label) return;
    label.textContent = STT_LABELS[state];
    label.className = 'stt-status stt-' + state;
  }

  function updateSttStatus({ active, streaming } = {}) {
    if (active === false) setSttState('disconnected');
    else if (active === true) setSttState(streaming ? 'connecting' : 'batch');
  }

  // ---- transcript history sidebar (hidden by default, manual toggle) ----
  let tsSidebarInterimEl = null;
  let sidebarOpen = false;
  // Track last committed row per channel — all chunks from same speaker go in one row
  const tsLastRow = { you: null, them: null };
  const tsRowTimer = { you: null, them: null };
  const TS_SENTENCE_GAP_MS = 10000; // 10s silence = new row

  const SIDEBAR_GAP = 12; // matches the 12px offset in .transcript-sidebar

  function placeSidebar(sidebar) {
    const panel = $('#panel').getBoundingClientRect();
    const needed = sidebar.offsetWidth + SIDEBAR_GAP;
    const areaLeft = screen.availLeft;
    const areaRight = screen.availLeft + screen.availWidth;
    const fitsRight = window.screenX + panel.right + needed <= areaRight;
    const fitsLeft = window.screenX + panel.left - needed >= areaLeft;
    const onLeft = !fitsRight && fitsLeft;
    if (sidebar.classList.contains('left') === onLeft) return;
    // Switch sides without animating, so the open transition starts from the new side's tucked position.
    sidebar.classList.add('ts-instant');
    sidebar.classList.toggle('left', onLeft);
    void sidebar.offsetWidth;
    sidebar.classList.remove('ts-instant');
  }

  function showSidebar() {
    const sidebar = document.getElementById('transcript-sidebar');
    const historyBtn = document.getElementById('history-btn');
    if (sidebar) {
      placeSidebar(sidebar);
      sidebar.classList.add('open');
    }
    if (historyBtn) historyBtn.classList.add('active');
    sidebarOpen = true;
  }

  function hideSidebar() {
    const sidebar = document.getElementById('transcript-sidebar');
    const historyBtn = document.getElementById('history-btn');
    if (sidebar) sidebar.classList.remove('open');
    if (historyBtn) historyBtn.classList.remove('active');
    sidebarOpen = false;
  }

  function toggleSidebar() {
    if (isQuietMode) return;
    if (sidebarOpen) {
      hideSidebar();
    } else {
      showSidebar();
      // FIX #7: Scroll to bottom when opening sidebar
      const list = document.getElementById('ts-list');
      if (list) {
        requestAnimationFrame(() => {
          list.scrollTop = list.scrollHeight;
        });
      }
    }
  }

  // History button toggle
  const historyBtn = document.getElementById('history-btn');
  if (historyBtn) {
    historyBtn.querySelector('.ic').innerHTML = icon('message-square-text', { size: 14 });
    historyBtn.addEventListener('click', toggleSidebar);
  }
  cue.on('history:toggle', toggleSidebar);

  // Close sidebar button
  const closeSidebarBtn = document.getElementById('close-sidebar-btn');
  if (closeSidebarBtn) {
    closeSidebarBtn.addEventListener('click', hideSidebar);
  }

  function appendTranscriptHistoryTurn(channel, text, isInterim) {
    const list = document.getElementById('ts-list');
    if (!list) return;

    // Remove placeholder on first real turn
    const ph = list.querySelector('.ts-placeholder');
    if (ph) ph.remove();

    if (isInterim) {
      // Update the single floating interim row
      if (!tsSidebarInterimEl) {
        tsSidebarInterimEl = document.createElement('div');
        tsSidebarInterimEl.className = 'ts-turn ts-' + channel + ' ts-interim-row';
        const chLabel = document.createElement('span');
        chLabel.className = 'ts-channel';
        chLabel.textContent = channel === 'them' ? 'Them' : 'You';
        const txt = document.createElement('span');
        txt.className = 'ts-text ts-interim';
        tsSidebarInterimEl.appendChild(chLabel);
        tsSidebarInterimEl.appendChild(txt);
        list.appendChild(tsSidebarInterimEl);
      }
      tsSidebarInterimEl.querySelector('.ts-text').textContent = text;
    } else {
      // Remove interim row
      if (tsSidebarInterimEl) { tsSidebarInterimEl.remove(); tsSidebarInterimEl = null; }

      const existingRow = tsLastRow[channel];
      const useExisting = existingRow && existingRow.isConnected;

      if (useExisting) {
        // Append to existing row — accumulates sentence fragments
        const txt = existingRow.querySelector('.ts-text');
        if (txt) {
          txt.textContent = txt.textContent ? txt.textContent + ' ' + text : text;
        }
      } else {
        // Start a new row (no buttons — just clean history view)
        const row = document.createElement('div');
        row.className = 'ts-turn ts-' + channel;

        const chLabel = document.createElement('span');
        chLabel.className = 'ts-channel';
        chLabel.textContent = channel === 'them' ? 'Them' : 'You';

        const txt = document.createElement('span');
        txt.className = 'ts-text';
        txt.textContent = text;

        row.appendChild(chLabel);
        row.appendChild(txt);
        list.appendChild(row);
        tsLastRow[channel] = row;
      }

      // Reset silence timer
      clearTimeout(tsRowTimer[channel]);
      tsRowTimer[channel] = setTimeout(() => { tsLastRow[channel] = null; }, TS_SENTENCE_GAP_MS);

      // When THIS channel speaks, reset the OTHER channel's row
      const other = channel === 'you' ? 'them' : 'you';
      clearTimeout(tsRowTimer[other]);
      tsLastRow[other] = null;

      list.scrollTop = list.scrollHeight;
    }
  }

  function clearTranscriptSidebar() {
    const list = document.getElementById('ts-list');
    if (list) list.innerHTML = '<div class="ts-placeholder">Conversation history will appear here when listening.</div>';
    tsSidebarInterimEl = null;
    tsLastRow.you = null; tsLastRow.them = null;
    clearTimeout(tsRowTimer.you); clearTimeout(tsRowTimer.them);
  }

  // ---- events from main --------------------------------------------------
  cue.on('capture:state', ({ active, streaming, mode }) => {
    setLiveDotState(active ? 'idle' : 'off');
    setSessionButton(active);
    // FIX #4: Add .listening class to composer when capture is active
    composer.classList.toggle('listening', active);
    // startSystemAudio() is called directly from the stop-button click handler
    // so that the getDisplayMedia request has a fresh user gesture.
    // Here we only start the mic (no gesture required) and stop everything on deactivate.
    if (active) {
      startMic();
      // Don't auto-open sidebar — user can toggle it manually
    } else {
      stopMic();
      stopSystemAudio();
      // FIX #2: Clear interim element when capture stops
      if (interimEl) {
        interimEl.textContent = '';
        interimEl.classList.remove('show');
      }
      // Don't auto-close sidebar — let user keep it open if they want
    }
    if (active && mode === 'local') setSttState('local');
    else updateSttStatus({ active, streaming });
  });

  cue.on('nofocus:state', (active) => {
    setNoFocusUI(active);
  });

  cue.on('hr:trigger', () => {
    if (isQuietMode) return;
    triggerHrMode();
  });

  cue.on('composer:focus', ({ temporary } = {}) => {
    temporaryFocusActive = Boolean(temporary);
    if (isQuietMode) {
      if (quietOutputBox && !quietOutputBox.classList.contains('hidden')) {
        clearQuietOutput();
      }
      if (quietInput) {
        quietInput.focus();
        quietInput.select();
      }
      return;
    }
    const wrap = $('#panel-wrap');
    if (wrap && wrap.classList.contains('collapsed')) {
      toggleHide();
    }
    input.focus();
    input.select();
  });

  cue.on('transparency:state', (enabled) => {
    const nextState = Boolean(enabled);
    if (isTransparencyMode === nextState && lastTransparencyNotified === nextState) return;
    isTransparencyMode = nextState;
    lastTransparencyNotified = nextState;
    if (isTransparencyMode) {
      const wrap = $('#panel-wrap');
      if (wrap && wrap.classList.contains('collapsed')) {
        toggleHide();
      }
      setIgnore(true);
      showToast('Transparency mode ON · Click-through active · Arrow keys scroll (Alt+V exits)', 3000);
    } else {
      showToast('Transparency mode OFF · Interactive mode restored', 2000);
    }
    document.body.classList.toggle('transparency-mode', isTransparencyMode);
    if (stealthIndicator) {
      stealthIndicator.classList.toggle('hidden', !isStealthTypingActive && !isTransparencyMode);
      const pillText = stealthIndicator.querySelector('.stealth-pill-text');
      if (pillText) {
        if (isStealthTypingActive && isTransparencyMode) pillText.textContent = 'Stealth + Click-Through';
        else if (isStealthTypingActive) pillText.textContent = 'Stealth';
        else if (isTransparencyMode) pillText.textContent = 'Click-Through';
      }
    }
    updatePlaceholder();
    syncCaretMirror();
  });

  cue.on('stealth:state', ({ capturing }) => {
    const nextState = Boolean(capturing);
    isStealthTypingActive = nextState;
    if (isQuietMode) {
      if (quietInputBox) quietInputBox.classList.toggle('stealth-active', isStealthTypingActive);
      if (isStealthTypingActive && quietOutputBox && !quietOutputBox.classList.contains('hidden')) {
        clearQuietOutput();
      }
      return;
    }
    if (!isStealthTypingActive) {
      isStealthSelectAll = false;
    }
    composer.classList.toggle('stealth-active', isStealthTypingActive);
    if (stealthIndicator) {
      stealthIndicator.classList.toggle('hidden', !isStealthTypingActive);
      if (isTransparencyMode) stealthIndicator.classList.remove('hidden');
      const pillText = stealthIndicator.querySelector('.stealth-pill-text');
      if (pillText) {
        if (isStealthTypingActive && isTransparencyMode) pillText.textContent = 'Stealth + Click-Through';
        else if (isStealthTypingActive) pillText.textContent = 'Stealth';
        else if (isTransparencyMode) pillText.textContent = 'Click-Through';
      }
    }
    updateDeleteButton();
    syncCaretMirror();
    if (lastStealthNotified !== nextState) {
      lastStealthNotified = nextState;
      if (isStealthTypingActive) {
        const wrap = $('#panel-wrap');
        if (wrap && wrap.classList.contains('collapsed')) {
          toggleHide();
        }
        showToast('Stealth typing ON · Type question (Enter sends · Esc exits)', 2500);
      } else {
        showToast('Stealth typing OFF · Keyboard back to background app', 2000);
      }
    }
    updatePlaceholder();
  });

  cue.on('stealth:char', ({ char }) => {
    if (!char) return;
    if (isQuietMode) {
      if (quietOutputBox && !quietOutputBox.classList.contains('hidden')) {
        clearQuietOutput();
      }
      if (isQuietSelectAll) {
        quietInput.value = char;
        isQuietSelectAll = false;
        quietStealthCaretPos = char.length;
      } else {
        const pos = Math.max(0, Math.min(quietInput.value.length, quietStealthCaretPos));
        quietInput.value = quietInput.value.slice(0, pos) + char + quietInput.value.slice(pos);
        quietStealthCaretPos = pos + char.length;
      }
      syncQuietInput();
      return;
    }
    if (char === '\t' && stagedInterviewerQuestion) {
      insertInterviewerQuestion();
      return;
    }
    if (isStealthSelectAll) {
      input.value = char;
      isStealthSelectAll = false;
      setStealthCaretPos(char.length);
    } else {
      const pos = getStealthCaretPos();
      input.value = input.value.slice(0, pos) + char + input.value.slice(pos);
      setStealthCaretPos(pos + char.length);
    }
    syncPlaceholder();
    updateSendButtonState();
    if (stealthCaretPos >= input.value.length) {
      input.scrollTop = input.scrollHeight;
    }
    if (caretMirror) caretMirror.scrollTop = input.scrollTop;
  });

  cue.on('stealth:backspace', () => {
    if (isQuietMode) {
      if (isQuietSelectAll) {
        quietInput.value = '';
        isQuietSelectAll = false;
        quietStealthCaretPos = 0;
        syncQuietInput();
        return;
      }
      if (quietStealthCaretPos > 0) {
        const pos = quietStealthCaretPos;
        quietInput.value = quietInput.value.slice(0, pos - 1) + quietInput.value.slice(pos);
        quietStealthCaretPos = pos - 1;
        syncQuietInput();
      }
      return;
    }
    if (isStealthSelectAll) {
      input.value = '';
      isStealthSelectAll = false;
      setStealthCaretPos(0);
      syncPlaceholder();
      updateSendButtonState();
      return;
    }
    const pos = getStealthCaretPos();
    if (pos > 0) {
      input.value = input.value.slice(0, pos - 1) + input.value.slice(pos);
      setStealthCaretPos(pos - 1);
      syncPlaceholder();
      updateSendButtonState();
      if (caretMirror) caretMirror.scrollTop = input.scrollTop;
    }
  });

  cue.on('stealth:delete', () => {
    if (isQuietMode) {
      if (isQuietSelectAll) {
        quietInput.value = '';
        isQuietSelectAll = false;
        quietStealthCaretPos = 0;
        syncQuietInput();
        return;
      }
      if (quietStealthCaretPos < quietInput.value.length) {
        const pos = quietStealthCaretPos;
        quietInput.value = quietInput.value.slice(0, pos) + quietInput.value.slice(pos + 1);
        syncQuietInput();
      }
      return;
    }
    if (isStealthSelectAll) {
      input.value = '';
      isStealthSelectAll = false;
      setStealthCaretPos(0);
      syncPlaceholder();
      updateSendButtonState();
      return;
    }
    const pos = getStealthCaretPos();
    if (pos < input.value.length) {
      input.value = input.value.slice(0, pos) + input.value.slice(pos + 1);
      setStealthCaretPos(pos);
      syncPlaceholder();
      updateSendButtonState();
      if (caretMirror) caretMirror.scrollTop = input.scrollTop;
    }
  });

  function moveStealthCaretVertical(direction) {
    const val = input.value || '';
    const pos = getStealthCaretPos();
    const lines = val.split('\n');
    let currentLineIndex = 0;
    let charCount = 0;
    let col = 0;

    for (let i = 0; i < lines.length; i++) {
      const lineLen = lines[i].length;
      if (pos <= charCount + lineLen) {
        currentLineIndex = i;
        col = pos - charCount;
        break;
      }
      charCount += lineLen + 1;
    }

    if (direction < 0) {
      if (currentLineIndex > 0) {
        const prevLineIndex = currentLineIndex - 1;
        let prevLineStart = 0;
        for (let i = 0; i < prevLineIndex; i++) {
          prevLineStart += lines[i].length + 1;
        }
        const targetCol = Math.min(col, lines[prevLineIndex].length);
        setStealthCaretPos(prevLineStart + targetCol);
      } else {
        setStealthCaretPos(0);
      }
    } else if (direction > 0) {
      if (currentLineIndex < lines.length - 1) {
        const nextLineIndex = currentLineIndex + 1;
        let nextLineStart = 0;
        for (let i = 0; i < nextLineIndex; i++) {
          nextLineStart += lines[i].length + 1;
        }
        const targetCol = Math.min(col, lines[nextLineIndex].length);
        setStealthCaretPos(nextLineStart + targetCol);
      } else {
        setStealthCaretPos(val.length);
      }
    }
    syncCaretMirror();
  }

  cue.on('stealth:arrow-left', () => {
    if (isQuietMode) {
      isQuietSelectAll = false;
      if (quietStealthCaretPos > 0) {
        quietStealthCaretPos--;
        syncQuietCaret();
      }
      return;
    }
    if (isStealthTypingActive) {
      isStealthSelectAll = false;
      const pos = getStealthCaretPos();
      if (pos > 0) {
        setStealthCaretPos(pos - 1);
        syncCaretMirror();
      }
    }
  });

  cue.on('stealth:arrow-right', () => {
    if (isQuietMode) {
      isQuietSelectAll = false;
      if (quietStealthCaretPos < quietInput.value.length) {
        quietStealthCaretPos++;
        syncQuietCaret();
      }
      return;
    }
    if (isStealthTypingActive) {
      isStealthSelectAll = false;
      const pos = getStealthCaretPos();
      if (pos < input.value.length) {
        setStealthCaretPos(pos + 1);
        syncCaretMirror();
      }
    }
  });

  let lastArrowTime = 0;
  let lastArrowDir = 0;

  function doArrowScroll(direction) {
    if (!messages) return;
    const now = Date.now();
    const dt = now - lastArrowTime;
    lastArrowTime = now;

    if (dt < 400 && lastArrowDir === direction) {
      // Key held down: instant scroll avoids Chromium smooth-scroll easing cancellation
      messages.scrollBy({ top: direction * 55, behavior: 'auto' });
    } else {
      // Individual press: smooth scroll step
      lastArrowDir = direction;
      messages.scrollBy({ top: direction * 85, behavior: 'smooth' });
    }
  }

  cue.on('stealth:arrow-up', () => {
    if (isStealthTypingActive) {
      isStealthSelectAll = false;
      moveStealthCaretVertical(-1);
    } else if (isTransparencyMode) {
      if (isQuietMode && quietOutputBox && !quietOutputBox.classList.contains('hidden')) {
        quietOutputBox.scrollBy({ top: -60, behavior: 'smooth' });
      } else {
        doArrowScroll(-1);
      }
    } else if (isQuietMode) {
      if (quietOutputBox && !quietOutputBox.classList.contains('hidden')) {
        quietOutputBox.scrollBy({ top: -60, behavior: 'smooth' });
      }
    }
  });

  cue.on('stealth:arrow-down', () => {
    if (isStealthTypingActive) {
      isStealthSelectAll = false;
      moveStealthCaretVertical(1);
    } else if (isTransparencyMode) {
      if (isQuietMode && quietOutputBox && !quietOutputBox.classList.contains('hidden')) {
        quietOutputBox.scrollBy({ top: 60, behavior: 'smooth' });
      } else {
        doArrowScroll(1);
      }
    } else if (isQuietMode) {
      if (quietOutputBox && !quietOutputBox.classList.contains('hidden')) {
        quietOutputBox.scrollBy({ top: 60, behavior: 'smooth' });
      }
    }
  });

  cue.on('stealth:page-up', () => {
    if (isQuietMode) {
      if (quietOutputBox && !quietOutputBox.classList.contains('hidden')) {
        quietOutputBox.scrollBy({ top: -200, behavior: 'smooth' });
      }
      return;
    }
    if (isStealthTypingActive) {
      isStealthSelectAll = false;
      setStealthCaretPos(0);
      syncCaretMirror();
    } else if (isTransparencyMode) {
      if (messages) {
        messages.scrollBy({ top: -Math.max(150, messages.clientHeight * 0.8), behavior: 'smooth' });
      }
    }
  });

  cue.on('stealth:page-down', () => {
    if (isQuietMode) {
      if (quietOutputBox && !quietOutputBox.classList.contains('hidden')) {
        quietOutputBox.scrollBy({ top: 200, behavior: 'smooth' });
      }
      return;
    }
    if (isStealthTypingActive) {
      isStealthSelectAll = false;
      setStealthCaretPos(input.value.length);
      syncCaretMirror();
    } else if (isTransparencyMode) {
      if (messages) {
        messages.scrollBy({ top: Math.max(150, messages.clientHeight * 0.8), behavior: 'smooth' });
      }
    }
  });

  cue.on('stealth:home', () => {
    if (isQuietMode) {
      isQuietSelectAll = false;
      quietStealthCaretPos = 0;
      syncQuietCaret();
      return;
    }
    if (isStealthTypingActive) {
      isStealthSelectAll = false;
      setStealthCaretPos(0);
      syncCaretMirror();
    }
  });

  cue.on('stealth:end', () => {
    if (isQuietMode) {
      isQuietSelectAll = false;
      quietStealthCaretPos = quietInput.value.length;
      syncQuietCaret();
      return;
    }
    if (isStealthTypingActive) {
      isStealthSelectAll = false;
      setStealthCaretPos(input.value.length);
      syncCaretMirror();
    }
  });

  cue.on('stealth:submit', () => {
    if (isQuietMode) {
      isStealthTypingActive = false;
      if (quietInputBox) quietInputBox.classList.remove('stealth-active');
      isQuietSelectAll = false;
      sendQuiet();
      return;
    }
    isStealthTypingActive = false;
    composer.classList.remove('stealth-active');
    if (stealthIndicator) {
      if (isTransparencyMode) {
        stealthIndicator.classList.remove('hidden');
        const pillText = stealthIndicator.querySelector('.stealth-pill-text');
        if (pillText) pillText.textContent = 'Click-Through';
      } else {
        stealthIndicator.classList.add('hidden');
      }
    }
    isStealthSelectAll = false;
    stealthCaretPos = -1;
    updatePlaceholder();
    send();
  });

  cue.on('stealth:cancel', () => {
    if (isQuietMode) {
      isStealthTypingActive = false;
      isQuietSelectAll = false;
      if (quietInputBox) quietInputBox.classList.remove('stealth-active');
      if (quietOutputBox && !quietOutputBox.classList.contains('hidden')) {
        clearQuietOutput();
      }
      return;
    }
    if (isStealthTypingActive) {
      isStealthTypingActive = false;
      isStealthSelectAll = false;
      composer.classList.remove('stealth-active');
      if (stealthIndicator) {
        if (isTransparencyMode) {
          stealthIndicator.classList.remove('hidden');
          const pillText = stealthIndicator.querySelector('.stealth-pill-text');
          if (pillText) pillText.textContent = 'Click-Through';
        } else {
          stealthIndicator.classList.add('hidden');
        }
      }
    } else if (isTransparencyMode) {
      isTransparencyMode = false;
      document.body.classList.remove('transparency-mode');
      if (stealthIndicator) {
        stealthIndicator.classList.add('hidden');
      }
    }
    updatePlaceholder();
    syncCaretMirror();
  });

  cue.on('stealth:paste', ({ text }) => {
    if (!text) return;
    if (isQuietMode) {
      if (quietOutputBox && !quietOutputBox.classList.contains('hidden')) {
        clearQuietOutput();
      }
      if (isQuietSelectAll) {
        quietInput.value = text;
        isQuietSelectAll = false;
        quietStealthCaretPos = text.length;
      } else {
        const pos = Math.max(0, Math.min(quietInput.value.length, quietStealthCaretPos));
        quietInput.value = quietInput.value.slice(0, pos) + text + quietInput.value.slice(pos);
        quietStealthCaretPos = pos + text.length;
      }
      syncQuietInput();
      return;
    }
    if (isStealthSelectAll) {
      input.value = text;
      isStealthSelectAll = false;
      setStealthCaretPos(text.length);
    } else {
      const pos = getStealthCaretPos();
      input.value = input.value.slice(0, pos) + text + input.value.slice(pos);
      setStealthCaretPos(pos + text.length);
    }
    syncPlaceholder();
    updateSendButtonState();
    if (stealthCaretPos >= input.value.length) {
      input.scrollTop = input.scrollHeight;
    }
    if (caretMirror) caretMirror.scrollTop = input.scrollTop;
  });

  cue.on('stealth:select-all', () => {
    if (isQuietMode) {
      isQuietSelectAll = true;
      return;
    }
    if (input.value.length > 0) {
      isStealthSelectAll = true;
      syncCaretMirror();
      try { input.select(); } catch (_) {}
    }
  });

  // ---- real-time transcript display (interim + final) ----
  let interimEl = null;
  function getOrCreateInterimEl() {
    if (!interimEl) {
      interimEl = document.createElement('div');
      interimEl.className = 'interim-transcript';
      // Insert into panel-main (the left column), before the action row
      const panelMain = document.getElementById('panel-main');
      const actionRow = document.getElementById('action-row');
      if (panelMain && actionRow && actionRow.parentNode === panelMain) {
        panelMain.insertBefore(interimEl, actionRow);
      } else if (panelMain) {
        panelMain.appendChild(interimEl);
      } else {
        document.getElementById('panel').appendChild(interimEl);
      }
    }
    return interimEl;
  }
  // FIX #12: Show interim text in input box (grayed/italic) before final arrives
  let inputInterimEl = null;
  function showInterimInInput(text) {
    if (!inputInterimEl) {
      inputInterimEl = document.createElement('span');
      inputInterimEl.className = 'input-interim';
      // FIX #2: Insert into composer (not input-area) for correct positioning
      composer.appendChild(inputInterimEl);
    }
    inputInterimEl.textContent = text;
    inputInterimEl.style.display = text ? 'block' : 'none';
  }
  function clearInputInterim() {
    if (inputInterimEl) {
      inputInterimEl.textContent = '';
      inputInterimEl.style.display = 'none';
    }
  }
  
  cue.on('stt:interim', ({ channel, text }) => {
    setLiveDotState('transcribing');
    const el = getOrCreateInterimEl();
    const label = channel === 'them' ? 'Them' : 'You';
    el.textContent = `${label}: ${text}`;
    el.classList.add('show');
    appendTranscriptHistoryTurn(channel, text, true); // update sidebar interim
    
    // Stream interviewer's interim speech into interviewer pill
    if (channel === 'them' && text && text.trim().length > 1) {
      showInterviewerPillInterim(text);
    }
  });
  cue.on('stt:final', ({ channel, text }) => {
    setLiveDotState('idle');
    // Clear interim when we get a final
    if (interimEl) { interimEl.textContent = ''; interimEl.classList.remove('show'); }
    clearTranscriptInterim();
    clearInputInterim(); // FIX #12: Clear interim text from input area
    // sidebar: the final turn is added via the 'transcript' event below
  });
  cue.on('stt:status', ({ channel, status, provider }) => {
    cue.log(`[stt] ${provider || channel || 'unknown'} ${status}`);
    if (provider === 'local') {
      const localStates = {
        loading: 'loading',
        ready: 'local',
        transcribing: 'local',
        stopping: 'stopping',
        off: 'disconnected',
        error: 'error'
      };
      if (localStates[status]) setSttState(localStates[status]);
      if (status === 'loading') setSessionButton(true);
      if (status === 'off' || status === 'error') setSessionButton(false);
      if (status === 'loading' || status === 'transcribing' || status === 'stopping') setLiveDotState('transcribing');
      if (status === 'ready') setLiveDotState('idle');
      if (status === 'off') setLiveDotState('off');
      return;
    }
    if (status === 'connected') setSttState('streaming');
  });
  cue.on('vad:state', ({ channel, speaking }) => {
    setLiveDotState(speaking ? 'speaking' : 'idle');
  });
  cue.on('slides:update', ({ count, last }) => {
    if (!count) return;
    const title = last && last.caption ? last.caption.split('\n')[0].slice(0, 80) : 'Slide ' + count;
    showToast(`Slide ${count} captured · ${title}`, 3000);
  });
  cue.on('llm:start', ({ userBubble, small, category, mode, text }) => {
    if (isQuietMode) {
      setBusy(true);
      quietCurrentOutput = '';
      if (quietInputBox) quietInputBox.classList.add('hidden');
      if (quietOutputBox) quietOutputBox.classList.remove('hidden');
      if (quietOutputText) quietOutputText.innerHTML = '<span class="quiet-loading">…</span>';
      return;
    }
    let group;
    if (retryingGroup && retryingGroup.isConnected) {
      group = retryingGroup;
      retryingGroup = null;
      const sep = group.querySelector('.response-sep');
      if (sep) {
        sep.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
      if (category) {
        let pill = group.querySelector('.category-pill');
        if (!pill) {
          pill = document.createElement('div');
          pill.className = 'category-pill';
          const sepEl = group.querySelector('.response-sep');
          const userBubbleEl = group.querySelector('.user-bubble');
          const insertAfter = userBubbleEl || sepEl;
          if (insertAfter && insertAfter.nextSibling) {
            group.insertBefore(pill, insertAfter.nextSibling);
          } else {
            group.appendChild(pill);
          }
        }
        pill.textContent = category.charAt(0).toUpperCase() + category.slice(1);
      }
    } else {
      retryingGroup = null;
      responseCount++;
      if (responseCount > MAX_RESPONSES) {
        const oldest = messages.querySelector('.response-group');
        if (oldest) oldest.remove();
        responseCount = MAX_RESPONSES;
      }
      group = document.createElement('div');
      group.className = 'response-group';
      const sep = document.createElement('div');
      sep.className = 'response-sep';
      sep.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      group.appendChild(sep);
      if (userBubble) {
        const b = document.createElement('div');
        b.className = 'user-bubble';
        b.textContent = userBubble;
        group.appendChild(b);
      }
      if (category) {
        const pill = document.createElement('div');
        pill.className = 'category-pill';
        pill.textContent = category.charAt(0).toUpperCase() + category.slice(1);
        group.appendChild(pill);
      }
      messages.appendChild(group);
    }
    if (mode) group.dataset.mode = mode;
    if (text != null) group.dataset.text = text;
    group.dataset.small = small ? 'true' : 'false';

    if (!aiEl || aiEl.parentNode !== group) {
      const oldAi = group.querySelector('.ai-text');
      if (oldAi) oldAi.remove();
      aiEl = document.createElement('div');
      aiEl.className = 'ai-text' + (small ? ' small' : '');
      aiEl.dataset.raw = '';
      caretEl = document.createElement('span');
      caretEl.className = 'ai-caret';
      aiEl.appendChild(caretEl);
      group.appendChild(aiEl);
    }

    const existingActions = group.querySelector('.response-actions');
    if (existingActions) existingActions.remove();

    // Use requestAnimationFrame so the DOM is fully updated before scrolling.
    // Scroll #messages directly rather than calling sep.scrollIntoView(): that
    // scrolls *every* scrollable ancestor, and once the panel is tall enough it
    // scrolls the document too, aligning the separator to the top of the window
    // and pushing #toolbar out of view. html/body are overflow:hidden, so there
    // is no scrollbar or wheel gesture to undo it — the Stop/Hide/Quit controls
    // just never come back.
    requestAnimationFrame(() => {
      const sep = group.querySelector('.response-sep');
      if (sep && sep.isConnected) {
        messages.scrollTo({ top: sep.offsetTop - messages.offsetTop, behavior: 'smooth' });
      }
    });
    setBusy(true);
  });
  cue.on('llm:token', ({ text }) => {
    if (isQuietMode) {
      quietCurrentOutput += text;
      if (quietOutputText) quietOutputText.innerHTML = renderMarkdown(quietCurrentOutput);
      if (typeof cue.autotypeSetText === 'function') {
        cue.autotypeSetText(quietCurrentOutput);
      }
      return;
    }
    appendToken(text);
  });
  cue.on('llm:done', () => {
    finalizeAi(false);
    setBusy(false);
  });
  cue.on('llm:error', ({ message, action }) => {
    if (isQuietMode) {
      if (quietOutputText) quietOutputText.innerHTML = '<span class="quiet-error">' + esc(message) + '</span>';
      setBusy(false);
      return;
    }
    if (!aiEl) startAi(true);
    aiEl.dataset.raw = message; finalizeAi(true); setBusy(false);
    // publik errors carry one action: the renderer's markdown emits no anchors,
    // so a link needs a real button (same pattern as the mic banner).
    if (action && action.kind === 'card') { showPublikCard(); return; }
    if (action && action.kind) showStatus(message, publikActionButton(action));
  });
  cue.on('transcript', ({ channel, text }) => {
    if (!text || text.trim().length < 2 || /^[?!.,;:\-…]+$/.test(text.trim())) return;
    appendTranscriptHistoryTurn(channel, text, false);
    if (isQuietMode) return;
    // Interviewer speech streams to Interviewer Pill (never dumps into input box!)
    if (channel === 'them') {
      cancelPillSoftClear();
      accumulateInterviewerQuestion(text);
    } else {
      // User spoke — soft clear (dims pill, auto-dismisses after sustained speech)
      softClearInterviewerPill();
    }
  });
  // Transcript of a meeting resumed at launch: sidebar rows only — no
  // auto-fill of the input box, which is for live speech.
  cue.on('transcript:restore', ({ turns }) => {
    for (const t of turns || []) {
      if (!t || !t.text || t.text.trim().length < 2) continue;
      appendTranscriptHistoryTurn(t.channel, t.text, false);
    }
  });
  let statusTimer = null;
  function showStatus(message, button) {
    let el = document.getElementById('cue-status');
    if (!el) {
      el = document.createElement('div');
      el.id = 'cue-status';
      // Insert into panel-main before the action row
      const panelMain = document.getElementById('panel-main');
      const actionRow = document.getElementById('action-row');
      if (panelMain && actionRow && actionRow.parentNode === panelMain) {
        panelMain.insertBefore(el, actionRow);
      } else if (panelMain) {
        panelMain.appendChild(el);
      } else {
        document.getElementById('panel').appendChild(el);
      }
    }
    el.textContent = message;
    if (button) el.appendChild(button);
    el.classList.add('show');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => el.classList.remove('show'), button ? 30000 : 11000);
  }
  cue.on('status', ({ message }) => {
    cue.log('[status] ' + message);
    showStatus(message);
    if (sttState !== 'disconnected') {
      const lower = message.toLowerCase();
      if (lower.includes('error') || lower.includes(' off')) setSttState('error');
    }
  });

  // ---- prep status & smart tooltip helpers -------------------------------


  // ---- AI rules: live char counter + soft cap ---------------------------
  function updateAiRulesCounter() {
    const el = document.getElementById('ai-rules');
    const counter = document.getElementById('ai-rules-count');
    if (!el || !counter) return;
    const n = el.value.length;
    const cap = 2000;
    counter.textContent = String(n);
    counter.classList.toggle('over', n >= cap);
    counter.parentElement.classList.toggle('s-counter-warn', n >= cap - 100);
  }
  const aiRulesEl = document.getElementById('ai-rules');
  if (aiRulesEl) aiRulesEl.addEventListener('input', updateAiRulesCounter);
  function updateSmartTooltip() {
    if (!settings) return;
    const m = settings.models[settings.provider] || { fast: '', smart: '' };
    const fast = (m.fast || '').trim();
    const smart = (m.smart || '').trim();
    const btn = document.getElementById('smart-toggle');
    if (!btn) return;
    const same = fast.toLowerCase() === smart.toLowerCase();
    btn.classList.toggle('hidden', same);
    if (same) return;
    btn.setAttribute('aria-label', 'Fast: ' + (fast || 'fast model') + ' · Smart: ' + (smart || 'smart model') + ' (higher quality, ~2× slower)');
  }

  // ---- microphone permission banner --------------------------------------
  function showMicPermissionBanner() {
    let banner = document.getElementById('mic-perm-banner');
    if (banner) { banner.classList.add('show'); return; }
    banner = document.createElement('div');
    banner.id = 'mic-perm-banner';
    banner.className = 'show';
    banner.innerHTML =
      '<div class="mic-perm-text">' +
        '<strong>🎙️ Microphone access required</strong><br>' +
        'cue needs microphone permission to hear you during calls. Grant access in System Settings, then restart cue.' +
      '</div>' +
      '<div class="mic-perm-actions"></div>';
    const actions = banner.querySelector('.mic-perm-actions');
    if (cue.platform === 'darwin') {
      const openBtn = document.createElement('button');
      openBtn.textContent = 'Open Microphone Settings';
      openBtn.addEventListener('click', () => cue.openPane('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'));
      actions.appendChild(openBtn);
    }
    const dismissBtn = document.createElement('button');
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.className = 'dismiss';
    dismissBtn.addEventListener('click', () => banner.classList.remove('show'));
    actions.appendChild(dismissBtn);
    const panel = document.getElementById('panel');
    panel.insertBefore(banner, document.getElementById('action-row'));
  }

  // ---- settings ----------------------------------------------------------
  const scrim = $('#settings-scrim');
  function openSettings() {
    fillSettings();
    scrim.classList.remove('hidden');
    refreshWhisperModels();
    refreshSherpaModels();
  }
  // Only hide after a successful save. A second closeSettings used to shadow
  // this one and always dismiss the modal, so validation errors (and any
  // settings:set throw) vanished with the panel — keys, models, and résumé
  // looked saved and then came back empty on the next launch.
  let closingSettings = false;
  async function closeSettings() {
    if (closingSettings) return;
    closingSettings = true;
    closeAllCustomSelects();
    try {
      if (await saveSettings()) scrim.classList.add('hidden');
    } finally {
      closingSettings = false;
    }
  }
  $('#more-btn').addEventListener('click', openSettings);
  $('#tb-settings-btn').addEventListener('click', openSettings);
  $('#s-close').addEventListener('click', () => { void closeSettings(); });
  scrim.addEventListener('click', (e) => { if (e.target === scrim) void closeSettings(); });

  // Tab switching
  document.querySelectorAll('.s-tab').forEach((tab) => {
    tab.addEventListener('click', async () => {
      closeAllCustomSelects();
      if (tab.classList.contains('on')) return;
      if (!(await saveSettings())) return;
      document.querySelectorAll('.s-tab').forEach(t => t.classList.remove('on'));
      document.querySelectorAll('.s-tab-pane').forEach(p => p.classList.add('hidden'));
      tab.classList.add('on');
      const pane = document.querySelector(`.s-tab-pane[data-pane="${tab.dataset.tab}"]`);
      if (pane) pane.classList.remove('hidden');
    });
  });

  function updateCustomProviderFields() {
    const provider = settings.provider;
    document.querySelectorAll('[data-key-for]').forEach((el) => {
      el.classList.toggle('hidden', el.dataset.keyFor !== provider);
    });
    $('#custom-endpoint-settings').classList.toggle('hidden', provider !== 'custom');
    $('#publik-settings').classList.toggle('hidden', provider !== 'publik');
    const minimaxRegionSettings = $('#minimax-region-settings');
    if (minimaxRegionSettings) minimaxRegionSettings.classList.toggle('hidden', provider !== 'minimax');
    const azureEndpointSettings = $('#azure-endpoint-settings');
    if (azureEndpointSettings) azureEndpointSettings.classList.toggle('hidden', provider !== 'azure');
    renderPublikBlock();
  }

  // ---- publik API (packaged-build default) --------------------------------
  function publikActionButton(action) {
    if (!action || !action.kind) return null;
    const btn = document.createElement('button');
    if (action.kind === 'link' && action.url) {
      btn.textContent = action.label || 'Open publikhq.com';
      btn.addEventListener('click', () => cue.publikOpen(action.url));
    } else if (action.kind === 'reconnect') {
      btn.textContent = action.label || 'Reconnect';
      btn.addEventListener('click', async () => { btn.disabled = true; publikState = await cue.publikReconnect(); renderPublikBlock(); });
    } else if (action.kind === 'disclosure') {
      btn.textContent = 'Set up publik API';
      btn.addEventListener('click', () => showPublikDisclosure());
    } else if (action.kind === 'card') {
      btn.textContent = 'Show the publik API card';
      btn.addEventListener('click', () => showPublikCard());
    } else {
      return null;
    }
    return btn;
  }

  // Low starter (CONTRACT §12 / task 3): one non-blocking banner with one
  // link, once per key while it sits below the 20% line — not on every push.
  let lowStarterNoticedFor = null;
  function maybeShowLowStarter(p) {
    if (!p || !p.lowStarter) { lowStarterNoticedFor = null; return; }
    if (lowStarterNoticedFor === p.keyId) return;
    lowStarterNoticedFor = p.keyId;
    showStatus(p.lowStarter.message, publikActionButton(p.lowStarter.action));
  }

  function selectByoProvider() {
    const openaiBtn = document.querySelector('#provider-seg button[data-provider="openai"]');
    if (openaiBtn) openaiBtn.click();
    $('#key-openai').focus();
  }

  function renderPublikBlock() {
    const p = publikState;
    const block = $('#publik-settings');
    if (!block || !p || !settings) return;
    const show = (id, on) => $(id).classList.toggle('hidden', !on);
    $('#publik-cost-note').textContent = p.copy.cost;
    $('#publik-data-note').textContent = p.copy.dataPath;
    const note = $('#publik-status-note');
    note.classList.remove('warn');
    let line;
    if (p.connected && p.revoked) {
      line = 'publik API key was revoked. Reconnect to set this computer up again.'; note.classList.add('warn');
    } else if (p.connected) {
      line = `Connected · key ${p.keyId} · ${p.line || 'Ready'}`;
    } else if (p.disconnected) {
      line = 'publik API is disconnected. This computer was removed from your publik account.'; note.classList.add('warn');
    } else if (!p.disclosureAccepted) {
      line = 'Not set up yet — no account or key needed to start.';
    } else if (p.lastError) {
      line = p.lastError; note.classList.add('warn');
    } else {
      line = 'Connecting…';
    }
    note.textContent = line;
    // Low starter: the same sentence the banner used, kept on the card.
    const low = $('#publik-low-note');
    low.textContent = p.lowStarter ? p.lowStarter.message : '';
    low.classList.toggle('hidden', !p.lowStarter);
    // "Why it costs money" — the one justification sentence (CONTRACT §12).
    $('#publik-why-summary').textContent = p.copy.whyItCostsToggle;
    $('#publik-why-text').textContent = p.copy.whyItCosts;
    // The primary button (CONTRACT §12.2): "Link this computer & pick a plan"
    // while anonymous, "Pick a plan" / "Manage plan" once claimed.
    const cta = p.settingsCta;
    $('#publik-link').textContent = cta ? cta.label : '';
    show('#publik-setup', !p.connected && !p.disclosureAccepted);
    show('#publik-reconnect', p.disclosureAccepted && (!p.connected || p.revoked));
    show('#publik-link', !!cta);
    show('#publik-add-credit', p.connected && !p.revoked && p.claimState === 'claimed' && !!p.addCreditUrl);
    show('#publik-disconnect', p.connected && !p.revoked);
    if (settings.provider === 'publik') $('#s-status').textContent = statusText();
  }
  $('#publik-setup').addEventListener('click', () => showPublikDisclosure());
  $('#publik-link').addEventListener('click', () => { const cta = publikState && publikState.settingsCta; if (cta) cue.publikOpen(cta.url); });
  $('#publik-add-credit').addEventListener('click', () => cue.publikOpen(publikState && publikState.addCreditUrl));
  $('#publik-pricing').addEventListener('click', () => cue.publikOpen(publikState ? publikState.links.pricing : ''));
  $('#publik-reconnect').addEventListener('click', async () => { $('#publik-reconnect').disabled = true; try { publikState = await cue.publikReconnect(); } finally { $('#publik-reconnect').disabled = false; } renderPublikBlock(); });
  $('#publik-disconnect').addEventListener('click', async () => { publikState = await cue.publikDisconnect(); renderPublikBlock(); });
  $('#publik-byo').addEventListener('click', selectByoProvider);
  cue.on('publik:state', (state) => { publikState = state; renderPublikBlock(); maybeShowLowStarter(state); });

  function fillSettings() {
    // Keys tab
    document.querySelectorAll('#provider-seg button').forEach((b) => b.classList.toggle('on', b.dataset.provider === settings.provider));
    $('#key-cerebras').value = settings.apiKeys.cerebras || '';
    $('#key-openai').value = settings.apiKeys.openai || '';
    $('#key-anthropic').value = settings.apiKeys.anthropic || '';
    $('#key-groq').value = settings.apiKeys.groq || '';
    $('#key-custom').value = settings.apiKeys.custom || '';
    $('#base-url').value = settings.baseUrl || '';
    updateCustomProviderFields();
    $('#key-gemini').value = settings.apiKeys.gemini || '';
    $('#key-deepgram').value = settings.apiKeys.deepgram || '';
    $('#key-ollama').value = settings.apiKeys.ollama || '';
    $('#key-minimax').value = settings.apiKeys.minimax || '';
    $('#key-deepseek').value = settings.apiKeys.deepseek || '';
    document.querySelectorAll('#minimax-region-seg button').forEach((b) => b.classList.toggle('on', b.dataset.region === (settings.minimaxRegion || 'global_en')));
    $('#key-azure').value = settings.apiKeys.azure || '';
    $('#azure-endpoint').value = settings.azureEndpoint || '';
    const m = settings.models[settings.provider] || { fast: '', smart: '' };
    $('#model-fast').value = m.fast; $('#model-smart').value = m.smart;
    const modelToggle = Array.isArray(settings.modelToggle) && settings.modelToggle.length >= 4
      ? settings.modelToggle
      : ['gemini', 'groq', 'custom', 'ollama'];
    for (let i = 1; i <= 4; i++) {
      const el = $(`#model-toggle-${i}`);
      if (el) el.value = modelToggle[i - 1] || '';
    }
    fillAppLinkCallers();
    $('#s-status').textContent = statusText();
    // Transcription tab
    document.querySelectorAll('#meeting-audio-seg button').forEach((button) => {
      button.classList.toggle('on', (button.dataset.meetingAudio === 'on') === !!settings.meetingAudio);
    });
    const meetingAudioNote = $('#meeting-audio-note');
    if (meetingAudioNote) {
      meetingAudioNote.textContent = isMac
        ? 'macOS can only capture system audio through a screen-capture session. While this is on, the menu bar shows the screen-recording indicator and Control Center lists cue under \u201cCurrently Sharing\u201d \u2014 visible to everyone you screen-share with. Off by default; your microphone, screen capture and answers are unaffected.'
        : 'Transcribes the other participants alongside your microphone. This platform\u2019s loopback capture shows no recording indicator.';
    }
    document.querySelectorAll('#stt-provider-seg button').forEach((button) => {
      button.classList.toggle('on', button.dataset.sttProvider === (settings.sttProvider || 'auto'));
    });
    const isLocalStt = (settings.sttProvider || 'auto') === 'local';
    const localEngineGroup = $('#local-engine-group');
    if (localEngineGroup) localEngineGroup.classList.toggle('hidden', !isLocalStt);
    const localEngine = settings.localEngine || 'whisper';
    document.querySelectorAll('#local-engine-seg button').forEach((button) => {
      button.classList.toggle('on', button.dataset.localEngine === localEngine);
    });
    const isWhisperActive = isLocalStt && localEngine === 'whisper';
    const isSherpaActive = isLocalStt && localEngine === 'sherpa-onnx';
    const whisperCard = $('#whisper-card');
    const whisperStatus = $('#whisper-status');
    if (whisperCard) whisperCard.classList.toggle('hidden', !isWhisperActive);
    if (whisperStatus) whisperStatus.classList.toggle('hidden', !isWhisperActive);
    const sherpaCard = $('#sherpa-card');
    const sherpaStatus = $('#sherpa-status');
    if (sherpaCard) sherpaCard.classList.toggle('hidden', !isSherpaActive);
    if (sherpaStatus) sherpaStatus.classList.toggle('hidden', !isSherpaActive);

    const localWhisper = settings.localWhisper || { modelId: 'base.en', language: 'auto', threads: 0 };
    $('#whisper-language').value = localWhisper.language || 'auto';
    $('#whisper-threads').value = Number(localWhisper.threads) || 0;

    const localSherpa = settings.localSherpa || { modelId: 'parakeet-ctc-0.6b', threads: 0, provider: 'cpu' };
    const sherpaProviderEl = $('#sherpa-provider');
    if (sherpaProviderEl) sherpaProviderEl.value = localSherpa.provider || 'cpu';
    const sherpaThreadsEl = $('#sherpa-threads');
    if (sherpaThreadsEl) sherpaThreadsEl.value = Number(localSherpa.threads) || 0;
    // Slides tab (inside Transcription pane)
    const slidesCfg = settings.slides || { enabled: false, intervalMs: 3000 };
    const slidesEnabled = $('#slides-enabled');
    if (slidesEnabled) slidesEnabled.checked = !!slidesCfg.enabled;
    const slidesInterval = $('#slides-interval');
    if (slidesInterval) slidesInterval.value = slidesCfg.intervalMs || 3000;
    // Style tab
    $('#ai-rules').value = settings.aiRules || '';
    updateAiRulesCounter();
    // HR tab
    const hrQaEl = $('#hr-qa');
    if (hrQaEl) hrQaEl.value = settings.hrStories || settings.hrQa || '';
    // Appearance tab
    applyOpacity(settings.opacity, false);
  }

  // Whoever cue has been told it may answer questions for. Empty is the normal
  // state — nothing appears here until something has asked and been allowed.
  async function fillAppLinkCallers() {
    const host = $('#applink-callers');
    if (!host || !cue.appLinkState) return;
    let state;
    try { state = await cue.appLinkState(); } catch (_) { return; }
    const callers = Object.entries((state && state.callers) || {});
    if (!callers.length) {
      host.innerHTML = '<div class="s-caller-empty">Nothing has asked yet.</div>';
      return;
    }
    host.innerHTML = '';
    for (const [id, scopes] of callers) {
      const allowed = Object.entries(scopes)
        .filter(([, record]) => record && record.decision === 'granted')
        .map(([scope]) => (scope === 'action' ? 'control' : 'read'));
      const name = (scopes.read && scopes.read.callerName) || (scopes.action && scopes.action.callerName) || id;

      const row = document.createElement('div');
      row.className = 's-caller';
      const label = document.createElement('span');
      label.textContent = name + ' — ' + (allowed.length ? allowed.join(' + ') : 'denied');
      label.dataset.callerId = id;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Forget';
      button.addEventListener('click', async () => {
        await cue.appLinkRevoke(id);
        fillAppLinkCallers();
      });
      row.append(label, button);
      host.append(row);
    }
  }

  function statusText() {
    const k = settings.apiKeys;
    const labels = { publik: 'publik API', cerebras: 'Cerebras', openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini', deepgram: 'Deepgram', custom: 'Custom', ollama: 'Ollama', groq: 'Groq', minimax: 'MiniMax', deepseek: 'DeepSeek', azure: 'Azure AI Foundry' };
    const has = Object.keys(labels).filter((p) => k[p]).map((p) => labels[p]);
    const publikPart = settings.provider === 'publik' && publikState
      ? ` · ${publikState.connected ? (publikState.balanceLabel ? `balance ${publikState.balanceLabel}` : 'connected') : 'not set up'}`
      : '';
    // 'auto' walks the same fallback chain src/stt.js builds; an explicit choice
    // is reported as-is so the status line matches what will actually be used.
    const selectedSttProvider = settings.sttProvider || 'auto';
    const automaticStt = k.openai ? 'OpenAI Realtime' : (k.groq ? 'Groq Whisper' : 'none');
    let stt = selectedSttProvider === 'auto' ? automaticStt : selectedSttProvider;
    if (selectedSttProvider === 'local') {
      stt = `local (${settings.localEngine || 'whisper'})`;
    }
    return `${labels[settings.provider] || settings.provider}${publikPart} · STT: ${stt}`;
  }

  document.querySelectorAll('#provider-seg button').forEach((b) => b.addEventListener('click', () => {
    settings.provider = b.dataset.provider;
    document.querySelectorAll('#provider-seg button').forEach((x) => x.classList.toggle('on', x === b));
    updateCustomProviderFields();
    const m = settings.models[settings.provider] || { fast: '', smart: '' };
    $('#model-fast').value = m.fast; $('#model-smart').value = m.smart;
    $('#s-status').textContent = statusText();
    updateSmartTooltip();
    updateModelIndicator();
  }));
  document.querySelectorAll('#minimax-region-seg button').forEach((b) => b.addEventListener('click', () => {
    settings.minimaxRegion = b.dataset.region;
    document.querySelectorAll('#minimax-region-seg button').forEach((x) => x.classList.toggle('on', x === b));
  }));
  document.querySelectorAll('#meeting-audio-seg button').forEach((button) => button.addEventListener('click', () => {
    settings.meetingAudio = button.dataset.meetingAudio === 'on';
    document.querySelectorAll('#meeting-audio-seg button').forEach((candidate) => {
      candidate.classList.toggle('on', candidate === button);
    });
  }));

  document.querySelectorAll('#stt-provider-seg button').forEach((button) => button.addEventListener('click', () => {
    settings.sttProvider = button.dataset.sttProvider;
    document.querySelectorAll('#stt-provider-seg button').forEach((candidate) => {
      candidate.classList.toggle('on', candidate === button);
    });
    const isLocal = settings.sttProvider === 'local';
    $('#local-engine-group')?.classList.toggle('hidden', !isLocal);
    const isWhisper = isLocal && (settings.localEngine || 'whisper') === 'whisper';
    const isSherpa = isLocal && settings.localEngine === 'sherpa-onnx';
    $('#whisper-card')?.classList.toggle('hidden', !isWhisper);
    $('#whisper-status')?.classList.toggle('hidden', !isWhisper);
    $('#sherpa-card')?.classList.toggle('hidden', !isSherpa);
    $('#sherpa-status')?.classList.toggle('hidden', !isSherpa);
    $('#s-status').textContent = statusText();
  }));

  document.querySelectorAll('#local-engine-seg button').forEach((button) => button.addEventListener('click', () => {
    settings.localEngine = button.dataset.localEngine;
    document.querySelectorAll('#local-engine-seg button').forEach((candidate) => {
      candidate.classList.toggle('on', candidate === button);
    });
    const isWhisper = settings.localEngine === 'whisper';
    $('#whisper-card')?.classList.toggle('hidden', !isWhisper);
    $('#whisper-status')?.classList.toggle('hidden', !isWhisper);
    $('#sherpa-card')?.classList.toggle('hidden', isWhisper);
    $('#sherpa-status')?.classList.toggle('hidden', isWhisper);
    $('#s-status').textContent = statusText();
    if (!isWhisper) refreshSherpaModels();
  }));

  for (let i = 1; i <= 4; i++) {
    const el = $(`#model-toggle-${i}`);
    if (el) {
      el.addEventListener('change', () => {
        if (!Array.isArray(settings.modelToggle) || settings.modelToggle.length < 4) {
          settings.modelToggle = ['gemini', 'groq', 'custom', 'ollama'];
        }
        settings.modelToggle[i - 1] = el.value;
        cue.settingsSet({ modelToggle: settings.modelToggle }).catch(() => {});
      });
    }
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
    const units = ['B', 'KB', 'MB', 'GB'];
    const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / (1024 ** unitIndex);
    return `${value >= 10 || unitIndex < 2 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
  }

  function getSelectedWhisperModel() {
    if (!whisperOverview) return null;
    return whisperOverview.models.find((model) => model.id === $('#whisper-model').value) || null;
  }

  function renderWhisperModelState() {
    const model = getSelectedWhisperModel();
    if (!model) return;
    const language = model.englishOnly ? 'English only' : 'Multilingual';
    const recommendation = model.recommended ? ' · recommended default' : '';
    const partial = model.partialBytes > 0 && !model.installed
      ? ` · ${formatBytes(model.partialBytes)} ready to resume`
      : '';
    $('#whisper-model-detail').textContent = `${formatBytes(model.bytes)} · ${language} · ${model.quantization} · ${model.hardwareTier}${recommendation}${partial}`;

    const progressWrap = $('#whisper-progress-wrap');
    const progressPercent = model.bytes > 0 ? Math.floor((model.partialBytes / model.bytes) * 100) : 0;
    progressWrap.classList.toggle('hidden', !model.downloading);
    $('#whisper-progress').value = progressPercent;
    $('#whisper-progress-label').textContent = `${progressPercent}%`;
    $('#whisper-download').disabled = model.installed || model.downloading;
    $('#whisper-download').textContent = model.installed ? 'Installed' : (model.partialBytes ? 'Resume' : 'Download');
    $('#whisper-cancel').classList.toggle('hidden', !model.downloading);
    $('#whisper-import').disabled = model.downloading;
    $('#whisper-delete').disabled = (model.installedBytes === 0 && model.partialBytes === 0) || model.downloading;
  }

  async function refreshWhisperModels() {
    const status = $('#whisper-status');
    try {
      const previousSelection = $('#whisper-model').value || settings.localWhisper?.modelId || 'base.en';
      whisperOverview = await cue.whisperModels();
      const runtimeBadge = $('#whisper-runtime-status');
      runtimeBadge.classList.toggle('ready', whisperOverview.runtime.available);
      runtimeBadge.classList.toggle('error', !whisperOverview.runtime.available);
      runtimeBadge.textContent = whisperOverview.runtime.available
        ? `Ready · v${whisperOverview.runtime.version} · ${whisperOverview.runtime.target}`
        : 'Not prepared';
      if (whisperOverview.runtime.message) {
        runtimeBadge.setAttribute('aria-label', whisperOverview.runtime.message);
      }

      const select = $('#whisper-model');
      select.innerHTML = '';
      for (const model of whisperOverview.models) {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = `${model.label} — ${formatBytes(model.bytes)}${model.recommended ? ' (recommended)' : ''}${model.installed ? ' ✓' : ''}`;
        select.appendChild(option);
      }
      const selectionExists = whisperOverview.models.some((model) => model.id === previousSelection);
      select.value = selectionExists ? previousSelection : 'base.en';
      if (!settings.localWhisper) settings.localWhisper = {};
      settings.localWhisper.modelId = select.value;
      status.textContent = whisperOverview.runtime.available
        ? 'Model files are verified before they can be loaded.'
        : whisperOverview.runtime.message;
      renderWhisperModelState();
    } catch (error) {
      status.textContent = `Could not load local model information: ${error.message}`;
    }
  }

  $('#whisper-model').addEventListener('change', () => {
    if (!settings.localWhisper) settings.localWhisper = {};
    settings.localWhisper.modelId = $('#whisper-model').value;
    renderWhisperModelState();
  });

  $('#whisper-download').addEventListener('click', async () => {
    const model = getSelectedWhisperModel();
    if (!model) return;
    model.downloading = true;
    renderWhisperModelState();
    $('#whisper-status').textContent = `Downloading ${model.id}. You can cancel and resume later.`;
    try {
      await cue.whisperModelDownload(model.id);
      $('#whisper-status').textContent = `${model.id} downloaded and verified.`;
    } catch (error) {
      $('#whisper-status').textContent = error.message.includes('cancelled')
        ? `${model.id} download paused. Progress was kept.`
        : `Download failed: ${error.message}`;
    } finally {
      await refreshWhisperModels();
    }
  });

  $('#whisper-cancel').addEventListener('click', async () => {
    const model = getSelectedWhisperModel();
    if (model) await cue.whisperModelCancel(model.id);
  });

  $('#whisper-import').addEventListener('click', async () => {
    const model = getSelectedWhisperModel();
    if (!model) return;
    $('#whisper-status').textContent = `Verifying imported ${model.id}…`;
    try {
      const result = await cue.whisperModelImport(model.id);
      $('#whisper-status').textContent = result.cancelled ? 'Import cancelled.' : `${model.id} imported and verified.`;
    } catch (error) {
      $('#whisper-status').textContent = `Import failed: ${error.message}`;
    } finally {
      await refreshWhisperModels();
    }
  });

  $('#whisper-delete').addEventListener('click', async () => {
    const model = getSelectedWhisperModel();
    if (!model) return;
    const confirmed = await showConfirmDialog({
      title: 'Delete Model',
      message: `Delete the ${model.id} model (${formatBytes(model.bytes)}) from this computer?`,
      confirmText: 'Delete',
      cancelText: 'Cancel',
      danger: true
    });
    if (!confirmed) return;
    try {
      await cue.whisperModelDelete(model.id);
      $('#whisper-status').textContent = `${model.id} deleted.`;
    } catch (error) {
      $('#whisper-status').textContent = `Delete failed: ${error.message}`;
    } finally {
      await refreshWhisperModels();
    }
  });

  cue.on('whisper:download-progress', (progress) => {
    if (!whisperOverview) return;
    const model = whisperOverview.models.find((candidate) => candidate.id === progress.modelId);
    if (!model) return;
    model.partialBytes = progress.receivedBytes;
    model.downloading = true;
    if ($('#whisper-model').value === progress.modelId) {
      $('#whisper-progress-wrap').classList.remove('hidden');
      $('#whisper-progress').value = progress.percent;
      $('#whisper-progress-label').textContent = `${progress.percent}%`;
      $('#whisper-model-detail').textContent = `${formatBytes(progress.receivedBytes)} of ${formatBytes(progress.totalBytes)}`;
    }
  });
  cue.on('whisper:models-changed', () => refreshWhisperModels());

  // ---- Sherpa-ONNX (Parakeet) Model UI ----
  let sherpaOverview = null;

  function getSelectedSherpaModel() {
    if (!sherpaOverview) return null;
    return sherpaOverview.models.find((model) => model.id === $('#sherpa-model').value) || null;
  }

  function renderSherpaModelState() {
    const model = getSelectedSherpaModel();
    if (!model) return;
    const progressWrap = $('#sherpa-progress-wrap');
    progressWrap.classList.toggle('hidden', !model.downloading);
    $('#sherpa-model-detail').textContent = `${formatBytes(model.bytes)} · English · ${model.hardwareTier} · ${model.description}`;
    $('#sherpa-download').disabled = model.installed || model.downloading;
    $('#sherpa-download').textContent = model.installed ? 'Installed' : 'Download';
    $('#sherpa-cancel').classList.toggle('hidden', !model.downloading);
    $('#sherpa-import').disabled = model.downloading;
    $('#sherpa-delete').disabled = !model.installed || model.downloading;
  }

  async function refreshSherpaModels() {
    const status = $('#sherpa-status');
    if (!status || !cue.sherpaModels) return;
    try {
      const previousSelection = $('#sherpa-model').value || settings.localSherpa?.modelId || 'parakeet-ctc-0.6b';
      sherpaOverview = await cue.sherpaModels();
      const runtimeBadge = $('#sherpa-runtime-status');
      if (runtimeBadge) {
        runtimeBadge.classList.toggle('ready', sherpaOverview.runtime.available);
        runtimeBadge.classList.toggle('error', !sherpaOverview.runtime.available);
        runtimeBadge.textContent = sherpaOverview.runtime.available
          ? `Ready · v${sherpaOverview.runtime.version} · ${sherpaOverview.runtime.target}`
          : 'Not prepared';
        if (sherpaOverview.runtime.message) {
          runtimeBadge.setAttribute('aria-label', sherpaOverview.runtime.message);
        }
      }

      const select = $('#sherpa-model');
      if (select) {
        select.innerHTML = '';
        for (const model of sherpaOverview.models) {
          const option = document.createElement('option');
          option.value = model.id;
          option.textContent = `${model.name} — ${formatBytes(model.bytes)}${model.installed ? ' ✓' : ''}`;
          select.appendChild(option);
        }
        const selectionExists = sherpaOverview.models.some((model) => model.id === previousSelection);
        select.value = selectionExists ? previousSelection : 'parakeet-ctc-0.6b';
        if (!settings.localSherpa) settings.localSherpa = {};
        settings.localSherpa.modelId = select.value;
      }
      status.textContent = sherpaOverview.runtime.available
        ? 'Sherpa-ONNX is ready with local Parakeet models.'
        : sherpaOverview.runtime.message;
      renderSherpaModelState();
    } catch (error) {
      status.textContent = `Could not load Sherpa model information: ${error.message}`;
    }
  }

  $('#sherpa-model').addEventListener('change', () => {
    if (!settings.localSherpa) settings.localSherpa = {};
    settings.localSherpa.modelId = $('#sherpa-model').value;
    renderSherpaModelState();
  });

  $('#sherpa-download').addEventListener('click', async () => {
    const model = getSelectedSherpaModel();
    if (!model) return;
    model.downloading = true;
    renderSherpaModelState();
    $('#sherpa-status').textContent = `Downloading ${model.id}…`;
    try {
      await cue.sherpaModelDownload(model.id);
      $('#sherpa-status').textContent = `${model.id} downloaded and ready.`;
    } catch (error) {
      $('#sherpa-status').textContent = `Download failed: ${error.message}`;
    } finally {
      await refreshSherpaModels();
    }
  });

  $('#sherpa-cancel').addEventListener('click', async () => {
    const model = getSelectedSherpaModel();
    if (model) await cue.sherpaModelCancel(model.id);
  });

  $('#sherpa-import').addEventListener('click', async () => {
    const model = getSelectedSherpaModel();
    if (!model) return;
    $('#sherpa-status').textContent = `Verifying imported ${model.id}…`;
    try {
      const result = await cue.sherpaModelImport(model.id);
      $('#sherpa-status').textContent = result.cancelled ? 'Import cancelled.' : `${model.id} imported and verified.`;
    } catch (error) {
      $('#sherpa-status').textContent = `Import failed: ${error.message}`;
    } finally {
      await refreshSherpaModels();
    }
  });

  $('#sherpa-delete').addEventListener('click', async () => {
    const model = getSelectedSherpaModel();
    if (!model) return;
    const confirmed = await showConfirmDialog({
      title: 'Delete Model',
      message: `Delete the ${model.name} (${formatBytes(model.bytes)}) from this computer?`,
      confirmText: 'Delete',
      cancelText: 'Cancel',
      danger: true
    });
    if (!confirmed) return;
    try {
      await cue.sherpaModelDelete(model.id);
      $('#sherpa-status').textContent = `${model.id} deleted.`;
    } catch (error) {
      $('#sherpa-status').textContent = `Delete failed: ${error.message}`;
    } finally {
      await refreshSherpaModels();
    }
  });

  cue.on('sherpa:download-progress', (progress) => {
    if (!sherpaOverview) return;
    const model = sherpaOverview.models.find((candidate) => candidate.id === progress.modelId);
    if (!model) return;
    model.downloading = true;
    if ($('#sherpa-model').value === progress.modelId) {
      $('#sherpa-progress-wrap').classList.remove('hidden');
      $('#sherpa-progress').value = progress.percent || 0;
      $('#sherpa-progress-label').textContent = `${progress.percent || 0}%`;
      if (progress.receivedBytes && progress.totalBytes) {
        $('#sherpa-model-detail').textContent = `${formatBytes(progress.receivedBytes)} of ${formatBytes(progress.totalBytes)}`;
      }
    }
  });
  cue.on('sherpa:models-changed', () => refreshSherpaModels());

  async function saveSettings() {
    // Keys
    settings.apiKeys.cerebras = $('#key-cerebras').value.trim();
    settings.apiKeys.openai = $('#key-openai').value.trim();
    settings.apiKeys.anthropic = $('#key-anthropic').value.trim();
    settings.apiKeys.groq = $('#key-groq').value.trim();
    settings.apiKeys.custom = $('#key-custom').value.trim();
    settings.baseUrl = $('#base-url').value.trim();
    settings.apiKeys.gemini = $('#key-gemini').value.trim();
    settings.apiKeys.deepgram = $('#key-deepgram').value.trim();
    settings.apiKeys.ollama = $('#key-ollama').value.trim();
    settings.apiKeys.minimax = $('#key-minimax').value.trim();
    settings.apiKeys.deepseek = $('#key-deepseek').value.trim();
    settings.apiKeys.azure = $('#key-azure').value.trim();
    settings.azureEndpoint = $('#azure-endpoint').value.trim();
    if (!settings.models[settings.provider]) settings.models[settings.provider] = {};
    settings.models[settings.provider].fast = $('#model-fast').value.trim();
    settings.models[settings.provider].smart = $('#model-smart').value.trim();
    if (!Array.isArray(settings.modelToggle) || settings.modelToggle.length < 4) {
      settings.modelToggle = ['gemini', 'groq', 'custom', 'ollama'];
    }
    for (let i = 1; i <= 4; i++) {
      const el = $(`#model-toggle-${i}`);
      if (el) settings.modelToggle[i - 1] = el.value || settings.modelToggle[i - 1];
    }
    // If the active provider still has no key, but the user just filled in a
    // key for a different provider (without touching the Provider selector —
    // the flow both bug reports describe), switch to that provider. Without
    // this, `settings.provider` stays on its default ('openai') forever and
    // cue keeps reporting itself unconfigured even though a valid key was
    // saved for the provider the user actually meant to use.
    if (!settings.apiKeys[settings.provider]) {
      const keyedProviders = ['cerebras', 'openai', 'anthropic', 'gemini', 'groq', 'minimax', 'deepseek', 'azure'];
      const justFilled = keyedProviders.find((p) => settings.apiKeys[p]);
      if (justFilled) settings.provider = justFilled;
    }
    // Transcription
    if (!settings.localWhisper) settings.localWhisper = {};
    settings.localWhisper.modelId = $('#whisper-model').value || settings.localWhisper.modelId || 'base.en';
    settings.localWhisper.language = $('#whisper-language').value || 'auto';
    settings.localWhisper.threads = Math.max(0, Math.min(64, Number.parseInt($('#whisper-threads').value, 10) || 0));

    settings.localEngine = $('#local-engine-seg button.on')?.dataset.localEngine || settings.localEngine || 'whisper';
    if (!settings.localSherpa) settings.localSherpa = {};
    const sherpaModelEl = $('#sherpa-model');
    if (sherpaModelEl) settings.localSherpa.modelId = sherpaModelEl.value || settings.localSherpa.modelId || 'parakeet-ctc-0.6b';
    const sherpaProvEl = $('#sherpa-provider');
    if (sherpaProvEl) settings.localSherpa.provider = sherpaProvEl.value || 'cpu';
    const sherpaThrEl = $('#sherpa-threads');
    if (sherpaThrEl) settings.localSherpa.threads = Math.max(0, Math.min(64, Number.parseInt(sherpaThrEl.value, 10) || 0));
    // Slides (opt-in, memory-only)
    if (!settings.slides) settings.slides = {};
    const slidesEnabledEl = $('#slides-enabled');
    const slidesIntervalEl = $('#slides-interval');
    if (slidesEnabledEl) settings.slides.enabled = !!slidesEnabledEl.checked;
    if (slidesIntervalEl) {
      const v = Number.parseInt(slidesIntervalEl.value, 10) || 3000;
      settings.slides.intervalMs = Math.max(1500, Math.min(15000, v));
    }
    // Style tab
    settings.aiRules = $('#ai-rules').value.trim();
    // HR tab
    const hrQaEl = $('#hr-qa');
    if (hrQaEl) {
      settings.hrStories = hrQaEl.value.trim();
      settings.hrQa = settings.hrStories;
    }
    // Appearance tab
    const opacitySlider = $('#s-opacity-slider');
    if (opacitySlider) settings.opacity = clampOpacity(Number(opacitySlider.value) / 100);
    try {
      settings = await cue.settingsSet(settings);
      $('#s-status').textContent = statusText();
      updateSmartTooltip();
      updateModelIndicator();
      return true;
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      $('#s-status').textContent = message;
      $('#base-url').focus();
      return false;
    }
  }

  // ---- example conversation (matches the reference screenshot) ------------
  function showExample() {
    clearMessages();
    const group = document.createElement('div');
    group.className = 'response-group';
    group.dataset.mode = 'say';
    group.dataset.text = '';
    const b = document.createElement('div');
    b.className = 'user-bubble';
    b.textContent = 'What should I say?';
    group.appendChild(b);
    const ai = document.createElement('div');
    ai.className = 'ai-text';
    const sampleText = '“A discounted cash flow model values a company by projecting future free cash flows and discounting them to present value using the weighted average cost of capital.”';
    ai.textContent = sampleText;
    ai.dataset.raw = sampleText;
    group.appendChild(ai);
    const actions = createResponseActions(group, sampleText, false);
    group.appendChild(actions);
    messages.appendChild(group);
  }

  // ---- global keys -------------------------------------------------------
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (isQuietMode && quietOutputBox && !quietOutputBox.classList.contains('hidden')) {
        e.preventDefault();
        clearQuietOutput();
        return;
      }
    }
    if (e.key === 'Escape' && !scrim.classList.contains('hidden')) void closeSettings();
    if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); openSettings(); }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && document.activeElement !== input && !e.altKey && !e.ctrlKey && !e.metaKey) {
      if (isQuietMode) {
        if (quietOutputBox && !quietOutputBox.classList.contains('hidden')) {
          e.preventDefault();
          quietOutputBox.scrollBy({ top: e.key === 'ArrowUp' ? -60 : 60, behavior: 'smooth' });
        }
        return;
      }
      if (messages) {
        e.preventDefault();
        doArrowScroll(e.key === 'ArrowUp' ? -1 : 1);
      }
    }
  });

  // Safety net for the same class of bug: html/body are overflow:hidden, so any
  // stray programmatic scroll of the document is invisible to the user and
  // unrecoverable by mouse. Snap it back so the toolbar cannot be stranded.
  window.addEventListener('scroll', () => {
    if (window.scrollY || window.scrollX) window.scrollTo(0, 0);
  }, { passive: true });

  // Dynamically synchronize --main-w with window width so all buttons are accommodated
  function syncWindowWidth() {
    const sideW = 300;
    const dynamicMainW = Math.max(700, window.innerWidth - (sideW * 2));
    document.documentElement.style.setProperty('--main-w', `${dynamicMainW}px`);
  }
  window.addEventListener('resize', syncWindowWidth);
  syncWindowWidth();

  // ---- click-through: only the UI blocks the mouse; empty gaps pass to your screen ----
  let ignoring = null;
  let draggingWindow = false;
  function setIgnore(v) { if (v !== ignoring) { ignoring = v; cue.setIgnoreMouse(v); } }
  document.addEventListener('mousemove', (e) => {
    if (isTransparencyMode) return; // Completely transparent to mouse hits in transparency mode
    // The window trails the cursor while dragging; going click-through then would drop the release.
    if (draggingWindow) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const overUI = !!(el && el.closest && el.closest('#toolbar, #panel-wrap, #transcript-sidebar, #settings-scrim, #onboard-scrim, #consent-scrim, #confirm-scrim, .custom-select-menu, #quiet-container'));
    setIgnore(!overUI);
  });
  setIgnore(true); // start fully click-through; hovering the panel re-enables it

  // ---- window drag: press anywhere on the toolbar that isn't a control ----
  const toolbar = $('#toolbar');
  toolbar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button, input, .tb-opacity-wrap')) return;
    e.preventDefault();
    toolbar.setPointerCapture(e.pointerId);
    draggingWindow = true;
    setIgnore(false);
    toolbar.classList.add('dragging');
    cue.windowDragStart();
  });
  // Fires on release, cancel, or anything else that ends the press.
  toolbar.addEventListener('lostpointercapture', () => {
    if (!draggingWindow) return;
    draggingWindow = false;
    toolbar.classList.remove('dragging');
    cue.windowDragEnd();
  });

  if (quietContainer) {
    quietContainer.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('textarea, a, button')) return;
      e.preventDefault();
      quietContainer.setPointerCapture(e.pointerId);
      draggingWindow = true;
      setIgnore(false);
      cue.windowDragStart();
    });
    quietContainer.addEventListener('lostpointercapture', () => {
      if (!draggingWindow) return;
      draggingWindow = false;
      cue.windowDragEnd();
    });
  }

  // ---- assistant access request ------------------------------------------
  // Shown here rather than as a native dialog because cue hides its dock icon:
  // an OS panel from an accessory app never comes forward and cannot be
  // clicked. Note the scrim is registered in the click-through selector above
  // and in styles.css — without both, this window stays transparent to the
  // mouse and the buttons do nothing.
  const consentScrim = $('#consent-scrim');
  let pendingConsentId = null;

  function answerConsent(allowed) {
    if (!pendingConsentId) return;
    cue.appLinkConsentRespond(pendingConsentId, allowed);
    pendingConsentId = null;
    consentScrim.classList.add('hidden');
  }

  cue.on('applink:consent-request', (request) => {
    pendingConsentId = request.id;
    $('#cs-title').textContent = request.message;
    $('#cs-body').textContent = request.detail;
    $('#cs-allow').textContent = request.allowLabel;
    consentScrim.classList.remove('hidden');
    // Do not wait for a mousemove to turn the mouse back on: the pointer may
    // already be still, and the sheet would be unclickable until it moved.
    setIgnore(false);
    $('#cs-deny').focus();
  });

  $('#cs-allow').addEventListener('click', () => answerConsent(true));
  $('#cs-deny').addEventListener('click', () => answerConsent(false));
  // Anything other than a deliberate Allow is a no, including Escape and
  // clicking away.
  consentScrim.addEventListener('click', (e) => { if (e.target === consentScrim) answerConsent(false); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pendingConsentId) { e.preventDefault(); answerConsent(false); }
  });

  // ---- onboarding / first-run tutorial -----------------------------------
  const obScrim = $('#onboard-scrim');
  const permissionHelp = isWindows
    ? 'cue needs permission to see and hear. Open Windows Privacy & security settings, allow <strong>Microphone</strong> and <strong>Screen recording</strong> for cue, then come back here.'
    : 'cue needs two macOS permissions. Click each button, turn <strong>cue</strong> ON in the window that opens, then come back here.';
  const permissionButtons = isWindows
    ? [
        { label: 'Open Microphone settings', action: () => cue.openPane('ms-settings:privacy-microphone') },
        { label: 'Open Screen recording settings', action: () => cue.openPane('ms-settings:privacy-screenrecorder') }
      ]
    : [
        { label: 'Open Microphone settings', action: () => cue.openPane('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone') },
        { label: 'Open Screen Recording settings', action: () => cue.openPane('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture') }
      ];
  const assistShortcut = isWindows ? '<span class="kbd">Ctrl</span><span class="kbd">⇧</span><span class="kbd">↵</span>' : '<span class="kbd">⌘</span><span class="kbd">⇧</span><span class="kbd">↵</span>';
  const sayShortcut = isWindows ? '<span class="kbd">Ctrl</span> <span class="kbd">↵</span>' : '<span class="kbd">⌘</span> <span class="kbd">↵</span>';
  const quitShortcut = isWindows ? '<span class="kbd">Ctrl</span><span class="kbd">⇧</span><span class="kbd">X</span>' : '<span class="kbd">⌘</span><span class="kbd">⇧</span><span class="kbd">X</span>';
  const OB_STEPS = [
    {
      icon: '👋',
      title: 'Welcome to cue',
      body: 'cue is a private AI copilot that floats over your screen. It can see your screen, hear your meetings, and help you answer questions – while staying hidden from screen shares.'
    },
    {
      icon: '🔐',
      title: 'Allow cue to see & hear',
      body: permissionHelp + '<ul><li><strong>Microphone</strong> – to hear you</li><li><strong>Screen recording</strong> – to see your screen and hear your meeting</li></ul>',
      buttons: permissionButtons
    },
    {
      icon: '⚙️',
      title: 'Connect an AI provider',
      body: 'cue uses API keys for <span class="hl">Cerebras API</span> and options to enable real-time transcription via a local or hosted transcription model.',
      buttons: [{ label: 'Configure cue settings', action: () => { finishOnboard(); openSettings(); } }]
    },
    {
      icon: '✨',
      title: 'You’re all set',
      body: 'How to use cue:<ul><li>' + sayShortcut + ' — <strong>What should I say?</strong> from the conversation</li><li>' + assistShortcut + ' — <strong>Smart assist</strong> with whatever\'s on screen or being said</li><li>Click <strong>Start session</strong> in the top bar to start listening to a meeting</li><li>Type a question and press <span class="kbd">↵</span></li></ul>Reopen this guide anytime by clicking the <strong>help</strong> icon in the top bar. Quit with ' + quitShortcut + '.'
    }
  ];
  // First-run disclosure (R21 §4.3): two disclosures — cost and data path —
  // and a visible "use my own key" branch. Copy comes from main (one source).
  // Only "Continue" mints a key; Next/Skip never provision.
  function publikStep() {
    const c = publikState.copy.disclosure;
    return {
      icon: '🪙',
      title: c.title,
      body: () => `${esc(c.intro)}<br><br><strong>Cost.</strong> ${esc(c.cost)}<br><br><strong>Where your prompts go.</strong> ${esc(c.dataPath)}` +
        `<span class="ob-fine">${esc(c.terms)} <a id="ob-publik-terms">publik API terms</a></span>`,
      buttons: [
        { label: c.accept, action: async () => {
          const btns = $('#ob-buttons').querySelectorAll('button'); btns.forEach((b) => { b.disabled = true; });
          publikState = await cue.publikAcceptDisclosure(); settings.provider = 'publik'; renderPublikBlock();
          // CONTRACT §12.1: the card comes right after POST /installs succeeds,
          // with the real balance on it. Nothing is spent before it is seen.
          if (publikState.card) { showPublikCard(); return; }
          if (obDialog) { hideOnboardDialog(); } else { obIndex++; renderOnboard(); }
        } },
        { label: c.decline, action: () => { if (obDialog) hideOnboardDialog(); else finishOnboard(); openSettings(); selectByoProvider(); } }
      ]
    };
  }
  // The first-run card (CONTRACT §12.1), in this order: (a) the balance line
  // from the mint response, (b) the one-sentence justification, (c) the
  // primary button that opens claim_url — and "Later", which keeps the free
  // starter. Everything is painted from publikState.card (src/publik.js
  // ctaView), so the copy has one source and the link rule is tested there.
  function publikCardStep() {
    const card = publikState.card;
    const done = async () => {
      publikState = await cue.publikCardSeen(); renderPublikBlock();
      const idx = OB_STEPS.findIndex((st) => st.publikCard);
      if (idx >= 0) OB_STEPS.splice(idx, 1);
      if (obDialog) { hideOnboardDialog(); return; }
      if (obIndex >= OB_STEPS.length) finishOnboard(); else renderOnboard();
    };
    const buttons = [];
    if (card.primary) {
      buttons.push({ label: card.primary.label, primary: true, action: async () => { cue.publikOpen(card.primary.url); await done(); } });
    }
    buttons.push({ label: card.secondary.label, action: done });
    return {
      icon: '✅',
      title: card.title,
      body: () => `<div class="publik-card-balance">${esc(card.balance)}</div><div class="publik-card-why">${esc(card.why)}</div>`,
      buttons,
      publikCard: true
    };
  }
  function esc(text) { const d = document.createElement('div'); d.textContent = text; return d.innerHTML; }
  let obDialog = false; // true while the publik card is shown alone, after onboarding
  function showPublikDisclosure() {
    if (!publikState || !publikState.available) return;
    const idx = OB_STEPS.findIndex((st) => st.publik);
    if (idx < 0) return;
    obDialog = true;
    $('#onboard').classList.add('dialog');
    obIndex = idx; renderOnboard();
    obScrim.classList.remove('hidden'); setIgnore(false);
  }
  // Show the card: inside onboarding it becomes the next step; afterwards it
  // is a dialog of its own (also reached from the "never a silent starter"
  // gate in main.js runFeature).
  function showPublikCard() {
    if (!publikState || !publikState.card) return;
    const existing = OB_STEPS.findIndex((st) => st.publikCard);
    if (existing >= 0) OB_STEPS.splice(existing, 1);
    const inOnboarding = !obScrim.classList.contains('hidden') && !obDialog;
    if (inOnboarding) {
      const idx = OB_STEPS.findIndex((st) => st.publik);
      OB_STEPS.splice(idx + 1, 0, publikCardStep());
      obIndex = idx + 1; renderOnboard();
      return;
    }
    OB_STEPS.push(publikCardStep());
    obDialog = true;
    $('#onboard').classList.add('dialog');
    obIndex = OB_STEPS.length - 1; renderOnboard();
    obScrim.classList.remove('hidden'); setIgnore(false);
  }
  function hideOnboardDialog() { obDialog = false; $('#onboard').classList.remove('dialog'); obScrim.classList.add('hidden'); }

  let obIndex = 0;
  function renderOnboard() {
    const step = OB_STEPS[obIndex];
    $('#ob-icon').textContent = step.icon;
    $('#ob-title').textContent = step.title;
    $('#ob-body').innerHTML = typeof step.body === 'function' ? step.body() : step.body;
    const termsLink = $('#ob-publik-terms');
    if (termsLink) termsLink.addEventListener('click', () => cue.publikOpen(publikState.links.terms));
    const btns = $('#ob-buttons'); btns.innerHTML = '';
    (step.buttons || []).forEach((b) => { const el = document.createElement('button'); el.textContent = b.label; if (b.primary) el.classList.add('ob-cta'); el.addEventListener('click', b.action); btns.appendChild(el); });
    // The publik card has its own two buttons and no Next/Skip: leaving it any
    // other way would spend the starter without the card being acknowledged.
    $('#onboard').classList.toggle('card', !!step.publikCard);
    const dots = $('#ob-dots'); dots.innerHTML = '';
    OB_STEPS.forEach((_, i) => { const d = document.createElement('span'); if (i === obIndex) d.className = 'on'; dots.appendChild(d); });
    $('#ob-back').style.visibility = obIndex === 0 ? 'hidden' : 'visible';
    $('#ob-next').textContent = obIndex === OB_STEPS.length - 1 ? 'Done' : 'Next';
    $('#ob-skip').style.visibility = obIndex === OB_STEPS.length - 1 ? 'hidden' : 'visible';
  }
  function showOnboard() { obDialog = false; $('#onboard').classList.remove('dialog'); obIndex = 0; renderOnboard(); obScrim.classList.remove('hidden'); setIgnore(false); }
  async function finishOnboard() {
    if (obDialog) { hideOnboardDialog(); return; }
    obScrim.classList.add('hidden');
    if (settings && !settings.onboarded) { settings.onboarded = true; await cue.settingsSet({ onboarded: true }); }
  }
  $('#ob-next').addEventListener('click', () => { if (obIndex === OB_STEPS.length - 1) finishOnboard(); else { obIndex++; renderOnboard(); } });
  $('#ob-back').addEventListener('click', () => { if (obIndex > 0) { obIndex--; renderOnboard(); } });
  $('#ob-skip').addEventListener('click', finishOnboard);
  $('#logo-btn').addEventListener('click', showOnboard);

  // ---- boot --------------------------------------------------------------
  (async function boot() {
    settings = await cue.settingsGet();
    const platformInfo = await cue.platformInfo();
    publikState = await cue.publikState();
    // A build with no app token never shows the option, and keeps the BYO
    // onboarding card. With one, the "Connect an AI provider" card becomes the
    // publik disclosure; the BYO branch stays one tap away on that card.
    if (publikState.available) OB_STEPS.splice(2, 1, { ...publikStep(), publik: true });

    // R4: shortcut hints
    const sayHintEl = document.getElementById('say-shortcut-hint');
    const assistHintEl = document.getElementById('assist-shortcut-hint');
    const prev4HintEl = document.getElementById('prev4-shortcut-hint');
    const historyHintEl = document.getElementById('history-shortcut-hint');
    if (sayHintEl) sayHintEl.textContent = isWindows ? 'Ctrl+↵' : '⌘↵';
    if (assistHintEl) assistHintEl.textContent = isWindows ? 'Ctrl+Shift+↵' : '⌘⇧↵';
    if (prev4HintEl) prev4HintEl.textContent = isWindows ? 'Alt+B' : '⌥B';
    if (historyHintEl) historyHintEl.textContent = isWindows ? 'Alt+N' : '⌥N';
    const smartHintEl = document.getElementById('smart-shortcut-hint');
    if (smartHintEl) smartHintEl.textContent = isWindows ? 'Alt+S' : '⌥S';
    const recapHintEl = document.getElementById('recap-shortcut-hint');
    if (recapHintEl) recapHintEl.textContent = isWindows ? 'Alt+Q' : '⌥Q';
    const hideHintEl = document.getElementById('hide-shortcut-hint');
    if (hideHintEl) hideHintEl.textContent = isWindows ? 'Alt+H' : '⌥H';
    const stopHintEl = document.getElementById('stop-shortcut-hint');
    if (stopHintEl) stopHintEl.textContent = isWindows ? 'Alt+Y' : '⌥Y';
    const sayBtn = document.querySelector('.act[data-mode="say"]');
    const assistBtn = document.querySelector('.act[data-mode="assist"]');
    const recapBtn = document.querySelector('.act[data-mode="recap"]');
    const prev4Btn = document.querySelector('.act[data-mode="previous4"]');
    const hrBtn = document.querySelector('.act[data-mode="hr"]');
    const hrHintEl = document.getElementById('hr-shortcut-hint');
    if (hrHintEl) hrHintEl.textContent = isWindows ? 'Alt+G' : '⌥G';
    const leetcodeBtn = document.querySelector('.act[data-mode="leetcode"]');
    const leetcodeHintEl = document.getElementById('leetcode-shortcut-hint');
    if (leetcodeHintEl) leetcodeHintEl.textContent = isWindows ? 'Ctrl+H' : '⌘H';
    const hideBtn = document.getElementById('hide-btn');
    const historyBtnEl = document.getElementById('history-btn');
    if (sayBtn) sayBtn.setAttribute('aria-label', isWindows
      ? 'Suggests what to say next based on the conversation (Ctrl+Enter)'
      : 'Suggests what to say next based on the conversation (⌘↵)');
    if (assistBtn) assistBtn.setAttribute('aria-label', isWindows
      ? 'Scans your screen and conversation to decide what you need (Ctrl+Shift+Enter)'
      : 'Scans your screen and conversation to decide what you need (⌘⇧↵)');
    if (recapBtn) recapBtn.setAttribute('aria-label', isWindows
      ? 'Recap (Alt+Q)'
      : 'Recap (⌥Q)');
    if (hideBtn) hideBtn.setAttribute('aria-label', isWindows
      ? 'Hide (Alt+H)'
      : 'Hide (⌥H)');
    if (prev4Btn) prev4Btn.setAttribute('aria-label', isWindows
      ? 'Explain terms from the last 4 messages with priority on newest (Alt+B)'
      : 'Explain terms from the last 4 messages with priority on newest (⌥B)');
    if (hrBtn) hrBtn.setAttribute('aria-label', isWindows
      ? 'Answer HR question with prepared stories (Alt+G)'
      : 'Answer HR question with prepared stories (⌥G)');
    if (leetcodeBtn) leetcodeBtn.setAttribute('aria-label', isWindows
      ? 'Solve LeetCode problem from screen (Ctrl+H)'
      : 'Solve LeetCode problem from screen (⌘H)');
    if (historyBtnEl) historyBtnEl.setAttribute('aria-label', isWindows
      ? 'Transcription history (Alt+N)'
      : 'Transcription history (⌥N)');

    // R6: smart tooltip
    updateSmartTooltip();
    updateModelIndicator();
    // Fix 3: Adjust permission buttons based on actual Windows version.
    // ms-settings:privacy-screenrecorder only exists on Windows 11.
    // On Windows 10, screen capture needs no permission — so replace the button
    // with a more helpful note instead of an invalid settings link.
    if (isWindows && platformInfo.winBuild > 0 && platformInfo.winBuild < 22000) {
      // Windows 10: update the onboarding screen recording button to be more helpful
      const ob = OB_STEPS[1];
      ob.buttons = ob.buttons.filter((b) => !b.label.toLowerCase().includes('screen'));
      ob.body = 'cue needs microphone permission to hear you. Click the button below to open Windows microphone settings and allow cue.<br><br><strong>Screen capture works automatically on Windows 10</strong> — no additional permission needed.<ul><li><strong>Microphone</strong> — to hear you</li><li><strong>Screen recording</strong> — works automatically on Windows 10</li></ul>';
    }

    smartBtn.classList.toggle('on', !!settings.smart);
    showExample();
    syncPlaceholder();
    updateSendButtonState(); // Initialize send button state

    // Initialize no-focus mode state and placeholder
    try {
      const initialNoFocus = typeof cue.nofocusGet === 'function' ? await cue.nofocusGet() : true;
      setNoFocusUI(initialNoFocus);
    } catch (_) {
      setNoFocusUI(true);
    }

    applyOpacity(settings.opacity, false);

    const st = await cue.captureState();
    $('#live-dot').classList.toggle('off', !st.active);
    setSessionButton(st.active);
    if (!settings.onboarded) showOnboard();
  })();
})();

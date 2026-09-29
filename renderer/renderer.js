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
    btn.classList.toggle('active', active);
    if (ic) ic.innerHTML = active
      ? icon('square', { size: 14 })
      : icon('play', { size: 14, filled: false });
    if (label) label.textContent = active ? 'End session' : 'Start session';
    const title = active ? 'End session' : 'Start session';
    btn.setAttribute('aria-label', title);
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

  function clearMessages() { messages.innerHTML = ''; aiEl = null; caretEl = null; }

  function addUserBubble(text) {
    const b = document.createElement('div');
    b.className = 'user-bubble';
    b.textContent = text;
    messages.appendChild(b);
  }

  function startAi(small) {
    aiEl = document.createElement('div');
    aiEl.className = 'ai-text' + (small ? ' small' : '');
    aiEl.dataset.raw = '';
    caretEl = document.createElement('span');
    caretEl.className = 'ai-caret';
    aiEl.appendChild(caretEl);
    messages.appendChild(aiEl);
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

  function finalizeAi() {
    if (!aiEl) return;
    const raw = aiEl.dataset.raw || '';
    aiEl.innerHTML = renderMarkdown(raw);
    aiEl = null; caretEl = null;
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
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      document.getElementById('panel-wrap').appendChild(el);
    }
    // Clear any pending timers to prevent overlap
    clearTimeout(toastTimer);
    clearTimeout(toastFadeTimer);
    // Immediately update content (no stacking)
    el.textContent = message;
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
    btn.addEventListener('click', () => runMode(btn.dataset.mode, ''));
  });

  const input = $('#input');
  const placeholder = $('#placeholder');
  const composer = $('#composer');

  // ========== NO-FOCUS (STEALTH) MODE ==========
  let isNoFocusMode = false;
  let temporaryFocusActive = false;
  let isStealthTypingActive = false;

  function updatePlaceholder() {
    const altKey = isWindows ? 'Alt' : '⌥';
    const ctrlKey = isWindows ? 'Ctrl' : '⌘';
    if (isStealthTypingActive) {
      placeholder.innerHTML = `<span style="color:#86efac;font-weight:600">⚡ Stealth typing active</span> · Enter sends · Esc/${altKey}+C exits`;
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

  // ========== SMART AUTO-FILL SYSTEM ==========
  // Track whether the current input text came from STT auto-fill (Them channel)
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
  // FIX #8: Batch class updates to avoid flicker
  function updateQuestionReadyState() {
    const text = input.value;
    const confidence = getQuestionConfidence(text);
    
    // Batch the class changes to minimize repaints
    const shouldBeReady = confidence === 'high' || confidence === 'medium';
    const shouldBeAccumulating = confidence === 'accumulating';
    
    // Only update if state actually changed
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
    
    updateSendButtonState(); // FIX #9: Keep send button in sync
  }
  
  // FIX #9: Send button visual "ready" state
  function updateSendButtonState() {
    const sendBtn = document.getElementById('send-btn');
    if (!sendBtn) return;
    
    const hasText = input.value.trim().length > 0;
    const isReady = composer.classList.contains('stt-ready');
    
    sendBtn.classList.toggle('ready', hasText && isReady);
    sendBtn.classList.toggle('has-text', hasText);
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

  // ---- Restore last question from history (Ctrl+Z) ----
  function restoreLastQuestion() {
    const last = questionHistory.pop();
    if (last) {
      input.value = last.text;
      inputFromSTT = true;
      lastSTTValue = last.text; // FIX #8: Track restored value for edit detection
      composer.classList.add('stt-filling');
      updateQuestionReadyState();
      syncPlaceholder();
      showToast('Question restored', 1500);
      return true;
    }
    showToast('No question to restore', 1500);
    return false;
  }

  // ---- Auto-fill the input box with transcribed speech from interviewer ----
  function autoFillInputFromSTT(text) {
    // If user has manually typed something different, don't overwrite
    if (!inputFromSTT && input.value.trim().length > 0) return;

    // Cancel any pending soft-clear (interviewer is still talking)
    clearTimeout(softClearTimer);
    composer.classList.remove('stt-dimmed');

    const current = input.value.trim();
    const newText = current ? current + ' ' + text : text;
    input.value = newText;
    inputFromSTT = true;
    lastSTTValue = newText; // FIX #6: Track the STT value for edit detection
    syncPlaceholder();

    // Show filling state
    composer.classList.add('stt-filling');
    updateQuestionReadyState();
    updateSendButtonState(); // FIX #9: Update send button state

    // Reset the idle timer — after 2s of silence, check if question is complete
    clearTimeout(questionFinalizeTimer);
    questionFinalizeTimer = setTimeout(() => {
      if (isLikelyCompleteQuestion(input.value)) {
        composer.classList.add('stt-ready');
        updateSendButtonState(); // FIX #9: Update send button when ready
        // Subtle notification that question is ready
        showToast('Press Enter to answer', 2500);
      }
    }, 1800);

    // After 8s of no new words, save to history and keep stable
    clearTimeout(sttFillTimer);
    sttFillTimer = setTimeout(() => {
      saveToQuestionHistory(input.value);
      composer.classList.remove('stt-filling');
      // Keep stt-ready if applicable
      updateQuestionReadyState();
      updateSendButtonState(); // FIX #9
    }, 8000);
  }

  // ---- Soft clear: don't immediately wipe question when user speaks ----
  function softClearSTTFill() {
    // When the user speaks (You channel), don't immediately clear
    // Instead, dim the input and wait — they might just be acknowledging
    if (!inputFromSTT) return;
    
    // FIX #3: Reset userSpeechStart at the beginning before setting new timestamp
    // This ensures we always track from fresh when a new soft-clear cycle begins
    const now = Date.now();
    if (!userSpeechStart) {
      userSpeechStart = now;
    }

    // Dim the input to show it's in "pending clear" state
    composer.classList.add('stt-dimmed');
    
    // Clear the finalization timer (user is responding)
    clearTimeout(questionFinalizeTimer);

    // Re-armed on every 'you' final, so this fires ~800ms after the user stops.
    // The 2s test below is measured from the FIRST final of this cycle, so a brief
    // acknowledgement ("mm-hm") leaves the question on screen while a sustained
    // answer clears it. Firing at 2.5s instead would make that test always true.
    clearTimeout(softClearTimer);
    softClearTimer = setTimeout(() => {
      const speechDuration = userSpeechStart ? Date.now() - userSpeechStart : 0;
      if (speechDuration > 2000) {
        // User has been speaking for a while — they're answering, clear the box
        saveToQuestionHistory(input.value);
        input.value = '';
        inputFromSTT = false;
        composer.classList.remove('stt-filling', 'stt-dimmed', 'stt-ready', 'stt-accumulating');
        syncPlaceholder();
        updateSendButtonState(); // FIX #9: Update send button state
        userSpeechStart = null;
      }
    }, 800);
  }

  // ---- Hard clear (called when user explicitly clears or types) ----
  // FIX #10: Add option to show toast when clearing
  function hardClearSTTFill(showUndoHint = false) {
    const hadContent = input.value.trim().length > 0;
    saveToQuestionHistory(input.value);
    input.value = '';
    inputFromSTT = false;
    lastSTTValue = ''; // FIX #6: Clear the tracked STT value
    userSpeechStart = null;
    composer.classList.remove('stt-filling', 'stt-dimmed', 'stt-ready', 'stt-accumulating');
    clearTimeout(softClearTimer);
    clearTimeout(questionFinalizeTimer);
    clearTimeout(sttFillTimer);
    clearInputInterim(); // FIX #5: Clear interim when clearing input
    syncPlaceholder();
    updateSendButtonState(); // FIX #9
    
    // FIX #10: Show undo hint when explicitly cleared
    if (showUndoHint && hadContent) {
      const undoHint = isWindows ? 'Ctrl+Z to undo' : '⌘Z to undo';
      showToast(`Cleared · ${undoHint}`, 2000);
    }
  }

  // ---- Reset soft-clear state (interviewer spoke again) ----
  // FIX #16: Reset userSpeechStart properly when cancelSoftClear is called
  function cancelSoftClear() {
    userSpeechStart = null; // Reset timestamp so next soft-clear starts fresh
    clearTimeout(softClearTimer);
    composer.classList.remove('stt-dimmed');
  }

  function syncPlaceholder() {
    placeholder.classList.toggle('hidden', input.value.length > 0 || document.activeElement === input);
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  }
  
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
      if (!isStealthTypingActive && typeof cue.stealthToggle === 'function') {
        cue.stealthToggle().catch(() => {});
      }
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
      if (!isStealthTypingActive && typeof cue.stealthToggle === 'function') {
        cue.stealthToggle().catch(() => {});
      }
      return;
    }
    input.focus();
  });

  function send() {
    const text = input.value.trim();
    if (isStealthTypingActive && typeof cue.stealthToggle === 'function') {
      cue.stealthToggle().catch(() => {});
    }
    if (temporaryFocusActive) {
      input.blur();
      temporaryFocusActive = false;
      if (typeof cue.nofocusSet === 'function') cue.nofocusSet(true).catch(() => {});
    }
    if (!text) { runMode('assist', ''); return; }
    const wasFromSTT = inputFromSTT;
    
    // Save to history before clearing (in case user wants to redo)
    saveToQuestionHistory(text);
    
    input.value = '';
    inputFromSTT = false;
    lastSTTValue = ''; // FIX #6: Clear tracked STT value
    userSpeechStart = null;
    composer.classList.remove('stt-filling', 'stt-dimmed', 'stt-ready', 'stt-accumulating');
    clearTimeout(softClearTimer);
    clearTimeout(questionFinalizeTimer);
    clearTimeout(sttFillTimer);
    syncPlaceholder();
    updateSendButtonState(); // FIX #9
    
    // If text came from STT (interviewer question), use answerThis mode
    // Otherwise use ask mode (user typed their own question)
    runMode(wasFromSTT ? 'answerThis' : 'ask', text);
  }
  $('#send-btn').addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    // Ctrl+Z / Cmd+Z: restore last question if input is empty
    if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !input.value.trim()) {
      e.preventDefault();
      restoreLastQuestion();
      return;
    }
    // Escape: clear the input (with undo hint) or exit temporary typing focus
    if (e.key === 'Escape') {
      if (input.value.trim()) {
        e.preventDefault();
        hardClearSTTFill(true); // FIX #10: Show undo hint
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
  
  // FIX #13: Global keyboard shortcut for force-answer (Ctrl+Shift+A / Cmd+Shift+A)
  document.addEventListener('keydown', (e) => {
    // Ctrl+Shift+A / Cmd+Shift+A: Force answer current question immediately
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      if (input.value.trim()) {
        send();
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

  // Smart toggle
  const smartBtn = $('#smart-toggle');
  smartBtn.addEventListener('click', async () => {
    settings.smart = !settings.smart;
    smartBtn.classList.toggle('on', settings.smart);
    await cue.settingsSet({ smart: settings.smart });
  });

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
      reopenSidebarOnExpand = sidebarOpen;
      if (sidebarOpen) hideSidebar();
    } else if (reopenSidebarOnExpand) {
      showSidebar();
    }
  }
  $('#hide-btn').addEventListener('click', toggleHide);
  cue.on('hide:toggle', toggleHide);

  const OPACITY_MIN = 0.2;
  function clampOpacity(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 1;
    return Math.min(1, Math.max(OPACITY_MIN, Math.round(n * 100) / 100));
  }
  function opacityToPercent(value) { return Math.round(clampOpacity(value) * 100); }
  function persistOpacitySoon() {
    clearTimeout(persistOpacitySoon.timer);
    persistOpacitySoon.timer = setTimeout(() => {
      if (!settings) return;
      cue.settingsSet({ opacity: settings.opacity }).then((next) => { if (next) settings = next; }).catch(() => {});
    }, 400);
  }
  function applyOpacity(value, persist) {
    const opacity = clampOpacity(value);
    const percent = opacityToPercent(opacity);
    if (settings) settings.opacity = opacity;
    document.documentElement.style.setProperty('--cue-opacity', String(opacity));
    const tb = $('#tb-opacity-slider');
    const tbVal = $('#tb-opacity-value');
    const s = $('#s-opacity-slider');
    const sVal = $('#s-opacity-value');
    if (tb) tb.value = String(percent);
    if (tbVal) tbVal.textContent = percent + '%';
    if (s) s.value = String(percent);
    if (sVal) sVal.textContent = percent + '%';
    if (persist) persistOpacitySoon();
  }
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

  // Stop = start/stop listening. Kick off system-audio capture straight from the click so
  // the user-gesture is fresh for getDisplayMedia (loopback capture needs it).
  $('#stop-btn').addEventListener('click', async () => {
    const turningOn = !$('#stop-btn').classList.contains('active');
    if (turningOn) {
      // startSystemAudio may fail (user cancels, no permission) — that's OK,
      // mic will still work and capture will toggle regardless
      try { await startSystemAudio(); } catch (_) { /* handled inside startSystemAudio */ }
    }
    const active = await cue.captureToggle();
    if (turningOn && !active) stopSystemAudio();
  });

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

  cue.on('composer:focus', ({ temporary } = {}) => {
    temporaryFocusActive = Boolean(temporary);
    const wrap = $('#panel-wrap');
    if (wrap && wrap.classList.contains('collapsed')) {
      toggleHide();
    }
    input.focus();
    input.select();
  });

  cue.on('stealth:state', ({ capturing }) => {
    isStealthTypingActive = Boolean(capturing);
    composer.classList.toggle('stealth-active', isStealthTypingActive);
    if (isStealthTypingActive) {
      const wrap = $('#panel-wrap');
      if (wrap && wrap.classList.contains('collapsed')) {
        toggleHide();
      }
      showToast('Stealth typing ON · Type question (Enter sends · Esc exits)', 2500);
    } else {
      showToast('Stealth typing OFF · Keyboard back to background app', 2000);
    }
    updatePlaceholder();
  });

  cue.on('stealth:char', ({ char }) => {
    if (!char) return;
    input.value += char;
    syncPlaceholder();
    updateSendButtonState();
  });

  cue.on('stealth:backspace', () => {
    if (input.value.length > 0) {
      input.value = input.value.slice(0, -1);
      syncPlaceholder();
      updateSendButtonState();
    }
  });

  cue.on('stealth:submit', () => {
    isStealthTypingActive = false;
    composer.classList.remove('stealth-active');
    updatePlaceholder();
    send();
  });

  cue.on('stealth:cancel', () => {
    isStealthTypingActive = false;
    composer.classList.remove('stealth-active');
    updatePlaceholder();
  });

  cue.on('stealth:paste', ({ text }) => {
    if (text) {
      input.value += text;
      syncPlaceholder();
      updateSendButtonState();
    }
  });

  cue.on('stealth:select-all', () => {
    // Selected in stealth mode
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
    
    // FIX #12: Show interviewer's interim speech in input area
    if (channel === 'them' && !input.value.trim()) {
      showInterimInInput(text);
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
  cue.on('llm:start', ({ userBubble, small, category }) => {
    responseCount++;
    if (responseCount > MAX_RESPONSES) {
      const oldest = messages.querySelector('.response-group');
      if (oldest) oldest.remove();
      responseCount = MAX_RESPONSES;
    }
    const group = document.createElement('div');
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
    aiEl = document.createElement('div');
    aiEl.className = 'ai-text' + (small ? ' small' : '');
    aiEl.dataset.raw = '';
    caretEl = document.createElement('span');
    caretEl.className = 'ai-caret';
    aiEl.appendChild(caretEl);
    group.appendChild(aiEl);
    messages.appendChild(group);
    // Use requestAnimationFrame so the DOM is fully updated before scrolling.
    // Scroll #messages directly rather than calling sep.scrollIntoView(): that
    // scrolls *every* scrollable ancestor, and once the panel is tall enough it
    // scrolls the document too, aligning the separator to the top of the window
    // and pushing #toolbar out of view. html/body are overflow:hidden, so there
    // is no scrollbar or wheel gesture to undo it — the Stop/Hide/Quit controls
    // just never come back.
    requestAnimationFrame(() => {
      if (sep && sep.isConnected) {
        messages.scrollTo({ top: sep.offsetTop - messages.offsetTop, behavior: 'smooth' });
      }
    });
    setBusy(true);
  });
  cue.on('llm:token', ({ text }) => appendToken(text));
  cue.on('llm:done', () => { finalizeAi(); setBusy(false); });
  cue.on('llm:error', ({ message, action }) => {
    if (!aiEl) startAi(true);
    aiEl.dataset.raw = message; finalizeAi(); setBusy(false);
    // publik errors carry one action: the renderer's markdown emits no anchors,
    // so a link needs a real button (same pattern as the mic banner).
    if (action && action.kind === 'card') { showPublikCard(); return; }
    if (action && action.kind) showStatus(message, publikActionButton(action));
  });
  cue.on('transcript', ({ channel, text }) => {
    if (!text || text.trim().length < 2 || /^[?!.,;:\-…]+$/.test(text.trim())) return;
    appendTranscriptHistoryTurn(channel, text, false);
    // Auto-fill the input box with Them (interviewer) speech
    if (channel === 'them') {
      cancelSoftClear(); // Interviewer is speaking, cancel any pending clear
      autoFillInputFromSTT(text);
    } else {
      // User spoke — soft clear (don't immediately wipe, wait to see if they're really answering)
      softClearSTTFill();
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
    const localWhisper = settings.localWhisper || { modelId: 'base.en', language: 'auto', threads: 0 };
    $('#whisper-language').value = localWhisper.language || 'auto';
    $('#whisper-threads').value = Number(localWhisper.threads) || 0;
    // Slides tab (inside Transcription pane)
    const slidesCfg = settings.slides || { enabled: false, intervalMs: 3000 };
    const slidesEnabled = $('#slides-enabled');
    if (slidesEnabled) slidesEnabled.checked = !!slidesCfg.enabled;
    const slidesInterval = $('#slides-interval');
    if (slidesInterval) slidesInterval.value = slidesCfg.intervalMs || 3000;
    // Style tab
    $('#ai-rules').value = settings.aiRules || '';
    updateAiRulesCounter();
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
    const stt = selectedSttProvider === 'auto' ? automaticStt : selectedSttProvider;
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
    $('#s-status').textContent = statusText();
  }));

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
    // Appearance tab
    const opacitySlider = $('#s-opacity-slider');
    if (opacitySlider) settings.opacity = clampOpacity(Number(opacitySlider.value) / 100);
    try {
      settings = await cue.settingsSet(settings);
      $('#s-status').textContent = statusText();
      updateSmartTooltip();
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
    addUserBubble('What should I say?');
    const ai = document.createElement('div');
    ai.className = 'ai-text';
    ai.textContent = '“A discounted cash flow model values a company by projecting future free cash flows and discounting them to present value using the weighted average cost of capital.”';
    messages.appendChild(ai);
  }

  // ---- global keys -------------------------------------------------------
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !scrim.classList.contains('hidden')) void closeSettings();
    if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); openSettings(); }
  });

  // Safety net for the same class of bug: html/body are overflow:hidden, so any
  // stray programmatic scroll of the document is invisible to the user and
  // unrecoverable by mouse. Snap it back so the toolbar cannot be stranded.
  window.addEventListener('scroll', () => {
    if (window.scrollY || window.scrollX) window.scrollTo(0, 0);
  }, { passive: true });

  // ---- click-through: only the UI blocks the mouse; empty gaps pass to your screen ----
  let ignoring = null;
  let draggingWindow = false;
  function setIgnore(v) { if (v !== ignoring) { ignoring = v; cue.setIgnoreMouse(v); } }
  document.addEventListener('mousemove', (e) => {
    // The window trails the cursor while dragging; going click-through then would drop the release.
    if (draggingWindow) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const overUI = !!(el && el.closest && el.closest('#toolbar, #panel-wrap, #transcript-sidebar, #settings-scrim, #onboard-scrim, #consent-scrim, #confirm-scrim, .custom-select-menu'));
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
    if (sayHintEl) sayHintEl.textContent = isWindows ? 'Ctrl+↵' : '⌘↵';
    if (assistHintEl) assistHintEl.textContent = isWindows ? 'Ctrl+Shift+↵' : '⌘⇧↵';
    const sayBtn = document.querySelector('.act[data-mode="say"]');
    const assistBtn = document.querySelector('.act[data-mode="assist"]');
    if (sayBtn) sayBtn.setAttribute('aria-label', isWindows
      ? 'Suggests what to say next based on the conversation (Ctrl+Enter)'
      : 'Suggests what to say next based on the conversation (⌘↵)');
    if (assistBtn) assistBtn.setAttribute('aria-label', isWindows
      ? 'Scans your screen and conversation to decide what you need (Ctrl+Shift+Enter)'
      : 'Scans your screen and conversation to decide what you need (⌘⇧↵)');

    // R6: smart tooltip
    updateSmartTooltip();
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
      const initialNoFocus = typeof cue.nofocusGet === 'function' ? await cue.nofocusGet() : false;
      setNoFocusUI(initialNoFocus);
    } catch (_) {
      setNoFocusUI(false);
    }

    applyOpacity(settings.opacity, false);

    const st = await cue.captureState();
    $('#live-dot').classList.toggle('off', !st.active);
    setSessionButton(st.active);
    if (!settings.onboarded) showOnboard();
  })();
})();

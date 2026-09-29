const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
const jsSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');

test('renderer/index.html contains no native title attributes', () => {
  // Title attributes in Chromium/Electron create OS-level floating dialogs
  // that lack setContentProtection(true), causing them to be captured on screen shares.
  const titleMatches = htmlSrc.match(/\btitle\s*=/gi) || [];
  assert.equal(titleMatches.length, 0, `index.html must not have title attributes, found ${titleMatches.length}`);
});

test('clear-transcript-btn and other buttons use aria-label instead of title', () => {
  assert.match(htmlSrc, /id="clear-transcript-btn"[^>]*aria-label="Clear all history"/);
  assert.match(htmlSrc, /id="close-sidebar-btn"[^>]*aria-label="Close history"/);
  assert.match(htmlSrc, /id="quit-btn"[^>]*aria-label="Quit cue"/);
  assert.match(htmlSrc, /id="hide-btn"[^>]*aria-label="Hide"/);
});

test('renderer.js installs global title suppression and DOM interception', () => {
  assert.match(jsSrc, /function stripTitles\(/, 'stripTitles function must be defined');
  assert.match(jsSrc, /Element\.prototype\.setAttribute/, 'Element.prototype.setAttribute must intercept title');
  assert.match(jsSrc, /Object\.defineProperty\(HTMLElement\.prototype,\s*'title'/, 'HTMLElement.prototype.title must be intercepted');
  assert.match(jsSrc, /new MutationObserver\(/, 'MutationObserver must watch for dynamically added title attributes');
});

test('title interceptor redirects to aria-label and removes title attribute', () => {
  // Test simulated DOM node behavior using the interception pattern from renderer.js
  class MockElement {
    constructor() {
      this.attributes = {};
    }
    hasAttribute(name) {
      return name in this.attributes;
    }
    getAttribute(name) {
      return this.attributes[name] || null;
    }
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    }
    removeAttribute(name) {
      delete this.attributes[name];
    }
  }

  // Interception logic matching renderer.js
  const origSetAttribute = MockElement.prototype.setAttribute;
  MockElement.prototype.setAttribute = function (name, value) {
    if (name && typeof name === 'string' && name.toLowerCase() === 'title') {
      if (value && !this.hasAttribute('aria-label')) {
        origSetAttribute.call(this, 'aria-label', value);
      }
      return;
    }
    return origSetAttribute.apply(this, arguments);
  };

  Object.defineProperty(MockElement.prototype, 'title', {
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

  const el = new MockElement();
  el.title = 'Clear all history';

  assert.equal(el.hasAttribute('title'), false, 'title attribute must not be present');
  assert.equal(el.getAttribute('aria-label'), 'Clear all history', 'aria-label must be set');
  assert.equal(el.title, 'Clear all history', 'title getter should return aria-label value');

  el.setAttribute('title', 'clears all history');
  assert.equal(el.hasAttribute('title'), false, 'setAttribute title must not set title attribute');
  assert.equal(el.getAttribute('aria-label'), 'Clear all history', 'existing aria-label preserved');
});

test('renderer.js installs custom in-DOM select dropdowns to avoid native OS popup menus', () => {
  // Native <select> menus spawn Win32 popups that bypass window capture protection.
  assert.match(jsSrc, /function setupCustomSelect\(/, 'setupCustomSelect function must be defined');
  assert.match(jsSrc, /s-select-native-hidden/, 'must hide native select from pointer events');
  assert.match(jsSrc, /custom-select-trigger/, 'must create custom-select-trigger');
  assert.match(jsSrc, /custom-select-menu/, 'must create custom-select-menu');
  assert.match(jsSrc, /document\.querySelectorAll\('select'\)\.forEach\(setupCustomSelect\)/, 'must initialize all selects');
});

test('renderer.js prevents native context menus and uses in-DOM confirm dialogs', () => {
  assert.match(jsSrc, /window\.addEventListener\('contextmenu',\s*\(e\)\s*=>\s*e\.preventDefault\(\)\)/, 'must suppress native right-click context menu');
  assert.match(jsSrc, /function showConfirmDialog\(/, 'showConfirmDialog must be defined');
  assert.ok(!jsSrc.includes('window.confirm('), 'window.confirm must not be used');
});

test('click-through overUI selector includes .custom-select-menu and #confirm-scrim', () => {
  assert.match(jsSrc, /closest\([^)]*\.custom-select-menu[^)]*\)/, 'overUI must include .custom-select-menu');
  assert.match(jsSrc, /closest\([^)]*#confirm-scrim[^)]*\)/, 'overUI must include #confirm-scrim');
});


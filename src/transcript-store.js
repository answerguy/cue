// Persists the full conversation history to disk (separate from the in-memory
// `transcript` array in main.js, which is session-only and feeds LLM prompt context).
// This store is purely for the History panel — old sessions never bleed into live context.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const FILE = path.join(app.getPath('userData'), 'cue-transcript.json');
const MAX_TURNS = 5000; // cap so the file doesn't grow unbounded across many sessions

let data = null;
let saveTimer = null;

function load() {
  if (data) return data;
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    data = Array.isArray(parsed) ? parsed : [];
  } catch {
    data = [];
  }
  return data;
}

function saveNow() { try { fs.writeFileSync(FILE, JSON.stringify(data)); } catch (_) { /* ignore */ } }

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 1000);
}

module.exports = {
  getAll() { return load(); },
  append(turn) {
    load();
    data.push(turn);
    if (data.length > MAX_TURNS) data.splice(0, data.length - MAX_TURNS);
    scheduleSave();
  },
  clear() {
    data = [];
    saveNow();
  }
};

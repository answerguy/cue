// Supplementary verification probe — NOT used by oracle.sh, written to check
// the REAL code path a genuine user hits (main.js:495 `createLLM(store.getSettings())`),
// which the oracle's own probe-anthropic.cjs does not exercise (it forces
// `models: {}` to reach llm.js's DEFAULT_MODELS fallback directly).
//
// store.js can't be `require()`d outside Electron (its top-level does
// `require('electron').app.getPath(...)`, which throws under plain Node), so
// this hand-copies its DEFAULTS.models entries verbatim (see src/store.js) to
// build the exact settings object deepMerge(DEFAULTS, {}) produces for a
// genuinely fresh install with no settings.json on disk yet, and separately
// the exact shape an EXISTING installed user's settings.json has before this
// fix migrates it (the DEAD_ANTHROPIC_MODEL_RE self-heal case).
const { createLLM } = require('./src/llm.js');

async function run(label, settings) {
  const llm = createLLM(settings);
  console.log(`[${label}] resolved model:`, llm.model, 'ready:', llm.ready);
  try {
    const out = await llm.stream({
      system: 'You are a test.',
      turns: [{ role: 'user', text: 'Say hi in one word.' }],
      onToken: () => {},
    });
    console.log(`[${label}] SUCCESS, reply:`, out);
    return true;
  } catch (err) {
    console.log(`[${label}] APP_ERROR_MESSAGE:`, err.message);
    return false;
  }
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.error('NO_KEY'); process.exit(2); }

  // Case A: fresh install, no settings.json yet -> deepMerge(DEFAULTS, {}) ->
  // settings.models is store.js's DEFAULTS.models verbatim (this fix's new values).
  const freshInstallModels = {
    anthropic: { fast: 'claude-haiku-4-5-20251001', smart: 'claude-sonnet-4-5-20250929' },
  };
  const okFast = await run('fresh-install fast-tier', {
    provider: 'anthropic', apiKeys: { anthropic: apiKey }, models: freshInstallModels, smart: false,
  });
  const okSmart = await run('fresh-install smart-tier', {
    provider: 'anthropic', apiKeys: { anthropic: apiKey }, models: freshInstallModels, smart: true,
  });

  // Case B: an EXISTING install whose settings.json was saved back when
  // store.js's DEFAULTS still had the dead ids (pre-fix), never touched in
  // Settings -> proves the DEAD_ANTHROPIC_MODEL_RE self-heal in llm.js migrates it.
  const staleOnDiskModels = {
    anthropic: { fast: 'claude-3-5-haiku-latest', smart: 'claude-3-5-sonnet-latest' },
  };
  const okStaleFast = await run('existing-install stale-on-disk fast-tier (self-heal)', {
    provider: 'anthropic', apiKeys: { anthropic: apiKey }, models: staleOnDiskModels, smart: false,
  });
  const okStaleSmart = await run('existing-install stale-on-disk smart-tier (self-heal)', {
    provider: 'anthropic', apiKeys: { anthropic: apiKey }, models: staleOnDiskModels, smart: true,
  });

  const allOk = okFast && okSmart && okStaleFast && okStaleSmart;
  console.log('ALL_REAL_PATHS_OK:', allOk);
  process.exit(allOk ? 0 : 1);
}
main();

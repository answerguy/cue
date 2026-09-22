// Drives cue's own src/llm.js exactly the way the renderer would: provider=anthropic,
// no model override (so DEFAULT_MODELS.anthropic is used), a real key, one short turn.
const { createLLM } = require('./src/llm.js');

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.error('NO_KEY'); process.exit(2); }

  const settings = {
    provider: 'anthropic',
    apiKeys: { anthropic: apiKey },
    models: {}, // no override -> DEFAULT_MODELS.anthropic
    smart: false,
  };

  const llm = createLLM(settings);
  console.log('resolved model (no override):', llm.model);
  console.log('ready:', llm.ready, 'configurationError:', llm.configurationError);

  try {
    const out = await llm.stream({
      system: 'You are a test.',
      turns: [{ role: 'user', text: 'Say hi in one word.' }],
      onToken: () => {},
    });
    console.log('SUCCESS, reply:', out);
    process.exit(0);
  } catch (err) {
    console.log('APP_ERROR_MESSAGE:', err.message);
    process.exit(1);
  }
}
main();

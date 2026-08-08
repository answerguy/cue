const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const { OPTIONAL_API_KEY_PLACEHOLDER } = require('../src/openai-compatible');

let capturedClientOptions = null;
let capturedCompletionRequest = null;
const originalModuleLoad = Module._load;

Module._load = function loadWithOpenAIStub(request, parent, isMain) {
  if (request === 'openai') {
    return class FakeOpenAI {
      constructor(clientOptions) {
        capturedClientOptions = clientOptions;
        this.chat = {
          completions: {
            create: async (completionRequest) => {
              capturedCompletionRequest = completionRequest;
              return [{ choices: [{ delta: { content: 'ok' } }] }];
            }
          }
        };
      }
    };
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};

const { createLLM } = require('../src/llm');

test.after(() => {
  Module._load = originalModuleLoad;
});

function createCustomSettings(overrides = {}) {
  return {
    provider: 'custom',
    smart: false,
    baseUrl: 'http://127.0.0.1:18789/v1',
    apiKeys: { custom: 'gateway-token' },
    models: { custom: { fast: 'openclaw/default', smart: 'openclaw/default' } },
    ...overrides
  };
}

test.beforeEach(() => {
  capturedClientOptions = null;
  capturedCompletionRequest = null;
});

test('routes the Custom provider through the configured OpenAI-compatible endpoint', async () => {
  const receivedTokens = [];
  const llm = createLLM(createCustomSettings());

  assert.equal(llm.ready, true);
  assert.equal(llm.model, 'openclaw/default');

  const response = await llm.stream({
    system: 'Be concise.',
    turns: [{ role: 'user', text: 'Hello' }],
    onToken: (token) => receivedTokens.push(token)
  });

  assert.deepEqual(capturedClientOptions, {
    apiKey: 'gateway-token',
    baseURL: 'http://127.0.0.1:18789/v1'
  });
  assert.equal(capturedCompletionRequest.model, 'openclaw/default');
  assert.equal(response, 'ok');
  assert.deepEqual(receivedTokens, ['ok']);
});

test('allows an unauthenticated local Custom endpoint', async () => {
  const llm = createLLM(createCustomSettings({ apiKeys: { custom: '' } }));
  await llm.stream({ system: '', turns: [], onToken: () => {} });

  assert.equal(capturedClientOptions.apiKey, OPTIONAL_API_KEY_PLACEHOLDER);
});

test('does not apply the Custom Base URL to official OpenAI requests', async () => {
  const llm = createLLM({
    provider: 'openai',
    smart: false,
    baseUrl: 'http://127.0.0.1:18789/v1',
    apiKeys: { openai: 'official-openai-key' },
    models: { openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' } }
  });

  await llm.stream({ system: '', turns: [], onToken: () => {} });

  assert.deepEqual(capturedClientOptions, { apiKey: 'official-openai-key' });
});

test('reports incomplete Custom endpoint settings without making a request', () => {
  const llm = createLLM(createCustomSettings({ baseUrl: '' }));

  assert.equal(llm.ready, false);
  assert.match(llm.configurationError, /Set a Base URL/);
  assert.equal(capturedClientOptions, null);
});

test('requires a model for the Custom provider', () => {
  const llm = createLLM(createCustomSettings({
    models: { custom: { fast: '', smart: '' } }
  }));

  assert.equal(llm.ready, false);
  assert.match(llm.configurationError, /Set a Fast or Smart model/);
});

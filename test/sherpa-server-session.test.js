const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { SherpaServerSession } = require('../src/sherpa-server-session');

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.signalCode = null;
    this.killSignals = [];
  }

  kill(signal) {
    this.killSignals.push(signal);
    this.exitCode = 0;
    queueMicrotask(() => this.emit('exit', 0, signal));
    return true;
  }
}

class FakeWebSocket extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.sentData = [];
    queueMicrotask(() => this.emit('open'));
  }

  send(data) {
    this.sentData.push(data);
    if (Buffer.isBuffer(data) && data.length > 8) {
      queueMicrotask(() => {
        this.emit('message', Buffer.from(JSON.stringify({ text: 'parakeet transcript' })));
      });
    }
  }

  close() {
    this.emit('close');
  }
}

test('builds CLI arguments correctly for CTC and Transducer models', () => {
  const sessionCtc = new SherpaServerSession({
    executablePath: 'sherpa.exe',
    runtimeDirectory: '.',
    modelConfig: {
      modelPath: 'model.int8.onnx',
      tokensPath: 'tokens.txt',
      architecture: 'nemo_ctc'
    },
    threads: 4,
    provider: 'directml'
  });

  const argsCtc = sessionCtc._buildArguments(6006);
  assert.ok(argsCtc.includes('--port=6006'));
  assert.ok(argsCtc.includes('--num-work-threads=4'));
  assert.ok(argsCtc.includes('--nemo-ctc-model=model.int8.onnx'));
  assert.ok(argsCtc.includes('--tokens=tokens.txt'));
  assert.ok(argsCtc.includes('--provider=directml'));

  const sessionTdt = new SherpaServerSession({
    executablePath: 'sherpa.exe',
    runtimeDirectory: '.',
    modelConfig: {
      encoderPath: 'enc.onnx',
      decoderPath: 'dec.onnx',
      joinerPath: 'join.onnx',
      tokensPath: 'tokens.txt',
      architecture: 'nemo_transducer'
    },
    threads: 2,
    provider: 'cpu'
  });

  const argsTdt = sessionTdt._buildArguments(6007);
  assert.ok(argsTdt.includes('--port=6007'));
  assert.ok(argsTdt.includes('--encoder=enc.onnx'));
  assert.ok(argsTdt.includes('--decoder=dec.onnx'));
  assert.ok(argsTdt.includes('--joiner=join.onnx'));
  assert.ok(argsTdt.includes('--model-type=nemo_transducer'));
  assert.ok(!argsTdt.some((a) => a.startsWith('--provider=cpu')));
});

test('spawns server process, connects via websocket, and transcribes audio', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-sherpa-session-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executablePath = path.join(root, process.platform === 'win32' ? 'sherpa.exe' : 'sherpa');
  fs.writeFileSync(executablePath, 'runtime');
  fs.chmodSync(executablePath, 0o755);

  const child = new FakeChild();
  const spawnCalls = [];

  const session = new SherpaServerSession({
    executablePath,
    runtimeDirectory: root,
    modelConfig: {
      modelPath: path.join(root, 'model.onnx'),
      tokensPath: path.join(root, 'tokens.txt')
    },
    threads: 2,
    spawnImpl: (...args) => { spawnCalls.push(args); return child; },
    findPort: async () => 45678,
    webSocketImpl: FakeWebSocket,
    wait: async () => {}
  });

  await session.start();
  assert.equal(spawnCalls.length, 1);

  const text = await session.transcribe(Buffer.alloc(3200));
  assert.equal(text, 'parakeet transcript');

  await session.stop();
  assert.ok(child.killSignals.length > 0);
});

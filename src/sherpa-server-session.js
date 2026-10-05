const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { pcmToWav } = require('./wav');

const LOOPBACK_HOST = '127.0.0.1';
const STARTUP_TIMEOUT_MS = 60000;
const HEALTH_POLL_MS = 150;
const INFERENCE_TIMEOUT_MS = 60000;
const PROCESS_EXIT_TIMEOUT_MS = 3000;
const MAX_LOG_TAIL_CHARACTERS = 12000;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function findFreeLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK_HOST, resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (!address || typeof address === 'string') throw new Error('Could not allocate a local Sherpa-ONNX port.');
  return address.port;
}

function pcmToSherpaPayload(pcm, sampleRate = 16000) {
  const bufferPcm = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm);
  const numSamples = Math.floor(bufferPcm.length / 2);
  const floatByteLength = numSamples * 4;
  const payload = Buffer.allocUnsafe(8 + floatByteLength);

  // Little-endian int32 sample rate, then expected float sample byte count
  payload.writeInt32LE(sampleRate, 0);
  payload.writeInt32LE(floatByteLength, 4);

  let inOffset = 0;
  let outOffset = 8;
  for (let i = 0; i < numSamples; i++) {
    const sampleInt16 = bufferPcm.readInt16LE(inOffset);
    payload.writeFloatLE(sampleInt16 / 32768.0, outOffset);
    inOffset += 2;
    outOffset += 4;
  }

  return payload;
}

class SherpaServerSession {
  /** Supervise one model-loaded sherpa-onnx server process for an entire capture session. */
  constructor({
    executablePath,
    runtimeDirectory,
    modelConfig = {},
    threads = 0,
    provider = 'cpu',
    spawnImpl = spawn,
    findPort = findFreeLoopbackPort,
    webSocketImpl = WebSocket,
    wait = delay,
    onState = () => {}
  } = {}) {
    if (!executablePath || !runtimeDirectory) {
      throw new Error('SherpaServerSession requires executable and runtime paths.');
    }

    this.executablePath = executablePath;
    this.runtimeDirectory = runtimeDirectory;
    this.modelConfig = modelConfig;
    this.threads = Number.isInteger(threads) && threads > 0 ? threads : 0;
    this.provider = provider || 'cpu';
    this.spawnImpl = spawnImpl;
    this.findPort = findPort;
    this.webSocketImpl = webSocketImpl;
    this.wait = wait;
    this.onState = onState;
    this.child = null;
    this.port = null;
    this.wsUrl = null;
    this.wsClient = null;
    this.logTail = '';
    this.exitError = null;
    this.stopRequested = false;
    this.inferenceAborts = new Set();
  }

  async start() {
    if (this.child) return;
    this.stopRequested = false;
    this.exitError = null;
    this.logTail = '';

    await fs.promises.access(this.executablePath, fs.constants.X_OK);

    this.port = await this.findPort();
    this.wsUrl = `ws://${LOOPBACK_HOST}:${this.port}`;
    const argumentsList = this._buildArguments(this.port);

    this.onState({ status: 'loading', message: 'Loading the Sherpa-ONNX model…' });
    this.child = this.spawnImpl(this.executablePath, argumentsList, {
      cwd: this.runtimeDirectory,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    this._observeChild(this.child);

    try {
      await this._waitUntilReady();
      this.onState({ status: 'ready', message: 'Sherpa-ONNX is ready.' });
    } catch (error) {
      await this.stop({ force: true });
      throw error;
    }
  }

  _buildArguments(port) {
    const args = [`--port=${port}`];
    if (this.threads > 0) {
      args.push(`--num-work-threads=${this.threads}`);
    }

    const { modelPath, tokensPath, architecture, encoderPath, decoderPath, joinerPath } = this.modelConfig;

    if (tokensPath) {
      args.push(`--tokens=${tokensPath}`);
    }

    if (architecture === 'nemo_transducer' || (encoderPath && decoderPath && joinerPath)) {
      if (encoderPath) args.push(`--encoder=${encoderPath}`);
      if (decoderPath) args.push(`--decoder=${decoderPath}`);
      if (joinerPath) args.push(`--joiner=${joinerPath}`);
      args.push('--model-type=nemo_transducer');
    } else if (modelPath) {
      args.push(`--nemo-ctc-model=${modelPath}`);
    }

    if (this.provider && this.provider !== 'cpu') {
      args.push(`--provider=${this.provider}`);
    }

    return args;
  }

  _observeChild(child) {
    child.stdout.on('data', (chunk) => this._appendLog(chunk));
    child.stderr.on('data', (chunk) => this._appendLog(chunk));
    child.once('exit', (code, signal) => {
      if (this.stopRequested) return;
      this.exitError = new Error(
        `Sherpa-ONNX process exited unexpectedly (code ${code ?? 'null'}, signal ${signal ?? 'none'}). ${this.logTail.slice(-400)}`
      );
      this.onState({ status: 'error', message: this.exitError.message });
    });
  }

  _appendLog(chunk) {
    this.logTail = (this.logTail + chunk.toString()).slice(-MAX_LOG_TAIL_CHARACTERS);
  }

  async _waitUntilReady() {
    const start = Date.now();
    while (Date.now() - start < STARTUP_TIMEOUT_MS) {
      if (this.exitError) throw this.exitError;
      if (this.stopRequested) throw new Error('Sherpa-ONNX startup was cancelled.');

      try {
        const connected = await this._probeWebSocket();
        if (connected) return;
      } catch {
        // Continue waiting
      }
      await this.wait(HEALTH_POLL_MS);
    }
    throw new Error(`Sherpa-ONNX server did not become ready in time. ${this.logTail.slice(-800)}`);
  }

  _probeWebSocket() {
    return new Promise((resolve) => {
      let settled = false;
      const socket = new this.webSocketImpl(this.wsUrl);
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { socket.close(); } catch {}
          resolve(false);
        }
      }, 500);

      socket.once('open', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          try { socket.close(); } catch {}
          resolve(true);
        }
      });
      socket.once('error', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(false);
        }
      });
    });
  }

  async transcribe(pcm) {
    if (!this.child || !this.wsUrl) throw new Error('Sherpa-ONNX is not running.');
    const payload = pcmToSherpaPayload(pcm, 16000);

    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = new this.webSocketImpl(this.wsUrl);
      const abortHandler = () => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error('Sherpa-ONNX inference timed out or was aborted.'));
        }
      };

      const timeout = setTimeout(abortHandler, INFERENCE_TIMEOUT_MS);
      this.inferenceAborts.add(abortHandler);

      const cleanup = () => {
        clearTimeout(timeout);
        this.inferenceAborts.delete(abortHandler);
        try {
          if (socket.readyState === 1) {
            socket.send('Done');
          }
          socket.close();
        } catch {}
      };

      socket.once('open', () => {
        try {
          socket.send(payload);
        } catch (err) {
          if (!settled) {
            settled = true;
            cleanup();
            reject(err);
          }
        }
      });

      socket.on('message', (data) => {
        if (!settled) {
          settled = true;
          let text = '';
          try {
            const parsed = JSON.parse(data.toString());
            text = String(parsed.text || '').trim();
          } catch {
            text = data.toString().trim();
          }
          cleanup();
          resolve(text);
        }
      });

      socket.once('error', (err) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(err);
        }
      });
    });
  }

  abortInferences() {
    for (const abort of this.inferenceAborts) abort();
    this.inferenceAborts.clear();
  }

  async stop({ force = false } = {}) {
    this.stopRequested = true;
    const child = this.child;
    this.child = null;
    this.wsUrl = null;
    if (!child) return;

    this.abortInferences();
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill(force ? 'SIGKILL' : 'SIGTERM');
    if (force) return;

    let exitTimeout = null;
    const closedGracefully = await Promise.race([
      exited.then(() => true),
      new Promise((resolve) => {
        exitTimeout = setTimeout(() => resolve(false), PROCESS_EXIT_TIMEOUT_MS);
      })
    ]);
    if (exitTimeout) clearTimeout(exitTimeout);

    if (!closedGracefully && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
  }
}

module.exports = {
  SherpaServerSession,
  LOOPBACK_HOST,
  findFreeLoopbackPort
};

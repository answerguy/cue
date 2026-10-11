// gemini-live-help.js — Live bidirectional assistant using Gemini Live API.
// Connects via @google/genai's live.connect WebSocket to provide real-time help.

const { appendResumeContext, appendAiRules } = require('./profile-context');
const { buildInterviewContext } = require('./interview-context');

const GEMINI_LIVE_DEFAULT_FAST = 'gemini-3.8-live';
const GEMINI_LIVE_DEFAULT_SMART = 'gemini-3.8-live-extended-thinking';

/**
 * Resolves the active model for Gemini Live Help based on the fast/smart tier.
 * Both tiers are user-configurable in settings.
 */
function resolveGeminiLiveModel(settings) {
  const s = settings || {};
  const isSmart = Boolean(s.smart);
  const tier = isSmart ? 'smart' : 'fast';

  const configured =
    (s.liveHelp && s.liveHelp.models && s.liveHelp.models[tier]) ||
    (s.models && s.models.geminiLive && s.models.geminiLive[tier]) ||
    (s.models && s.models['gemini-live'] && s.models['gemini-live'][tier]);

  if (configured && typeof configured === 'string' && configured.trim()) {
    return configured.trim();
  }

  return isSmart ? GEMINI_LIVE_DEFAULT_SMART : GEMINI_LIVE_DEFAULT_FAST;
}

/**
 * Constructs the system instruction for the live assistant session,
 * embedding interview/resume context and user AI rules.
 */
function buildLiveHelpSystem(settings = {}) {
  let basePrompt =
    'You are cue, an invisible real-time copilot assisting the candidate live during an interview, meeting, or technical coding session.\n' +
    'Provide immediate, crisp, high-value answers and suggestions in first person ("I", "my").\n' +
    'Keep your advice concise (2-4 sentences or crisp bullet points), confident, and directly actionable.\n' +
    'No preamble or conversational filler. Deliver the exact thoughts, points, or code the user should state right now.';

  const resumeText = (settings && (settings.resumeConfig || (settings.profile && settings.profile.resume))) || '';
  if (resumeText) {
    try {
      const interviewCtx = buildInterviewContext(resumeText, 'live_help', []);
      if (interviewCtx) {
        basePrompt = interviewCtx + '\n\n' + basePrompt;
      } else {
        basePrompt = appendResumeContext(basePrompt, resumeText);
      }
    } catch (_) {
      basePrompt = appendResumeContext(basePrompt, resumeText);
    }
  }

  const hrText = settings && settings.hrConfig;
  if (hrText) {
    basePrompt += '\n\nAdditional behavioral / HR background stories:\n' + hrText.slice(0, 4000);
  }

  const aiRules = settings && settings.aiRules;
  if (aiRules) {
    basePrompt = appendAiRules(basePrompt, aiRules);
  }

  return basePrompt;
}

class GeminiLiveHelpSession {
  constructor(options = {}) {
    this.apiKey = options.apiKey || '';
    this.model = options.model || GEMINI_LIVE_DEFAULT_FAST;
    this.systemInstruction = options.systemInstruction || 'You are cue, an invisible real-time copilot.';
    this.createClient = options.createClient || ((apiKey) => {
      const { GoogleGenAI } = require('@google/genai');
      return new GoogleGenAI({ apiKey });
    });

    this.responseModalities = options.responseModalities || null;
    this.onStatusChange = options.onStatusChange || (() => {});
    this.onToken = options.onToken || (() => {});
    this.onTurnComplete = options.onTurnComplete || (() => {});
    this.onError = options.onError || (() => {});

    this.connected = false;
    this._connecting = false;
    this._closedByUs = false;
    this.session = null;
    this._currentResponse = '';
    this._pendingAudio = [];
  }

  async connect() {
    if (this.connected || this._connecting) return;
    this._connecting = true;
    this._closedByUs = false;
    this.onStatusChange('connecting');

    try {
      if (!this.apiKey) {
        throw new Error('Gemini API key is required for Live Help');
      }

      const isTranscribeModel = this.model && this.model.includes('transcribe');
      const responseModalities = this.responseModalities || (isTranscribeModel ? ['TEXT'] : ['AUDIO']);

      const liveConfig = {
        responseModalities,
        systemInstruction: {
          parts: [{ text: this.systemInstruction }]
        }
      };

      if (responseModalities.includes('AUDIO')) {
        liveConfig.outputAudioTranscription = {};
        liveConfig.inputAudioTranscription = {};
      }

      const ai = this.createClient(this.apiKey);
      const attempt = ai.live.connect({
        model: this.model,
        config: liveConfig,
        callbacks: {
          onopen: () => {
            this.connected = true;
            this.onStatusChange('connected');
            this._flushPendingAudio();
          },
          onmessage: (msg) => {
            this._handleMessage(msg);
          },
          onerror: (err) => {
            this.onError({ message: (err && err.message) || 'Gemini Live error' });
          },
          onclose: (evt) => {
            this.connected = false;
            this.session = null;
            this.onStatusChange('disconnected');
            if (!this._closedByUs && evt && evt.reason) {
              this.onError({ message: evt.reason });
            }
          }
        }
      });

      this.session = await attempt;
      this.connected = true;
      this.onStatusChange('connected');
      this._flushPendingAudio();
    } catch (err) {
      this.connected = false;
      this.session = null;
      this.onStatusChange('error');
      this.onError({ message: (err && err.message) || String(err) });
    } finally {
      this._connecting = false;
    }
  }

  _handleMessage(msg) {
    if (!msg) return;
    const sc = msg.serverContent;
    if (sc) {
      // 1. Output audio transcription (real-time text transcript of the model's response)
      const transcriptText =
        (sc.outputTranscription && sc.outputTranscription.text) ||
        (sc.outputAudioTranscription && sc.outputAudioTranscription.text);

      if (transcriptText && typeof transcriptText === 'string') {
        let textDelta = '';
        // Handle both incremental delta chunks and cumulative text
        if (this._currentResponse && transcriptText.startsWith(this._currentResponse)) {
          textDelta = transcriptText.slice(this._currentResponse.length);
        } else {
          textDelta = transcriptText;
        }
        if (textDelta) {
          this._currentResponse += textDelta;
          this.onToken(textDelta);
        }
      } else if (sc.modelTurn && sc.modelTurn.parts) {
        // Fallback for models that emit TEXT parts in modelTurn
        for (const part of sc.modelTurn.parts) {
          if (part && typeof part.text === 'string' && part.text) {
            this._currentResponse += part.text;
            this.onToken(part.text);
          }
        }
      }

      if (sc.turnComplete || sc.generationComplete || msg.turnComplete) {
        const full = this._currentResponse;
        this._currentResponse = '';
        this.onTurnComplete(full);
      }
    }
  }

  sendAudio(pcmBuffer) {
    const buf = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer);
    if (!this.connected || !this.session) {
      this._pendingAudio.push(buf);
      if (this._pendingAudio.length > 50) this._pendingAudio.shift(); // ~5s buffer while connecting
      return;
    }
    this._sendAudioChunk(buf);
  }

  _sendAudioChunk(buf) {
    try {
      this.session.sendRealtimeInput({
        audio: {
          data: buf.toString('base64'),
          mimeType: 'audio/pcm;rate=16000'
        }
      });
    } catch (err) {
      this.onError({ message: (err && err.message) || String(err) });
    }
  }

  _flushPendingAudio() {
    while (this._pendingAudio.length > 0 && this.connected && this.session) {
      const chunk = this._pendingAudio.shift();
      if (chunk) this._sendAudioChunk(chunk);
    }
  }

  sendText(text) {
    if (!this.connected || !this.session) return;
    try {
      this._currentResponse = '';
      this.session.sendClientContent({
        turns: [{
          role: 'user',
          parts: [{ text }]
        }],
        turnComplete: true
      });
    } catch (err) {
      this.onError({ message: (err && err.message) || String(err) });
    }
  }

  close() {
    this._closedByUs = true;
    this.connected = false;
    if (this.session) {
      try {
        this.session.close();
      } catch (_) {}
      this.session = null;
    }
    this.onStatusChange('disconnected');
  }
}

module.exports = {
  GEMINI_LIVE_DEFAULT_FAST,
  GEMINI_LIVE_DEFAULT_SMART,
  resolveGeminiLiveModel,
  buildLiveHelpSystem,
  GeminiLiveHelpSession
};

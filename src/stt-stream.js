// Streaming speech-to-text (Deepgram) — persistent WS per channel, ~200-300ms results,
// instead of the batch flushChannel()/Whisper path in main.js. Only active when a
// Deepgram key is set; main.js falls back to the batch pipeline otherwise.
// Audio in is raw Int16LE mono 16kHz PCM (see renderer/pcm-processor.js) — this is
// exactly Deepgram's 'linear16' format, so chunks are forwarded as-is, no re-encoding.

const { looksLikeHallucination } = require('./stt');

function createStreamingSTT(settings, { onPartial, onFinal, onError }) {
  const key = (settings.apiKeys || {}).deepgram;
  if (!key) return { available: false, send() {}, close() {} };

  const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
  const deepgram = createClient(key);
  const channels = {};

  function openChannel(channel) {
    let committed = ''; // text from is_final segments not yet closed out by speech_final
    const conn = deepgram.listen.live({
      model: 'nova-2',
      encoding: 'linear16',
      sample_rate: 16000,
      channels: 1,
      interim_results: true,
      smart_format: true,
      endpointing: 300,
      utterance_end_ms: 1000
    });

    conn.on(LiveTranscriptionEvents.Transcript, (data) => {
      const alt = data && data.channel && data.channel.alternatives && data.channel.alternatives[0];
      const text = alt && alt.transcript;

      if (data && data.speech_final) {
        const full = (committed + ' ' + (text || '')).trim();
        committed = '';
        if (full && !looksLikeHallucination(full)) onFinal(channel, full);
        onPartial(channel, '');
        return;
      }
      if (!text) return;
      if (data.is_final) {
        committed = (committed + ' ' + text).trim();
        onPartial(channel, committed);
      } else {
        onPartial(channel, (committed + ' ' + text).trim());
      }
    });
    conn.on(LiveTranscriptionEvents.Error, (e) => onError(channel, e));

    return conn;
  }

  channels.you = openChannel('you');
  channels.them = openChannel('them');

  return {
    available: true,
    send(channel, pcmBuffer) {
      const conn = channels[channel];
      if (conn && conn.getReadyState() === 1) conn.send(pcmBuffer);
    },
    close() {
      Object.values(channels).forEach((c) => { try { c.requestClose(); } catch (_) { /* already closed */ } });
    }
  };
}

module.exports = { createStreamingSTT };

const DEFAULT_SHERPA_MODEL_ID = 'parakeet-ctc-0.6b';

const SHERPA_MODELS = Object.freeze([
  {
    id: 'parakeet-ctc-0.6b',
    name: 'Conformer CTC Medium (English, Fast)',
    family: 'conformer',
    architecture: 'nemo_ctc',
    hardwareTier: 'Light',
    englishOnly: true,
    description: 'NeMo Conformer CTC Medium (INT8). Lightweight (~67MB), fast non-autoregressive transcription.',
    bytes: 67644353,
    filename: 'model.int8.onnx',
    tokensFilename: 'tokens.txt',
    files: [
      {
        filename: 'model.int8.onnx',
        url: 'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-ctc-en-conformer-medium/resolve/main/model.int8.onnx',
        bytes: 67632742
      },
      {
        filename: 'tokens.txt',
        url: 'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-ctc-en-conformer-medium/resolve/main/tokens.txt',
        bytes: 11611
      }
    ]
  },
  {
    id: 'parakeet-tdt-0.6b',
    name: 'Parakeet TDT 0.6B (English, Recommended)',
    family: 'parakeet',
    architecture: 'nemo_transducer',
    hardwareTier: 'Balanced',
    englishOnly: true,
    description: 'NVIDIA FastConformer TDT (Transducer). State-of-the-art accuracy on conversational English.',
    bytes: 670478772,
    filename: 'encoder.int8.onnx',
    decoderFilename: 'decoder.int8.onnx',
    joinerFilename: 'joiner.int8.onnx',
    tokensFilename: 'tokens.txt',
    files: [
      {
        filename: 'encoder.int8.onnx',
        url: 'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main/encoder.int8.onnx',
        bytes: 652184281
      },
      {
        filename: 'decoder.int8.onnx',
        url: 'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main/decoder.int8.onnx',
        bytes: 11845275
      },
      {
        filename: 'joiner.int8.onnx',
        url: 'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main/joiner.int8.onnx',
        bytes: 6355277
      },
      {
        filename: 'tokens.txt',
        url: 'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main/tokens.txt',
        bytes: 93939
      }
    ]
  },
  {
    id: 'parakeet-ctc-1.1b',
    name: 'FastConformer CTC Large (English)',
    family: 'conformer',
    architecture: 'nemo_ctc',
    hardwareTier: 'Heavy',
    englishOnly: true,
    description: 'Full-scale NeMo FastConformer CTC (FP32). High accuracy on challenging noisy audio.',
    bytes: 458172755,
    filename: 'model.onnx',
    tokensFilename: 'tokens.txt',
    files: [
      {
        filename: 'model.onnx',
        url: 'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-fast-conformer-ctc-en-24500/resolve/main/model.onnx',
        bytes: 458161322
      },
      {
        filename: 'tokens.txt',
        url: 'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-fast-conformer-ctc-en-24500/resolve/main/tokens.txt',
        bytes: 11433
      }
    ]
  }
]);

const MODEL_MAP = new Map(SHERPA_MODELS.map((m) => [m.id, m]));

function getSherpaModel(modelId) {
  return MODEL_MAP.get(modelId) || null;
}

function requireSherpaModel(modelId) {
  const model = getSherpaModel(modelId);
  if (!model) throw new Error(`Unknown Sherpa-ONNX model "${modelId}".`);
  return model;
}

module.exports = {
  DEFAULT_SHERPA_MODEL_ID,
  SHERPA_MODELS,
  getSherpaModel,
  requireSherpaModel
};

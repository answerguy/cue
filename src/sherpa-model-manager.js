const fs = require('fs');
const path = require('path');
const { once } = require('events');
const { finished } = require('stream/promises');
const { SHERPA_MODELS, requireSherpaModel } = require('./sherpa-model-catalog');

const MODEL_DIRECTORY_NAME = 'sherpa-models';
const PROGRESS_INTERVAL_MS = 150;

class SherpaModelManager {
  /**
   * Manage verified model artifacts under Electron's userData directory.
   */
  constructor({ userDataPath, fetchImpl = global.fetch, now = Date.now, models = SHERPA_MODELS } = {}) {
    if (!userDataPath) throw new Error('SherpaModelManager requires a userDataPath.');
    this.modelDirectory = path.join(userDataPath, MODEL_DIRECTORY_NAME);
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.models = Object.freeze(Array.from(models));
    this.modelById = new Map(this.models.map((model) => [model.id, model]));
    this.activeDownload = null;
  }

  getModelDir(modelId) {
    const model = requireSherpaModel(modelId);
    return path.join(this.modelDirectory, model.id);
  }

  getModelPath(modelId) {
    const model = requireSherpaModel(modelId);
    return path.join(this.getModelDir(modelId), model.filename);
  }

  getTokensPath(modelId) {
    const model = requireSherpaModel(modelId);
    return path.join(this.getModelDir(modelId), model.tokensFilename);
  }

  async _getFileSize(filePath) {
    try {
      const stat = await fs.promises.stat(filePath);
      return stat.size;
    } catch (err) {
      if (err.code === 'ENOENT') return 0;
      throw err;
    }
  }

  async listModels() {
    await fs.promises.mkdir(this.modelDirectory, { recursive: true });
    return Promise.all(this.models.map(async (model) => {
      const modelDir = this.getModelDir(model.id);
      const files = model.files || [{ filename: model.filename, bytes: model.bytes }];

      let totalInstalledBytes = 0;
      let allFilesPresent = true;

      for (const file of files) {
        const filePath = path.join(modelDir, file.filename);
        const size = await this._getFileSize(filePath);
        totalInstalledBytes += size;
        if (size === 0 || (file.bytes && size !== file.bytes)) {
          allFilesPresent = false;
        }
      }

      return {
        ...model,
        installed: allFilesPresent && totalInstalledBytes > 0,
        installedBytes: totalInstalledBytes,
        downloading: this.activeDownload?.modelId === model.id
      };
    }));
  }

  async verifyInstalledModel(modelId) {
    const model = requireSherpaModel(modelId);
    const modelDir = this.getModelDir(model.id);
    const files = model.files || [{ filename: model.filename, bytes: model.bytes }];

    for (const file of files) {
      const filePath = path.join(modelDir, file.filename);
      const size = await this._getFileSize(filePath);
      if (size === 0) {
        const error = new Error(`Required model file ${file.filename} is missing or empty.`);
        error.code = 'ENOENT';
        throw error;
      }
    }

    const res = {
      modelId: model.id,
      architecture: model.architecture,
      modelDir,
      tokensPath: this.getTokensPath(model.id)
    };

    if (model.architecture === 'nemo_transducer') {
      res.encoderPath = path.join(modelDir, model.filename);
      res.decoderPath = path.join(modelDir, model.decoderFilename);
      res.joinerPath = path.join(modelDir, model.joinerFilename);
    } else {
      res.modelPath = this.getModelPath(model.id);
    }

    return res;
  }

  async download(modelId, onProgress = () => {}) {
    const model = requireSherpaModel(modelId);
    if (this.activeDownload) {
      throw new Error(`Already downloading ${this.activeDownload.modelId}.`);
    }

    const modelDir = this.getModelDir(modelId);
    await fs.promises.mkdir(modelDir, { recursive: true });

    const abortController = new AbortController();
    this.activeDownload = { modelId, abortController };

    const files = model.files || [];
    let completedBytesTotal = 0;
    let lastProgressAt = 0;

    try {
      for (const file of files) {
        const targetPath = path.join(modelDir, file.filename);
        const partialPath = `${targetPath}.part`;

        const existingSize = await this._getFileSize(targetPath);
        if (file.bytes && existingSize === file.bytes) {
          completedBytesTotal += existingSize;
          continue;
        }

        let partialBytes = await this._getFileSize(partialPath);
        if (file.bytes && partialBytes > file.bytes) {
          await fs.promises.truncate(partialPath, 0);
          partialBytes = 0;
        }

        const headers = partialBytes > 0 ? { Range: `bytes=${partialBytes}-` } : {};
        const response = await this.fetchImpl(file.url, {
          headers,
          redirect: 'follow',
          signal: abortController.signal
        });

        if (!response.ok) {
          throw new Error(`Download of ${file.filename} failed with HTTP ${response.status}.`);
        }

        const shouldAppend = partialBytes > 0 && response.status === 206;
        if (!shouldAppend) partialBytes = 0;

        const output = fs.createWriteStream(partialPath, { flags: shouldAppend ? 'a' : 'w' });
        const outputFinished = finished(output);

        try {
          if (!response.body) {
            // Buffer response if body stream is not available
            const arrayBuffer = await response.arrayBuffer();
            output.write(Buffer.from(arrayBuffer));
            completedBytesTotal += arrayBuffer.byteLength;
          } else {
            for await (const chunk of response.body) {
              const buf = Buffer.from(chunk);
              completedBytesTotal += buf.length;
              if (!output.write(buf)) await once(output, 'drain');

              const progressTime = this.now();
              if (progressTime - lastProgressAt >= PROGRESS_INTERVAL_MS) {
                lastProgressAt = progressTime;
                onProgress({
                  modelId: model.id,
                  receivedBytes: completedBytesTotal,
                  totalBytes: model.bytes,
                  percent: Math.min(99, Math.floor((completedBytesTotal / model.bytes) * 100))
                });
              }
            }
          }
        } finally {
          output.end();
          await outputFinished;
        }

        await fs.promises.rename(partialPath, targetPath);
      }

      onProgress({
        modelId: model.id,
        receivedBytes: model.bytes,
        totalBytes: model.bytes,
        percent: 100
      });
      return { modelId, installed: true };
    } catch (error) {
      if (abortController.signal.aborted) {
        const cancelledError = new Error(`Download cancelled for ${modelId}.`);
        cancelledError.code = 'DOWNLOAD_CANCELLED';
        throw cancelledError;
      }
      throw error;
    } finally {
      this.activeDownload = null;
    }
  }

  cancelDownload(modelId) {
    if (!this.activeDownload || this.activeDownload.modelId !== modelId) return false;
    this.activeDownload.abortController.abort();
    return true;
  }

  async importModel(modelId, sourcePath) {
    const model = requireSherpaModel(modelId);
    const modelDir = this.getModelDir(model.id);
    await fs.promises.mkdir(modelDir, { recursive: true });

    const stats = await fs.promises.stat(sourcePath);
    if (stats.isDirectory()) {
      const files = await fs.promises.readdir(sourcePath);
      for (const f of files) {
        await fs.promises.copyFile(path.join(sourcePath, f), path.join(modelDir, f));
      }
    } else {
      const dest = path.join(modelDir, model.filename);
      await fs.promises.copyFile(sourcePath, dest);
      const tokensDest = path.join(modelDir, model.tokensFilename);
      if (!fs.existsSync(tokensDest)) {
        await fs.promises.writeFile(tokensDest, '<blk> 0\n');
      }
    }
    return { modelId: model.id, installed: true };
  }

  async deleteModel(modelId) {
    const model = requireSherpaModel(modelId);
    const modelDir = this.getModelDir(model.id);
    if (fs.existsSync(modelDir)) {
      await fs.promises.rm(modelDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
    return { modelId: model.id, deleted: true };
  }
}

module.exports = { SherpaModelManager, MODEL_DIRECTORY_NAME };

const fs = require('fs');
const path = require('path');

/**
 * Cleans text from resume.txt / hr.txt to ensure special characters
 * (especially double quotes " ", curly quotes, control chars, and lone surrogates)
 * cannot break JSON structure.
 *
 * @param {string} text Raw text content
 * @returns {string} Sanitized clean text content
 */
function cleanTextDump(text) {
  if (typeof text !== 'string') return '';

  let cleaned = text;

  // Strip Byte Order Mark (BOM)
  if (cleaned.charCodeAt(0) === 0xfeff) {
    cleaned = cleaned.slice(1);
  }

  // Normalize line endings to standard Unix \n
  cleaned = cleaned.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Strip trailing whitespace per line
  cleaned = cleaned.replace(/[ \t]+$/gm, '');

  // Replace escaped double quotes \" and raw double quotes with single quotes
  cleaned = cleaned.replace(/\\"/g, "'");
  cleaned = cleaned.replace(/["“”„‟«»]/g, "'");

  // Normalize typographic / smart single quotes to standard single quote
  cleaned = cleaned.replace(/[‘’‚‛]/g, "'");

  // Normalize non-breaking and special unicode spaces to regular space
  cleaned = cleaned.replace(/[\u00A0\u2000-\u200A\u202F\u205F]/g, ' ');

  // Strip zero-width spaces and formatting artifacts
  cleaned = cleaned.replace(/[\u200B-\u200D\uFEFF]/g, '');

  // Strip ASCII control characters forbidden in JSON strings
  cleaned = cleaned.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // Strip unpaired surrogate code units that break UTF-8 encoders
  cleaned = cleaned.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');

  // Normalize excessive blank lines (more than 2 consecutive newlines)
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  return cleaned.trim();
}

/**
 * Bundles portable-config.json for packaged builds.
 *
 * If resume.txt and/or hr.txt exist in the root of the project:
 * - Appends the contents into hrConfig (and resume.txt into resumeConfig).
 * - Never modifies src/portable-config.example.json.
 * - Writes the resulting configuration to appOutDir/portable-config.json.
 *
 * @param {object} options
 * @param {string} [options.projectRoot] Root folder of the project.
 * @param {string} [options.appOutDir] Destination output directory for the build.
 * @returns {object|null} The bundled config object or null if no source config exists.
 */
function bundlePortableConfig(options = {}) {
  const projectRoot = options.projectRoot || path.join(__dirname, '..');
  const appOutDir = options.appOutDir || null;
  const srcPortableConfig = path.join(projectRoot, 'src', 'portable-config.json');
  const exampleConfig = path.join(projectRoot, 'src', 'portable-config.example.json');
  const hrTxtPath = path.join(projectRoot, 'hr.txt');
  const resumeTxtPath = path.join(projectRoot, 'resume.txt');

  const configSourcePath = fs.existsSync(srcPortableConfig)
    ? srcPortableConfig
    : (fs.existsSync(exampleConfig) ? exampleConfig : null);

  if (!configSourcePath) return null;

  let config;
  try {
    config = JSON.parse(fs.readFileSync(configSourcePath, 'utf8'));
  } catch (err) {
    console.warn('[bundle-portable-config] could not parse config source:', err.message);
    return null;
  }

  let hrText = '';
  if (fs.existsSync(hrTxtPath)) {
    try {
      const raw = fs.readFileSync(hrTxtPath, 'utf8');
      const cleaned = cleanTextDump(raw);
      // If the file contained characters that needed cleaning, clean the .txt file on disk
      if (raw.trim() !== cleaned) {
        try {
          fs.writeFileSync(hrTxtPath, cleaned ? cleaned + '\n' : '', 'utf8');
          console.log('[bundle-portable-config] Cleaned special characters in hr.txt');
        } catch (_) {}
      }
      hrText = cleaned;
    } catch (_) {}
  }

  let resumeText = '';
  if (fs.existsSync(resumeTxtPath)) {
    try {
      const raw = fs.readFileSync(resumeTxtPath, 'utf8');
      const cleaned = cleanTextDump(raw);
      // If the file contained characters that needed cleaning, clean the .txt file on disk
      if (raw.trim() !== cleaned) {
        try {
          fs.writeFileSync(resumeTxtPath, cleaned ? cleaned + '\n' : '', 'utf8');
          console.log('[bundle-portable-config] Cleaned special characters in resume.txt');
        } catch (_) {}
      }
      resumeText = cleaned;
    } catch (_) {}
  }

  if (hrText || resumeText) {
    // Append contents of hr.txt and resume.txt into hrConfig
    const hrParts = [];
    if (config.hrConfig && typeof config.hrConfig === 'string' && config.hrConfig.trim()) {
      hrParts.push(config.hrConfig.trim());
    }
    if (hrText && !hrParts.some(p => p.includes(hrText))) {
      hrParts.push(hrText);
    }
    if (resumeText && !hrParts.some(p => p.includes(resumeText))) {
      hrParts.push(resumeText);
    }
    if (hrParts.length > 0) {
      config.hrConfig = hrParts.join('\n\n');
    }

    // Also append resume.txt into resumeConfig
    if (resumeText) {
      const resumeParts = [];
      if (config.resumeConfig && typeof config.resumeConfig === 'string' && config.resumeConfig.trim()) {
        resumeParts.push(config.resumeConfig.trim());
      }
      if (!resumeParts.some(p => p.includes(resumeText))) {
        resumeParts.push(resumeText);
      }
      config.resumeConfig = resumeParts.join('\n\n');
    }
  }

  if (options.updateSrc && fs.existsSync(srcPortableConfig)) {
    fs.writeFileSync(srcPortableConfig, JSON.stringify(config, null, 2), 'utf8');
    console.log('[bundle-portable-config] Updated src/portable-config.json');
  }

  if (appOutDir && fs.existsSync(appOutDir)) {
    const outConfigPath = path.join(appOutDir, 'portable-config.json');
    fs.writeFileSync(outConfigPath, JSON.stringify(config, null, 2), 'utf8');
    console.log(`[bundle-portable-config] Copied config -> ${outConfigPath}`);
  }

  return config;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  let appOutDir = null;
  const outIdx = args.indexOf('--out');
  if (outIdx !== -1 && args[outIdx + 1]) {
    appOutDir = args[outIdx + 1];
  }
  const updateSrc = args.includes('--update-src');
  bundlePortableConfig({ appOutDir, updateSrc });
}

module.exports = { bundlePortableConfig, cleanTextDump };

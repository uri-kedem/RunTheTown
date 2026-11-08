#!/usr/bin/env node
// Applies RunTheTown's fixes to installed Capacitor plugins (node_modules is not in git, so
// every `npm install` brings back the stock files). Runs as part of `npm run ios`; safe to rerun.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const patches = [
  {
    name: '@capacitor-community/text-to-speech',
    versions: ['6.1.0'],
    target: 'ios/Sources/TextToSpeechPlugin/TextToSpeech.swift',
    source: 'native/ios-patches/TextToSpeech.swift',
  },
];

for (const p of patches) {
  const pkgPath = join(root, 'node_modules', p.name, 'package.json');
  if (!existsSync(pkgPath)) { console.log(`patch: ${p.name} not installed, skipped`); continue; }
  const version = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
  if (!p.versions.includes(version)) {
    console.error(`patch: ${p.name} is ${version}, but the patch was written for ${p.versions.join(', ')}. Check native/ios-patches/ against the new plugin source before syncing.`);
    process.exit(1);
  }
  const target = join(root, 'node_modules', p.name, p.target);
  const wanted = readFileSync(join(root, p.source), 'utf8');
  if (readFileSync(target, 'utf8') === wanted) { console.log(`patch: ${p.name} already patched`); continue; }
  writeFileSync(target, wanted);
  console.log(`patch: ${p.name} ${version} patched (${p.target})`);
}

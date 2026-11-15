#!/usr/bin/env node
// Configures the Xcode project for RunTheTown's native pieces (see configure-ios.rb) and
// adds the permission texts and the Live Activity switch to Info.plist. Part of
// `npm run ios`; safe to rerun. Uses the Ruby and xcodeproj gem that CocoaPods brings.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const plist = join(root, 'ios/App/App/Info.plist');
const set = (key, type, value) => {
  try { execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { stdio: 'pipe' }); }
  catch { execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} ${type} ${value}`, plist]); console.log(`Info.plist: ${key} added`); }
};
set('NSHealthUpdateUsageDescription', 'string', 'To save your runs as workouts in Health (distance, time and the route).');
set('NSHealthShareUsageDescription', 'string', 'RunTheTown only writes your runs to Health; it reads nothing.');
set('NSSupportsLiveActivities', 'bool', 'true');

// Ruby with the xcodeproj gem: CocoaPods' own copy (Homebrew), else whatever `gem` installed.
const cellar = '/opt/homebrew/Cellar/cocoapods';
let env = { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' };
if (existsSync(cellar)) {
  const v = readdirSync(cellar).sort().pop();
  const gems = join(cellar, v, 'libexec');
  if (existsSync(join(gems, 'gems'))) env = { ...env, GEM_HOME: gems }; // GEM_PATH is left alone so Ruby's own default gems (rexml) stay visible
}
// Homebrew's Ruby (the one CocoaPods was built for), not the old system one.
const ruby = ['/opt/homebrew/opt/ruby/bin/ruby', '/usr/local/opt/ruby/bin/ruby'].find((p) => existsSync(p)) || 'ruby';
execFileSync(ruby, [join(root, 'native/configure-ios.rb')], { stdio: 'inherit', env });

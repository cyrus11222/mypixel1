import { execFileSync } from 'node:child_process';
// Vercel exit codes: 0 skips deployment; 1 proceeds with the build.
// Compare with the last successful deployment, not the previous Git commit:
// an account-data commit may follow code that has not been deployed yet.
const build = message => { console.log(`Building: ${message}`); process.exit(1); };
const previousSha = process.env.VERCEL_GIT_PREVIOUS_SHA?.trim();
if (!previousSha || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(previousSha)) {
  build('no valid previous successful deployment SHA is available.');
}
const git = args => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
try {
  git(['rev-parse', '--verify', `${previousSha}^{commit}`]);
  git(['rev-parse', '--verify', 'HEAD^{commit}']);
  // A shallow clone, rewritten history, or unexpected branch relationship must
  // build rather than make an unverified decision to skip deployment.
  git(['merge-base', '--is-ancestor', previousSha, 'HEAD']);
  const files = git(['diff', '--no-renames', '--no-relative', '--name-only', '-z', previousSha, 'HEAD', '--']).split('\0').filter(Boolean);
  if (files.length > 0 && files.every(file => file === 'user.txt')) {
    console.log('Data-only deployment skipped: only user.txt changed since the previous successful deployment.');
    console.log('For environment-variable changes, Redeploy with "Use project\'s Ignore Build Step" unchecked.');
    process.exit(0);
  }
  build('code changed, or this is a redeployment of the same commit.');
} catch {
  build('the previous deployment history could not be verified; continuing safely.');
}

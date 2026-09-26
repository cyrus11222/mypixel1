import { execFileSync } from 'node:child_process';
// Skip only data-only changes. Do not trust a commit message to skip code changes.
try {
  const files=execFileSync('git',['diff','--name-only','HEAD^','HEAD'],{encoding:'utf8'}).trim().split('\n').filter(Boolean);
  process.exit(files.length>0 && files.every(file=>file==='user.txt') ? 0 : 1);
} catch { process.exit(1); }

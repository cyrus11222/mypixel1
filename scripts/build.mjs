import { cp, mkdir } from 'node:fs/promises';
// Only static assets are published. HTML is served by the Vercel functions.
await mkdir('dist/assets', { recursive: true });
await cp('assets', 'dist/assets', { recursive: true });
console.log('Static assets ready; HTML remains behind page functions.');

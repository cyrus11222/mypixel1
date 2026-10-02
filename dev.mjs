// Local development only. Vercel runs api/*.js directly; it never runs this file.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import site from './api/site.js';
import auth from './api/auth.js';
import login from './api/login.js';

const root = path.dirname(fileURLToPath(import.meta.url));
process.chdir(root);
process.env.AUTH_STORE ||= 'local';
process.env.APP_ORIGIN ||= 'http://127.0.0.1:3000';
process.env.RATE_LIMIT_SECRET ||= randomBytes(32).toString('hex');
const assets = new Map(['auth.css', 'auth.js', 'account.js', 'account-security.js', 'passkeys.js', 'community.css', 'operations.js', 'operations.css', 'brand.css', 'scene.jpg', 'mypixel-logo.png', 'skywolf-logo.png'].map(file => ['/assets/' + file, 'assets/' + file]));
export function createDevServer() {
  return http.createServer(async (req,res) => {
    const pathname = new URL(req.url,'http://localhost').pathname;
    try {
      if (['/','/index.html','/api/site'].includes(pathname)) return await site(req,res);
      if (pathname === '/api/auth') return await auth(req,res);
      if (['/login','/login.html','/api/login'].includes(pathname)) return await login(req,res);
      if (assets.has(pathname) && ['GET','HEAD'].includes(req.method)) {
        const file = assets.get(pathname);
        const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.jpg':'image/jpeg','.png':'image/png'};
        res.setHeader('Content-Type',types[path.extname(file)]); res.setHeader('X-Content-Type-Options','nosniff');
        res.end(req.method === 'HEAD' ? '' : await readFile(path.join(root,file))); return;
      }
      res.statusCode=404;res.end('Not found');
    } catch { res.statusCode=503;res.end('Service unavailable'); }
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createDevServer().listen(Number(process.env.PORT || 3000),'127.0.0.1',()=>console.log(`Local preview: ${process.env.APP_ORIGIN}\nStorage: ${process.env.AUTH_STORE} (local mode does not write to GitHub)`));
}

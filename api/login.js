import { readFile } from 'node:fs/promises';
import path from 'node:path';
export default async function handler(req, res) {
  if (!['GET','HEAD'].includes(req.method)) { res.statusCode=405;res.setHeader('Allow','GET, HEAD');res.end();return; }
  try {
    const html=(await readFile(path.join(process.cwd(),'login.html'),'utf8')).replaceAll('href="assets/','href="/assets/').replaceAll('src="assets/','src="/assets/');
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Frame-Options','DENY');
    res.statusCode=200;res.end(req.method==='HEAD'?'':html);
  } catch { res.statusCode=503;res.end('Login page unavailable'); }
}

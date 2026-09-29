import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { authService, common, token } from '../lib/http.mjs';
let htmlPromise;
export default async function handler(req, res) {
  common(res);
  if (!['GET', 'HEAD'].includes(req.method)) { res.statusCode = 405; res.setHeader('Allow', 'GET, HEAD'); return res.end(); }
  try {
    const sessionToken = token(req);
    const user = sessionToken ? await authService().session(sessionToken) : null;
    if (!user) { res.statusCode = 302; res.setHeader('Location', '/login'); return res.end(); }
    htmlPromise ||= readFile(path.join(process.cwd(), 'index.html'), 'utf8').catch(e => { htmlPromise = null; throw e; });
    const html = (await htmlPromise).replaceAll('href="assets/', 'href="/assets/').replaceAll('src="assets/', 'src="/assets/');
    const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`).join(' ');
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' ${hashes}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.statusCode = 200; res.end(req.method === 'HEAD' ? '' : html);
  } catch {
    res.statusCode = 503; res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>mypixel club</title><body style="background:#101c18;color:#f4f6ee;font:18px sans-serif;padding:10vw"><h1>暂时无法验证登录状态</h1><p>请稍后刷新，或联系服主检查账户服务。</p><a style="color:#c4f477" href="/login">返回登录页</a></body></html>');
  }
}

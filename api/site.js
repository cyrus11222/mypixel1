import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { common } from '../lib/http.mjs';
let htmlPromise;
export default async function handler(req, res) {
  common(res);
  if (!['GET', 'HEAD'].includes(req.method)) { res.statusCode = 405; res.setHeader('Allow', 'GET, HEAD'); return res.end(); }
  try {
    // Public browsing must remain available even when account storage is offline.
    // Account mutations still require a validated session in api/auth.js.
    htmlPromise ||= readFile(path.join(process.cwd(), 'index.html'), 'utf8').catch(e => { htmlPromise = null; throw e; });
    // HTML parsers normalize Windows line endings before checking script hashes.
    const html = (await htmlPromise).replace(/\r\n?/g, '\n').replaceAll('href="assets/', 'href="/assets/').replaceAll('src="assets/', 'src="/assets/');
    const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`).join(' ');
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' ${hashes}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.statusCode = 200; res.end(req.method === 'HEAD' ? '' : html);
  } catch {
    res.statusCode = 503; res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>mypixel club</title><body style="background:#101c18;color:#f4f6ee;font:18px sans-serif;padding:10vw"><h1>页面暂时无法加载</h1><p>请稍后刷新，或联系服主检查部署文件。</p></body></html>');
  }
}

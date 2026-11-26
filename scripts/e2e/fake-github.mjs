// A small fake of the GitHub REST API: enough for Experiment Guard's comment, review, override
// and status calls. It keeps state in memory and records every request to $GH_LOG (JSON lines).
import http from 'node:http';
import fs from 'node:fs';

const PORT = Number(process.env.PORT ?? 9200);
const TOKEN = process.env.GH_TOKEN ?? 'ghs_e2e';
const LOG = process.env.GH_LOG;
if (LOG) fs.writeFileSync(LOG, '');

const comments = new Map(); // "owner/repo#n" -> [{id, body, html_url, user}]
const prState = new Map();  // "owner/repo#n" -> 'open' | 'closed'
const labelEvents = new Map(); // "owner/repo#n" -> [{event, label, actor, created_at}]
const roles = { maintainer1: 'maintain', newbie: 'read' };
let nextId = 5000;
const requests = [];

const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => (raw += c));
  req.on('end', () => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const p = url.pathname;
    const body = raw ? JSON.parse(raw) : undefined;
    const entry = { method: req.method, path: p + url.search, auth: req.headers.authorization, body };
    if (!p.startsWith('/__admin/')) requests.push(entry);
    if (LOG) fs.appendFileSync(LOG, JSON.stringify(entry) + '\n');
    if (p.startsWith('/__admin/')) {
      if (p === '/__admin/label') { // { repo, pr, label, actor }
        const k = `${body.repo}#${body.pr}`;
        labelEvents.set(k, [...(labelEvents.get(k) ?? []), { event: 'labeled', label: { name: body.label }, actor: { login: body.actor }, created_at: new Date().toISOString() }]);
        return send(res, 200, { ok: true });
      }
      if (p === '/__admin/state') return send(res, 200, { comments: Object.fromEntries(comments), requests });
      if (p === '/__admin/close') { prState.set(`${body.repo}#${body.pr}`, 'closed'); return send(res, 200, { ok: true }); }
      return send(res, 404, {});
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}` && req.headers.authorization !== `token ${TOKEN}`) return send(res, 401, { message: 'Bad credentials' });
    let m;
    if ((m = p.match(/^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/))) {
      const k = `${m[1]}#${m[2]}`;
      if (req.method === 'GET') return send(res, 200, comments.get(k) ?? []);
      const id = nextId++;
      const c = { id, body: body.body, user: { login: 'github-actions[bot]' }, html_url: `https://github.com/${m[1]}/pull/${m[2]}#issuecomment-${id}` };
      comments.set(k, [...(comments.get(k) ?? []), c]);
      return send(res, 201, c);
    }
    if ((m = p.match(/^\/repos\/([^/]+\/[^/]+)\/issues\/comments\/(\d+)$/)) && req.method === 'PATCH') {
      for (const list of comments.values()) for (const c of list) if (c.id === Number(m[2])) { c.body = body.body; return send(res, 200, c); }
      return send(res, 404, { message: 'Not Found' });
    }
    if ((m = p.match(/^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/events$/))) return send(res, 200, labelEvents.get(`${m[1]}#${m[2]}`) ?? []);
    if ((m = p.match(/^\/repos\/([^/]+\/[^/]+)\/collaborators\/([^/]+)\/permission$/))) {
      const role = roles[decodeURIComponent(m[2])] ?? 'read';
      return send(res, 200, { permission: role === 'maintain' ? 'write' : role, role_name: role, user: { login: m[2] } });
    }
    if ((m = p.match(/^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/reviews$/))) return send(res, 200, { id: nextId++, state: 'COMMENTED', body: body?.body });
    if ((m = p.match(/^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/))) return send(res, 200, { number: Number(m[2]), state: prState.get(`${m[1]}#${m[2]}`) ?? 'open' });
    if ((m = p.match(/^\/repos\/([^/]+\/[^/]+)\/statuses\/([0-9a-f]+)$/))) return send(res, 201, { id: nextId++, state: body.state, context: body.context, description: body.description });
    return send(res, 404, { message: 'Not Found' });
  });
}).listen(PORT, '127.0.0.1', () => process.stdout.write(`fake github on http://127.0.0.1:${PORT}\n`));

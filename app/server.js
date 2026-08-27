// Servidor do portal (Node puro, sem dependências externas).
// Serve a SPA em public/ e a API em /api. Rotas desconhecidas caem na SPA,
// que renderiza a tela 404 com a identidade visual do portal.
import { createServer } from 'node:http';
import { readFileSync, createReadStream, existsSync, statSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, one, run } from './src/db.js';
import { hashPassword, parseCookies, sessionCookie, userFromToken } from './src/auth.js';
import * as api from './src/api.js';
import { ApiError } from './src/api.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

export function seedAdmin(db, { email, password, name }) {
  if (one(db, 'SELECT id FROM users WHERE email = ?', email)) return false;
  run(db, "INSERT INTO users (name, email, passwordHash, role) VALUES (?, ?, ?, 'admin')",
    name, email, hashPassword(password));
  return true;
}

export function createApp({ dbPath, storageDir }) {
  const db = openDb(dbPath);

  async function readJsonBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) throw new ApiError(413, 'Requisição excede o tamanho máximo permitido.');
      chunks.push(chunk);
    }
    if (chunks.length === 0) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new ApiError(400, 'Corpo da requisição inválido.');
    }
  }

  function sendJson(res, status, payload, extraHeaders = {}) {
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders });
    res.end(body);
  }

  // Rotas da API: método + padrão com parâmetros :nome.
  const routes = [
    ['POST', '/api/auth/register', (ctx, p, body) => api.register(ctx, body)],
    ['POST', '/api/auth/login', (ctx, p, body) => api.login(ctx, body)],
    ['POST', '/api/auth/logout', (ctx) => api.logout(ctx)],
    ['GET', '/api/auth/me', (ctx) => api.me(ctx)],

    ['GET', '/api/projects', (ctx) => api.listMine(ctx)],
    ['GET', '/api/projects/:id/dashboard', (ctx, p) => api.dashboard(ctx, p.id)],
    ['POST', '/api/projects/:id/feedback', (ctx, p, body) => api.submitFeedback(ctx, p.id, body)],

    ['GET', '/api/admin/overview', (ctx) => api.adminOverview(ctx)],
    ['GET', '/api/admin/accounts', (ctx) => api.listAccounts(ctx)],
    ['POST', '/api/admin/projects', (ctx, p, body) => api.createProject(ctx, body)],
    ['GET', '/api/admin/projects/:id', (ctx, p) => api.adminProjectDetail(ctx, p.id)],
    ['PATCH', '/api/admin/projects/:id', (ctx, p, body) => api.updateProject(ctx, p.id, body)],
    ['DELETE', '/api/admin/projects/:id', (ctx, p) => api.deleteProject(ctx, p.id)],

    ['POST', '/api/admin/clients', (ctx, p, body) => api.createClient(ctx, body)],
    ['PATCH', '/api/admin/clients/:id', (ctx, p, body) => api.updateClient(ctx, p.id, body)],
    ['DELETE', '/api/admin/clients/:id', (ctx, p) => api.deleteClient(ctx, p.id)],
    ['POST', '/api/admin/projects/:id/clients', (ctx, p, body) => api.linkClient(ctx, p.id, body)],
    ['DELETE', '/api/admin/projects/:id/clients/:linkId', (ctx, p) => api.unlinkClient(ctx, p.id, p.linkId)],

    ['POST', '/api/admin/projects/:id/members', (ctx, p, body) => api.assignMember(ctx, p.id, body)],
    ['DELETE', '/api/admin/projects/:id/members/:memberId', (ctx, p) => api.removeMember(ctx, p.id, p.memberId)],

    ['POST', '/api/admin/projects/:id/milestones', (ctx, p, body) => api.createMilestone(ctx, p.id, body)],
    ['PATCH', '/api/admin/projects/:id/milestones/:mid', (ctx, p, body) => api.updateMilestone(ctx, p.id, p.mid, body)],
    ['DELETE', '/api/admin/projects/:id/milestones/:mid', (ctx, p) => api.deleteMilestone(ctx, p.id, p.mid)],

    ['POST', '/api/admin/projects/:id/deliverables', (ctx, p, body) => api.createDeliverable(ctx, p.id, body)],
    ['PATCH', '/api/admin/projects/:id/deliverables/:did', (ctx, p, body) => api.updateDeliverable(ctx, p.id, p.did, body)],
    ['DELETE', '/api/admin/projects/:id/deliverables/:did', (ctx, p) => api.deleteDeliverable(ctx, p.id, p.did)],

    ['POST', '/api/admin/projects/:id/contacts', (ctx, p, body) => api.createContact(ctx, p.id, body)],
    ['DELETE', '/api/admin/projects/:id/contacts/:cid', (ctx, p) => api.deleteContact(ctx, p.id, p.cid)],

    ['POST', '/api/admin/projects/:id/activities', (ctx, p, body) => api.createActivity(ctx, p.id, body)],
    ['PATCH', '/api/admin/projects/:id/activities/:aid', (ctx, p, body) => api.updateActivity(ctx, p.id, p.aid, body)],
    ['DELETE', '/api/admin/projects/:id/activities/:aid', (ctx, p) => api.deleteActivity(ctx, p.id, p.aid)],

    ['POST', '/api/admin/projects/:id/documents', (ctx, p, body) => api.uploadDocument(ctx, p.id, body)],
    ['DELETE', '/api/admin/projects/:id/documents/:docId', (ctx, p) => api.deleteDocument(ctx, p.id, p.docId)]
  ].map(([method, pattern, handler]) => {
    const keys = [];
    const regex = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, key) => {
      keys.push(key);
      return '([^/]+)';
    }) + '$');
    return { method, regex, keys, handler };
  });

  function matchRoute(method, pathname) {
    for (const route of routes) {
      if (route.method !== method) continue;
      const match = route.regex.exec(pathname);
      if (match) {
        const params = {};
        route.keys.forEach((key, i) => { params[key] = decodeURIComponent(match[i + 1]); });
        return { route, params };
      }
    }
    return null;
  }

  function serveStatic(res, pathname) {
    const safe = normalize(pathname).replace(/^([/\\])+/, '');
    const filePath = join(PUBLIC_DIR, safe);
    if (!filePath.startsWith(PUBLIC_DIR)) return false;
    if (!existsSync(filePath) || !statSync(filePath).isFile()) return false;
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    createReadStream(filePath).pipe(res);
    return true;
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    try {
      const token = parseCookies(req.headers.cookie).sid || null;
      const ctx = {
        db,
        storageDir,
        sessionToken: token,
        user: userFromToken(db, token),
        _cookie: null,
        setSession(session) {
          this._cookie = session
            ? sessionCookie(session.token, session.expiresAt)
            : sessionCookie(null);
        }
      };

      // Download de documento: streaming fora do fluxo JSON.
      const download = /^\/api\/projects\/(\d+)\/documents\/(\d+)\/download$/.exec(pathname);
      if (req.method === 'GET' && download) {
        const { doc, path } = api.downloadDocument(ctx, download[1], download[2]);
        if (!existsSync(path)) throw new ApiError(404, 'Arquivo não encontrado no armazenamento.');
        res.writeHead(200, {
          'Content-Type': doc.mimeType,
          'Content-Disposition': `attachment; filename="${encodeURIComponent(doc.name)}"`,
          'Content-Length': String(doc.sizeBytes)
        });
        createReadStream(path).pipe(res);
        return;
      }

      const matched = matchRoute(req.method, pathname);
      if (matched) {
        const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readJsonBody(req) : {};
        const result = matched.route.handler(ctx, matched.params, body);
        const headers = ctx._cookie ? { 'Set-Cookie': ctx._cookie } : {};
        sendJson(res, 200, result ?? { ok: true }, headers);
        return;
      }

      if (pathname.startsWith('/api/')) {
        sendJson(res, 404, { error: 'Rota de API não encontrada.' });
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'Método não permitido.' });
        return;
      }

      if (pathname !== '/' && serveStatic(res, pathname)) return;

      // SPA: qualquer outra rota devolve o shell; o cliente renderiza a página (inclusive a 404).
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(readFileSync(join(PUBLIC_DIR, 'index.html')));
    } catch (err) {
      if (err instanceof ApiError) {
        sendJson(res, err.status, { error: err.message });
      } else {
        console.error(err);
        sendJson(res, 500, { error: 'Erro interno do servidor.' });
      }
    }
  });

  return { server, db };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1]);
if (isMain) {
  const dbPath = process.env.PORTAL_DB || join(ROOT, 'data', 'portal.db');
  const storageDir = process.env.PORTAL_STORAGE || join(ROOT, 'data', 'storage');
  const { server, db } = createApp({ dbPath, storageDir });
  const adminEmail = process.env.PORTAL_ADMIN_EMAIL || 'admin@portal.local';
  const adminPassword = process.env.PORTAL_ADMIN_PASSWORD || 'admin123';
  if (seedAdmin(db, { email: adminEmail, password: adminPassword, name: 'Administração' })) {
    console.log(`Conta administradora criada: ${adminEmail} (senha: ${adminPassword})`);
  }
  const port = Number(process.env.PORT || 3000);
  server.listen(port, () => {
    console.log(`Portal de Projetos disponível em http://localhost:${port}`);
  });
}

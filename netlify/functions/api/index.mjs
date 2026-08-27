// API do Portal de Projetos no Netlify: porta da versão local (app/src) para
// Netlify Database (Postgres) + Netlify Blobs. As rotas e contratos JSON são
// idênticos aos do servidor local, então a SPA em app/public funciona sem mudança.
// O controle de acesso continua integralmente no servidor.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { getDatabase } from '@netlify/database';
import { getStore } from '@netlify/blobs';

const db = getDatabase();
const documents = () => getStore('project-documents');

const PROJECT_STATUSES = ['planning', 'on_track', 'attention', 'delayed', 'paused', 'completed'];
const MILESTONE_STATUSES = ['pending', 'in_progress', 'completed'];
const DELIVERABLE_STATUSES = ['not_started', 'in_progress', 'review', 'completed'];
const ACCESS_ROLES = ['client', 'viewer', 'manager'];
const MANUAL_ACTIVITY_TYPE = 'update';
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME_PREFIXES = ['image/', 'application/pdf', 'text/', 'application/zip',
  'application/vnd.openxmlformats-officedocument', 'application/msword', 'application/vnd.ms-excel'];
const SESSION_DAYS = 7;

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const badRequest = (msg) => new ApiError(400, msg);
const forbidden = (msg = 'Você não possui acesso a este projeto.') => new ApiError(403, msg);

const trim = (v, max) => String(v ?? '').trim().slice(0, max);
const normalized = (v) => String(v || '').trim().toLowerCase();

function validDateRange(startDate, endDate) {
  if (startDate && endDate && endDate < startDate) {
    throw badRequest('A data de término não pode ser anterior à data de início.');
  }
}
function clampProgress(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw badRequest('O progresso deve ser um número entre 0 e 100.');
  return Math.round(n);
}

// ------------------------------------------------------------------ senha e sessão

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 32).toString('hex')}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function parseCookies(header) {
  const jar = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) jar[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return jar;
}
function sessionCookie(token, expiresAt) {
  const expires = token ? new Date(expiresAt).toUTCString() : new Date(0).toUTCString();
  return `sid=${token || ''}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${expires}`;
}

// Garante a conta administradora inicial (idempotente, protegida contra corrida).
let adminEnsured = null;
function ensureAdmin() {
  adminEnsured ??= (async () => {
    const existing = await db.sql`SELECT id FROM users WHERE role = 'admin' LIMIT 1`;
    if (existing.length) return;
    const email = normalized(Netlify.env.get('PORTAL_ADMIN_EMAIL') || 'admin@portal.local');
    const password = Netlify.env.get('PORTAL_ADMIN_PASSWORD') || 'admin123';
    await db.sql`
      INSERT INTO users (name, email, "passwordHash", role)
      VALUES (${'Administração'}, ${email}, ${hashPassword(password)}, 'admin')
      ON CONFLICT (email) DO NOTHING`;
  })().catch((err) => { adminEnsured = null; throw err; });
  return adminEnsured;
}

async function userFromToken(token) {
  if (!token) return null;
  const rows = await db.sql`
    SELECT u.id, u.name, u.email, u.role
      FROM sessions s JOIN users u ON u.id = s."userId"
     WHERE s.token = ${token} AND s."expiresAt" > now()`;
  return rows[0] ?? null;
}

// ------------------------------------------------------------------ guards e helpers

function requireUser(ctx) {
  if (!ctx.user) throw new ApiError(401, 'Sessão não encontrada. Entre novamente para continuar.');
  return ctx.user;
}
function requireAdmin(ctx) {
  const user = requireUser(ctx);
  if (user.role !== 'admin') throw new ApiError(403, 'Apenas administradores podem executar esta ação.');
  return user;
}
async function membership(projectId, userId) {
  const rows = await db.sql`SELECT * FROM "projectMembers" WHERE "projectId" = ${projectId} AND "userId" = ${userId}`;
  return rows[0] ?? null;
}
async function requireProject(projectId) {
  const rows = await db.sql`SELECT * FROM projects WHERE id = ${Number(projectId)}`;
  if (!rows[0]) throw new ApiError(404, 'Projeto não encontrado.');
  return rows[0];
}
async function addActivity(projectId, actorName, activityType, title, description = '') {
  await db.sql`
    INSERT INTO "projectActivities" ("projectId", "actorName", "activityType", title, description)
    VALUES (${projectId}, ${actorName}, ${activityType}, ${title}, ${description})`;
}

// ------------------------------------------------------------------ auth

async function startSession(ctx, userId) {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  await db.sql`INSERT INTO sessions (token, "userId", "expiresAt") VALUES (${token}, ${userId}, ${expiresAt})`;
  ctx.cookie = sessionCookie(token, expiresAt);
  const rows = await db.sql`SELECT id, name, email, role FROM users WHERE id = ${userId}`;
  return { user: rows[0] };
}

async function register(ctx, body) {
  const name = trim(body.name, 120);
  const email = normalized(body.email);
  const password = String(body.password || '');
  if (!name || !email || !email.includes('@')) throw badRequest('Informe nome e um e-mail válido.');
  if (password.length < 6) throw badRequest('A senha deve ter pelo menos 6 caracteres.');
  const existing = await db.sql`SELECT id FROM users WHERE email = ${email}`;
  if (existing.length) throw new ApiError(409, 'Já existe uma conta com este e-mail.');
  const [user] = await db.sql`
    INSERT INTO users (name, email, "passwordHash", role)
    VALUES (${name}, ${email}, ${hashPassword(password)}, 'client') RETURNING id`;
  return startSession(ctx, user.id);
}

async function login(ctx, body) {
  const email = normalized(body.email);
  const rows = await db.sql`SELECT * FROM users WHERE email = ${email}`;
  const user = rows[0];
  if (!user || !verifyPassword(String(body.password || ''), user.passwordHash)) {
    throw new ApiError(401, 'E-mail ou senha inválidos.');
  }
  return startSession(ctx, user.id);
}

async function logout(ctx) {
  if (ctx.sessionToken) await db.sql`DELETE FROM sessions WHERE token = ${ctx.sessionToken}`;
  ctx.cookie = sessionCookie(null);
  return { ok: true };
}

// ------------------------------------------------------------------ cliente

async function listMine(ctx) {
  const user = requireUser(ctx);
  const projects = await db.sql`
    SELECT p.*, m."accessRole"
      FROM projects p JOIN "projectMembers" m ON m."projectId" = p.id
     WHERE m."userId" = ${user.id}
     ORDER BY p.name`;
  return { projects };
}

async function dashboard(ctx, projectId) {
  const user = requireUser(ctx);
  const project = await requireProject(projectId);
  const member = await membership(project.id, user.id);
  // Ramo explícito de inspeção administrativa: nenhum vínculo falso é criado.
  if (!member && user.role !== 'admin') throw forbidden();
  const [milestones, deliverables, contacts, docs, activities, organizations] = await Promise.all([
    db.sql`SELECT * FROM milestones WHERE "projectId" = ${project.id} ORDER BY position, "dueDate"`,
    db.sql`SELECT * FROM deliverables WHERE "projectId" = ${project.id} ORDER BY "dueDate" IS NULL, "dueDate"`,
    db.sql`SELECT * FROM "projectContacts" WHERE "projectId" = ${project.id} ORDER BY "isPrimary" DESC, name`,
    db.sql`SELECT id, name, "mimeType", "sizeBytes", "uploadedBy", "createdAt" FROM "projectDocuments" WHERE "projectId" = ${project.id} ORDER BY "createdAt" DESC`,
    db.sql`SELECT * FROM "projectActivities" WHERE "projectId" = ${project.id} ORDER BY "createdAt" DESC, id DESC LIMIT 50`,
    db.sql`SELECT c.name, c.status, pc.relationship FROM "projectClients" pc JOIN clients c ON c.id = pc."clientId" WHERE pc."projectId" = ${project.id}`
  ]);
  return {
    project, viewerIsMember: Boolean(member),
    milestones, deliverables, contacts, documents: docs, activities, organizations
  };
}

async function submitFeedback(ctx, projectId, body) {
  const user = requireUser(ctx);
  const project = await requireProject(projectId);
  // Sem bypass administrativo: feedback é insumo do cliente vinculado.
  if (!(await membership(project.id, user.id))) throw forbidden();
  const subject = trim(body.subject, 140);
  const message = trim(body.message, 2000);
  if (!subject || !message) throw badRequest('Informe assunto e mensagem do feedback.');
  await db.sql`INSERT INTO "projectFeedback" ("projectId", "userId", subject, message)
    VALUES (${project.id}, ${user.id}, ${subject}, ${message})`;
  await addActivity(project.id, user.name, 'feedback', `Feedback recebido: ${subject}`,
    'Um cliente enviou um novo feedback para a equipe do projeto.');
  return { ok: true };
}

async function downloadDocument(ctx, projectId, docId) {
  const user = requireUser(ctx);
  const project = await requireProject(projectId);
  if (!(await membership(project.id, user.id)) && user.role !== 'admin') throw forbidden();
  const rows = await db.sql`SELECT * FROM "projectDocuments" WHERE id = ${Number(docId)} AND "projectId" = ${project.id}`;
  const doc = rows[0];
  if (!doc) throw new ApiError(404, 'Documento não encontrado.');
  const data = await documents().get(doc.fileKey, { type: 'arrayBuffer' });
  if (!data) throw new ApiError(404, 'Arquivo não encontrado no armazenamento.');
  return new Response(data, {
    status: 200,
    headers: {
      'Content-Type': doc.mimeType,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(doc.name)}"`
    }
  });
}

// ------------------------------------------------------------------ admin

async function adminOverview(ctx) {
  requireAdmin(ctx);
  const projects = await db.sql`
    SELECT p.*,
      (SELECT COUNT(*)::int FROM "projectClients" pc WHERE pc."projectId" = p.id) AS "orgCount",
      (SELECT COUNT(*)::int FROM "projectMembers" pm WHERE pm."projectId" = p.id) AS "memberCount",
      (SELECT COUNT(*)::int FROM deliverables d WHERE d."projectId" = p.id AND d."needsAttention") AS "attentionDeliverables"
    FROM projects p ORDER BY p.name`;
  for (const p of projects) {
    p.attentionPoints = [];
    if (['attention', 'delayed'].includes(p.status)) p.attentionPoints.push('Saúde do projeto exige acompanhamento');
    if (p.attentionDeliverables > 0) p.attentionPoints.push(`${p.attentionDeliverables} entregável(is) com alerta`);
    if (p.orgCount === 0) p.attentionPoints.push('Sem organização cliente vinculada');
    if (p.memberCount === 0) p.attentionPoints.push('Sem conta de cliente com acesso');
  }
  const clients = await db.sql`SELECT * FROM clients ORDER BY name`;
  return { projects, clients };
}

async function adminProjectDetail(ctx, projectId) {
  requireAdmin(ctx);
  const project = await requireProject(projectId);
  const [milestones, deliverables, contacts, docs, activities, feedback, organizations, members] = await Promise.all([
    db.sql`SELECT * FROM milestones WHERE "projectId" = ${project.id} ORDER BY position, "dueDate"`,
    db.sql`SELECT * FROM deliverables WHERE "projectId" = ${project.id} ORDER BY "dueDate" IS NULL, "dueDate"`,
    db.sql`SELECT * FROM "projectContacts" WHERE "projectId" = ${project.id} ORDER BY "isPrimary" DESC, name`,
    db.sql`SELECT id, name, "mimeType", "sizeBytes", "uploadedBy", "createdAt" FROM "projectDocuments" WHERE "projectId" = ${project.id} ORDER BY "createdAt" DESC`,
    db.sql`SELECT * FROM "projectActivities" WHERE "projectId" = ${project.id} ORDER BY "createdAt" DESC, id DESC`,
    db.sql`SELECT f.*, u.name AS "userName" FROM "projectFeedback" f JOIN users u ON u.id = f."userId" WHERE f."projectId" = ${project.id} ORDER BY f."createdAt" DESC`,
    db.sql`SELECT pc.id AS "linkId", pc.relationship, c.* FROM "projectClients" pc JOIN clients c ON c.id = pc."clientId" WHERE pc."projectId" = ${project.id} ORDER BY c.name`,
    db.sql`SELECT pm.id AS "memberId", pm."accessRole", pm."assignedAt", u.id AS "userId", u.name, u.email
             FROM "projectMembers" pm JOIN users u ON u.id = pm."userId"
            WHERE pm."projectId" = ${project.id} ORDER BY u.name`
  ]);
  return { project, milestones, deliverables, contacts, documents: docs, activities, feedback, organizations, members };
}

async function createProject(ctx, body) {
  const admin = requireAdmin(ctx);
  const name = trim(body.name, 140);
  const code = trim(body.code, 30).toUpperCase();
  if (!name || !code) throw badRequest('Informe o código e o nome do projeto.');
  validDateRange(body.startDate, body.endDate);
  const dup = await db.sql`SELECT id FROM projects WHERE code = ${code}`;
  if (dup.length) throw new ApiError(409, 'Já existe um projeto com este código.');
  const [project] = await db.sql`
    INSERT INTO projects (code, name, description, status, progress, "startDate", "endDate")
    VALUES (${code}, ${name}, ${trim(body.description, 2000)}, 'planning', 0, ${body.startDate || null}, ${body.endDate || null})
    RETURNING *`;
  await addActivity(project.id, admin.name, 'project_created', 'Projeto criado',
    `O projeto ${name} foi criado no portal.`);
  return { project };
}

async function updateProject(ctx, projectId, body) {
  const admin = requireAdmin(ctx);
  const project = await requireProject(projectId);
  const name = body.name !== undefined ? trim(body.name, 140) : project.name;
  if (!name) throw badRequest('O nome do projeto é obrigatório.');
  const status = body.status !== undefined ? String(body.status) : project.status;
  if (!PROJECT_STATUSES.includes(status)) throw badRequest('Status de projeto inválido.');
  const progress = body.progress !== undefined ? clampProgress(body.progress) : project.progress;
  const startDate = body.startDate !== undefined ? (body.startDate || null) : project.startDate;
  const endDate = body.endDate !== undefined ? (body.endDate || null) : project.endDate;
  validDateRange(startDate, endDate);
  const description = body.description !== undefined ? trim(body.description, 2000) : project.description;
  const [updated] = await db.sql`
    UPDATE projects SET name = ${name}, description = ${description}, status = ${status},
           progress = ${progress}, "startDate" = ${startDate}, "endDate" = ${endDate}
     WHERE id = ${project.id} RETURNING *`;
  if (status !== project.status) {
    await addActivity(project.id, admin.name, 'status_changed', 'Situação do projeto atualizada',
      `A situação passou de ${project.status} para ${status}.`);
  } else {
    await addActivity(project.id, admin.name, 'project_updated', 'Dados do projeto atualizados',
      'Informações gerais do projeto foram revisadas pela administração.');
  }
  return { project: updated };
}

async function deleteProject(ctx, projectId) {
  requireAdmin(ctx);
  const project = await requireProject(projectId);
  const docs = await db.sql`SELECT "fileKey" FROM "projectDocuments" WHERE "projectId" = ${project.id}`;
  // Exclusão em transação, em ordem segura de dependências.
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    for (const table of ['projectFeedback', 'projectActivities', 'projectDocuments', 'projectContacts',
      'deliverables', 'milestones', 'projectClients', 'projectMembers']) {
      await client.query(`DELETE FROM "${table}" WHERE "projectId" = $1`, [project.id]);
    }
    await client.query('DELETE FROM projects WHERE id = $1', [project.id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  const store = documents();
  await Promise.all(docs.map((d) => store.delete(d.fileKey)));
  return { ok: true };
}

// ------------------------------------------------------------------ organizações

async function assertOrgUnique(body, exceptId = 0) {
  const name = normalized(body.name);
  const email = normalized(body.email);
  if (name) {
    const dup = await db.sql`SELECT id FROM clients WHERE lower(trim(name)) = ${name} AND id != ${exceptId}`;
    if (dup.length) throw new ApiError(409, 'Já existe uma organização cadastrada com este nome.');
  }
  if (email) {
    const dup = await db.sql`SELECT id FROM clients WHERE lower(trim(email)) = ${email} AND id != ${exceptId}`;
    if (dup.length) throw new ApiError(409, 'Já existe uma organização cadastrada com este e-mail.');
  }
}
function orgFields(body) {
  return {
    name: trim(body.name, 120),
    legalName: trim(body.legalName, 160),
    contactName: trim(body.contactName, 120),
    email: trim(body.email, 160),
    phone: trim(body.phone, 20),
    status: body.status === 'inactive' ? 'inactive' : 'active'
  };
}

async function createClient(ctx, body) {
  requireAdmin(ctx);
  const f = orgFields(body);
  if (!f.name) throw badRequest('Informe o nome da organização.');
  await assertOrgUnique(f);
  const [client] = await db.sql`
    INSERT INTO clients (name, "legalName", "contactName", email, phone, status)
    VALUES (${f.name}, ${f.legalName}, ${f.contactName}, ${f.email}, ${f.phone}, ${f.status})
    RETURNING *`;
  return { client };
}

async function updateClient(ctx, clientId, body) {
  requireAdmin(ctx);
  const rows = await db.sql`SELECT * FROM clients WHERE id = ${Number(clientId)}`;
  const existing = rows[0];
  if (!existing) throw new ApiError(404, 'Organização não encontrada.');
  const f = orgFields({ ...existing, ...body });
  if (!f.name) throw badRequest('Informe o nome da organização.');
  await assertOrgUnique(f, existing.id);
  const [client] = await db.sql`
    UPDATE clients SET name = ${f.name}, "legalName" = ${f.legalName}, "contactName" = ${f.contactName},
           email = ${f.email}, phone = ${f.phone}, status = ${f.status}
     WHERE id = ${existing.id} RETURNING *`;
  return { client };
}

async function deleteClient(ctx, clientId) {
  requireAdmin(ctx);
  const rows = await db.sql`SELECT * FROM clients WHERE id = ${Number(clientId)}`;
  if (!rows[0]) throw new ApiError(404, 'Organização não encontrada.');
  const links = await db.sql`SELECT COUNT(*)::int AS n FROM "projectClients" WHERE "clientId" = ${rows[0].id}`;
  if (links[0].n > 0) {
    throw new ApiError(409,
      'Esta organização está vinculada a projetos ativos. Remova os vínculos antes de excluir o cadastro.');
  }
  await db.sql`DELETE FROM clients WHERE id = ${rows[0].id}`;
  return { ok: true };
}

async function linkClient(ctx, projectId, body) {
  const admin = requireAdmin(ctx);
  const project = await requireProject(projectId);
  const rows = await db.sql`SELECT * FROM clients WHERE id = ${Number(body.clientId)}`;
  const client = rows[0];
  if (!client) throw new ApiError(404, 'Organização não encontrada.');
  if (client.status !== 'active') throw badRequest('Apenas organizações ativas podem receber novos vínculos.');
  const dup = await db.sql`SELECT id FROM "projectClients" WHERE "projectId" = ${project.id} AND "clientId" = ${client.id}`;
  if (dup.length) throw new ApiError(409, 'Esta organização já está vinculada ao projeto.');
  const relationship = body.relationship === 'stakeholder' ? 'stakeholder' : 'primary';
  await db.sql`INSERT INTO "projectClients" ("projectId", "clientId", relationship)
    VALUES (${project.id}, ${client.id}, ${relationship})`;
  await addActivity(project.id, admin.name, 'client_linked', 'Organização vinculada',
    `A organização ${client.name} foi associada ao projeto.`);
  return { ok: true };
}

async function unlinkClient(ctx, projectId, linkId) {
  const admin = requireAdmin(ctx);
  const project = await requireProject(projectId);
  const rows = await db.sql`
    SELECT pc.id, c.name FROM "projectClients" pc JOIN clients c ON c.id = pc."clientId"
     WHERE pc.id = ${Number(linkId)} AND pc."projectId" = ${project.id}`;
  const link = rows[0];
  if (!link) throw new ApiError(404, 'Vínculo não encontrado.');
  await db.sql`DELETE FROM "projectClients" WHERE id = ${link.id}`;
  await addActivity(project.id, admin.name, 'client_unlinked', 'Organização desvinculada',
    `A organização ${link.name} deixou de estar associada ao projeto.`);
  return { ok: true };
}

// ------------------------------------------------------------------ contas e acesso

async function listAccounts(ctx) {
  requireAdmin(ctx);
  const users = await db.sql`SELECT id, name, email, "createdAt" FROM users WHERE role != 'admin' ORDER BY name`;
  return { users };
}

async function assignMember(ctx, projectId, body) {
  const admin = requireAdmin(ctx);
  const project = await requireProject(projectId);
  const rows = await db.sql`SELECT * FROM users WHERE id = ${Number(body.userId)} AND role != 'admin'`;
  const user = rows[0];
  if (!user) throw new ApiError(404, 'Conta de cliente não encontrada.');
  const accessRole = ACCESS_ROLES.includes(body.accessRole) ? body.accessRole : 'client';
  if (await membership(project.id, user.id)) throw new ApiError(409, 'Esta conta já possui acesso ao projeto.');
  await db.sql`INSERT INTO "projectMembers" ("projectId", "userId", "accessRole")
    VALUES (${project.id}, ${user.id}, ${accessRole})`;
  await addActivity(project.id, admin.name, 'member_assigned', 'Acesso concedido',
    `A conta ${user.email} recebeu acesso ao projeto (${accessRole}).`);
  return { ok: true };
}

async function removeMember(ctx, projectId, memberId) {
  const admin = requireAdmin(ctx);
  const project = await requireProject(projectId);
  const rows = await db.sql`
    SELECT pm.id, u.email FROM "projectMembers" pm JOIN users u ON u.id = pm."userId"
     WHERE pm.id = ${Number(memberId)} AND pm."projectId" = ${project.id}`;
  const member = rows[0];
  if (!member) throw new ApiError(404, 'Acesso não encontrado.');
  await db.sql`DELETE FROM "projectMembers" WHERE id = ${member.id}`;
  await addActivity(project.id, admin.name, 'member_removed', 'Acesso removido',
    `A conta ${member.email} não possui mais acesso ao projeto.`);
  return { ok: true };
}

// ------------------------------------------------------------------ marcos, entregáveis, contatos

async function createMilestone(ctx, projectId, body) {
  const admin = requireAdmin(ctx);
  const project = await requireProject(projectId);
  const title = trim(body.title, 140);
  if (!title) throw badRequest('Informe o título do marco.');
  await db.sql`
    INSERT INTO milestones ("projectId", title, status, "dueDate", position)
    VALUES (${project.id}, ${title}, 'pending', ${body.dueDate || null},
      (SELECT COALESCE(MAX(position), 0) + 1 FROM milestones WHERE "projectId" = ${project.id}))`;
  await addActivity(project.id, admin.name, 'milestone', 'Novo marco no cronograma', `Marco adicionado: ${title}.`);
  return { ok: true };
}

async function updateMilestone(ctx, projectId, milestoneId, body) {
  requireAdmin(ctx);
  const project = await requireProject(projectId);
  const rows = await db.sql`SELECT * FROM milestones WHERE id = ${Number(milestoneId)} AND "projectId" = ${project.id}`;
  const row = rows[0];
  if (!row) throw new ApiError(404, 'Marco não encontrado.');
  const status = body.status !== undefined ? String(body.status) : row.status;
  if (!MILESTONE_STATUSES.includes(status)) throw badRequest('Status de marco inválido.');
  const title = body.title !== undefined ? trim(body.title, 140) : row.title;
  if (!title) throw badRequest('Informe o título do marco.');
  const completedAt = status === 'completed' ? (row.completedAt || new Date().toISOString()) : null;
  const dueDate = body.dueDate !== undefined ? (body.dueDate || null) : row.dueDate;
  await db.sql`UPDATE milestones SET title = ${title}, status = ${status}, "dueDate" = ${dueDate},
    "completedAt" = ${completedAt} WHERE id = ${row.id}`;
  return { ok: true };
}

async function deleteMilestone(ctx, projectId, milestoneId) {
  requireAdmin(ctx);
  const project = await requireProject(projectId);
  const result = await db.sql`DELETE FROM milestones WHERE id = ${Number(milestoneId)} AND "projectId" = ${project.id} RETURNING id`;
  if (!result.length) throw new ApiError(404, 'Marco não encontrado.');
  return { ok: true };
}

async function createDeliverable(ctx, projectId, body) {
  const admin = requireAdmin(ctx);
  const project = await requireProject(projectId);
  const title = trim(body.title, 140);
  if (!title) throw badRequest('Informe o título do entregável.');
  await db.sql`
    INSERT INTO deliverables ("projectId", title, "ownerName", status, progress, "dueDate", "needsAttention")
    VALUES (${project.id}, ${title}, ${trim(body.ownerName, 120)}, 'not_started', 0, ${body.dueDate || null}, FALSE)`;
  await addActivity(project.id, admin.name, 'deliverable', 'Novo entregável', `Entregável adicionado: ${title}.`);
  return { ok: true };
}

async function updateDeliverable(ctx, projectId, deliverableId, body) {
  requireAdmin(ctx);
  const project = await requireProject(projectId);
  const rows = await db.sql`SELECT * FROM deliverables WHERE id = ${Number(deliverableId)} AND "projectId" = ${project.id}`;
  const row = rows[0];
  if (!row) throw new ApiError(404, 'Entregável não encontrado.');
  const status = body.status !== undefined ? String(body.status) : row.status;
  if (!DELIVERABLE_STATUSES.includes(status)) throw badRequest('Status de entregável inválido.');
  const title = body.title !== undefined ? trim(body.title, 140) : row.title;
  if (!title) throw badRequest('Informe o título do entregável.');
  const progress = body.progress !== undefined ? clampProgress(body.progress) : row.progress;
  const ownerName = body.ownerName !== undefined ? trim(body.ownerName, 120) : row.ownerName;
  const dueDate = body.dueDate !== undefined ? (body.dueDate || null) : row.dueDate;
  const needsAttention = body.needsAttention !== undefined ? Boolean(body.needsAttention) : row.needsAttention;
  await db.sql`UPDATE deliverables SET title = ${title}, "ownerName" = ${ownerName}, status = ${status},
    progress = ${progress}, "dueDate" = ${dueDate}, "needsAttention" = ${needsAttention} WHERE id = ${row.id}`;
  return { ok: true };
}

async function deleteDeliverable(ctx, projectId, deliverableId) {
  requireAdmin(ctx);
  const project = await requireProject(projectId);
  const result = await db.sql`DELETE FROM deliverables WHERE id = ${Number(deliverableId)} AND "projectId" = ${project.id} RETURNING id`;
  if (!result.length) throw new ApiError(404, 'Entregável não encontrado.');
  return { ok: true };
}

async function createContact(ctx, projectId, body) {
  requireAdmin(ctx);
  const project = await requireProject(projectId);
  const name = trim(body.name, 120);
  if (!name) throw badRequest('Informe o nome do contato.');
  await db.sql`INSERT INTO "projectContacts" ("projectId", name, role, email, "isPrimary")
    VALUES (${project.id}, ${name}, ${trim(body.role, 80)}, ${trim(body.email, 160)}, ${Boolean(body.isPrimary)})`;
  return { ok: true };
}

async function deleteContact(ctx, projectId, contactId) {
  requireAdmin(ctx);
  const project = await requireProject(projectId);
  const result = await db.sql`DELETE FROM "projectContacts" WHERE id = ${Number(contactId)} AND "projectId" = ${project.id} RETURNING id`;
  if (!result.length) throw new ApiError(404, 'Contato não encontrado.');
  return { ok: true };
}

// ------------------------------------------------------------------ feed manual

async function createActivity(ctx, projectId, body) {
  const admin = requireAdmin(ctx);
  const project = await requireProject(projectId);
  const title = trim(body.title, 140);
  if (!title) throw badRequest('Informe o título da publicação.');
  await addActivity(project.id, admin.name, MANUAL_ACTIVITY_TYPE, title, trim(body.description, 2000));
  return { ok: true };
}

async function requireManualActivity(projectId, activityId) {
  const rows = await db.sql`SELECT * FROM "projectActivities" WHERE id = ${Number(activityId)} AND "projectId" = ${projectId}`;
  const row = rows[0];
  if (!row) throw new ApiError(404, 'Publicação não encontrada.');
  if (row.activityType !== MANUAL_ACTIVITY_TYPE) {
    throw new ApiError(409, 'Registros automáticos de auditoria são somente leitura.');
  }
  return row;
}

async function updateActivity(ctx, projectId, activityId, body) {
  requireAdmin(ctx);
  const project = await requireProject(projectId);
  const row = await requireManualActivity(project.id, activityId);
  const title = body.title !== undefined ? trim(body.title, 140) : row.title;
  if (!title) throw badRequest('Informe o título da publicação.');
  const description = body.description !== undefined ? trim(body.description, 2000) : row.description;
  await db.sql`UPDATE "projectActivities" SET title = ${title}, description = ${description} WHERE id = ${row.id}`;
  return { ok: true };
}

async function deleteActivity(ctx, projectId, activityId) {
  requireAdmin(ctx);
  const project = await requireProject(projectId);
  const row = await requireManualActivity(project.id, activityId);
  await db.sql`DELETE FROM "projectActivities" WHERE id = ${row.id}`;
  return { ok: true };
}

// ------------------------------------------------------------------ documentos

async function uploadDocument(ctx, projectId, body) {
  const admin = requireAdmin(ctx);
  const project = await requireProject(projectId);
  const name = trim(body.name, 180);
  const mimeType = trim(body.mimeType, 100);
  if (!name) throw badRequest('Informe o nome do arquivo.');
  if (!/^[\w.,() À-ÿ-]+$/.test(name) || name.includes('..')) {
    throw badRequest('O nome do arquivo contém caracteres não permitidos.');
  }
  if (!ALLOWED_MIME_PREFIXES.some((p) => mimeType.startsWith(p))) {
    throw badRequest('Tipo de arquivo não suportado pelo portal.');
  }
  let bytes;
  try {
    bytes = Buffer.from(String(body.contentBase64 || ''), 'base64');
  } catch {
    throw badRequest('Conteúdo do arquivo inválido.');
  }
  if (bytes.length === 0) throw badRequest('O arquivo enviado está vazio.');
  if (bytes.length > MAX_UPLOAD_BYTES) throw badRequest('O arquivo excede o tamanho máximo de 5 MB.');
  const safeName = `${randomBytes(6).toString('hex')}-${name.replace(/[^\w.À-ÿ-]+/g, '_')}`;
  const fileKey = `projects/${project.id}/documents/${safeName}`;
  await documents().set(fileKey, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  let deliverableId = null;
  if (body.deliverableId) {
    const rows = await db.sql`SELECT id FROM deliverables WHERE id = ${Number(body.deliverableId)} AND "projectId" = ${project.id}`;
    deliverableId = rows[0]?.id ?? null;
  }
  await db.sql`
    INSERT INTO "projectDocuments" ("projectId", "deliverableId", name, "fileKey", "mimeType", "sizeBytes", "uploadedBy")
    VALUES (${project.id}, ${deliverableId}, ${name}, ${fileKey}, ${mimeType}, ${bytes.length}, ${admin.name})`;
  await addActivity(project.id, admin.name, 'document', 'Documento disponibilizado',
    `O arquivo ${name} foi publicado para o projeto.`);
  return { ok: true };
}

async function deleteDocument(ctx, projectId, docId) {
  requireAdmin(ctx);
  const project = await requireProject(projectId);
  const rows = await db.sql`SELECT * FROM "projectDocuments" WHERE id = ${Number(docId)} AND "projectId" = ${project.id}`;
  const doc = rows[0];
  if (!doc) throw new ApiError(404, 'Documento não encontrado.');
  await db.sql`DELETE FROM "projectDocuments" WHERE id = ${doc.id}`;
  await documents().delete(doc.fileKey);
  return { ok: true };
}

// ------------------------------------------------------------------ roteamento

const routes = [
  ['POST', '/api/auth/register', (ctx, p, body) => register(ctx, body)],
  ['POST', '/api/auth/login', (ctx, p, body) => login(ctx, body)],
  ['POST', '/api/auth/logout', (ctx) => logout(ctx)],
  ['GET', '/api/auth/me', (ctx) => ({ user: ctx.user || null })],

  ['GET', '/api/projects', (ctx) => listMine(ctx)],
  ['GET', '/api/projects/:id/dashboard', (ctx, p) => dashboard(ctx, p.id)],
  ['GET', '/api/projects/:id/documents/:docId/download', (ctx, p) => downloadDocument(ctx, p.id, p.docId)],
  ['POST', '/api/projects/:id/feedback', (ctx, p, body) => submitFeedback(ctx, p.id, body)],

  ['GET', '/api/admin/overview', (ctx) => adminOverview(ctx)],
  ['GET', '/api/admin/accounts', (ctx) => listAccounts(ctx)],
  ['POST', '/api/admin/projects', (ctx, p, body) => createProject(ctx, body)],
  ['GET', '/api/admin/projects/:id', (ctx, p) => adminProjectDetail(ctx, p.id)],
  ['PATCH', '/api/admin/projects/:id', (ctx, p, body) => updateProject(ctx, p.id, body)],
  ['DELETE', '/api/admin/projects/:id', (ctx, p) => deleteProject(ctx, p.id)],

  ['POST', '/api/admin/clients', (ctx, p, body) => createClient(ctx, body)],
  ['PATCH', '/api/admin/clients/:id', (ctx, p, body) => updateClient(ctx, p.id, body)],
  ['DELETE', '/api/admin/clients/:id', (ctx, p) => deleteClient(ctx, p.id)],
  ['POST', '/api/admin/projects/:id/clients', (ctx, p, body) => linkClient(ctx, p.id, body)],
  ['DELETE', '/api/admin/projects/:id/clients/:linkId', (ctx, p) => unlinkClient(ctx, p.id, p.linkId)],

  ['POST', '/api/admin/projects/:id/members', (ctx, p, body) => assignMember(ctx, p.id, body)],
  ['DELETE', '/api/admin/projects/:id/members/:memberId', (ctx, p) => removeMember(ctx, p.id, p.memberId)],

  ['POST', '/api/admin/projects/:id/milestones', (ctx, p, body) => createMilestone(ctx, p.id, body)],
  ['PATCH', '/api/admin/projects/:id/milestones/:mid', (ctx, p, body) => updateMilestone(ctx, p.id, p.mid, body)],
  ['DELETE', '/api/admin/projects/:id/milestones/:mid', (ctx, p) => deleteMilestone(ctx, p.id, p.mid)],

  ['POST', '/api/admin/projects/:id/deliverables', (ctx, p, body) => createDeliverable(ctx, p.id, body)],
  ['PATCH', '/api/admin/projects/:id/deliverables/:did', (ctx, p, body) => updateDeliverable(ctx, p.id, p.did, body)],
  ['DELETE', '/api/admin/projects/:id/deliverables/:did', (ctx, p) => deleteDeliverable(ctx, p.id, p.did)],

  ['POST', '/api/admin/projects/:id/contacts', (ctx, p, body) => createContact(ctx, p.id, body)],
  ['DELETE', '/api/admin/projects/:id/contacts/:cid', (ctx, p) => deleteContact(ctx, p.id, p.cid)],

  ['POST', '/api/admin/projects/:id/activities', (ctx, p, body) => createActivity(ctx, p.id, body)],
  ['PATCH', '/api/admin/projects/:id/activities/:aid', (ctx, p, body) => updateActivity(ctx, p.id, p.aid, body)],
  ['DELETE', '/api/admin/projects/:id/activities/:aid', (ctx, p) => deleteActivity(ctx, p.id, p.aid)],

  ['POST', '/api/admin/projects/:id/documents', (ctx, p, body) => uploadDocument(ctx, p.id, body)],
  ['DELETE', '/api/admin/projects/:id/documents/:docId', (ctx, p) => deleteDocument(ctx, p.id, p.docId)]
].map(([method, pattern, handler]) => {
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, key) => {
    keys.push(key);
    return '([^/]+)';
  }) + '$');
  return { method, regex, keys, handler };
});

export default async (req) => {
  const url = new URL(req.url);
  try {
    await ensureAdmin();
    const token = parseCookies(req.headers.get('cookie')).sid || null;
    const ctx = { user: await userFromToken(token), sessionToken: token, cookie: null };

    for (const route of routes) {
      if (route.method !== req.method) continue;
      const match = route.regex.exec(url.pathname);
      if (!match) continue;
      const params = {};
      route.keys.forEach((key, i) => { params[key] = decodeURIComponent(match[i + 1]); });
      let body = {};
      if (['POST', 'PATCH', 'PUT'].includes(req.method)) {
        try {
          const text = await req.text();
          body = text ? JSON.parse(text) : {};
        } catch {
          throw badRequest('Corpo da requisição inválido.');
        }
      }
      const result = await route.handler(ctx, params, body);
      if (result instanceof Response) return result;
      const headers = { 'Content-Type': 'application/json; charset=utf-8' };
      if (ctx.cookie) headers['Set-Cookie'] = ctx.cookie;
      return new Response(JSON.stringify(result ?? { ok: true }), { status: 200, headers });
    }
    return Response.json({ error: 'Rota de API não encontrada.' }, { status: 404 });
  } catch (err) {
    if (err instanceof ApiError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    console.error(err);
    return Response.json({ error: 'Erro interno do servidor.' }, { status: 500 });
  }
};

export const config = {
  path: '/api/*'
};

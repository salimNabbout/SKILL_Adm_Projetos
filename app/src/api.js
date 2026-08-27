// Procedures do portal. Controle de acesso é responsabilidade do servidor:
// - authProcedure: exige sessão válida.
// - memberProcedure: exige vínculo em projectMembers (sem confiar em id vindo do cliente).
// - adminProcedure: exige role 'admin' para toda manutenção.
import { randomBytes } from 'node:crypto';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  one, all, run, tx,
  PROJECT_STATUSES, MILESTONE_STATUSES, DELIVERABLE_STATUSES, ACCESS_ROLES,
  AUTOMATED_ACTIVITY_TYPES, MANUAL_ACTIVITY_TYPE
} from './db.js';
import { hashPassword, verifyPassword, createSession, destroySession } from './auth.js';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME_PREFIXES = ['image/', 'application/pdf', 'text/', 'application/zip',
  'application/vnd.openxmlformats-officedocument', 'application/msword', 'application/vnd.ms-excel'];

const badRequest = (msg) => new ApiError(400, msg);
const forbidden = (msg = 'Você não possui acesso a este projeto.') => new ApiError(403, msg);

function requireUser(ctx) {
  if (!ctx.user) throw new ApiError(401, 'Sessão não encontrada. Entre novamente para continuar.');
  return ctx.user;
}

function requireAdmin(ctx) {
  const user = requireUser(ctx);
  if (user.role !== 'admin') throw new ApiError(403, 'Apenas administradores podem executar esta ação.');
  return user;
}

function membership(db, projectId, userId) {
  return one(db, 'SELECT * FROM projectMembers WHERE projectId = ? AND userId = ?', projectId, userId);
}

function requireProject(db, projectId) {
  const project = one(db, 'SELECT * FROM projects WHERE id = ?', Number(projectId));
  if (!project) throw new ApiError(404, 'Projeto não encontrado.');
  return project;
}

function addActivity(db, projectId, actorName, activityType, title, description = '') {
  run(
    db,
    'INSERT INTO projectActivities (projectId, actorName, activityType, title, description) VALUES (?, ?, ?, ?, ?)',
    projectId, actorName, activityType, title, description
  );
}

const trim = (v, max) => String(v ?? '').trim().slice(0, max);

function validDateRange(startDate, endDate) {
  if (startDate && endDate && endDate < startDate) {
    throw badRequest('A data de término não pode ser anterior à data de início.');
  }
}

function normalized(value) {
  return String(value || '').trim().toLowerCase();
}

function clampProgress(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw badRequest('O progresso deve ser um número entre 0 e 100.');
  return Math.round(n);
}

// ------------------------------------------------------------------ auth

export function register(ctx, body) {
  const name = trim(body.name, 120);
  const email = normalized(body.email);
  const password = String(body.password || '');
  if (!name || !email || !email.includes('@')) throw badRequest('Informe nome e um e-mail válido.');
  if (password.length < 6) throw badRequest('A senha deve ter pelo menos 6 caracteres.');
  if (one(ctx.db, 'SELECT id FROM users WHERE email = ?', email)) {
    throw new ApiError(409, 'Já existe uma conta com este e-mail.');
  }
  const result = run(ctx.db, 'INSERT INTO users (name, email, passwordHash, role) VALUES (?, ?, ?, ?)',
    name, email, hashPassword(password), 'client');
  return startSession(ctx, Number(result.lastInsertRowid));
}

export function login(ctx, body) {
  const email = normalized(body.email);
  const user = one(ctx.db, 'SELECT * FROM users WHERE email = ?', email);
  if (!user || !verifyPassword(String(body.password || ''), user.passwordHash)) {
    throw new ApiError(401, 'E-mail ou senha inválidos.');
  }
  return startSession(ctx, user.id);
}

function startSession(ctx, userId) {
  const session = createSession(ctx.db, userId);
  ctx.setSession(session);
  const user = one(ctx.db, 'SELECT id, name, email, role FROM users WHERE id = ?', userId);
  return { user };
}

export function logout(ctx) {
  destroySession(ctx.db, ctx.sessionToken);
  ctx.setSession(null);
  return { ok: true };
}

export function me(ctx) {
  return { user: ctx.user || null };
}

// ------------------------------------------------------------------ cliente

export function listMine(ctx) {
  const user = requireUser(ctx);
  const rows = all(
    ctx.db,
    `SELECT p.*, m.accessRole
       FROM projects p JOIN projectMembers m ON m.projectId = p.id
      WHERE m.userId = ?
      ORDER BY p.name`,
    user.id
  );
  return { projects: rows };
}

export function dashboard(ctx, projectId) {
  const user = requireUser(ctx);
  const project = requireProject(ctx.db, projectId);
  const member = membership(ctx.db, project.id, user.id);
  // Ramo explícito de inspeção administrativa: nenhum vínculo falso é criado.
  if (!member && user.role !== 'admin') throw forbidden();
  const db = ctx.db;
  return {
    project,
    viewerIsMember: Boolean(member),
    milestones: all(db, 'SELECT * FROM milestones WHERE projectId = ? ORDER BY position, dueDate', project.id),
    deliverables: all(db, 'SELECT * FROM deliverables WHERE projectId = ? ORDER BY dueDate IS NULL, dueDate', project.id),
    contacts: all(db, 'SELECT * FROM projectContacts WHERE projectId = ? ORDER BY isPrimary DESC, name', project.id),
    documents: all(db, 'SELECT id, name, mimeType, sizeBytes, uploadedBy, createdAt FROM projectDocuments WHERE projectId = ? ORDER BY createdAt DESC', project.id),
    activities: all(db, 'SELECT * FROM projectActivities WHERE projectId = ? ORDER BY createdAt DESC, id DESC LIMIT 50', project.id),
    organizations: all(db,
      `SELECT c.name, c.status, pc.relationship FROM projectClients pc JOIN clients c ON c.id = pc.clientId WHERE pc.projectId = ?`,
      project.id)
  };
}

export function submitFeedback(ctx, projectId, body) {
  const user = requireUser(ctx);
  const project = requireProject(ctx.db, projectId);
  // Sem bypass administrativo: feedback é insumo do cliente vinculado.
  if (!membership(ctx.db, project.id, user.id)) throw forbidden();
  const subject = trim(body.subject, 140);
  const message = trim(body.message, 2000);
  if (!subject || !message) throw badRequest('Informe assunto e mensagem do feedback.');
  run(ctx.db, 'INSERT INTO projectFeedback (projectId, userId, subject, message) VALUES (?, ?, ?, ?)',
    project.id, user.id, subject, message);
  addActivity(ctx.db, project.id, user.name, 'feedback', `Feedback recebido: ${subject}`,
    'Um cliente enviou um novo feedback para a equipe do projeto.');
  return { ok: true };
}

export function downloadDocument(ctx, projectId, docId) {
  const user = requireUser(ctx);
  const project = requireProject(ctx.db, projectId);
  if (!membership(ctx.db, project.id, user.id) && user.role !== 'admin') throw forbidden();
  const doc = one(ctx.db, 'SELECT * FROM projectDocuments WHERE id = ? AND projectId = ?', Number(docId), project.id);
  if (!doc) throw new ApiError(404, 'Documento não encontrado.');
  return { doc, path: join(ctx.storageDir, doc.fileKey) };
}

// ------------------------------------------------------------------ admin

export function adminOverview(ctx) {
  requireAdmin(ctx);
  const db = ctx.db;
  const projects = all(db, `
    SELECT p.*,
      (SELECT COUNT(*) FROM projectClients pc WHERE pc.projectId = p.id) AS orgCount,
      (SELECT COUNT(*) FROM projectMembers pm WHERE pm.projectId = p.id) AS memberCount,
      (SELECT COUNT(*) FROM deliverables d WHERE d.projectId = p.id AND d.needsAttention = 1) AS attentionDeliverables
    FROM projects p ORDER BY p.name`);
  for (const p of projects) {
    // Pontos de atenção: saúde da entrega + vínculos operacionais ausentes.
    p.attentionPoints = [];
    if (['attention', 'delayed'].includes(p.status)) p.attentionPoints.push('Saúde do projeto exige acompanhamento');
    if (p.attentionDeliverables > 0) p.attentionPoints.push(`${p.attentionDeliverables} entregável(is) com alerta`);
    if (p.orgCount === 0) p.attentionPoints.push('Sem organização cliente vinculada');
    if (p.memberCount === 0) p.attentionPoints.push('Sem conta de cliente com acesso');
  }
  return {
    projects,
    clients: all(db, 'SELECT * FROM clients ORDER BY name')
  };
}

export function adminProjectDetail(ctx, projectId) {
  requireAdmin(ctx);
  const project = requireProject(ctx.db, projectId);
  const db = ctx.db;
  return {
    project,
    milestones: all(db, 'SELECT * FROM milestones WHERE projectId = ? ORDER BY position, dueDate', project.id),
    deliverables: all(db, 'SELECT * FROM deliverables WHERE projectId = ? ORDER BY dueDate IS NULL, dueDate', project.id),
    contacts: all(db, 'SELECT * FROM projectContacts WHERE projectId = ? ORDER BY isPrimary DESC, name', project.id),
    documents: all(db, 'SELECT id, name, mimeType, sizeBytes, uploadedBy, createdAt FROM projectDocuments WHERE projectId = ? ORDER BY createdAt DESC', project.id),
    activities: all(db, 'SELECT * FROM projectActivities WHERE projectId = ? ORDER BY createdAt DESC, id DESC', project.id),
    feedback: all(db,
      `SELECT f.*, u.name AS userName FROM projectFeedback f JOIN users u ON u.id = f.userId
        WHERE f.projectId = ? ORDER BY f.createdAt DESC`, project.id),
    organizations: all(db,
      `SELECT pc.id AS linkId, pc.relationship, c.* FROM projectClients pc JOIN clients c ON c.id = pc.clientId
        WHERE pc.projectId = ? ORDER BY c.name`, project.id),
    members: all(db,
      `SELECT pm.id AS memberId, pm.accessRole, pm.assignedAt, u.id AS userId, u.name, u.email
         FROM projectMembers pm JOIN users u ON u.id = pm.userId
        WHERE pm.projectId = ? ORDER BY u.name`, project.id)
  };
}

export function createProject(ctx, body) {
  const admin = requireAdmin(ctx);
  const name = trim(body.name, 140);
  const code = trim(body.code, 30).toUpperCase();
  if (!name || !code) throw badRequest('Informe o código e o nome do projeto.');
  validDateRange(body.startDate, body.endDate);
  if (one(ctx.db, 'SELECT id FROM projects WHERE code = ?', code)) {
    throw new ApiError(409, 'Já existe um projeto com este código.');
  }
  const result = run(ctx.db,
    'INSERT INTO projects (code, name, description, status, progress, startDate, endDate) VALUES (?, ?, ?, ?, ?, ?, ?)',
    code, name, trim(body.description, 2000), 'planning', 0, body.startDate || null, body.endDate || null);
  const projectId = Number(result.lastInsertRowid);
  addActivity(ctx.db, projectId, admin.name, 'project_created', 'Projeto criado',
    `O projeto ${name} foi criado no portal.`);
  return { project: requireProject(ctx.db, projectId) };
}

export function updateProject(ctx, projectId, body) {
  const admin = requireAdmin(ctx);
  const project = requireProject(ctx.db, projectId);
  const name = body.name !== undefined ? trim(body.name, 140) : project.name;
  if (!name) throw badRequest('O nome do projeto é obrigatório.');
  const status = body.status !== undefined ? String(body.status) : project.status;
  if (!PROJECT_STATUSES.includes(status)) throw badRequest('Status de projeto inválido.');
  const progress = body.progress !== undefined ? clampProgress(body.progress) : project.progress;
  const startDate = body.startDate !== undefined ? (body.startDate || null) : project.startDate;
  const endDate = body.endDate !== undefined ? (body.endDate || null) : project.endDate;
  validDateRange(startDate, endDate);
  const description = body.description !== undefined ? trim(body.description, 2000) : project.description;
  run(ctx.db,
    'UPDATE projects SET name = ?, description = ?, status = ?, progress = ?, startDate = ?, endDate = ? WHERE id = ?',
    name, description, status, progress, startDate, endDate, project.id);
  if (status !== project.status) {
    addActivity(ctx.db, project.id, admin.name, 'status_changed', 'Situação do projeto atualizada',
      `A situação passou de ${project.status} para ${status}.`);
  } else {
    addActivity(ctx.db, project.id, admin.name, 'project_updated', 'Dados do projeto atualizados',
      'Informações gerais do projeto foram revisadas pela administração.');
  }
  return { project: requireProject(ctx.db, project.id) };
}

export function deleteProject(ctx, projectId) {
  requireAdmin(ctx);
  const project = requireProject(ctx.db, projectId);
  // Exclusão em transação, em ordem segura de dependências.
  tx(ctx.db, () => {
    for (const table of ['projectFeedback', 'projectActivities', 'projectDocuments', 'projectContacts',
      'deliverables', 'milestones', 'projectClients', 'projectMembers']) {
      run(ctx.db, `DELETE FROM ${table} WHERE projectId = ?`, project.id);
    }
    run(ctx.db, 'DELETE FROM projects WHERE id = ?', project.id);
  });
  rmSync(join(ctx.storageDir, 'projects', String(project.id)), { recursive: true, force: true });
  return { ok: true };
}

// ------------------------------------------------------------------ organizações

function assertOrgUnique(db, body, exceptId = 0) {
  const name = normalized(body.name);
  const email = normalized(body.email);
  if (name && one(db, 'SELECT id FROM clients WHERE lower(trim(name)) = ? AND id != ?', name, exceptId)) {
    throw new ApiError(409, 'Já existe uma organização cadastrada com este nome.');
  }
  if (email && one(db, 'SELECT id FROM clients WHERE lower(trim(email)) = ? AND id != ?', email, exceptId)) {
    throw new ApiError(409, 'Já existe uma organização cadastrada com este e-mail.');
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

export function createClient(ctx, body) {
  requireAdmin(ctx);
  const fields = orgFields(body);
  if (!fields.name) throw badRequest('Informe o nome da organização.');
  assertOrgUnique(ctx.db, fields);
  const result = run(ctx.db,
    'INSERT INTO clients (name, legalName, contactName, email, phone, status) VALUES (?, ?, ?, ?, ?, ?)',
    fields.name, fields.legalName, fields.contactName, fields.email, fields.phone, fields.status);
  return { client: one(ctx.db, 'SELECT * FROM clients WHERE id = ?', Number(result.lastInsertRowid)) };
}

export function updateClient(ctx, clientId, body) {
  requireAdmin(ctx);
  const existing = one(ctx.db, 'SELECT * FROM clients WHERE id = ?', Number(clientId));
  if (!existing) throw new ApiError(404, 'Organização não encontrada.');
  const fields = orgFields({ ...existing, ...body });
  if (!fields.name) throw badRequest('Informe o nome da organização.');
  assertOrgUnique(ctx.db, fields, existing.id);
  run(ctx.db,
    'UPDATE clients SET name = ?, legalName = ?, contactName = ?, email = ?, phone = ?, status = ? WHERE id = ?',
    fields.name, fields.legalName, fields.contactName, fields.email, fields.phone, fields.status, existing.id);
  return { client: one(ctx.db, 'SELECT * FROM clients WHERE id = ?', existing.id) };
}

export function deleteClient(ctx, clientId) {
  requireAdmin(ctx);
  const existing = one(ctx.db, 'SELECT * FROM clients WHERE id = ?', Number(clientId));
  if (!existing) throw new ApiError(404, 'Organização não encontrada.');
  const links = one(ctx.db, 'SELECT COUNT(*) AS n FROM projectClients WHERE clientId = ?', existing.id);
  if (links.n > 0) {
    throw new ApiError(409,
      'Esta organização está vinculada a projetos ativos. Remova os vínculos antes de excluir o cadastro.');
  }
  run(ctx.db, 'DELETE FROM clients WHERE id = ?', existing.id);
  return { ok: true };
}

export function linkClient(ctx, projectId, body) {
  const admin = requireAdmin(ctx);
  const project = requireProject(ctx.db, projectId);
  const client = one(ctx.db, 'SELECT * FROM clients WHERE id = ?', Number(body.clientId));
  if (!client) throw new ApiError(404, 'Organização não encontrada.');
  if (client.status !== 'active') throw badRequest('Apenas organizações ativas podem receber novos vínculos.');
  if (one(ctx.db, 'SELECT id FROM projectClients WHERE projectId = ? AND clientId = ?', project.id, client.id)) {
    throw new ApiError(409, 'Esta organização já está vinculada ao projeto.');
  }
  const relationship = body.relationship === 'stakeholder' ? 'stakeholder' : 'primary';
  run(ctx.db, 'INSERT INTO projectClients (projectId, clientId, relationship) VALUES (?, ?, ?)',
    project.id, client.id, relationship);
  addActivity(ctx.db, project.id, admin.name, 'client_linked', 'Organização vinculada',
    `A organização ${client.name} foi associada ao projeto.`);
  return { ok: true };
}

export function unlinkClient(ctx, projectId, linkId) {
  const admin = requireAdmin(ctx);
  const project = requireProject(ctx.db, projectId);
  const link = one(ctx.db,
    `SELECT pc.id, c.name FROM projectClients pc JOIN clients c ON c.id = pc.clientId
      WHERE pc.id = ? AND pc.projectId = ?`, Number(linkId), project.id);
  if (!link) throw new ApiError(404, 'Vínculo não encontrado.');
  run(ctx.db, 'DELETE FROM projectClients WHERE id = ?', link.id);
  addActivity(ctx.db, project.id, admin.name, 'client_unlinked', 'Organização desvinculada',
    `A organização ${link.name} deixou de estar associada ao projeto.`);
  return { ok: true };
}

// ------------------------------------------------------------------ contas e acesso

export function listAccounts(ctx) {
  requireAdmin(ctx);
  return { users: all(ctx.db, "SELECT id, name, email, createdAt FROM users WHERE role != 'admin' ORDER BY name") };
}

export function assignMember(ctx, projectId, body) {
  const admin = requireAdmin(ctx);
  const project = requireProject(ctx.db, projectId);
  const user = one(ctx.db, "SELECT * FROM users WHERE id = ? AND role != 'admin'", Number(body.userId));
  if (!user) throw new ApiError(404, 'Conta de cliente não encontrada.');
  const accessRole = ACCESS_ROLES.includes(body.accessRole) ? body.accessRole : 'client';
  if (membership(ctx.db, project.id, user.id)) {
    throw new ApiError(409, 'Esta conta já possui acesso ao projeto.');
  }
  run(ctx.db, 'INSERT INTO projectMembers (projectId, userId, accessRole) VALUES (?, ?, ?)',
    project.id, user.id, accessRole);
  addActivity(ctx.db, project.id, admin.name, 'member_assigned', 'Acesso concedido',
    `A conta ${user.email} recebeu acesso ao projeto (${accessRole}).`);
  return { ok: true };
}

export function removeMember(ctx, projectId, memberId) {
  const admin = requireAdmin(ctx);
  const project = requireProject(ctx.db, projectId);
  const member = one(ctx.db,
    `SELECT pm.id, u.email FROM projectMembers pm JOIN users u ON u.id = pm.userId
      WHERE pm.id = ? AND pm.projectId = ?`, Number(memberId), project.id);
  if (!member) throw new ApiError(404, 'Acesso não encontrado.');
  run(ctx.db, 'DELETE FROM projectMembers WHERE id = ?', member.id);
  addActivity(ctx.db, project.id, admin.name, 'member_removed', 'Acesso removido',
    `A conta ${member.email} não possui mais acesso ao projeto.`);
  return { ok: true };
}

// ------------------------------------------------------------------ marcos e entregáveis

export function createMilestone(ctx, projectId, body) {
  const admin = requireAdmin(ctx);
  const project = requireProject(ctx.db, projectId);
  const title = trim(body.title, 140);
  if (!title) throw badRequest('Informe o título do marco.');
  const position = one(ctx.db, 'SELECT COALESCE(MAX(position), 0) + 1 AS p FROM milestones WHERE projectId = ?', project.id).p;
  run(ctx.db, 'INSERT INTO milestones (projectId, title, status, dueDate, position) VALUES (?, ?, ?, ?, ?)',
    project.id, title, 'pending', body.dueDate || null, position);
  addActivity(ctx.db, project.id, admin.name, 'milestone', 'Novo marco no cronograma', `Marco adicionado: ${title}.`);
  return { ok: true };
}

export function updateMilestone(ctx, projectId, milestoneId, body) {
  requireAdmin(ctx);
  const project = requireProject(ctx.db, projectId);
  const row = one(ctx.db, 'SELECT * FROM milestones WHERE id = ? AND projectId = ?', Number(milestoneId), project.id);
  if (!row) throw new ApiError(404, 'Marco não encontrado.');
  const status = body.status !== undefined ? String(body.status) : row.status;
  if (!MILESTONE_STATUSES.includes(status)) throw badRequest('Status de marco inválido.');
  const title = body.title !== undefined ? trim(body.title, 140) : row.title;
  if (!title) throw badRequest('Informe o título do marco.');
  const completedAt = status === 'completed' ? (row.completedAt || new Date().toISOString()) : null;
  run(ctx.db, 'UPDATE milestones SET title = ?, status = ?, dueDate = ?, completedAt = ? WHERE id = ?',
    title, status, body.dueDate !== undefined ? (body.dueDate || null) : row.dueDate, completedAt, row.id);
  return { ok: true };
}

export function deleteMilestone(ctx, projectId, milestoneId) {
  requireAdmin(ctx);
  const project = requireProject(ctx.db, projectId);
  const result = run(ctx.db, 'DELETE FROM milestones WHERE id = ? AND projectId = ?', Number(milestoneId), project.id);
  if (result.changes === 0) throw new ApiError(404, 'Marco não encontrado.');
  return { ok: true };
}

export function createDeliverable(ctx, projectId, body) {
  const admin = requireAdmin(ctx);
  const project = requireProject(ctx.db, projectId);
  const title = trim(body.title, 140);
  if (!title) throw badRequest('Informe o título do entregável.');
  run(ctx.db,
    'INSERT INTO deliverables (projectId, title, ownerName, status, progress, dueDate, needsAttention) VALUES (?, ?, ?, ?, ?, ?, ?)',
    project.id, title, trim(body.ownerName, 120), 'not_started', 0, body.dueDate || null, 0);
  addActivity(ctx.db, project.id, admin.name, 'deliverable', 'Novo entregável', `Entregável adicionado: ${title}.`);
  return { ok: true };
}

export function updateDeliverable(ctx, projectId, deliverableId, body) {
  requireAdmin(ctx);
  const project = requireProject(ctx.db, projectId);
  const row = one(ctx.db, 'SELECT * FROM deliverables WHERE id = ? AND projectId = ?', Number(deliverableId), project.id);
  if (!row) throw new ApiError(404, 'Entregável não encontrado.');
  const status = body.status !== undefined ? String(body.status) : row.status;
  if (!DELIVERABLE_STATUSES.includes(status)) throw badRequest('Status de entregável inválido.');
  const title = body.title !== undefined ? trim(body.title, 140) : row.title;
  if (!title) throw badRequest('Informe o título do entregável.');
  const progress = body.progress !== undefined ? clampProgress(body.progress) : row.progress;
  run(ctx.db,
    'UPDATE deliverables SET title = ?, ownerName = ?, status = ?, progress = ?, dueDate = ?, needsAttention = ? WHERE id = ?',
    title,
    body.ownerName !== undefined ? trim(body.ownerName, 120) : row.ownerName,
    status, progress,
    body.dueDate !== undefined ? (body.dueDate || null) : row.dueDate,
    body.needsAttention !== undefined ? (body.needsAttention ? 1 : 0) : row.needsAttention,
    row.id);
  return { ok: true };
}

export function deleteDeliverable(ctx, projectId, deliverableId) {
  requireAdmin(ctx);
  const project = requireProject(ctx.db, projectId);
  const result = run(ctx.db, 'DELETE FROM deliverables WHERE id = ? AND projectId = ?', Number(deliverableId), project.id);
  if (result.changes === 0) throw new ApiError(404, 'Entregável não encontrado.');
  return { ok: true };
}

// ------------------------------------------------------------------ contatos

export function createContact(ctx, projectId, body) {
  requireAdmin(ctx);
  const project = requireProject(ctx.db, projectId);
  const name = trim(body.name, 120);
  if (!name) throw badRequest('Informe o nome do contato.');
  run(ctx.db, 'INSERT INTO projectContacts (projectId, name, role, email, isPrimary) VALUES (?, ?, ?, ?, ?)',
    project.id, name, trim(body.role, 80), trim(body.email, 160), body.isPrimary ? 1 : 0);
  return { ok: true };
}

export function deleteContact(ctx, projectId, contactId) {
  requireAdmin(ctx);
  const project = requireProject(ctx.db, projectId);
  const result = run(ctx.db, 'DELETE FROM projectContacts WHERE id = ? AND projectId = ?', Number(contactId), project.id);
  if (result.changes === 0) throw new ApiError(404, 'Contato não encontrado.');
  return { ok: true };
}

// ------------------------------------------------------------------ feed manual

export function createActivity(ctx, projectId, body) {
  const admin = requireAdmin(ctx);
  const project = requireProject(ctx.db, projectId);
  const title = trim(body.title, 140);
  const description = trim(body.description, 2000);
  if (!title) throw badRequest('Informe o título da publicação.');
  addActivity(ctx.db, project.id, admin.name, MANUAL_ACTIVITY_TYPE, title, description);
  return { ok: true };
}

function requireManualActivity(db, projectId, activityId) {
  const row = one(db, 'SELECT * FROM projectActivities WHERE id = ? AND projectId = ?', Number(activityId), projectId);
  if (!row) throw new ApiError(404, 'Publicação não encontrada.');
  if (row.activityType !== MANUAL_ACTIVITY_TYPE || AUTOMATED_ACTIVITY_TYPES.includes(row.activityType)) {
    throw new ApiError(409, 'Registros automáticos de auditoria são somente leitura.');
  }
  return row;
}

export function updateActivity(ctx, projectId, activityId, body) {
  requireAdmin(ctx);
  const project = requireProject(ctx.db, projectId);
  const row = requireManualActivity(ctx.db, project.id, activityId);
  const title = body.title !== undefined ? trim(body.title, 140) : row.title;
  if (!title) throw badRequest('Informe o título da publicação.');
  run(ctx.db, 'UPDATE projectActivities SET title = ?, description = ? WHERE id = ?',
    title, body.description !== undefined ? trim(body.description, 2000) : row.description, row.id);
  return { ok: true };
}

export function deleteActivity(ctx, projectId, activityId) {
  requireAdmin(ctx);
  const project = requireProject(ctx.db, projectId);
  const row = requireManualActivity(ctx.db, project.id, activityId);
  run(ctx.db, 'DELETE FROM projectActivities WHERE id = ?', row.id);
  return { ok: true };
}

// ------------------------------------------------------------------ documentos

export function uploadDocument(ctx, projectId, body) {
  const admin = requireAdmin(ctx);
  const project = requireProject(ctx.db, projectId);
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
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw badRequest('O arquivo excede o tamanho máximo de 5 MB.');
  }
  const safeName = `${randomBytes(6).toString('hex')}-${name.replace(/[^\w.À-ÿ-]+/g, '_')}`;
  const fileKey = join('projects', String(project.id), 'documents', safeName);
  const absolute = join(ctx.storageDir, fileKey);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, bytes);
  const deliverableId = body.deliverableId
    ? one(ctx.db, 'SELECT id FROM deliverables WHERE id = ? AND projectId = ?', Number(body.deliverableId), project.id)?.id ?? null
    : null;
  run(ctx.db,
    'INSERT INTO projectDocuments (projectId, deliverableId, name, fileKey, mimeType, sizeBytes, uploadedBy) VALUES (?, ?, ?, ?, ?, ?, ?)',
    project.id, deliverableId, name, fileKey, mimeType, bytes.length, admin.name);
  addActivity(ctx.db, project.id, admin.name, 'document', 'Documento disponibilizado',
    `O arquivo ${name} foi publicado para o projeto.`);
  return { ok: true };
}

export function deleteDocument(ctx, projectId, docId) {
  requireAdmin(ctx);
  const project = requireProject(ctx.db, projectId);
  const doc = one(ctx.db, 'SELECT * FROM projectDocuments WHERE id = ? AND projectId = ?', Number(docId), project.id);
  if (!doc) throw new ApiError(404, 'Documento não encontrado.');
  run(ctx.db, 'DELETE FROM projectDocuments WHERE id = ?', doc.id);
  rmSync(join(ctx.storageDir, doc.fileKey), { force: true });
  return { ok: true };
}

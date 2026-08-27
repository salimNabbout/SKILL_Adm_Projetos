// Testes da camada de procedures: comportamento não autenticado, cliente e admin.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, seedAdmin } from '../server.js';
import { one } from '../src/db.js';

let server, db, baseUrl, workDir;

function client(cookieJar = {}) {
  return {
    cookies: cookieJar,
    async call(method, path, body) {
      const res = await fetch(baseUrl + path, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(this.cookies.sid ? { Cookie: `sid=${this.cookies.sid}` } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'manual'
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) {
        const match = /sid=([^;]*)/.exec(setCookie);
        if (match) this.cookies.sid = match[1] || undefined;
      }
      let data = null;
      const type = res.headers.get('content-type') || '';
      if (type.includes('json')) data = await res.json();
      else data = await res.text();
      return { status: res.status, data, headers: res.headers };
    }
  };
}

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'portal-test-'));
  const appInstance = createApp({
    dbPath: join(workDir, 'test.db'),
    storageDir: join(workDir, 'storage')
  });
  server = appInstance.server;
  db = appInstance.db;
  seedAdmin(db, { email: 'admin@test.local', password: 'admin123', name: 'Admin QA' });
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

after(() => {
  server.close();
  rmSync(workDir, { recursive: true, force: true });
});

test('portal de status de projetos', async (t) => {
  const admin = client();
  const alice = client();
  const bruno = client();

  await t.test('não autenticado é bloqueado nas rotas protegidas', async () => {
    const anon = client();
    assert.equal((await anon.call('GET', '/api/projects')).status, 401);
    assert.equal((await anon.call('GET', '/api/admin/overview')).status, 401);
    assert.equal((await anon.call('POST', '/api/admin/projects', { code: 'X', name: 'X' })).status, 401);
  });

  await t.test('registro cria conta client e login do admin funciona', async () => {
    const reg = await alice.call('POST', '/api/auth/register', {
      name: 'Alice Cliente', email: 'alice@cliente.com', password: 'segredo1'
    });
    assert.equal(reg.status, 200);
    assert.equal(reg.data.user.role, 'client');

    await bruno.call('POST', '/api/auth/register', {
      name: 'Bruno Cliente', email: 'bruno@cliente.com', password: 'segredo2'
    });

    const login = await admin.call('POST', '/api/auth/login', {
      email: 'admin@test.local', password: 'admin123'
    });
    assert.equal(login.status, 200);
    assert.equal(login.data.user.role, 'admin');
  });

  let projectId;

  await t.test('admin cria projeto; datas inválidas são rejeitadas', async () => {
    const bad = await admin.call('POST', '/api/admin/projects', {
      code: 'PRJ-9', name: 'Datas erradas', startDate: '2026-09-01', endDate: '2026-08-01'
    });
    assert.equal(bad.status, 400);
    assert.match(bad.data.error, /término/);

    const ok = await admin.call('POST', '/api/admin/projects', {
      code: 'PRJ-1', name: 'Implantação ERP', description: 'Projeto de teste',
      startDate: '2026-08-01', endDate: '2026-12-01'
    });
    assert.equal(ok.status, 200);
    projectId = ok.data.project.id;
    assert.ok(projectId > 0);
  });

  await t.test('não-admin não invoca mutações administrativas', async () => {
    assert.equal((await alice.call('POST', '/api/admin/projects', { code: 'HAK', name: 'Invasão' })).status, 403);
    assert.equal((await alice.call('PATCH', `/api/admin/projects/${projectId}`, { name: 'Novo' })).status, 403);
    assert.equal((await alice.call('DELETE', `/api/admin/projects/${projectId}`)).status, 403);
    assert.equal((await alice.call('POST', '/api/admin/clients', { name: 'Org' })).status, 403);
    assert.equal((await alice.call('DELETE', '/api/admin/clients/1')).status, 403);
    assert.equal((await alice.call('POST', `/api/admin/projects/${projectId}/documents`, {
      name: 'a.txt', mimeType: 'text/plain', contentBase64: 'QQ=='
    })).status, 403);
  });

  await t.test('cliente sem vínculo em projectMembers não abre o projeto', async () => {
    const res = await alice.call('GET', `/api/projects/${projectId}/dashboard`);
    assert.equal(res.status, 403);
    assert.match(res.data.error, /acesso/);
    const feedback = await alice.call('POST', `/api/projects/${projectId}/feedback`, {
      subject: 'Oi', message: 'Sem acesso'
    });
    assert.equal(feedback.status, 403);
  });

  let orgId;

  await t.test('admin cria organização; duplicidades retornam 409 com mensagem clara', async () => {
    const created = await admin.call('POST', '/api/admin/clients', {
      name: 'ACME Ltda', email: 'contato@acme.com', contactName: 'Carlos', phone: '(11) 98765-4321'
    });
    assert.equal(created.status, 200);
    orgId = created.data.client.id;

    const dupName = await admin.call('POST', '/api/admin/clients', { name: '  acme ltda ', email: 'outro@x.com' });
    assert.equal(dupName.status, 409);
    assert.match(dupName.data.error, /nome/);

    const dupEmail = await admin.call('POST', '/api/admin/clients', { name: 'Outra Org', email: 'CONTATO@ACME.COM' });
    assert.equal(dupEmail.status, 409);
    assert.match(dupEmail.data.error, /e-mail/);
  });

  await t.test('organização vinculada não pode ser excluída; sem vínculo, pode', async () => {
    const link = await admin.call('POST', `/api/admin/projects/${projectId}/clients`, { clientId: orgId });
    assert.equal(link.status, 200);

    const blocked = await admin.call('DELETE', `/api/admin/clients/${orgId}`);
    assert.equal(blocked.status, 409);
    assert.match(blocked.data.error, /vinculada/);

    const temp = await admin.call('POST', '/api/admin/clients', { name: 'Org Temporária QA' });
    const allowed = await admin.call('DELETE', `/api/admin/clients/${temp.data.client.id}`);
    assert.equal(allowed.status, 200);
  });

  await t.test('admin concede acesso e o cliente passa a ver apenas o seu projeto', async () => {
    const accounts = await admin.call('GET', '/api/admin/accounts');
    const aliceAccount = accounts.data.users.find((u) => u.email === 'alice@cliente.com');
    assert.ok(aliceAccount, 'conta autenticada listada para o admin');

    const assign = await admin.call('POST', `/api/admin/projects/${projectId}/members`, {
      userId: aliceAccount.id, accessRole: 'client'
    });
    assert.equal(assign.status, 200);

    const mine = await alice.call('GET', '/api/projects');
    assert.equal(mine.status, 200);
    assert.equal(mine.data.projects.length, 1);
    assert.equal(mine.data.projects[0].id, projectId);

    const brunoMine = await bruno.call('GET', '/api/projects');
    assert.equal(brunoMine.data.projects.length, 0);
    assert.equal((await bruno.call('GET', `/api/projects/${projectId}/dashboard`)).status, 403);
  });

  await t.test('dashboard expõe viewerIsMember; feedback exige vínculo mesmo para admin', async () => {
    const asMember = await alice.call('GET', `/api/projects/${projectId}/dashboard`);
    assert.equal(asMember.status, 200);
    assert.equal(asMember.data.viewerIsMember, true);

    const asAdmin = await admin.call('GET', `/api/projects/${projectId}/dashboard`);
    assert.equal(asAdmin.status, 200);
    assert.equal(asAdmin.data.viewerIsMember, false, 'admin inspeciona sem vínculo falso');

    const adminFeedback = await admin.call('POST', `/api/projects/${projectId}/feedback`, {
      subject: 'Teste', message: 'Admin não envia feedback'
    });
    assert.equal(adminFeedback.status, 403);

    const ok = await alice.call('POST', `/api/projects/${projectId}/feedback`, {
      subject: 'Dúvida sobre prazo', message: 'O marco 2 será entregue quando?'
    });
    assert.equal(ok.status, 200);

    const dash = await alice.call('GET', `/api/projects/${projectId}/dashboard`);
    assert.ok(dash.data.activities.some((a) => a.activityType === 'feedback'),
      'feedback gera entrada visível no feed');
  });

  await t.test('upload de documento valida tipo e tamanho; download exige vínculo', async () => {
    const badMime = await admin.call('POST', `/api/admin/projects/${projectId}/documents`, {
      name: 'virus.exe', mimeType: 'application/x-msdownload', contentBase64: 'QQ=='
    });
    assert.equal(badMime.status, 400);

    const tooBig = await admin.call('POST', `/api/admin/projects/${projectId}/documents`, {
      name: 'grande.txt', mimeType: 'text/plain',
      contentBase64: Buffer.alloc(5 * 1024 * 1024 + 1, 65).toString('base64')
    });
    assert.equal(tooBig.status, 400);
    assert.match(tooBig.data.error, /5 MB/);

    const ok = await admin.call('POST', `/api/admin/projects/${projectId}/documents`, {
      name: 'ata-reuniao.txt', mimeType: 'text/plain',
      contentBase64: Buffer.from('Ata da reunião de kickoff').toString('base64')
    });
    assert.equal(ok.status, 200);

    const dash = await alice.call('GET', `/api/projects/${projectId}/dashboard`);
    const doc = dash.data.documents[0];
    assert.ok(doc, 'documento visível para o cliente vinculado');

    const download = await alice.call('GET', `/api/projects/${projectId}/documents/${doc.id}/download`);
    assert.equal(download.status, 200);
    assert.match(String(download.data), /kickoff/);

    const blocked = await bruno.call('GET', `/api/projects/${projectId}/documents/${doc.id}/download`);
    assert.equal(blocked.status, 403);
  });

  await t.test('feed manual é editável; auditoria automática é somente leitura', async () => {
    await admin.call('POST', `/api/admin/projects/${projectId}/activities`, {
      title: 'Sprint 3 concluída', description: 'Módulo financeiro entregue.'
    });
    const detail = await admin.call('GET', `/api/admin/projects/${projectId}`);
    const manual = detail.data.activities.find((a) => a.activityType === 'update');
    const automated = detail.data.activities.find((a) => a.activityType !== 'update');
    assert.ok(manual && automated);

    const editManual = await admin.call('PATCH', `/api/admin/projects/${projectId}/activities/${manual.id}`, {
      title: 'Sprint 3 concluída ✔'
    });
    assert.equal(editManual.status, 200);

    const editAudit = await admin.call('PATCH', `/api/admin/projects/${projectId}/activities/${automated.id}`, {
      title: 'Adulterado'
    });
    assert.equal(editAudit.status, 409);
    const delAudit = await admin.call('DELETE', `/api/admin/projects/${projectId}/activities/${automated.id}`);
    assert.equal(delAudit.status, 409);
  });

  await t.test('exclusão de projeto remove registros dependentes em transação', async () => {
    const temp = await admin.call('POST', '/api/admin/projects', { code: 'QA-DEL', name: 'Projeto QA descartável' });
    const tempId = temp.data.project.id;
    await admin.call('POST', `/api/admin/projects/${tempId}/milestones`, { title: 'Marco QA' });
    await admin.call('POST', `/api/admin/projects/${tempId}/deliverables`, { title: 'Entregável QA' });
    await admin.call('POST', `/api/admin/projects/${tempId}/contacts`, { name: 'Contato QA' });
    await admin.call('POST', `/api/admin/projects/${tempId}/documents`, {
      name: 'qa.txt', mimeType: 'text/plain', contentBase64: Buffer.from('qa').toString('base64')
    });

    const del = await admin.call('DELETE', `/api/admin/projects/${tempId}`);
    assert.equal(del.status, 200);

    for (const table of ['projects', 'milestones', 'deliverables', 'projectContacts',
      'projectDocuments', 'projectActivities', 'projectMembers', 'projectClients', 'projectFeedback']) {
      const column = table === 'projects' ? 'id' : 'projectId';
      const row = one(db, `SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`, tempId);
      assert.equal(row.n, 0, `${table} sem registros do projeto excluído`);
    }
    assert.ok(!existsSync(join(workDir, 'storage', 'projects', String(tempId))),
      'arquivos do projeto excluído removidos do armazenamento');
  });

  await t.test('marcos e entregáveis: atualização e exclusão funcionam', async () => {
    await admin.call('POST', `/api/admin/projects/${projectId}/milestones`, { title: 'Kickoff', dueDate: '2026-08-10' });
    let detail = await admin.call('GET', `/api/admin/projects/${projectId}`);
    const milestone = detail.data.milestones[0];
    const done = await admin.call('PATCH', `/api/admin/projects/${projectId}/milestones/${milestone.id}`, { status: 'completed' });
    assert.equal(done.status, 200);

    const badStatus = await admin.call('PATCH', `/api/admin/projects/${projectId}/milestones/${milestone.id}`, { status: 'invalido' });
    assert.equal(badStatus.status, 400);

    await admin.call('POST', `/api/admin/projects/${projectId}/deliverables`, { title: 'Especificação' });
    detail = await admin.call('GET', `/api/admin/projects/${projectId}`);
    const deliverable = detail.data.deliverables[0];
    const progress = await admin.call('PATCH', `/api/admin/projects/${projectId}/deliverables/${deliverable.id}`, { progress: 150 });
    assert.equal(progress.status, 400, 'progresso acima de 100 é rejeitado');
  });

  await t.test('rotas SPA e 404 de API', async () => {
    const spa = await client().call('GET', '/rota-que-nao-existe');
    assert.equal(spa.status, 200);
    assert.match(String(spa.data), /Portal de Projetos/, 'shell da SPA renderiza a tela 404 própria');

    const apiMiss = await client().call('GET', '/api/nada');
    assert.equal(apiMiss.status, 404);
  });

  await t.test('logout encerra a sessão', async () => {
    const out = await alice.call('POST', '/api/auth/logout');
    assert.equal(out.status, 200);
    assert.equal((await alice.call('GET', '/api/projects')).status, 401);
  });
});

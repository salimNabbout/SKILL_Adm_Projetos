/* SPA do Portal de Projetos (PT-BR).
   A interface esconde controles conforme o papel, mas a autorização
   real acontece sempre no servidor. */
(() => {
  'use strict';

  const app = document.getElementById('app');
  let currentUser; // undefined = ainda não resolvido; null = sem sessão

  // ------------------------------------------------------------ utilidades

  const esc = (v) => String(v ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

  const STATUS_LABELS = {
    planning: 'Planejamento', on_track: 'No prazo', attention: 'Atenção',
    delayed: 'Atrasado', paused: 'Pausado', completed: 'Concluído'
  };
  const MILESTONE_LABELS = { pending: 'Pendente', in_progress: 'Em andamento', completed: 'Concluído' };
  const DELIVERABLE_LABELS = { not_started: 'Não iniciado', in_progress: 'Em andamento', review: 'Em revisão', completed: 'Concluído' };
  const ACCESS_LABELS = { client: 'Cliente', viewer: 'Observador', manager: 'Gestor' };
  const ACTIVITY_LABELS = {
    update: 'Publicação', project_created: 'Auditoria', project_updated: 'Auditoria',
    status_changed: 'Auditoria', client_linked: 'Auditoria', client_unlinked: 'Auditoria',
    member_assigned: 'Auditoria', member_removed: 'Auditoria', milestone: 'Cronograma',
    deliverable: 'Entregável', document: 'Documento', feedback: 'Feedback'
  };

  const fmtDate = (iso) => {
    if (!iso) return '—';
    const [y, m, d] = String(iso).slice(0, 10).split('-');
    return (y && m && d) ? `${d}/${m}/${y}` : String(iso);
  };
  const fmtDateTime = (iso) => {
    const date = new Date(String(iso).includes('T') ? iso : iso + 'Z');
    return Number.isNaN(date.getTime()) ? String(iso) : date.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  };
  const fmtBytes = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';

  const statusBadge = (status) => `<span class="badge ${esc(status)}">${esc(STATUS_LABELS[status] || status)}</span>`;
  const progressBar = (value) => `<div class="progress" role="progressbar" aria-valuenow="${Number(value) || 0}" aria-valuemin="0" aria-valuemax="100"><span style="width:${Number(value) || 0}%"></span></div>`;

  // Máscara de telefone brasileiro: (11) 98765-4321
  function maskPhoneBR(value) {
    const digits = String(value).replace(/\D/g, '').slice(0, 11);
    if (digits.length <= 2) return digits;
    if (digits.length <= 6) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`;
    if (digits.length <= 10) return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  }
  function bindPhoneMask(input) {
    if (input) input.addEventListener('input', () => { input.value = maskPhoneBR(input.value); });
  }

  // ------------------------------------------------------------ toasts + confirmação

  function toast(message, kind = 'error') {
    const box = document.getElementById('toasts');
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = message;
    box.appendChild(el);
    setTimeout(() => el.remove(), 5200);
  }

  function confirmAction({ title, message, okLabel = 'Confirmar' }) {
    return new Promise((resolve) => {
      const dialog = document.getElementById('confirm-dialog');
      document.getElementById('confirm-title').textContent = title;
      document.getElementById('confirm-message').textContent = message;
      document.getElementById('confirm-ok').textContent = okLabel;
      const onClose = () => {
        dialog.removeEventListener('close', onClose);
        resolve(dialog.returnValue === 'confirm');
      };
      dialog.addEventListener('close', onClose);
      dialog.showModal();
    });
  }

  // ------------------------------------------------------------ API

  class ApiError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }

  async function api(method, path, body) {
    let res;
    try {
      res = await fetch(path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined
      });
    } catch {
      throw new ApiError(0, 'Falha de conexão com o portal. Verifique sua rede.');
    }
    let data = {};
    try { data = await res.json(); } catch { /* corpo vazio */ }
    if (!res.ok) throw new ApiError(res.status, data.error || 'Erro inesperado no portal.');
    return data;
  }

  // Integração central de erros de mutação: um único toast por falha.
  async function mutate(method, path, body, successMessage) {
    try {
      const result = await api(method, path, body);
      if (successMessage) toast(successMessage, 'success');
      return result;
    } catch (err) {
      toast(err.message, 'error');
      return null;
    }
  }

  // ------------------------------------------------------------ roteador

  function navigate(path) {
    history.pushState({}, '', path);
    render();
  }

  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[data-nav]');
    if (link) {
      event.preventDefault();
      navigate(link.getAttribute('href'));
    }
  });
  window.addEventListener('popstate', render);

  async function resolveUser() {
    if (currentUser !== undefined) return currentUser;
    try {
      const { user } = await api('GET', '/api/auth/me');
      currentUser = user;
    } catch {
      currentUser = null;
    }
    return currentUser;
  }

  function layout(content, { active } = {}) {
    const user = currentUser;
    const navLinks = [];
    if (user) {
      if (user.role === 'admin') {
        navLinks.push(`<a data-nav href="/admin" class="btn btn-ghost btn-sm ${active === 'admin' ? 'active' : ''}">Administração</a>`);
      }
      navLinks.push(`<a data-nav href="/portal" class="btn btn-ghost btn-sm">Meus projetos</a>`);
      navLinks.push(`<span class="user-chip">${esc(user.name)}</span>`);
      navLinks.push(`<button class="btn btn-ghost btn-sm" id="logout-btn">Sair</button>`);
    } else {
      navLinks.push(`<a data-nav href="/acessar" class="btn btn-sm">Acessar portal</a>`);
    }
    app.innerHTML = `
      <header class="topbar">
        <div class="topbar-inner">
          <a data-nav href="/" class="brand"><span class="brand-mark">✓</span> Portal de Projetos</a>
          <nav class="topbar-actions" aria-label="Navegação principal">${navLinks.join('')}</nav>
        </div>
      </header>
      <main class="page">${content}</main>`;
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async () => {
        await mutate('POST', '/api/auth/logout');
        currentUser = null;
        navigate('/');
      });
    }
  }

  const loadingView = (message = 'Carregando…') =>
    `<div class="loading-state"><span class="spinner" aria-hidden="true"></span>${esc(message)}</div>`;

  function errorView(message, retryPath) {
    return `<div class="card">
      <h2>Não foi possível carregar</h2>
      <p class="card-sub">${esc(message)}</p>
      <button class="btn" id="retry-btn">Tentar novamente</button>
    </div>`;
  }
  function bindRetry() {
    const btn = document.getElementById('retry-btn');
    if (btn) btn.addEventListener('click', render);
  }

  // ------------------------------------------------------------ páginas

  function renderLanding() {
    layout(`
      <section class="hero">
        <h1>Transparência total sobre o andamento dos seus projetos</h1>
        <p>Acompanhe progresso, marcos, entregáveis, documentos e atualizações da equipe em um só lugar, com acesso seguro e individual.</p>
        <a data-nav href="/acessar" class="btn">Acessar meu portal</a>
      </section>
      <section class="feature-grid" aria-label="Recursos do portal">
        <div class="card"><div class="feature-icon">📈</div><h2>Progresso em tempo real</h2><p class="card-sub">Percentual de conclusão, situação de saúde e datas sempre atualizados pela equipe do projeto.</p></div>
        <div class="card"><div class="feature-icon">🗓️</div><h2>Marcos e entregáveis</h2><p class="card-sub">Cronograma claro com marcos do projeto e o estado de cada entregável.</p></div>
        <div class="card"><div class="feature-icon">📄</div><h2>Documentos centralizados</h2><p class="card-sub">Arquivos do projeto publicados com segurança, disponíveis para download a qualquer momento.</p></div>
        <div class="card"><div class="feature-icon">💬</div><h2>Feedback direto</h2><p class="card-sub">Envie observações para a equipe e acompanhe o feed de atividades do projeto.</p></div>
      </section>`);
  }

  // Gateway de acesso: espera a sessão resolver e roteia por papel.
  async function renderGateway() {
    layout(loadingView('Verificando sua sessão…'));
    const user = await resolveUser();
    if (user) {
      navigate(user.role === 'admin' ? '/admin' : '/portal');
      return;
    }
    layout(`
      <div class="dash-grid" style="max-width:900px;margin:0 auto">
        <div class="card">
          <h2>Entrar no portal</h2>
          <p class="card-sub">Use a conta fornecida pela equipe do projeto.</p>
          <form id="login-form" novalidate>
            <div class="field"><label for="login-email">E-mail</label>
              <input id="login-email" name="email" type="email" required maxlength="160" autocomplete="email"></div>
            <div class="field"><label for="login-password">Senha</label>
              <input id="login-password" name="password" type="password" required autocomplete="current-password"></div>
            <button class="btn" type="submit">Entrar</button>
          </form>
        </div>
        <div class="card">
          <h2>Primeiro acesso?</h2>
          <p class="card-sub">Crie sua conta. A equipe administrativa vinculará seus projetos em seguida.</p>
          <form id="register-form" novalidate>
            <div class="field"><label for="reg-name">Nome completo</label>
              <input id="reg-name" name="name" required maxlength="120" autocomplete="name"></div>
            <div class="field"><label for="reg-email">E-mail</label>
              <input id="reg-email" name="email" type="email" required maxlength="160" autocomplete="email"></div>
            <div class="field"><label for="reg-password">Senha (mín. 6 caracteres)</label>
              <input id="reg-password" name="password" type="password" required minlength="6" autocomplete="new-password"></div>
            <button class="btn btn-ghost" type="submit">Criar conta</button>
          </form>
        </div>
      </div>`);
    const handle = (formId, endpoint) => {
      document.getElementById(formId).addEventListener('submit', async (event) => {
        event.preventDefault();
        const payload = Object.fromEntries(new FormData(event.target));
        const result = await mutate('POST', endpoint, payload);
        if (result && result.user) {
          currentUser = result.user;
          navigate(result.user.role === 'admin' ? '/admin' : '/portal');
        }
      });
    };
    handle('login-form', '/api/auth/login');
    handle('register-form', '/api/auth/register');
  }

  async function renderPortal() {
    const user = await resolveUser();
    if (!user) { navigate('/acessar'); return; }
    layout(loadingView('Carregando seus projetos…'));
    let data;
    try {
      data = await api('GET', '/api/projects');
    } catch (err) {
      layout(errorView(err.message)); bindRetry(); return;
    }
    const cards = data.projects.map((p) => `
      <article class="card project-card" data-open="${p.id}" tabindex="0" role="link" aria-label="Abrir projeto ${esc(p.name)}">
        <div class="workspace-header"><h2>${esc(p.name)}</h2>${statusBadge(p.status)}</div>
        <p class="card-sub">${esc(p.code)}${p.description ? ' · ' + esc(p.description.slice(0, 120)) : ''}</p>
        ${progressBar(p.progress)}
        <div class="meta-row" style="margin-top:.5rem">
          <span>Início: ${fmtDate(p.startDate)}</span><span>Término: ${fmtDate(p.endDate)}</span><span>${p.progress}% concluído</span>
        </div>
      </article>`).join('');
    layout(`
      <h1>Meus projetos</h1>
      <p class="card-sub">Você visualiza apenas os projetos atribuídos à sua conta.</p>
      ${data.projects.length ? `<div class="project-grid">${cards}</div>`
        : `<div class="empty-state">Nenhum projeto atribuído à sua conta até o momento.<br>Assim que a equipe vincular um projeto, ele aparecerá aqui.</div>`}`);
    app.querySelectorAll('[data-open]').forEach((card) => {
      const open = () => navigate(`/projetos/${card.dataset.open}`);
      card.addEventListener('click', open);
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    });
  }

  async function renderProject(projectId) {
    const user = await resolveUser();
    if (!user) { navigate('/acessar'); return; }
    layout(loadingView('Carregando projeto…'));
    let data;
    try {
      data = await api('GET', `/api/projects/${projectId}/dashboard`);
    } catch (err) {
      if (err.status === 404) { renderNotFound(); return; }
      layout(errorView(err.message)); bindRetry(); return;
    }
    const { project: p, viewerIsMember } = data;

    const milestones = data.milestones.length ? `<ul class="timeline">${data.milestones.map((m) => `
      <li class="${esc(m.status)}">
        <strong>${esc(m.title)}</strong>
        <small class="card-sub">${esc(MILESTONE_LABELS[m.status] || m.status)} · Previsto: ${fmtDate(m.dueDate)}</small>
      </li>`).join('')}</ul>` : '<div class="empty-state">Nenhum marco cadastrado ainda.</div>';

    const deliverables = data.deliverables.length ? `<ul class="list">${data.deliverables.map((d) => `
      <li class="list-item"><div class="grow">
        <strong>${esc(d.title)}</strong> ${d.needsAttention ? '<span class="badge attention">Atenção</span>' : ''}
        <small>${esc(DELIVERABLE_LABELS[d.status] || d.status)} · Responsável: ${esc(d.ownerName || '—')} · Prazo: ${fmtDate(d.dueDate)}</small>
        ${progressBar(d.progress)}
      </div></li>`).join('')}</ul>` : '<div class="empty-state">Nenhum entregável cadastrado ainda.</div>';

    const documents = data.documents.length ? `<ul class="list">${data.documents.map((doc) => `
      <li class="list-item"><div class="grow">
        <strong>${esc(doc.name)}</strong>
        <small>${fmtBytes(doc.sizeBytes)} · publicado por ${esc(doc.uploadedBy)} em ${fmtDateTime(doc.createdAt)}</small>
      </div>
      <a class="btn btn-ghost btn-sm" href="/api/projects/${p.id}/documents/${doc.id}/download">Baixar</a></li>`).join('')}</ul>`
      : '<div class="empty-state">Nenhum documento publicado ainda.</div>';

    const activities = data.activities.length ? `<ul class="list">${data.activities.map((a) => `
      <li class="list-item"><div class="grow">
        <strong>${esc(a.title)}</strong> <span class="badge plain planning">${esc(ACTIVITY_LABELS[a.activityType] || 'Atividade')}</span>
        ${a.description ? `<small>${esc(a.description)}</small>` : ''}
        <small>${esc(a.actorName)} · ${fmtDateTime(a.createdAt)}</small>
      </div></li>`).join('')}</ul>` : '<div class="empty-state">Nenhuma atividade registrada ainda.</div>';

    const contacts = data.contacts.length ? `<ul class="list">${data.contacts.map((c) => `
      <li class="list-item"><div class="grow">
        <strong>${esc(c.name)}</strong>${c.isPrimary ? ' <span class="badge plain on_track">Principal</span>' : ''}
        <small>${esc(c.role || '')}${c.email ? ' · ' + esc(c.email) : ''}</small>
      </div></li>`).join('')}</ul>` : '<div class="empty-state">Nenhum contato divulgado.</div>';

    const orgs = data.organizations.length
      ? data.organizations.map((o) => `<span class="badge plain planning">${esc(o.name)}${o.status !== 'active' ? ' (Inativo)' : ''}</span>`).join(' ')
      : '<span class="card-sub">—</span>';

    const feedbackCard = viewerIsMember ? `
      <div class="card"><h2>Enviar feedback</h2>
        <p class="card-sub">Sua mensagem chega diretamente à equipe do projeto.</p>
        <form id="feedback-form">
          <div class="field"><label for="fb-subject">Assunto</label>
            <input id="fb-subject" name="subject" required maxlength="140"></div>
          <div class="field"><label for="fb-message">Mensagem</label>
            <textarea id="fb-message" name="message" rows="4" required maxlength="2000"></textarea></div>
          <button class="btn" type="submit">Enviar feedback</button>
        </form>
      </div>` : `
      <div class="card"><h2>Enviar feedback</h2>
        <p class="notice">Você está visualizando como administrador. O envio de feedback é exclusivo de contas vinculadas ao projeto.</p>
        <form aria-disabled="true">
          <div class="field"><label for="fb-subject">Assunto</label><input id="fb-subject" disabled></div>
          <div class="field"><label for="fb-message">Mensagem</label><textarea id="fb-message" rows="4" disabled></textarea></div>
          <button class="btn" type="button" disabled>Enviar feedback</button>
        </form>
      </div>`;

    layout(`
      <div class="workspace-header" style="margin-bottom:.8rem">
        <a data-nav href="${user.role === 'admin' && !viewerIsMember ? '/admin' : '/portal'}" class="btn btn-ghost btn-sm">← Voltar</a>
        <h1 style="margin:0">${esc(p.name)}</h1>${statusBadge(p.status)}
      </div>
      ${!viewerIsMember ? '<p class="notice" style="margin-bottom:1rem">Modo de inspeção administrativa: esta é a visão que o cliente tem do projeto.</p>' : ''}
      <div class="card">
        <div class="meta-row"><span>Código: <strong>${esc(p.code)}</strong></span>
          <span>Início: <strong>${fmtDate(p.startDate)}</strong></span>
          <span>Término previsto: <strong>${fmtDate(p.endDate)}</strong></span>
          <span>Organizações: ${orgs}</span></div>
        ${p.description ? `<p style="margin:.6rem 0">${esc(p.description)}</p>` : ''}
        <div style="margin-top:.6rem">${progressBar(p.progress)}<p class="card-sub" style="margin-top:.3rem">${p.progress}% concluído</p></div>
      </div>
      <div class="dash-grid">
        <div>
          <div class="card"><h2>Marcos do projeto</h2>${milestones}</div>
          <div class="card"><h2>Entregáveis</h2>${deliverables}</div>
          <div class="card"><h2>Atividades recentes</h2>${activities}</div>
        </div>
        <div>
          <div class="card"><h2>Documentos</h2>${documents}</div>
          <div class="card"><h2>Contatos do projeto</h2>${contacts}</div>
          ${feedbackCard}
        </div>
      </div>`);

    const feedbackForm = document.getElementById('feedback-form');
    if (feedbackForm) {
      feedbackForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const payload = Object.fromEntries(new FormData(event.target));
        const ok = await mutate('POST', `/api/projects/${p.id}/feedback`, payload, 'Feedback enviado à equipe do projeto.');
        if (ok) render();
      });
    }
  }

  // ------------------------------------------------------------ administração

  const adminState = { selectedId: null, tab: 'status' };

  async function renderAdmin() {
    const user = await resolveUser();
    if (!user) { navigate('/acessar'); return; }
    if (user.role !== 'admin') { navigate('/portal'); return; }
    layout(loadingView('Carregando administração…'), { active: 'admin' });
    let overview;
    try {
      overview = await api('GET', '/api/admin/overview');
    } catch (err) {
      layout(errorView(err.message), { active: 'admin' }); bindRetry(); return;
    }
    if (adminState.selectedId && !overview.projects.some((p) => p.id === adminState.selectedId)) {
      adminState.selectedId = null;
    }
    if (!adminState.selectedId && overview.projects.length) {
      adminState.selectedId = overview.projects[0].id;
    }

    let detail = null;
    if (adminState.selectedId) {
      try {
        detail = await api('GET', `/api/admin/projects/${adminState.selectedId}`);
      } catch {
        adminState.selectedId = null;
      }
    }

    const portfolioItems = overview.projects.length ? overview.projects.map((p) => `
      <li class="list-item ${p.id === adminState.selectedId ? 'selected' : ''}" data-select="${p.id}" tabindex="0">
        <div class="grow">
          <strong>${esc(p.name)}</strong>
          <small>${esc(p.code)} · ${esc(STATUS_LABELS[p.status] || p.status)} · ${p.progress}%</small>
          ${p.attentionPoints.map((a) => `<small class="attention-flag">⚠ ${esc(a)}</small>`).join('')}
        </div>
      </li>`).join('')
      : '<li class="empty-state">Nenhum projeto criado ainda. Use “Novo projeto” para começar.</li>';

    layout(`
      <h1>Administração</h1>
      <p class="card-sub">Mantenha projetos, organizações clientes, acessos e o feed de atualizações.</p>
      <div class="admin-layout">
        <aside class="portfolio">
          <div class="card">
            <div class="workspace-header"><h2 style="flex:1">Portfólio</h2>
              <button class="btn btn-sm" id="new-project-btn">＋ Novo projeto</button></div>
            <form id="new-project-form" hidden style="margin:.7rem 0">
              <div class="field"><label for="np-code">Código</label><input id="np-code" name="code" required maxlength="30" placeholder="PRJ-001"></div>
              <div class="field"><label for="np-name">Nome</label><input id="np-name" name="name" required maxlength="140"></div>
              <div class="field"><label for="np-desc">Descrição</label><textarea id="np-desc" name="description" rows="2" maxlength="2000"></textarea></div>
              <div class="form-row">
                <div class="field"><label for="np-start">Início</label><input id="np-start" name="startDate" type="date"></div>
                <div class="field"><label for="np-end">Término</label><input id="np-end" name="endDate" type="date"></div>
              </div>
              <p class="field-error" id="np-date-error" hidden>A data de término não pode ser anterior à data de início.</p>
              <button class="btn" type="submit">Criar projeto</button>
            </form>
            <ul class="list" id="portfolio-list">${portfolioItems}</ul>
          </div>
          <div class="card">
            <h2>Organizações clientes</h2>
            <p class="card-sub">Diretório de empresas atendidas (cadastro ≠ conta de acesso).</p>
            <div id="org-directory"></div>
          </div>
        </aside>
        <section id="workspace">
          ${detail ? '' : '<div class="empty-state">Selecione ou crie um projeto para abrir o espaço de trabalho.</div>'}
        </section>
      </div>`, { active: 'admin' });

    // ---- portfólio
    document.querySelectorAll('[data-select]').forEach((item) => {
      const select = () => { adminState.selectedId = Number(item.dataset.select); render(); };
      item.addEventListener('click', select);
      item.addEventListener('keydown', (e) => { if (e.key === 'Enter') select(); });
    });
    const newBtn = document.getElementById('new-project-btn');
    const newForm = document.getElementById('new-project-form');
    newBtn.addEventListener('click', () => { newForm.hidden = !newForm.hidden; });
    const npStart = document.getElementById('np-start');
    const npEnd = document.getElementById('np-end');
    const npError = document.getElementById('np-date-error');
    const checkDates = () => {
      npEnd.min = npStart.value || '';
      npError.hidden = !(npStart.value && npEnd.value && npEnd.value < npStart.value);
    };
    npStart.addEventListener('change', checkDates);
    npEnd.addEventListener('change', checkDates);
    newForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      checkDates();
      if (!npError.hidden) return;
      const payload = Object.fromEntries(new FormData(event.target));
      const result = await mutate('POST', '/api/admin/projects', payload, 'Projeto criado.');
      if (result) { adminState.selectedId = result.project.id; adminState.tab = 'status'; render(); }
    });

    renderOrgDirectory(overview.clients);
    if (detail) renderWorkspace(detail, overview.clients);
  }

  function renderOrgDirectory(clients) {
    const host = document.getElementById('org-directory');
    const items = clients.length ? `<ul class="list">${clients.map((c) => `
      <li class="list-item"><div class="grow">
        <strong>${esc(c.name)}</strong>${c.status !== 'active' ? ' <span class="badge inactive">Inativo</span>' : ''}
        <small>${esc(c.contactName || '—')}${c.email ? ' · ' + esc(c.email) : ''}${c.phone ? ' · ' + esc(c.phone) : ''}</small>
      </div>
      <button class="btn btn-ghost btn-sm" data-edit-org="${c.id}">Editar</button>
      <button class="btn btn-danger btn-sm" data-del-org="${c.id}" data-org-name="${esc(c.name)}">Excluir</button></li>`).join('')}</ul>`
      : '<div class="empty-state">Nenhuma organização cadastrada.</div>';
    host.innerHTML = `${items}
      <button class="btn btn-ghost btn-sm" id="org-add-btn" style="margin-top:.6rem">＋ Nova organização</button>
      <form id="org-form" hidden style="margin-top:.7rem"></form>`;

    const form = document.getElementById('org-form');
    const openForm = (client) => {
      form.hidden = false;
      form.dataset.editing = client ? client.id : '';
      form.innerHTML = `
        <h3>${client ? 'Editar organização' : 'Nova organização'}</h3>
        <div class="field"><label for="org-name">Nome</label><input id="org-name" name="name" required maxlength="120" value="${esc(client?.name || '')}"></div>
        <div class="field"><label for="org-legal">Razão social</label><input id="org-legal" name="legalName" maxlength="160" value="${esc(client?.legalName || '')}"></div>
        <div class="field"><label for="org-contact">Contato</label><input id="org-contact" name="contactName" maxlength="120" value="${esc(client?.contactName || '')}"></div>
        <div class="field"><label for="org-email">E-mail</label><input id="org-email" name="email" type="email" maxlength="160" value="${esc(client?.email || '')}"></div>
        <div class="field"><label for="org-phone">Telefone</label><input id="org-phone" name="phone" maxlength="16" placeholder="(11) 98765-4321" value="${esc(client?.phone || '')}"></div>
        <div class="field"><label for="org-status">Situação</label>
          <select id="org-status" name="status">
            <option value="active" ${!client || client.status === 'active' ? 'selected' : ''}>Ativa</option>
            <option value="inactive" ${client?.status === 'inactive' ? 'selected' : ''}>Inativa</option>
          </select></div>
        <button class="btn" type="submit">${client ? 'Salvar alterações' : 'Cadastrar'}</button>`;
      bindPhoneMask(document.getElementById('org-phone'));
    };
    document.getElementById('org-add-btn').addEventListener('click', () => openForm(null));
    host.querySelectorAll('[data-edit-org]').forEach((btn) => {
      btn.addEventListener('click', () => openForm(clients.find((c) => c.id === Number(btn.dataset.editOrg))));
    });
    host.querySelectorAll('[data-del-org]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const ok = await confirmAction({
          title: 'Excluir organização',
          message: `A organização “${btn.dataset.orgName}” será removida do diretório. Organizações vinculadas a projetos não podem ser excluídas.`,
          okLabel: 'Excluir'
        });
        if (!ok) return;
        const result = await mutate('DELETE', `/api/admin/clients/${btn.dataset.delOrg}`, undefined, 'Organização excluída.');
        if (result) render();
      });
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(form));
      const editing = form.dataset.editing;
      const result = editing
        ? await mutate('PATCH', `/api/admin/clients/${editing}`, payload, 'Organização atualizada.')
        : await mutate('POST', '/api/admin/clients', payload, 'Organização cadastrada.');
      if (result) render();
    });
  }

  function renderWorkspace(detail, allClients) {
    const host = document.getElementById('workspace');
    const p = detail.project;
    const tabs = [
      ['status', 'Status'], ['orgs', 'Organizações'], ['access', 'Acesso'],
      ['milestones', 'Marcos'], ['deliverables', 'Entregáveis'], ['contacts', 'Contatos'],
      ['documents', 'Documentos'], ['feed', 'Feed e feedback']
    ];
    host.innerHTML = `
      <div class="card">
        <div class="workspace-header">
          <h2>${esc(p.name)}</h2>${statusBadge(p.status)}
          <span class="card-sub">${esc(p.code)}</span>
          <span style="flex:1"></span>
          <a data-nav href="/projetos/${p.id}" class="btn btn-ghost btn-sm">Ver como cliente</a>
          <button class="btn btn-danger btn-sm" id="delete-project-btn">Excluir projeto</button>
        </div>
        <div style="margin-top:.6rem">${progressBar(p.progress)}</div>
        <nav class="tabs" style="margin-top:1rem" aria-label="Seções do projeto">
          ${tabs.map(([key, label]) => `<button class="tab ${adminState.tab === key ? 'active' : ''}" data-tab="${key}">${label}</button>`).join('')}
        </nav>
        <div id="tab-content"></div>
      </div>`;

    host.querySelectorAll('[data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => { adminState.tab = btn.dataset.tab; renderWorkspace(detail, allClients); });
    });
    document.getElementById('delete-project-btn').addEventListener('click', async () => {
      const ok = await confirmAction({
        title: 'Excluir projeto',
        message: `Excluir “${p.name}” remove em cascata todos os marcos, entregáveis, contatos, documentos, atividades, feedbacks e vínculos de acesso e de organizações. Esta ação não pode ser desfeita.`,
        okLabel: 'Excluir tudo'
      });
      if (!ok) return;
      const result = await mutate('DELETE', `/api/admin/projects/${p.id}`, undefined, 'Projeto excluído.');
      if (result) { adminState.selectedId = null; render(); }
    });

    const content = document.getElementById('tab-content');
    const renderers = {
      status: renderStatusTab, orgs: renderOrgsTab, access: renderAccessTab,
      milestones: renderMilestonesTab, deliverables: renderDeliverablesTab,
      contacts: renderContactsTab, documents: renderDocumentsTab, feed: renderFeedTab
    };
    (renderers[adminState.tab] || renderStatusTab)(content, detail, allClients);
  }

  function renderStatusTab(host, detail) {
    const p = detail.project;
    host.innerHTML = `
      <form id="status-form">
        <div class="field"><label for="st-name">Nome do projeto</label><input id="st-name" name="name" required maxlength="140" value="${esc(p.name)}"></div>
        <div class="field"><label for="st-desc">Descrição</label><textarea id="st-desc" name="description" rows="3" maxlength="2000">${esc(p.description)}</textarea></div>
        <div class="form-row">
          <div class="field"><label for="st-status">Situação</label>
            <select id="st-status" name="status">
              ${Object.entries(STATUS_LABELS).map(([v, l]) => `<option value="${v}" ${p.status === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select></div>
          <div class="field"><label for="st-progress">Progresso (%)</label>
            <input id="st-progress" name="progress" type="number" min="0" max="100" value="${p.progress}"></div>
          <div class="field"><label for="st-start">Início</label><input id="st-start" name="startDate" type="date" value="${esc(p.startDate || '')}"></div>
          <div class="field"><label for="st-end">Término</label><input id="st-end" name="endDate" type="date" value="${esc(p.endDate || '')}" min="${esc(p.startDate || '')}"></div>
        </div>
        <p class="field-error" id="st-date-error" hidden>A data de término não pode ser anterior à data de início.</p>
        <button class="btn" type="submit">Salvar status</button>
      </form>`;
    const start = document.getElementById('st-start');
    const end = document.getElementById('st-end');
    const error = document.getElementById('st-date-error');
    const check = () => {
      end.min = start.value || '';
      error.hidden = !(start.value && end.value && end.value < start.value);
    };
    start.addEventListener('change', check);
    end.addEventListener('change', check);
    document.getElementById('status-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      check();
      if (!error.hidden) return;
      const payload = Object.fromEntries(new FormData(event.target));
      const result = await mutate('PATCH', `/api/admin/projects/${detail.project.id}`, payload, 'Status do projeto atualizado.');
      if (result) render();
    });
  }

  function renderOrgsTab(host, detail, allClients) {
    const activeClients = allClients.filter((c) => c.status === 'active' &&
      !detail.organizations.some((o) => o.id === c.id));
    host.innerHTML = `
      <h3>Organizações vinculadas</h3>
      ${detail.organizations.length ? `<ul class="list">${detail.organizations.map((o) => `
        <li class="list-item"><div class="grow">
          <strong>${esc(o.name)}</strong>${o.status !== 'active' ? ' <span class="badge inactive">Inativo</span>' : ''}
          <small>${o.relationship === 'primary' ? 'Cliente principal' : 'Parte interessada'}</small>
        </div>
        <button class="btn btn-danger btn-sm" data-unlink="${o.linkId}" data-name="${esc(o.name)}">Remover vínculo</button></li>`).join('')}</ul>`
        : '<div class="empty-state">Nenhuma organização vinculada a este projeto.</div>'}
      <form id="link-form" class="form-inline" style="margin-top:1rem">
        <div class="field"><label for="link-client">Organização (apenas ativas)</label>
          <select id="link-client" name="clientId" required>
            <option value="">Selecione…</option>
            ${activeClients.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}
          </select></div>
        <div class="field"><label for="link-rel">Relação</label>
          <select id="link-rel" name="relationship">
            <option value="primary">Cliente principal</option>
            <option value="stakeholder">Parte interessada</option>
          </select></div>
        <button class="btn" type="submit" ${activeClients.length ? '' : 'disabled'}>Vincular</button>
      </form>`;
    host.querySelectorAll('[data-unlink]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const ok = await confirmAction({
          title: 'Remover vínculo',
          message: `A organização “${btn.dataset.name}” deixará de estar associada a este projeto. O cadastro dela permanece no diretório.`,
          okLabel: 'Remover'
        });
        if (!ok) return;
        const result = await mutate('DELETE', `/api/admin/projects/${detail.project.id}/clients/${btn.dataset.unlink}`, undefined, 'Vínculo removido.');
        if (result) render();
      });
    });
    document.getElementById('link-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(event.target));
      const result = await mutate('POST', `/api/admin/projects/${detail.project.id}/clients`, payload, 'Organização vinculada.');
      if (result) render();
    });
  }

  async function renderAccessTab(host, detail) {
    host.innerHTML = loadingView('Carregando contas…');
    let accounts;
    try {
      accounts = await api('GET', '/api/admin/accounts');
    } catch (err) {
      host.innerHTML = `<p class="field-error">${esc(err.message)}</p>`;
      return;
    }
    const available = accounts.users.filter((u) => !detail.members.some((m) => m.userId === u.id));
    host.innerHTML = `
      <h3>Contas com acesso</h3>
      <p class="card-sub">O cliente só enxerga o projeto depois de receber acesso aqui.</p>
      ${detail.members.length ? `<ul class="list">${detail.members.map((m) => `
        <li class="list-item"><div class="grow">
          <strong>${esc(m.name)}</strong>
          <small>${esc(m.email)} · Papel: ${esc(ACCESS_LABELS[m.accessRole] || m.accessRole)} · desde ${fmtDateTime(m.assignedAt)}</small>
        </div>
        <button class="btn btn-danger btn-sm" data-remove-member="${m.memberId}" data-name="${esc(m.email)}">Remover acesso</button></li>`).join('')}</ul>`
        : '<div class="empty-state">Nenhuma conta de cliente tem acesso a este projeto.</div>'}
      <form id="assign-form" class="form-inline" style="margin-top:1rem">
        <div class="field"><label for="assign-user">Conta autenticada</label>
          <select id="assign-user" name="userId" required>
            <option value="">Selecione…</option>
            ${available.map((u) => `<option value="${u.id}">${esc(u.name)} — ${esc(u.email)}</option>`).join('')}
          </select></div>
        <div class="field"><label for="assign-role">Papel de acesso</label>
          <select id="assign-role" name="accessRole">
            ${Object.entries(ACCESS_LABELS).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
          </select></div>
        <button class="btn" type="submit" ${available.length ? '' : 'disabled'}>Conceder acesso</button>
      </form>
      ${available.length ? '' : '<p class="card-sub" style="margin-top:.5rem">Todas as contas já possuem acesso ou nenhum cliente criou conta ainda. Peça ao contato do cliente que acesse o portal uma vez.</p>'}`;
    host.querySelectorAll('[data-remove-member]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const ok = await confirmAction({
          title: 'Remover acesso',
          message: `A conta ${btn.dataset.name} perderá o acesso a este projeto imediatamente.`,
          okLabel: 'Remover acesso'
        });
        if (!ok) return;
        const result = await mutate('DELETE', `/api/admin/projects/${detail.project.id}/members/${btn.dataset.removeMember}`, undefined, 'Acesso removido.');
        if (result) render();
      });
    });
    document.getElementById('assign-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(event.target));
      const result = await mutate('POST', `/api/admin/projects/${detail.project.id}/members`, payload, 'Acesso concedido.');
      if (result) render();
    });
  }

  function renderMilestonesTab(host, detail) {
    host.innerHTML = `
      ${detail.milestones.length ? `<ul class="list">${detail.milestones.map((m) => `
        <li class="list-item"><div class="grow">
          <strong>${esc(m.title)}</strong>
          <small>Previsto: ${fmtDate(m.dueDate)}${m.completedAt ? ' · concluído em ' + fmtDateTime(m.completedAt) : ''}</small>
        </div>
        <select data-milestone-status="${m.id}" class="btn-ghost" style="padding:.3rem;border-radius:8px;border:1px solid var(--line)">
          ${Object.entries(MILESTONE_LABELS).map(([v, l]) => `<option value="${v}" ${m.status === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <button class="btn btn-danger btn-sm" data-del-milestone="${m.id}" data-name="${esc(m.title)}">Excluir</button></li>`).join('')}</ul>`
        : '<div class="empty-state">Nenhum marco cadastrado.</div>'}
      <form id="milestone-form" class="form-inline" style="margin-top:1rem">
        <div class="field"><label for="ms-title">Novo marco</label><input id="ms-title" name="title" required maxlength="140"></div>
        <div class="field"><label for="ms-due">Data prevista</label><input id="ms-due" name="dueDate" type="date"></div>
        <button class="btn" type="submit">Adicionar</button>
      </form>`;
    host.querySelectorAll('[data-milestone-status]').forEach((select) => {
      select.addEventListener('change', async () => {
        const result = await mutate('PATCH', `/api/admin/projects/${detail.project.id}/milestones/${select.dataset.milestoneStatus}`,
          { status: select.value }, 'Marco atualizado.');
        if (result) render();
      });
    });
    host.querySelectorAll('[data-del-milestone]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const ok = await confirmAction({ title: 'Excluir marco', message: `O marco “${btn.dataset.name}” será removido do cronograma.`, okLabel: 'Excluir' });
        if (!ok) return;
        const result = await mutate('DELETE', `/api/admin/projects/${detail.project.id}/milestones/${btn.dataset.delMilestone}`, undefined, 'Marco excluído.');
        if (result) render();
      });
    });
    document.getElementById('milestone-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const result = await mutate('POST', `/api/admin/projects/${detail.project.id}/milestones`,
        Object.fromEntries(new FormData(event.target)), 'Marco adicionado.');
      if (result) render();
    });
  }

  function renderDeliverablesTab(host, detail) {
    host.innerHTML = `
      ${detail.deliverables.length ? `<ul class="list">${detail.deliverables.map((d) => `
        <li class="list-item"><div class="grow">
          <strong>${esc(d.title)}</strong>${d.needsAttention ? ' <span class="badge attention">Atenção</span>' : ''}
          <small>Responsável: ${esc(d.ownerName || '—')} · Prazo: ${fmtDate(d.dueDate)} · ${d.progress}%</small>
          ${progressBar(d.progress)}
        </div>
        <div style="display:flex;flex-direction:column;gap:.3rem">
          <select data-deliv-status="${d.id}" style="padding:.3rem;border-radius:8px;border:1px solid var(--line)">
            ${Object.entries(DELIVERABLE_LABELS).map(([v, l]) => `<option value="${v}" ${d.status === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
          <input data-deliv-progress="${d.id}" type="number" min="0" max="100" value="${d.progress}" title="Progresso (%)"
            style="width:90px;padding:.3rem;border-radius:8px;border:1px solid var(--line)">
          <label style="font-size:.75rem;color:var(--ink-soft)"><input type="checkbox" data-deliv-attention="${d.id}" ${d.needsAttention ? 'checked' : ''}> Sinalizar atenção</label>
        </div>
        <button class="btn btn-danger btn-sm" data-del-deliv="${d.id}" data-name="${esc(d.title)}">Excluir</button></li>`).join('')}</ul>`
        : '<div class="empty-state">Nenhum entregável cadastrado.</div>'}
      <form id="deliverable-form" class="form-inline" style="margin-top:1rem">
        <div class="field"><label for="dv-title">Novo entregável</label><input id="dv-title" name="title" required maxlength="140"></div>
        <div class="field"><label for="dv-owner">Responsável</label><input id="dv-owner" name="ownerName" maxlength="120"></div>
        <div class="field"><label for="dv-due">Prazo</label><input id="dv-due" name="dueDate" type="date"></div>
        <button class="btn" type="submit">Adicionar</button>
      </form>`;
    const patch = (id, body) => mutate('PATCH', `/api/admin/projects/${detail.project.id}/deliverables/${id}`, body, 'Entregável atualizado.');
    host.querySelectorAll('[data-deliv-status]').forEach((el) => {
      el.addEventListener('change', async () => { if (await patch(el.dataset.delivStatus, { status: el.value })) render(); });
    });
    host.querySelectorAll('[data-deliv-progress]').forEach((el) => {
      el.addEventListener('change', async () => { if (await patch(el.dataset.delivProgress, { progress: el.value })) render(); });
    });
    host.querySelectorAll('[data-deliv-attention]').forEach((el) => {
      el.addEventListener('change', async () => { if (await patch(el.dataset.delivAttention, { needsAttention: el.checked })) render(); });
    });
    host.querySelectorAll('[data-del-deliv]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const ok = await confirmAction({ title: 'Excluir entregável', message: `O entregável “${btn.dataset.name}” será removido do projeto.`, okLabel: 'Excluir' });
        if (!ok) return;
        const result = await mutate('DELETE', `/api/admin/projects/${detail.project.id}/deliverables/${btn.dataset.delDeliv}`, undefined, 'Entregável excluído.');
        if (result) render();
      });
    });
    document.getElementById('deliverable-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const result = await mutate('POST', `/api/admin/projects/${detail.project.id}/deliverables`,
        Object.fromEntries(new FormData(event.target)), 'Entregável adicionado.');
      if (result) render();
    });
  }

  function renderContactsTab(host, detail) {
    host.innerHTML = `
      ${detail.contacts.length ? `<ul class="list">${detail.contacts.map((c) => `
        <li class="list-item"><div class="grow">
          <strong>${esc(c.name)}</strong>${c.isPrimary ? ' <span class="badge plain on_track">Principal</span>' : ''}
          <small>${esc(c.role || '—')}${c.email ? ' · ' + esc(c.email) : ''}</small>
        </div>
        <button class="btn btn-danger btn-sm" data-del-contact="${c.id}" data-name="${esc(c.name)}">Remover</button></li>`).join('')}</ul>`
        : '<div class="empty-state">Nenhum contato cadastrado.</div>'}
      <form id="contact-form" class="form-inline" style="margin-top:1rem">
        <div class="field"><label for="ct-name">Nome</label><input id="ct-name" name="name" required maxlength="120"></div>
        <div class="field"><label for="ct-role">Função</label><input id="ct-role" name="role" maxlength="80"></div>
        <div class="field"><label for="ct-email">E-mail</label><input id="ct-email" name="email" type="email" maxlength="160"></div>
        <div class="field" style="flex:0"><label for="ct-primary">Principal</label><input id="ct-primary" name="isPrimary" type="checkbox" value="1" style="width:auto"></div>
        <button class="btn" type="submit">Adicionar</button>
      </form>`;
    host.querySelectorAll('[data-del-contact]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const ok = await confirmAction({ title: 'Remover contato', message: `O contato “${btn.dataset.name}” deixará de aparecer para o cliente.`, okLabel: 'Remover' });
        if (!ok) return;
        const result = await mutate('DELETE', `/api/admin/projects/${detail.project.id}/contacts/${btn.dataset.delContact}`, undefined, 'Contato removido.');
        if (result) render();
      });
    });
    document.getElementById('contact-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.target));
      data.isPrimary = Boolean(data.isPrimary);
      const result = await mutate('POST', `/api/admin/projects/${detail.project.id}/contacts`, data, 'Contato adicionado.');
      if (result) render();
    });
  }

  function renderDocumentsTab(host, detail) {
    const MAX = 5 * 1024 * 1024;
    host.innerHTML = `
      ${detail.documents.length ? `<ul class="list">${detail.documents.map((doc) => `
        <li class="list-item"><div class="grow">
          <strong>${esc(doc.name)}</strong>
          <small>${fmtBytes(doc.sizeBytes)} · ${esc(doc.mimeType)} · publicado por ${esc(doc.uploadedBy)} em ${fmtDateTime(doc.createdAt)}</small>
        </div>
        <a class="btn btn-ghost btn-sm" href="/api/projects/${detail.project.id}/documents/${doc.id}/download">Baixar</a>
        <button class="btn btn-danger btn-sm" data-del-doc="${doc.id}" data-name="${esc(doc.name)}">Excluir</button></li>`).join('')}</ul>`
        : '<div class="empty-state">Nenhum documento publicado para este projeto.</div>'}
      <form id="upload-form" style="margin-top:1rem">
        <div class="field"><label for="up-file">Publicar arquivo (máx. 5 MB)</label>
          <input id="up-file" type="file" required></div>
        <p class="field-error" id="up-error" hidden></p>
        <button class="btn" type="submit">Enviar documento</button>
      </form>`;
    host.querySelectorAll('[data-del-doc]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const ok = await confirmAction({ title: 'Excluir documento', message: `O arquivo “${btn.dataset.name}” será removido do portal e do armazenamento.`, okLabel: 'Excluir' });
        if (!ok) return;
        const result = await mutate('DELETE', `/api/admin/projects/${detail.project.id}/documents/${btn.dataset.delDoc}`, undefined, 'Documento excluído.');
        if (result) render();
      });
    });
    document.getElementById('upload-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const input = document.getElementById('up-file');
      const errorEl = document.getElementById('up-error');
      errorEl.hidden = true;
      const file = input.files[0];
      if (!file) return;
      if (file.size > MAX) {
        errorEl.textContent = 'O arquivo excede o tamanho máximo de 5 MB.';
        errorEl.hidden = false;
        return;
      }
      const buffer = await file.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buffer);
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      const result = await mutate('POST', `/api/admin/projects/${detail.project.id}/documents`, {
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        contentBase64: btoa(binary)
      }, 'Documento publicado.');
      if (result) render();
    });
  }

  function renderFeedTab(host, detail) {
    const manual = detail.activities.filter((a) => a.activityType === 'update');
    const automated = detail.activities.filter((a) => a.activityType !== 'update');
    host.innerHTML = `
      <h3>Nova publicação para o cliente</h3>
      <form id="activity-form">
        <div class="field"><label for="ac-title">Título</label><input id="ac-title" name="title" required maxlength="140"></div>
        <div class="field"><label for="ac-desc">Descrição</label><textarea id="ac-desc" name="description" rows="3" maxlength="2000"></textarea></div>
        <button class="btn" type="submit">Publicar no feed</button>
      </form>
      <h3 style="margin-top:1.4rem">Publicações manuais</h3>
      ${manual.length ? `<ul class="list">${manual.map((a) => `
        <li class="list-item"><div class="grow">
          <strong>${esc(a.title)}</strong>
          ${a.description ? `<small>${esc(a.description)}</small>` : ''}
          <small>${esc(a.actorName)} · ${fmtDateTime(a.createdAt)}</small>
        </div>
        <button class="btn btn-ghost btn-sm" data-edit-act="${a.id}">Editar</button>
        <button class="btn btn-danger btn-sm" data-del-act="${a.id}" data-name="${esc(a.title)}">Excluir</button></li>`).join('')}</ul>`
        : '<div class="empty-state">Nenhuma publicação manual ainda.</div>'}
      <h3 style="margin-top:1.4rem">Auditoria automática <span class="badge plain planning">somente leitura</span></h3>
      ${automated.length ? `<ul class="list">${automated.slice(0, 15).map((a) => `
        <li class="list-item"><div class="grow">
          <strong>${esc(a.title)}</strong>
          ${a.description ? `<small>${esc(a.description)}</small>` : ''}
          <small>${esc(a.actorName)} · ${fmtDateTime(a.createdAt)}</small>
        </div></li>`).join('')}</ul>` : '<div class="empty-state">Nenhum registro automático.</div>'}
      <h3 style="margin-top:1.4rem">Feedback recebido dos clientes</h3>
      ${detail.feedback.length ? `<ul class="list">${detail.feedback.map((f) => `
        <li class="list-item"><div class="grow">
          <strong>${esc(f.subject)}</strong>
          <small>${esc(f.message)}</small>
          <small>${esc(f.userName)} · ${fmtDateTime(f.createdAt)}</small>
        </div></li>`).join('')}</ul>` : '<div class="empty-state">Nenhum feedback recebido ainda.</div>'}`;

    document.getElementById('activity-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const result = await mutate('POST', `/api/admin/projects/${detail.project.id}/activities`,
        Object.fromEntries(new FormData(event.target)), 'Publicação adicionada ao feed.');
      if (result) render();
    });
    host.querySelectorAll('[data-edit-act]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const activity = manual.find((a) => a.id === Number(btn.dataset.editAct));
        const title = prompt('Título da publicação:', activity.title);
        if (title === null) return;
        const description = prompt('Descrição:', activity.description || '');
        if (description === null) return;
        const result = await mutate('PATCH', `/api/admin/projects/${detail.project.id}/activities/${activity.id}`,
          { title, description }, 'Publicação atualizada.');
        if (result) render();
      });
    });
    host.querySelectorAll('[data-del-act]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const ok = await confirmAction({ title: 'Excluir publicação', message: `A publicação “${btn.dataset.name}” será removida do feed do cliente.`, okLabel: 'Excluir' });
        if (!ok) return;
        const result = await mutate('DELETE', `/api/admin/projects/${detail.project.id}/activities/${btn.dataset.delAct}`, undefined, 'Publicação excluída.');
        if (result) render();
      });
    });
  }

  function renderNotFound() {
    layout(`
      <div class="notfound card">
        <div class="code">404</div>
        <h1>Página não encontrada</h1>
        <p class="card-sub">O endereço que você tentou abrir não existe ou foi movido.<br>Verifique o link ou volte para uma área conhecida do portal.</p>
        <p style="margin-top:1.2rem">
          <a data-nav href="/" class="btn btn-ghost">Página inicial</a>
          <a data-nav href="/acessar" class="btn">Acessar meu portal</a>
        </p>
      </div>`);
  }

  // ------------------------------------------------------------ despacho

  async function render() {
    const path = location.pathname;
    await resolveUser();
    if (path === '/') return renderLanding();
    if (path === '/acessar') return renderGateway();
    if (path === '/portal') return renderPortal();
    if (path === '/admin') return renderAdmin();
    const projectMatch = /^\/projetos\/(\d+)$/.exec(path);
    if (projectMatch) return renderProject(projectMatch[1]);
    return renderNotFound();
  }

  render();
})();

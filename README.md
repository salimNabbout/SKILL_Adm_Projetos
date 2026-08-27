# SKILL_Adm_Projetos

Skill **`project-status-portal`** para Claude: construir e evoluir **portais de status de projetos** seguros, com área do cliente restrita e centro de controle administrativo.

## O que a skill faz

Guia a construção (ou evolução) de um portal web com três experiências:

- **Página pública** — apresentação e ponto de entrada seguro (`/acessar`).
- **Área do cliente** (`/portal`) — o cliente autenticado vê **somente os projetos atribuídos a ele**: progresso, datas, marcos, entregáveis, documentos, feed de atividades, contatos e envio de feedback.
- **Área administrativa** (`/admin`) — administradores criam e mantêm projetos, organizações clientes, atribuições de acesso, marcos, entregáveis, documentos e publicações no feed.

## Princípios centrais

- **Controle de acesso no servidor**, nunca como filtro de interface: acesso por `projectMembers(projectId, userId, accessRole)`, verificação de vínculo em toda consulta, e guard `adminProcedure` para toda manutenção.
- **Organizações ≠ contas**: organizações clientes vinculam-se a projetos via `projectClients` (relação de negócio); contas individuais via `projectMembers` (autorização de acesso).
- **Roteamento por papel após o login**: `admin` → `/admin`, demais → `/portal`.
- **Auditoria visível**: mudanças administrativas relevantes geram entradas em `projectActivities` para o feed do cliente.
- **Uploads seguros**: arquivos no storage (S3 etc.) com chave por projeto; no banco, só metadados.
- **QA obrigatório**: checklist de verificação cobrindo permissões, exclusões em cascata, duplicidades, rota 404 com identidade visual PT-BR, build e sessão publicada.

## Quando usar

Pedidos envolvendo progresso de projetos, marcos, entregáveis, compartilhamento de documentos, feed de atividades, feedback de clientes, acesso por cliente, fluxos administrativos ou roteamento pós-login por papel. **Não** usar para sites institucionais públicos sem área autenticada de projetos.

## Estrutura do repositório

```
SKILL_Adm_Projetos/
├── SKILL.md    # Definição da skill (frontmatter + instruções completas)
├── README.md   # Este arquivo
└── app/        # Aplicação de referência: portal responsivo construído com a skill
```

## Aplicação de referência (`app/`)

O diretório [`app/`](app/README.md) contém um portal completo e responsivo construído a partir desta skill — Node.js puro (≥ 22.5, sem dependências externas), SQLite nativo, autenticação por sessão, área do cliente, administração e suíte de testes:

```bash
cd app
npm start   # http://localhost:3000
npm test    # suíte de QA da camada de procedures
```

## Como instalar

Copie a pasta para o diretório de skills do seu projeto ou usuário:

```
.claude/skills/project-status-portal/SKILL.md    # por projeto
~/.claude/skills/project-status-portal/SKILL.md  # global (usuário)
```

Ou adicione a skill ao Claude (Claude Code / claude.ai) apontando para este repositório.

## Repositórios relacionados

- [SKILL_Financeira](https://github.com/salimNabbout/SKILL_Financeira)
- [SKILL_IM](https://github.com/salimNabbout/SKILL_IM)

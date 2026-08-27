# Portal de Projetos — aplicação de referência

Aplicação web **responsiva** construída a partir da skill [`project-status-portal`](../SKILL.md): portal de status de projetos com área do cliente restrita e centro de controle administrativo, inteiramente em PT-BR.

## Destaques

- **Zero dependências externas**: Node.js ≥ 22.5 puro, com SQLite nativo (`node:sqlite`). Nenhum `npm install` é necessário.
- **Controle de acesso no servidor**: vínculo por `projectMembers(projectId, userId, accessRole)` verificado em toda consulta; toda manutenção passa por guard de administrador. A interface esconde controles, mas a autorização é sempre do servidor.
- **Três experiências**: página pública, área do cliente (`/portal`, `/projetos/:id`) e administração (`/admin`), com gateway `/acessar` que roteia por papel após o login (`admin` → `/admin`, demais → `/portal`).
- **Auditoria visível**: mudanças administrativas relevantes geram entradas no feed do cliente; publicações manuais são editáveis, registros automáticos são somente leitura.
- **Uploads seguros**: validação de nome, tipo e tamanho (máx. 5 MB) no navegador e no servidor; arquivos em `app/data/storage/projects/{id}/documents/`, banco guarda apenas metadados.
- **Tela 404 própria**, com a mesma identidade visual do portal.
- **Responsivo**: layout fluido com grid/flex; painéis empilham em telas estreitas.
- **Tema claro/escuro**: botão de alternância na barra superior (🌙/☀️). Sem escolha explícita o portal segue o tema do sistema; a escolha manual fica salva no navegador (`localStorage`) e escolher o mesmo tema do sistema volta ao modo automático. Toda a paleta vive em variáveis CSS em `styles.css`.

## Como executar

```bash
cd app
npm start
# Portal de Projetos disponível em http://localhost:3000
```

No primeiro início, uma conta administradora é criada e exibida no console
(padrão: `admin@portal.local` / `admin123`; personalize com
`PORTAL_ADMIN_EMAIL` e `PORTAL_ADMIN_PASSWORD`).

Variáveis de ambiente: `PORT`, `PORTAL_DB` (caminho do SQLite), `PORTAL_STORAGE` (diretório de arquivos).

## Primeiro uso (sequência recomendada)

1. Entre com a conta administradora e abra **Administração**.
2. Cadastre a organização cliente e crie o projeto (status, datas, resumo).
3. Vincule a organização ao projeto.
4. Peça ao contato do cliente para criar a conta dele em **/acessar**.
5. Na aba **Acesso**, conceda o acesso da conta ao projeto.
6. Adicione marcos, entregáveis, contatos, documentos e uma publicação inicial.
7. Confirme com **Ver como cliente** o que o cliente enxerga.

## Testes

```bash
cd app
npm test
```

A suíte cobre o checklist de verificação da skill: bloqueio de não autenticados, cliente sem vínculo, mutações administrativas negadas a não-admin, duplicidade de organização (409), guard de exclusão de organização, exclusão de projeto em cascata (transação), validação de datas e de progresso, upload/download com autorização, feed manual × auditoria e a rota 404.

## Estrutura

```
app/
├── server.js          # Servidor HTTP, roteamento da API e da SPA
├── src/
│   ├── db.js          # Esquema SQLite + helpers de linhas cruas
│   ├── auth.js        # scrypt + sessões por token em cookie HttpOnly
│   └── api.js         # Procedures (cliente e admin) com guards de acesso
├── public/
│   ├── index.html     # Shell da SPA
│   ├── styles.css     # Tema central (variáveis) + layout responsivo
│   └── app.js         # SPA: landing, gateway, portal, projeto, admin, 404
└── tests/
    └── api.test.js    # Suíte de QA da camada de procedures
```

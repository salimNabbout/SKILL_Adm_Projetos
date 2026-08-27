-- Esquema do Portal de Projetos (equivalente Postgres do esquema SQLite local).
-- Identificadores em camelCase entre aspas para casar com o JSON esperado pela SPA.

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  "passwordHash" TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'client',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  "userId" INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "expiresAt" TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'planning',
  progress INTEGER NOT NULL DEFAULT 0,
  "startDate" TEXT,
  "endDate" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "projectMembers" (
  id SERIAL PRIMARY KEY,
  "projectId" INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  "userId" INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "accessRole" TEXT NOT NULL DEFAULT 'client',
  "assignedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE ("projectId", "userId")
);

CREATE TABLE IF NOT EXISTS clients (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  "legalName" TEXT NOT NULL DEFAULT '',
  "contactName" TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "projectClients" (
  id SERIAL PRIMARY KEY,
  "projectId" INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  "clientId" INTEGER NOT NULL REFERENCES clients(id),
  relationship TEXT NOT NULL DEFAULT 'primary',
  UNIQUE ("projectId", "clientId")
);

CREATE TABLE IF NOT EXISTS milestones (
  id SERIAL PRIMARY KEY,
  "projectId" INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  "dueDate" TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  "completedAt" TEXT
);

CREATE TABLE IF NOT EXISTS deliverables (
  id SERIAL PRIMARY KEY,
  "projectId" INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  "ownerName" TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'not_started',
  progress INTEGER NOT NULL DEFAULT 0,
  "dueDate" TEXT,
  "needsAttention" BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS "projectContacts" (
  id SERIAL PRIMARY KEY,
  "projectId" INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  "isPrimary" BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS "projectDocuments" (
  id SERIAL PRIMARY KEY,
  "projectId" INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  "deliverableId" INTEGER REFERENCES deliverables(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  "fileKey" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "uploadedBy" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "projectActivities" (
  id SERIAL PRIMARY KEY,
  "projectId" INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  "actorName" TEXT NOT NULL DEFAULT '',
  "activityType" TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "projectFeedback" (
  id SERIAL PRIMARY KEY,
  "projectId" INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  "userId" INTEGER NOT NULL REFERENCES users(id),
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

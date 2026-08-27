---
name: project-status-portal
description: Build or evolve secure client-facing project status portals with a restricted customer workspace and an administrative control center. Use for requests involving project progress, milestones, deliverables, document sharing, activity feeds, client feedback, client-specific access, administrator workflows, or post-login routing to role-based project portals.
---

# Project Status Portal

Build a professional, transparent portal in which customers see only their assigned projects and administrators maintain projects, organizations, access, progress, documents, and updates.

## Apply This Skill When

Use this skill for a new portal or an existing web app that needs any of the following:

- A customer dashboard for project progress, dates, milestones, deliverables, documents, activity, or feedback.
- A protected administration area for creating and maintaining project data.
- Explicit project access assignments for client accounts.
- Customer organizations that can be related to one or more projects.
- Role-aware routing after sign-in, especially when administrators must be taken to editing tools instead of a read-only customer screen.
- QA hardening for mutations, delete operations, 404 routes, and published-session validation.

Do not use this skill for a generic public marketing site with no authenticated project workspace.

## Non-Negotiable Access Model

Treat access control as a server-side feature, not a client-side filter.

1. Authenticate every portal user through the project authentication mechanism.
2. Keep customer project access in an explicit join table such as `projectMembers(projectId, userId, accessRole)`.
3. Query customer projects by the authenticated `userId`; never trust a project ID received from the client without checking membership.
4. Protect all customer project detail, feedback, document, and activity procedures with the same membership check.
5. Gate maintenance actions with an administrator-only procedure. Do not rely on hiding buttons for authorization.
6. Keep an organization directory separate from login accounts. Link organizations to projects through `projectClients`; link individual accounts to projects through `projectMembers`.

> A client organization assignment is a business relationship. An account assignment is the authorization that grants a particular person access to a project.

Use roles such as `admin`, `client`, `viewer`, and `manager` only when their behaviors are defined. At minimum, `admin` can maintain all records and `client` can view assigned projects and submit feedback.

## Minimal Domain Model

Create only the fields necessary for the requested workflow. Start with these entities.

| Entity | Required purpose | Typical fields |
|---|---|---|
| `projects` | Project summary and health | code, name, description, status, progress, startDate, endDate |
| `projectMembers` | Person-level access control | projectId, userId, accessRole, assignedAt |
| `clients` | Customer organization directory | name, legalName, contactName, email, phone, status |
| `projectClients` | Organization-to-project relationship | projectId, clientId, relationship |
| `milestones` | Timeline events | projectId, title, status, dueDate, position, completedAt |
| `deliverables` | Work products and progress | projectId, title, ownerName, status, progress, dueDate, needsAttention |
| `projectContacts` | Visible project owners | projectId, name, role, email, isPrimary |
| `projectDocuments` | File metadata only | projectId, deliverableId, name, fileKey, url, mimeType, sizeBytes, uploadedBy |
| `projectActivities` | Chronological project feed | projectId, actorName, activityType, title, description, createdAt |
| `projectFeedback` | Customer input | projectId, userId, subject, message, createdAt |

Store documents in S3 or the configured file storage service. Persist only metadata and the file key or URL in the database; never store file bytes in a database column.

## Delivery Workflow

### 1. Establish the portal split

Create three experiences.

| Experience | Audience | Required behavior |
|---|---|---|
| Public landing page | Unauthenticated visitors | Explain value and start secure access. Do not imply that the page itself is editable. |
| Customer workspace | Authenticated non-admin accounts | List only assigned projects; expose read-only information plus contextual feedback. |
| Administrative workspace | Admin accounts | Create and maintain project data, organizations, account assignments, documents, and activity. |

Use a dashboard layout for the authenticated workspace. Show the administration navigation item only for administrator accounts, while retaining server-side authorization as the enforcement layer.

### 2. Build the schema before UI

Draft the domain model, update the schema, generate a migration, review the generated SQL, then apply it. Preserve referential integrity and use cascade deletion only where it is clearly safe.

Implement database helpers that return raw rows. Build typed server procedures around those helpers instead of letting UI code construct direct database queries.

### 3. Implement the customer procedures

Implement at least these protected operations:

- `projects.listMine`: return projects through `projectMembers` for `ctx.user.id`.
- `projects.dashboard`: verify membership before returning the project and its related records. Permit an authenticated administrator to inspect any real project through an explicit server-side admin branch; do not add a fake project membership.
- `projects.submitFeedback`: verify membership, write feedback, and add a visible activity entry.

For any customer-facing document operation, require an appropriate project role. Administrators may bypass project membership only through an explicit administrator procedure.

### 4. Implement administration procedures

Use one `adminProcedure` or equivalent server guard for all maintenance operations. Include procedures for:

- Listing and creating projects.
- Updating project name, dates, status, and progress.
- Listing, creating, and updating customer organizations.
- Reject a create or update when another organization has the same normalized name or the same normalized email. Return a human-readable conflict message from the API.
- Associating or removing organizations from a project.
- Listing eligible user accounts that have previously authenticated.
- Assigning or removing a customer account from a project with an explicit role.
- Creating and updating milestones and deliverables.
- Creating and removing responsible contacts, activities, and documents.
- Editing and deleting manual customer-feed publications. Preserve automated audit activities separately or mark them read-only.
- Deleting deliverables and milestones.
- Deleting a project in a deliberate transaction or dependency-safe order, including deliverables, milestones, contacts, documents, activities, feedback, and membership/organization assignments.
- Deleting an organization only when the defined active project-link rule allows it; otherwise return an explanatory conflict error.
- Uploading a file after validating file name, MIME type, decoded byte size, and maximum size.

When an administrative change is relevant to customers, write a `projectActivities` entry so the customer feed explains what changed. At minimum, audit project creation/edition and status changes, organization assignment, and manual feed publication. Use stable activity types so manual publications can be edited or deleted without exposing automated audit entries as editable content.

### 5. Build the administration interface

Use a project selector in a persistent portfolio panel and render a focused workspace for the selected project. Prioritize these controls:

1. A clearly visible **New project** action.
2. A project status editor with percentage progress, dates, and health state.
3. An organization directory that supports create and edit.
4. Project-to-organization association with primary or stakeholder relationship.
5. An account access panel that lists authenticated customer accounts, assigns an access role, and removes access.
6. Quick creation and update controls for milestones, deliverables, contacts, documents, and activities.
7. Empty, loading, and error states for both projects and clients.
8. A **Ver como cliente** action in the selected-project header that opens `/projetos/:id`. Keep it available only in the administrative workspace.

Keep the customer interface deliberately simpler. It should show progress, dates, milestones, deliverables, documents, activity, contacts, and feedback—not project-editing controls.

### Validation and data-entry rules

- Define project health values deliberately. A useful baseline is `planning`, `on_track`, `attention`, `delayed`, `paused`, and `completed`; render every accepted status consistently in both workspaces.
- Reject an end date earlier than the start date in the API and give immediate form feedback in the UI. Set the end-date input minimum to the selected start date as a further guardrail.
- Apply Brazilian phone formatting to organization contact fields and define explicit `maxLength` values for every organization text input.
- Show only active organizations in a new-assignment dropdown. Retain inactive organizations in existing assignments and directory cards with an **Inativo** badge.
- Calculate administrative attention points from both delivery health and missing operational links. Flag projects with no organization or no assigned account in the portfolio.

### Mutation feedback and destructive actions

Configure one client-wide mutation-error listener through the query/mutation cache or an equivalent central integration. On every mutation failure, show one error toast using the API message. Do not duplicate it with local `onError` toasts in forms; reserve local handlers for state reset or cleanup.

Require an accessible confirmation dialog before every destructive UI action. Explain the scope of cascade deletion for projects. Re-fetch the affected workspace and portfolio after a successful deletion, and clear the selected project when it no longer exists.

## Authentication and Routing

Do not force users to infer where editing lives. Route them after authentication based on their role.

Create a dedicated access gateway route such as `/acessar`.

1. The public CTA always navigates to the gateway.
2. The gateway waits for the authentication query to resolve.
3. If no session exists, begin the login flow in an effect or event handler, never during rendering.
4. Send `admin` users to `/admin` and all other authenticated users to `/portal`.
5. Show a compact loading state while the session resolves and a retry state if it fails.

This avoids a common failure mode: a logged-in administrator sees the public landing page, assumes editing is unavailable, and never discovers the protected administration route.

## Document Upload Rules

Accept file uploads only from an authorized administrator or a defined project manager role. Enforce a maximum size in both the browser and server. Convert or stream bytes safely, store the file using a project-scoped key such as `projects/{projectId}/documents/{safeName}`, then persist the returned storage metadata.

Allow removal of the metadata record only when appropriate for the business workflow. If physical file deletion is required, implement it deliberately with the storage provider; do not assume database deletion removes file bytes.

## UI and Content Standards

Use a calm, professional hierarchy: clear project health, explicit dates, concise labels, and visible attention signals. Keep brand colors in central theme variables so the palette can be replaced without rewriting component styles.

Make the 404 route part of the product, not a generic template. Use PT-BR copy, the same font family, palette, card radius, shadows, navigation cues, and responsive behavior as the landing and dashboard screens. Avoid generic blue layouts or alarming red error iconography when the portal's own neutral visual language is available.

Do not fabricate customer reviews, ratings, testimonials, or project records. Use clearly labeled empty states until real data is created. Avoid local media in the deployed project; upload static assets through the project storage workflow.

## Verification Checklist

Before delivery, verify all of the following:

- Test unauthenticated, customer, and admin behavior at the procedure layer.
- Assert that a customer cannot open a project without a `projectMembers` relationship.
- Assert that non-admin users cannot invoke administrative mutations.
- Assert that an administrator can create a client organization and upload a valid document payload.
- Assert that duplicate organization name and email attempts fail with the intended API message and produce exactly one error toast in the UI integration.
- Assert non-admin callers cannot invoke any delete procedure.
- Exercise a project deletion with a temporary QA record, then assert its dependent records are gone and clean the temporary data before delivery.
- Exercise the organization delete guard for both blocked and allowed cases.
- Confirm an admin opens `/projetos/:id` for a real project and that a non-member customer remains blocked.
- Verify the administrative **Ver como cliente** action targets the currently selected project.
- Visit an invalid published route and confirm the branded PT-BR 404 screen.
- Run the test suite, type check, and production build.
- Capture the public page, the customer workspace, and the administrator workspace at desktop and mobile breakpoints.
- Visit the published `/acessar` route with the owner session and confirm that it lands at `/admin`.
- Verify the published direct `/admin` route with the owner account.
- When production queries briefly show no data after a new deployment, reload through `/acessar` and wait for the authenticated session to refresh before diagnosing a data issue. Confirm the database separately before modifying records.
- Read the complete project TODO file and mark all finished items before checkpointing.

## First-Use Operating Sequence

For a newly deployed portal, operate in this order:

1. Sign in with the owner account and open **Administração**.
2. Create the customer organization.
3. Create the project and enter the initial status, dates, and summary.
4. Associate the organization with the project.
5. Ask the customer contact to sign in once so an account exists in the portal.
6. Assign that account to the project with the correct role.
7. Add milestones, deliverables, documents, contacts, and an initial activity update.
8. Confirm that the customer sees only the assigned project.

Use this skill as a repeatable baseline, then add domain-specific fields or notifications only after the core access boundary and administration workflow are working.

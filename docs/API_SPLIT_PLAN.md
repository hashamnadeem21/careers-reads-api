# API split plan

This plan splits Career Reads into **three repos**:

| Repo | Local folder | What it is | Talks to |
| --- | --- | --- | --- |
| **API** (new) | `../blognest-api` | NestJS backend. The **only** thing that touches PostgreSQL, file storage, and passwords. | Postgres, Vercel Blob, the website's `/api/revalidate` |
| **Admin** | `../blognest-admin` | Next.js 16 dashboard. Screens only. | API (bearer tokens) |
| **Website** | `blognest` (this repo) | Next.js 16 public site. Pages only. | API (public endpoints + a server key) |

Today the admin and the website both connect straight to Postgres and keep their own copy of `schema.ts`. After this plan, neither of them has a database driver, a schema file, or a `DATABASE_URL`.

The plan is split into **8 phases**. Each phase is one work session: follow the brief, do it **in the repo it names**, check the result, commit, then start the next phase. Don't skip phases. Until Phase 7 is done, the admin keeps using the database directly, so nothing breaks in the meantime.

> **Status (7 Oct 2026):** Phase 1 is built (`../blognest-api`). See "Implementation notes" at the end.

> **Next.js 16 reminder:** prompts for the admin and website say to read `node_modules/next/dist/docs/` first (`proxy.ts` instead of `middleware.ts`, and `params`, `searchParams`, `headers()` and `cookies()` are all awaited).

---

## Decisions already made

- **Framework:** NestJS 12 (ESM, `nodenext`: relative imports end in `.js`), TypeScript strict, Node 20.9+. Tests use Vitest + supertest, linting uses oxlint (the Nest 12 defaults).
- **Database:** stays as it is. Same Postgres, same 17 tables, same Drizzle schema. Only the **owner** changes: the schema and migrations move from the admin to the API.
- **Admin auth:** JWT bearer tokens (see "Auth design").
- **Validation:** Zod everywhere, through the API's own `ZodPipe` + `@ApiZodBody()` / `@ApiZodQuery()` (`src/common/zod.ts`; `nestjs-zod` doesn't support Nest 12). Zod 4's `z.toJSONSchema()` feeds the OpenAPI spec. The admin's existing Zod rules in `src/shared/` move to the API, which becomes the source of truth.
- **Contract:** the API publishes an OpenAPI spec at `/docs-json`. The admin and website generate a typed client from it (`openapi-typescript` + `openapi-fetch`). This replaces copying `schema.ts` and running `sync:shared`.

---

## Auth design (JWT)

- `POST /auth/login` → `{ accessToken, refreshToken, user }`.
  - **Access token:** JWT, 15 minutes, signed with `JWT_SECRET`, `sub` = user id.
  - **Refresh token:** random 32 bytes, 30 days. Only its SHA-256 hash is stored, in the existing `sessions` table, so no new table is needed.
- `POST /auth/refresh` **rotates** the refresh token: it deletes the old row and issues a new pair. If a refresh token is reused after rotation, every session for that user is revoked.
- `POST /auth/logout` deletes the refresh row. A password change or user removal deletes all of that user's rows (same as `destroyAllSessions` today).
- **Guard:** `JwtAuthGuard` verifies the token, then **loads the user from the database on every request**. Role changes, removals and paused companies take effect immediately, just as they do now, so a token never carries stale roles.
- `RolesGuard` + `@Roles()` and a company-scope check replace `requireUser(role)` and `lib/jobs/access.ts`.
- **Admin side:** the browser never sees the tokens. The admin's Next.js server keeps them in httpOnly cookies on the admin domain, sends `Authorization: Bearer …` from Server Actions and server components, and refreshes automatically when it gets a 401. No CORS is needed.
- **Login rate limit and argon2 hashing** move to the API unchanged. Existing password hashes keep working.
- **Website → API:** public reads need no auth. Writes (contact, newsletter, stats) and draft previews send `X-Site-Key: SITE_API_KEY`, and pass the visitor's IP in `X-Forwarded-For` so rate limits still work per visitor.

## API layout

```
src/
  main.ts, app.module.ts
  config/            Zod-validated env (DATABASE_URL, JWT_SECRET, SITE_API_KEY, REVALIDATE_SECRET,
                     PUBLIC_SITE_URL, ADMIN_URL, BLOB_READ_WRITE_TOKEN, UPLOADS_DIR)
  db/                schema.ts, migrations/, DrizzleModule (moved from the admin)
  shared/            Zod rules + visibility rules (isPubliclyVisible, isJobVisible)
  common/            guards, @Roles, @CurrentUser, rate limit, audit, revalidate-site, error filter
  auth/  users/  invites/  companies/
  posts/  jobs/  categories/  authors/  media/
  messages/  subscribers/  settings/  stats/  dashboard/  search/  preferences/
  public/            read-only endpoints for the website (/public/...)
scripts/             admin-create, import-content (moved from the admin)
```

Every admin write goes through one service method that (1) checks role and scope, (2) validates input, (3) writes, (4) records an `audit_log` row, and (5) calls `revalidateSite({ tags, paths })`. The admin's actions follow these same steps today; the API keeps them.

## Endpoint map (from the admin's current Server Actions)

| Area | Endpoints |
| --- | --- |
| Auth | `POST /auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/change-password`, `GET /auth/me` |
| Posts | `GET/POST /posts`, `GET/PATCH/DELETE /posts/:id`, `POST /posts/:id/duplicate`, `POST /posts/bulk` |
| Jobs | `GET/POST /jobs`, `GET/PATCH/DELETE /jobs/:id`, `POST /jobs/:id/{duplicate,close,status,approve,reject}`, `POST /jobs/bulk` |
| Media | `POST /media` (multipart), `GET /media?q=`, `PATCH /media/:id`, `GET /media/:id/usage`, `DELETE /media/:id` |
| Categories | `GET/POST /categories`, `PATCH/DELETE /categories/:id`, `POST /categories/reorder` |
| Authors | `GET/POST /authors`, `PATCH/DELETE /authors/:id` |
| Companies | `GET/POST /companies`, `PATCH/DELETE /companies/:id`, `POST /companies/:id/active`, `POST /companies/:id/invites` |
| Users | `GET /users`, `PATCH /users/:id/role`, `DELETE /users/:id`, `POST /invites`, `DELETE /invites/:id`, `GET /invites/:token`, `POST /invites/:token/accept` |
| Messages | `GET /messages`, `PATCH /messages/:id`, `DELETE /messages/:id`, `GET /subscribers`, `DELETE /subscribers`, `GET /subscribers/export.csv` |
| Settings | `GET/PUT /settings` |
| Dashboard | `GET /dashboard`, `GET /dashboard/stats?range=`, `GET /activity`, `PUT /me/dashboard-layout`, `PUT /me/theme` |
| Search | `GET /search?q=` |
| Public (website) | `GET /public/articles`, `/public/articles/:slug`, `/public/jobs`, `/public/jobs/:slug`, `/public/categories`, `/public/authors`, `/public/settings`; `POST /public/contact`, `/public/subscribe`, `/public/stats` |

`renderPostPreview` **stays in the admin**. It only renders MDX and never touches the database.

## Media

- Production: Vercel Blob, same as today, but uploaded by the API.
- Development: files go to `UPLOADS_DIR` (default `../blognest/public/uploads`), so existing `/uploads/...` URLs in the database keep working on the website and nothing needs to be migrated.
- Same rules: `jpg/png/webp/avif`, max 5 MB, random names.

## Hosting

The API is a long-running Node server, so host it on **Railway, Render or Fly** (or a VPS) rather than Vercel. Use `api.careersreads.com`. The admin and website stay on Vercel.

---

## The phases

### Phase 1 (new repo `blognest-api`): scaffold, database, contract

> Create `../blognest-api` (git init, remote `career-reads-api`). Copy `../blognest/docs/API_SPLIT_PLAN.md` to `docs/`.
> Scaffold the latest NestJS with TypeScript strict, ESLint, and a Zod-validated config module (see "API layout").
> Move ownership of the database: copy `../blognest-admin/src/db/schema.ts`, `src/db/migrations/` (including `meta/_journal.json`, so the live DB is **not** re-migrated) and `drizzle.config.ts`. Add a `DrizzleModule` (Neon serverless in production, `pg` locally, same as the admin's `src/db/index.ts`). Add `db:generate`, `db:migrate`, `db:local` (reuse the admin's private Postgres on port 54329).
> Copy the admin's `src/shared/` to `src/shared/`.
> Add a Zod validation pipe, a global error filter returning `{ error: { code, message, fields? } }`, `@nestjs/swagger` at `/docs` and `/docs-json`, `GET /health` (checks the DB), helmet, and request logging.
> Add Vitest + supertest against the `blognest_test` database, and `npm run check` (lint, typecheck, tests, build).

**Check:** `npm run start:dev` → `GET /health` returns ok, `/docs` loads, and `npm run db:migrate` reports nothing to apply against your local DB.

### Phase 2 (`blognest-api`): auth, users, invites, companies

> Implement "Auth design" exactly. Port the logic from `../blognest-admin/src/lib/auth/*`, `src/app/actions/{auth,users,companies}.ts`, `src/lib/users`, `src/lib/companies` and `src/lib/rate-limit.ts`, `src/lib/audit.ts`.
> `@nestjs/jwt`, `@node-rs/argon2`. Guards: `JwtAuthGuard` (global, `@Public()` to opt out), `RolesGuard`, `SiteKeyGuard`.
> Move `scripts/admin-create` here (`npm run admin:create -- email "Name" [--reset]`).
> e2e tests: login, wrong password, rate limit, refresh rotation, refresh reuse revokes everything, role change takes effect on the next request, paused company is locked out, invite accept, password change kills other sessions.

**Check:** `/docs` → log in → "Authorize" with the token → `GET /auth/me` works; after the token expires, `/auth/refresh` gives a new pair.

### Phase 3 (`blognest-api`): public endpoints for the website

> Port the read logic from `../blognest/src/lib/content/postgres-repository.ts`, `src/lib/jobs/index.ts`, `src/lib/categories-loader.ts`, `src/lib/site-data.ts`, and the writes from `src/lib/forms/store.ts` and `src/app/api/stats/route.ts`.
> Build the `/public/*` endpoints from the endpoint map. Visibility (`isPubliclyVisible`, `isJobVisible`) is enforced **in the API**. Drafts only with `X-Site-Key` + `?preview=1`. Writes require `X-Site-Key` and rate-limit by the forwarded IP. Bot filtering stays in the stats endpoint.
> Add `common/revalidate-site.ts` (port of the admin's `src/lib/revalidate-site.ts`).
> e2e tests for each endpoint, including that drafts, scheduled posts and expired jobs are never returned without the key.

**Check:** `curl localhost:4000/public/articles` returns the same posts the website shows today.

### Phase 4 (website `blognest`): read from the API

> Read `AGENTS.md` and the Next.js 16 docs first.
> Generate a typed client from the API (`npm run api:types` → `src/lib/api/schema.d.ts`) and add `src/lib/api/client.ts` (server-only, adds `X-Site-Key`).
> Replace `PostgresContentRepository` with `ApiContentRepository`, and do the same for jobs, categories, authors and settings. Keep the **file fallback** when `API_URL` is unset. Keep `"use cache"` + `cacheTag()` and `/api/revalidate` exactly as they are.
> Contact, newsletter and `/api/stats` forward to the API with the visitor's IP.
> Delete `src/db/`, `src/lib/db.ts`, and the `pg`, `@neondatabase/serverless`, `ws`, `drizzle-orm` deps. Replace `DATABASE_URL` with `API_URL` + `SITE_API_KEY` in env and `.env.example`. Update `docs/DATABASE.md` and the README.
> Lint, typecheck, unit tests, build and e2e must pass.

**Check:** the website looks exactly the same, and a contact message still shows up in the admin's Messages.

### Phase 5 (`blognest-api`): posts, jobs, media

> Port `../blognest-admin/src/app/actions/{posts,jobs,media}.ts` and `src/lib/{posts,jobs,media}` into services and controllers. Keep every rule: company scoping and approval flow for jobs, slug handling, scheduling, image slots, media usage checks, bulk actions, audit + revalidate after each write.
> Media upload is multipart (`@nestjs/platform-express` + file validation). Storage is described in "Media".
> e2e tests mirroring the admin's existing tests for these areas.

**Check:** with Swagger, create a draft post, upload an image, publish → it appears on the website.

### Phase 6 (`blognest-api`): everything else

> Port categories, authors, messages + subscribers (with the CSV export), settings, dashboard (`src/lib/dashboard/*`), activity, search, and preferences (theme + dashboard layout).
> Move `scripts/import-content` here.
> After this phase, every row in the endpoint map exists. Add a test that fails if any admin Server Action listed in the map has no matching route.

**Check:** `/docs` lists every endpoint in the map, and `npm run check` passes.

### Phase 7 (admin `blognest-admin`): switch to the API

> Read `AGENTS.md` and the Next.js 16 docs first.
> Generate the typed client (`npm run api:types`). Add `src/lib/api/client.ts` (server-only). It reads tokens from httpOnly cookies, sends the bearer header, refreshes once on 401, and redirects to `/login` if the refresh fails.
> Rewrite `actions/auth.ts` around `/auth/*`. `getCurrentUser` becomes `GET /auth/me` (still wrapped in `cache()`). `proxy.ts` still only redirects when there are no cookies.
> Rewrite every Server Action and every page/query that imports `@/db` so it calls the API instead. Map API `fields` errors into the existing form state so the UI doesn't change. Keep `renderPostPreview` local.
> Delete `src/db/`, `drizzle.config.ts`, `src/shared/`, `src/lib/rate-limit.ts`, `src/lib/audit.ts`, `src/lib/revalidate-site.ts`, `scripts/import-*`, `sync:shared`, and the `drizzle-orm`, `pg`, `@neondatabase/serverless`, `ws`, `@node-rs/argon2`, `@vercel/blob` deps. Env becomes `API_URL` + `PUBLIC_SITE_URL`.
> Playwright e2e now starts **all three** apps against the test DB. All existing e2e tests must pass unchanged.

**Check:** `grep -r "drizzle\|@/db" src` returns nothing, and every screen works as before. Everyone has to log in once more after this change.

### Phase 8 (all three repos): go live and tidy up

> Update each README with how the three repos fit together, local setup (start order: Postgres → API :4000 → website :3000 → admin :3001), and env tables.
> In the API: CORS off (server-to-server only), `trust proxy` set for the host, Dockerfile, health check, and a GitHub Action running `npm run check`.
> In the admin and website: a CI step that fails if `api:types` is out of date with the deployed API.
> Write the go-live checklist below into the API README.

**Check:** a fresh clone of all three repos runs locally by following the READMEs alone.

---

## Going live checklist

- [ ] Deploy the API to Railway/Render/Fly at `api.careersreads.com` with `DATABASE_URL`, `JWT_SECRET`, `SITE_API_KEY`, `REVALIDATE_SECRET`, `PUBLIC_SITE_URL`, `BLOB_READ_WRITE_TOKEN`.
- [ ] Run `npm run db:migrate` from the API (the only repo that migrates from now on).
- [ ] Website (Vercel): remove `DATABASE_URL`, add `API_URL` + `SITE_API_KEY`. Redeploy **before** the admin.
- [ ] Admin (Vercel): remove `DATABASE_URL` and `BLOB_READ_WRITE_TOKEN`, add `API_URL`. Redeploy.
- [ ] Log in to the admin, publish a test post, and confirm it appears on the site within seconds.
- [ ] Rotate the old `DATABASE_URL` password so only the API can connect.

---

## Implementation notes (how it was actually built)

### Phase 1
- NestJS 12 scaffolds ESM + Vitest + oxlint, so the API uses those (the plan originally said Jest). Install with `npx npm@latest install`: the npm bundled with Node 22.23 crashes (`Cannot read properties of null (reading 'edgesOut')`) on Nest 12's dependency tree.
- `src/db/client.ts` is the admin's `src/db/index.ts` as a factory; `DbModule` (global) provides it and closes the pool on shutdown. Inject with `@InjectDb() db: Database`.
- `src/app.setup.ts` holds everything `main.ts` applies (helmet, `trust proxy`, 1 MB JSON limit, error filter, optional CORS, Swagger at `/docs` + `/docs-json`). The e2e tests use it too, so they test the real setup.
- Errors are always `{ error: { code, message, fields? } }` (`ApiError`, `ErrorFilter`). Unknown errors are logged and returned as `internal_error` with no details.
- `scripts/db-local.sh` reuses `../blognest-admin/.data/pg` when the API has no `.data/pg` of its own, so all three apps share one local database. Set `PG_DATA_DIR` to override.
- The migrations and `meta/_journal.json` were copied unchanged: `npm run db:migrate` against the existing local DB applies nothing.
- Port 4000 by default (`PORT`).

# API split plan

This plan splits Career Reads into **three repos**:

| Repo | Local folder | What it is | Talks to |
| --- | --- | --- | --- |
| **API** (new) | `../blognest-api` | NestJS backend. The **only** thing that touches PostgreSQL, file storage, and passwords. | Postgres, Vercel Blob, the website's `/api/revalidate` |
| **Admin** | `../blognest-admin` | Next.js 16 dashboard. Screens only. | API (bearer tokens) |
| **Website** | `blognest` (this repo) | Next.js 16 public site. Pages only. | API (public endpoints + a server key) |

Today the admin and the website both connect straight to Postgres and keep their own copy of `schema.ts`. After this plan, neither of them has a database driver, a schema file, or a `DATABASE_URL`.

The plan is split into **8 phases**. Each phase is one work session: follow the brief, do it **in the repo it names**, check the result, commit, then start the next phase. Don't skip phases. Until Phase 7 is done, the admin keeps using the database directly, so nothing breaks in the meantime.

> **Status (7 Oct 2026):** Phases 1–7 are built, plus the API part of Phase 8 (Dockerfile, CI, README). The rest of Phase 8 (admin and website CI, READMEs, go-live) is next. Production API: `https://api.careersreads.com`. See "Implementation notes" at the end.

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
- **Server keys:** the admin and website servers send `X-Api-Key` (`ADMIN_API_KEY` / `SITE_API_KEY`) plus the visitor's address in `X-Client-IP`. The API only believes `X-Client-IP` when the key is valid, so per-visitor rate limits (login, contact, stats) still work and can't be spoofed.
- **Website → API:** public reads need no auth. Writes (contact, newsletter, stats) and draft previews require `SITE_API_KEY`.

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
| Editor lookups | `GET /posts/options`, `GET /jobs/options`, `GET /jobs/review-count`, `GET /companies/options`, `GET /companies/:id/dashboard` |
| Media | `POST /media` (multipart), `GET /media?q=`, `PATCH /media/:id`, `GET /media/:id/usage`, `DELETE /media/:id` |
| Categories | `GET/POST /categories`, `PATCH/DELETE /categories/:id`, `POST /categories/reorder` |
| Authors | `GET/POST /authors`, `PATCH/DELETE /authors/:id` |
| Companies | `GET/POST /companies`, `PATCH/DELETE /companies/:id`, `POST /companies/:id/active`, `POST /companies/:id/invites` |
| Users | `GET /users`, `PATCH /users/:id/role`, `DELETE /users/:id`, `POST /invites`, `DELETE /invites?email=`, `GET /invites/:token`, `POST /invites/:token/accept` |
| Messages | `GET /messages`, `PATCH /messages/:id`, `DELETE /messages/:id`, `GET /subscribers`, `DELETE /subscribers`, `GET /subscribers/export.csv` |
| Settings | `GET/PUT /settings` |
| Dashboard | `GET /dashboard`, `GET /dashboard/badges`, `GET /activity`, `PUT /me/dashboard-layout`, `PUT /me/theme` |
| Search | `GET /search?q=` |
| Public (website) | `GET /public/articles`, `/public/articles/:slug`, `/public/jobs`, `/public/jobs/:slug`, `/public/categories`, `/public/authors`, `/public/settings`; `POST /public/contact`, `/public/subscribe`, `/public/stats` |

`renderPostPreview` **stays in the admin**. It only renders MDX and never touches the database.

## Media

- Production: Vercel Blob, same as today, but uploaded by the API.
- Development: files go to `UPLOADS_DIR` (default `../blognest/public/uploads`), so existing `/uploads/...` URLs in the database keep working on the website and nothing needs to be migrated.
- Same rules: `jpg/png/webp/avif`, max 5 MB, random names.

## Hosting

The API is a long-running Node server, so host it on **Railway, Render or Fly** (or a VPS) rather than Vercel. Use `https://api.careersreads.com`. The admin and website stay on Vercel.

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
> `@nestjs/jwt`, `@node-rs/argon2`. Guards: `JwtAuthGuard` (global, `@Public()` to opt out), `RolesGuard`, a site-key check for Phase 3.
> Move `scripts/admin-create` here (`npm run admin:create -- email "Name" [--reset]`).
> e2e tests: login, wrong password, rate limit, refresh rotation, refresh reuse revokes everything, role change takes effect on the next request, paused company is locked out, invite accept, password change kills other sessions.

**Check:** `/docs` → log in → "Authorize" with the token → `GET /auth/me` works; after the token expires, `/auth/refresh` gives a new pair.

### Phase 3 (`blognest-api`): public endpoints for the website

> Port the read logic from `../blognest/src/lib/content/postgres-repository.ts`, `src/lib/jobs/index.ts`, `src/lib/categories-loader.ts`, `src/lib/site-data.ts`, and the writes from `src/lib/forms/store.ts` and `src/app/api/stats/route.ts`.
> Build the `/public/*` endpoints from the endpoint map. Visibility (`isPubliclyVisible`, `isJobVisible`) is enforced **in the API**. Drafts only with the site's `X-Api-Key` + `?preview=1`. Writes require the site's `X-Api-Key` and rate-limit by the forwarded IP. Bot filtering stays in the stats endpoint.
> Add `common/revalidate-site.ts` (port of the admin's `src/lib/revalidate-site.ts`).
> e2e tests for each endpoint, including that drafts, scheduled posts and expired jobs are never returned without the key.

**Check:** `curl localhost:4000/public/articles` returns the same posts the website shows today.

### Phase 4 (website `blognest`): read from the API

> Read `AGENTS.md` and the Next.js 16 docs first.
> Generate a typed client from the API (`npm run api:types` → `src/lib/api/schema.d.ts`) and add `src/lib/api/client.ts` (server-only, adds `X-Api-Key` and `X-Client-IP`).
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
> Delete `src/db/`, `drizzle.config.ts`, `src/shared/`, `src/lib/rate-limit.ts`, `src/lib/audit.ts`, `src/lib/revalidate-site.ts`, `scripts/import-*`, `sync:shared`, and the `drizzle-orm`, `pg`, `@neondatabase/serverless`, `ws`, `@node-rs/argon2`, `@vercel/blob` deps. Env becomes `API_URL` + `ADMIN_API_KEY` + `PUBLIC_SITE_URL`. Send `X-Api-Key` and `X-Client-IP` on every call (login rate limits need the visitor's IP).
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

- [ ] Deploy the API to Railway/Render/Fly at `api.careersreads.com` with `DATABASE_URL`, `JWT_SECRET`, `ADMIN_API_KEY`, `SITE_API_KEY`, `ADMIN_URL`, `REVALIDATE_SECRET`, `PUBLIC_SITE_URL`, `BLOB_READ_WRITE_TOKEN`.
- [ ] Run `npm run db:migrate` from the API (the only repo that migrates from now on).
- [ ] Website (Vercel): remove `DATABASE_URL`, add `API_URL` + `SITE_API_KEY`. Redeploy **before** the admin.
- [ ] Admin (Vercel): remove `DATABASE_URL` and `BLOB_READ_WRITE_TOKEN`, add `API_URL` + `ADMIN_API_KEY`. Redeploy.
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

### Phase 2
- **Refresh tokens are signed JWTs** (`aud: career-reads:refresh`, random `jti`). The `sessions` row id is `sha256(jti)`, so no schema change was needed. Access tokens (`aud: career-reads:access`) carry `sid` = that row id, and `AuthGuard` joins `sessions → users → companies → user_prefs` on every request. Revoking a session, removing a user, pausing a company or changing a role all take effect on the next request.
- **Rotation grace:** a rotated refresh token keeps working for 30 s (`REFRESH_GRACE_SECONDS`), so the admin's parallel server requests don't trip reuse detection. A validly signed refresh token whose session is gone counts as reuse, and all of that user's sessions are revoked.
- **One global `AuthGuard`** (APP_GUARD). Routes are private unless marked `@Public()`. Use `@Roles()`, `@StaffOnly()` or `@SuperAdminOnly()`, and `@CurrentUser()` for the user. Users with a temporary password get `403 password_change_required` everywhere except `/auth/me`, `/auth/change-password` and `/auth/logout` (`@AllowPasswordChangePending()`).
- **Responses:** login, refresh, change-password and invite-accept all return `{ accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt, user }`. `user` includes `theme`, so the admin can set its theme cookie. Actions that the admin used to answer with `{ ok, message }` now return `{ message }` on success and the standard error otherwise (`last_super_admin`, `remove_self`, `already_member`, `name_taken`, `company_paused`, `invite_invalid`, …).
- **Invite links** are built from `ADMIN_URL` (the admin used the request's Host header).
- `GET /companies/:id/dashboard` replaces `CompanyDashboard`'s three queries. Super admins can open any company's dashboard; a company account can open only its own.
- `npm run admin:create` moved to the API. The admin's copy still works until Phase 7 deletes it.
- **Login rate limits** are keyed on `X-Client-IP`, so the admin **must** send `ADMIN_API_KEY` and the visitor's IP. Otherwise every admin user shares one IP bucket (the admin server's).

### Phase 3
- `PublicModule` (`src/public/`). Rows are mapped with the same Zod schemas as the website's files (`mappers.ts`); a bad row is skipped and logged, never fatal.
- `GET /public/articles` returns full articles (the website's search needs the body); `?view=summary` drops the body and table of contents. `GET /public/authors/:slug` was added next to the list.
- `?preview=1` without the site key is a **403**, not silently ignored. Jobs have no preview: draft, future and expired jobs are never returned.
- `@SiteOnly()` (`common/site-key.guard.ts`) marks the writes: `POST /public/contact`, `/public/subscribe`, `/public/stats`, all `204`. Limits per visitor (`X-Client-IP`): contact 3 and subscribe 5 per 10 minutes, stats 120 per minute. The website keeps its honeypot, fill-time check and email/webhook delivery.
- Stats read the visitor's user agent from `X-Client-User-Agent` for the bot filter, and only count pages that are live.
- `RevalidateSiteService` (Phase 2) is the port of the admin's `revalidate-site.ts`.

### Phase 4
- The website calls the API through `src/lib/api/client.ts` (server-only). Paths are typed from `npm run api:types`; the spec has no response schemas yet, so response types come from the website's own Zod types. `openapi-fetch` wasn't needed.
- Reads keep `unstable_cache` with the same tags (the site doesn't use Cache Components), so `/api/revalidate` works unchanged.
- `CACHE_TAGS` moved to `src/lib/cache-tags.ts`; `hasDatabase()` became `hasApi()`.

### Phase 5
- `PostsModule`, `JobsModule`, `MediaModule`. Posts and jobs are keyed by **slug** (the `:id` in the endpoint map). Extra read routes: `GET /posts/options` (blog categories + authors), `GET /jobs/options` (job categories), `GET /jobs/review-count` (staff badge). `GET /jobs/:slug` returns `{ job, stats: { views, applies } }`. Lists return `{ rows, total, page, pageSize, counts }`, so a list page is one call.
- **Posts:** `POST /posts` and `PATCH /posts/:slug` take the editor's fields plus `intent` (`draft`, `publish`, `schedule` + `scheduleAt`, `update`, `unpublish`, `autosave`). Success returns `{ slug, status, publishedAt, savedAt, message, siteRefreshed, missingSections }`. Failed checks are `400 validation_failed` with `fields` keyed like the admin's (`images.0.alt`, `coverImage: "Choose a hero image"`, …). Autosaving a live post is `409 autosave_published`. The MDX body check (`@mdx-js/mdx` + `remarkSafeMdx`) runs in the API.
- **Jobs:** the body is the job form as JSON (strings, blank = not set, lists as arrays, `postedAt`/`deadline` as `YYYY-MM-DD` or ISO, `companyId` for staff). Success returns `{ job, notice, message }`, where `notice` is `submitted`, `saved` or `saved-offline` (the admin's redirect `?notice=`). Jobs another company owns are always `404`. Approve/reject on a job that isn't waiting is `409 not_pending`.
- **Media:** `POST /media` is multipart (`files`, up to 20, plus `alt`). It returns `{ uploaded, errors }` per file, like the admin did. A file over 5 MB fails the whole request with `413 file_too_large` (multer's limit), and the upload rate limit (60 per 10 minutes) is a `429`. Usage is by id (`GET /media/:id/usage`). `DELETE` on an image in use is `409 in_use` with `error.details.usage`, a new optional field on the error body. Storage: Vercel Blob when `BLOB_READ_WRITE_TOKEN` is set, otherwise `UPLOADS_DIR`.
- Not ported (they stay in the admin as UI code): `renderPostPreview`, `lib/posts/outline.ts` (it needs `shared/content/toc.ts`, so Phase 7 must keep a copy of that file when it deletes `src/shared/`), `lib/jobs/form-values.ts`.
- A post or job whose slug is `options`, `review-count` or `bulk` can't be opened by slug. No such slugs exist.

### Phase 6
- `CategoriesModule`, `AuthorsModule`, `MessagesModule` (`/messages` + `/subscribers`), `SettingsModule` (super admins), `DashboardModule` (`/dashboard`, `/dashboard/badges`, `/activity`), `SearchModule`, `PreferencesModule` (`/me/theme`, `/me/dashboard-layout`). Categories and authors are keyed by slug.
- **Endpoint map corrections:** `GET /dashboard/stats?range=` was dropped. The admin buckets the 365 daily points from `GET /dashboard` itself (`toBuckets`). `GET /dashboard/badges` replaces the sidebar's two count queries. Invites are revoked with `DELETE /invites?email=` (built that way in Phase 2: invites have no id). An "Editor lookups" row lists the extra read routes.
- `test/endpoint-map.e2e-spec.ts` parses the endpoint map table in this file and fails if any route is missing from `/docs-json`. Keep the table up to date.
- Lists return what the admin pages showed: categories with `used`, authors with `posts`, the newest 200 messages / 500 subscribers with `unread` and `subscribers` counts, activity 30 per page.
- Form errors use the message "Please fix the highlighted fields." (`formBody()` in `common/zod.ts`). Slug clashes on categories and authors are `409 slug_taken` with `fields.slug`. Deleting a category or author that's still used is `409 in_use`.
- `PUT /me/theme` works for every role. The admin still sets its own theme cookie; the API only stores the preference.
- `npm run db:import` (port of the admin's `scripts/import-content.ts` + `lib/import/plan.ts`) reads `BLOGNEST_DIR`. The admin's `DashboardLayout` labels stay in the admin; the API only knows the card ids.

### Phase 7
- The admin calls the API through `src/lib/api/client.ts` (server-only): bearer token from the `cr_admin_access` cookie, `X-Api-Key` (`ADMIN_API_KEY`) and `X-Client-IP` on every call. `apiFetch(path, { dates: true })` revives ISO dates for row-shaped answers; row types live in `src/lib/api/types.ts`.
- **Refresh happens in `proxy.ts`, not on 401.** Server Components can't write cookies, so a refresh during a page render couldn't store the rotated refresh token (and its reuse would later sign the user out everywhere). The proxy refreshes when the access token has under a minute left, passes the new cookies to the page in the same request, and sets them on the response. A 401 that still reaches the client sends the user to `/login`. The API's 30-second rotation grace covers parallel requests.
- Every `lib/*` query module and Server Action kept its exported signature, so the screens didn't change. API `fields` errors map into the existing form state (`formErrors()`, `toResult()`).
- `src/shared/` was **not** deleted. The post preview (`renderPostPreview`, kept local as planned), the editor's live hints and the job/settings label lists need the MDX rules, `toc`, schemas and label lists. It is now a display copy synced from the API (`npm run sync:shared` reads `../blognest-api`). The unused files (visibility, blog categories) were removed.
- `pg` stays as a **dev** dependency: the existing e2e specs inspect the test database directly (17 queries) and had to pass unchanged. The app has no database dependency; `tests/unit/security.test.ts` fails if anything in `src/` imports one.
- e2e: `global-setup` runs the API's `npm run e2e:seed` (migrate, truncate, import the site's content, create the QA accounts passed in `E2E_SEED`; refuses databases not named `*_test`). Playwright starts the API (:3103), the website (:3102, which waits for the API before `next build`) and the admin (:3101).
- Admin env is `API_URL` (production default `https://api.careersreads.com`), `ADMIN_API_KEY`, `PUBLIC_SITE_URL`. Old sessions aren't used any more, so everyone signs in once after the switch.

### Phase 8 (API part)
- Production URL is `https://api.careersreads.com`. Website production deployments (`VERCEL_ENV=production`) default `API_URL` to it; the admin should do the same in Phase 7.
- `Dockerfile` (multi-stage, health check), `.github/workflows/check.yml` (Postgres 18 service, `npm run check`), `TRUST_PROXY` env (default 1), CORS still off unless `CORS_ORIGINS` is set, README with the env table and the go-live checklist.

# Career Reads API

The backend for [Career Reads](../blognest). It is the **only** service that talks to PostgreSQL, file storage and passwords. The website ([`blognest`](../blognest)) and the admin panel ([`blognest-admin`](../blognest-admin)) call it over HTTP.

- Plan and architecture: [`docs/API_SPLIT_PLAN.md`](docs/API_SPLIT_PLAN.md)
- API docs (when running): http://localhost:4000/docs, with the OpenAPI JSON at `/docs-json`

> The split is in progress. The website reads everything through the API (plan phase 4). Until phase 7 is done, the admin still reads the database directly and keeps a read-only copy of `src/db/schema.ts`.

## How the three repos fit together

| Repo | Port | What it does | Talks to |
| --- | --- | --- | --- |
| `blognest-api` (this) | 4000 | Owns Postgres, file storage, passwords and the schema/migrations | Postgres, the website's `/api/revalidate` |
| `blognest` (website) | 3000 | Public pages | API: `/public/*`, with `SITE_API_KEY` for forms, stats and previews |
| `blognest-admin` | 3001 | Dashboard screens | API with bearer tokens and `ADMIN_API_KEY` |

Start them in this order: Postgres (`npm run db:local`) → API → website → admin.

## Run it locally

You need Node 20.9+ and Homebrew Postgres (`brew install postgresql@18`).

```bash
npx npm@latest install      # the npm bundled with Node 22.23 crashes on this dependency tree
npm run db:local            # start the private Postgres on port 54329 (shared with the admin's)
cp .env.example .env.local  # then set JWT_SECRET (openssl rand -hex 32)
npm run db:migrate          # create or update the tables
npm run start:dev           # http://localhost:4000
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm run start:dev` | API on http://localhost:4000 with reload |
| `npm run build` / `start:prod` | Compile to `dist/` / run the compiled API |
| `npm run db:local` / `db:local:stop` | Start / stop the private local Postgres |
| `npm run db:generate` | Create a migration after editing `src/db/schema.ts` |
| `npm run db:migrate` | Apply migrations to `DATABASE_URL` (this repo is the only one that migrates) |
| `npm run db:studio` | Drizzle Studio |
| `npm run admin:create -- email "Name" [--reset]` | Create the first super admin, or reset someone's password (they become a super admin), with a temporary password |
| `npm test` | Unit tests (`src/**/*.spec.ts`) |
| `npm run test:e2e` | HTTP tests against the `blognest_test` database (`test/**/*.e2e-spec.ts`) |
| `npm run check` | Lint, typecheck, unit tests, e2e tests, build |

## Layout

```
src/
  main.ts            boots the app (loads .env.local, then .env)
  app.setup.ts       helmet, trust proxy, error filter, CORS, Swagger (shared with e2e tests)
  config/env.ts      Zod-validated environment
  db/                schema.ts, migrations/, client.ts, DbModule (@InjectDb())
  common/            ApiError, ErrorFilter, ZodPipe + @ApiZodBody/@ApiZodQuery, request logger,
                     rate limits, audit log, website revalidation, client IP / server keys
  auth/              login, refresh, logout, me, change password; AuthGuard + @Public/@Roles/@CurrentUser
  users/             staff users and invites (staff and company)
  companies/         companies, their people and job stats
  public/            what the website reads (/public/articles, jobs, categories, authors, settings)
                     and writes (contact, subscribe, stats; need the site key)
  shared/            Zod rules and visibility rules (isPubliclyVisible, isJobVisible)
  health/            GET /health
test/                e2e tests + helpers (test DB, app factory)
```

## Auth in one paragraph

`POST /auth/login` returns a 15-minute access token and a 30-day refresh token. Send `Authorization: Bearer <access>` on every call. When you get a 401, call `POST /auth/refresh` once with the refresh token. Each refresh returns a new pair, and the old refresh token stops working 30 seconds later. Every route needs a token unless it's marked `@Public()`. The admin and website servers also send `X-Api-Key` and the visitor's `X-Client-IP`, which the rate limits use.

## Environment

| Variable | Required | What it is |
| --- | --- | --- |
| `DATABASE_URL` | Yes | Postgres. Local: `postgres://postgres@localhost:54329/blognest`. Production: Neon |
| `JWT_SECRET` | Yes | Signs access and refresh tokens (`openssl rand -hex 32`) |
| `ADMIN_API_KEY` / `SITE_API_KEY` | Yes in production | Server keys the admin and website send as `X-Api-Key` |
| `ADMIN_URL` / `PUBLIC_SITE_URL` | Yes in production | Origins for invite links and website revalidation |
| `REVALIDATE_SECRET` | Yes in production | Same value as the website's; the API calls its `/api/revalidate` after saves |
| `PORT` | No | Default 4000 |
| `TRUST_PROXY` | No | Proxies in front of the API (default 1) |
| `BLOB_READ_WRITE_TOKEN` | Yes in production | Vercel Blob token for media uploads. Without it, uploads go to `UPLOADS_DIR` (refused in production) |
| `UPLOADS_DIR` | No | Local uploads folder, default `../blognest/public/uploads` so `/uploads/…` URLs work on the website |
| `CORS_ORIGINS` | No | Leave empty: browsers never call the API directly |
| `ACCESS_TOKEN_TTL_SECONDS` / `REFRESH_TOKEN_DAYS` | No | Default 900 seconds / 30 days |

## Deploying

The API is a long-running Node server: host it on Railway, Render or Fly (not Vercel) at `https://api-careersreads.com`. The `Dockerfile` builds a production image with a health check on `GET /health`. CI (`.github/workflows/check.yml`) runs `npm run check` against a Postgres service on every push and pull request.

### Going live checklist

- [ ] Deploy the API at `https://api-careersreads.com` with `DATABASE_URL`, `JWT_SECRET`, `ADMIN_API_KEY`, `SITE_API_KEY`, `ADMIN_URL`, `REVALIDATE_SECRET`, `PUBLIC_SITE_URL`, `BLOB_READ_WRITE_TOKEN`.
- [ ] Run `npm run db:migrate` from the API (the only repo that migrates from now on).
- [ ] Website (Vercel): remove `DATABASE_URL`, add `SITE_API_KEY` (production deployments use `https://api-careersreads.com` unless `API_URL` overrides it). Redeploy **before** the admin.
- [ ] Admin (Vercel): remove `DATABASE_URL` and `BLOB_READ_WRITE_TOKEN`, add `API_URL` + `ADMIN_API_KEY`. Redeploy.
- [ ] Log in to the admin, publish a test post, and confirm it appears on the site within seconds.
- [ ] Rotate the old `DATABASE_URL` password so only the API can connect.

## Conventions

- ESM with `nodenext`: relative imports end in `.js`.
- Validate every input with Zod: `@Body(new ZodPipe(schema))` plus `@ApiZodBody(schema)` so it shows in `/docs`.
- Errors are always `{ error: { code, message, fields? } }`. Throw `ApiError` for expected failures.
- Every write that changes something visible: check the role, validate, write, `AuditService.log(...)`, then `RevalidateSiteService.revalidate(...)` when the website shows it.

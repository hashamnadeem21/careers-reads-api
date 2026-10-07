# Career Reads API

The backend for [Career Reads](../blognest). It is the **only** service that talks to PostgreSQL, file storage and passwords. The website ([`blognest`](../blognest)) and the admin panel ([`blognest-admin`](../blognest-admin)) call it over HTTP.

- Plan and architecture: [`docs/API_SPLIT_PLAN.md`](docs/API_SPLIT_PLAN.md)
- API docs (when running): http://localhost:4000/docs, with the OpenAPI JSON at `/docs-json`

> The split is in progress. Until plan phases 4 and 7 are done, the website and admin still read the database directly and keep read-only copies of `src/db/schema.ts`.

## Run it locally

You need Node 20.9+ and Homebrew Postgres (`brew install postgresql@18`).

```bash
npx npm@latest install      # the npm bundled with Node 22.23 crashes on this dependency tree
npm run db:local            # start the private Postgres on port 54329 (shared with the admin's)
cp .env.example .env.local
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
  common/            ApiError, ErrorFilter, ZodPipe + @ApiZodBody/@ApiZodQuery, request logger
  shared/            Zod rules and visibility rules (isPubliclyVisible, isJobVisible)
  health/            GET /health
test/                e2e tests + helpers (test DB, app factory)
```

## Conventions

- ESM with `nodenext`: relative imports end in `.js`.
- Validate every input with Zod: `@Body(new ZodPipe(schema))` plus `@ApiZodBody(schema)` so it shows in `/docs`.
- Errors are always `{ error: { code, message, fields? } }`. Throw `ApiError` for expected failures.

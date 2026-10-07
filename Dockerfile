# Career Reads API. Build: docker build -t career-reads-api .
# Run:   docker run -p 4000:4000 --env-file .env.production career-reads-api
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# The npm bundled with Node 22 crashes on this dependency tree.
RUN npx npm@latest ci
COPY . .
RUN npm run build && npx npm@latest prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production PORT=4000
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/db/migrations ./src/db/migrations
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.js"]

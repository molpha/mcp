FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# The build needs the dev toolchain; the image does not. The hosted server signs nothing, so the
# Privy and Turnkey SDKs (dev dependencies of the published package) are pruned with the rest.
RUN npm ci --include=dev
COPY tsconfig.json ./
COPY src ./src
COPY cli ./cli
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production MOLPHA_HTTP_HOST=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 8402
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MOLPHA_HTTP_PORT||8402)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "dist/src/server.js"]
CMD ["--http"]

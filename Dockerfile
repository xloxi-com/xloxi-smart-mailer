# =============================================================================
# XLOXI Smart Product Mailer — multi-stage production image
# Default CMD: web service only (npm run start:web).
# Does NOT run prisma migrate on container start.
# Override CMD for: db:migrate | worker:scheduler | worker:email | worker:webhooks
# =============================================================================

FROM node:22-alpine AS base
RUN apk add --no-cache openssl libc6-compat
WORKDIR /app

# ---- Dependencies ----
FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci

# ---- Build ----
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NODE_ENV=production
ENV SHOPIFY_APP_SKIP_ENV_VALIDATION=1

RUN npx prisma generate
RUN npm run build
RUN npm prune --omit=dev && npm cache clean --force

# ---- Runtime ----
FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

RUN addgroup -S xloxi && adduser -S xloxi -G xloxi
USER xloxi

COPY --from=build --chown=xloxi:xloxi /app/package.json ./package.json
COPY --from=build --chown=xloxi:xloxi /app/package-lock.json* ./
COPY --from=build --chown=xloxi:xloxi /app/node_modules ./node_modules
COPY --from=build --chown=xloxi:xloxi /app/build ./build
COPY --from=build --chown=xloxi:xloxi /app/prisma ./prisma
COPY --from=build --chown=xloxi:xloxi /app/workers ./workers
COPY --from=build --chown=xloxi:xloxi /app/app ./app
COPY --from=build --chown=xloxi:xloxi /app/shopify.app.toml ./shopify.app.toml

# Web only — migrations are a separate Cloud Run Job (npm run db:migrate).
CMD ["npm", "run", "start:web"]

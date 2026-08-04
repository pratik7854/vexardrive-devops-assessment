# syntax=docker/dockerfile:1.7
FROM node:22.14.0-alpine3.21 AS dependencies
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:22.14.0-alpine3.21 AS runtime
ENV NODE_ENV=production PORT=8080
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=dependencies --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app package.json server.js ./
USER app
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]

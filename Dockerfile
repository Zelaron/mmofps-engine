FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN npm ci
COPY . .
RUN npm run typecheck && npm run build

FROM node:22-alpine
WORKDIR /app
COPY --from=build --chown=node:node /app/packages/server/dist packages/server/dist
COPY --from=build --chown=node:node /app/packages/client/dist packages/client/dist
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8080
ENV HOST=0.0.0.0 PORT=8080 BOTS=192 DATA_DIR=/app/data
VOLUME ["/app/data"]
CMD ["node", "--experimental-sqlite", "packages/server/dist/server.cjs"]

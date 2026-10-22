# Build context is the repo root. tsc resolves scraper imports from the root
# node_modules; tsup then bundles them, looking in the extension's as well.
# The runtime image only keeps that bundle. @napi-rs/keyring stays out —
# OPENRECORD_SECRET_BACKEND=file is the store this container has.
FROM oven/bun:1 AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile \
  && cd claude-desktop-extension && bun install --frozen-lockfile && bun run build

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build \
  /src/claude-desktop-extension/dist/server.cjs \
  /src/claude-desktop-extension/dist/node-sqlite3-wasm.wasm \
  ./
ENV OPENRECORD_SECRET_BACKEND=file
ENV HOME=/data
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8787
USER node
CMD ["node", "server.cjs", "--http"]

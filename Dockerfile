FROM ghcr.io/denoland/celld:0.6.2 AS celld
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=celld /usr/local/bin/celld /usr/local/bin/celld
COPY --from=celld /usr/share/doc/celld /usr/share/doc/celld
COPY --from=build /app/runtime/ ./
COPY --from=build /app/.output/public ./.output/public
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/node_modules/ws ./node_modules/ws
EXPOSE 9876
CMD ["node", "scripts/start.mjs"]

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY src ./src
RUN npm install \
      effect@^3.22.1 \
      @effect/platform@^0.97.1 \
      @effect/platform-node@^0.108.1 \
      esbuild@^0.25.12 \
 && npx esbuild src/server/main.ts \
      --bundle \
      --platform=node \
      --format=cjs \
      --outfile=output/server.cjs \
      --packages=bundle

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/output/server.cjs ./server.cjs
RUN chown -R node:node /app && mkdir -p /tmp/finalizer && chown node:node /tmp/finalizer
USER node
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.cjs"]

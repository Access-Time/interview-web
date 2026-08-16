FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server.js ./server.js
RUN chown -R node:node /app && mkdir -p /tmp/finalizer && chown node:node /tmp/finalizer
USER node
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]

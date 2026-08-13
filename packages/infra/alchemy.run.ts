import path from "node:path";
import alchemy from "alchemy";
import {
  Container,
  D1Database,
  Queue,
  R2Bucket,
  TanStackStart,
  Worker,
} from "alchemy/cloudflare";
import { config } from "dotenv";

const infraDir = import.meta.dirname;
const finalizerDir = path.resolve(infraDir, "../finalizer");

config({ path: "./.env" });
config({ path: "../../apps/web/.env" });

const app = await alchemy("interview-web");

const db = await D1Database("database", {
  migrationsDir: "../../packages/db/src/migrations",
});

const recordings = await R2Bucket("recordings", {
  devDomain: false,
});

const finalizationQueue = await Queue("finalization", {
  name: "recording-finalizations",
});

export const web = await TanStackStart("web", {
  bindings: {
    CORS_ORIGIN: alchemy.env.CORS_ORIGIN ?? "*",
    DB: db,
    FINALIZATION_QUEUE: finalizationQueue,
    RECORDINGS: recordings,
  },
  cwd: "../../apps/web",
});

const finalizerContainer = await Container("recording-finalizer-container", {
  build: {
    context: "../../packages/finalizer",
    dockerfile: "Dockerfile",
    platform: "linux/amd64",
  },
  className: "RecordingFinalizerContainer",
  maxInstances: 1,
});
export const finalizer = await Worker("recording-finalizer", {
  bindings: {
    DB: db,
    FINALIZATION_QUEUE: finalizationQueue,
    FINALIZER: finalizerContainer,
    RECORDINGS: recordings,
  },
  crons: ["*/15 * * * *"],
  // Alchemy 0.94 matches Worker.entrypoint against esbuild's metafile string.
  // A repo-root path like ../../packages/finalizer/src/worker.ts is the same
  // file as ../finalizer/src/worker.ts, but esbuild records the latter and
  // the worker never starts. Bundle from the finalizer package instead.
  // sourceMap: false avoids a watch loop (Alchemy rewrites worker.js.map).
  cwd: finalizerDir,
  entrypoint: "src/worker.ts",
  eventSources: [
    {
      queue: finalizationQueue,
      settings: { batchSize: 1, maxConcurrency: 1, maxRetries: 5 },
    },
  ],
  sourceMap: false,
});

console.log(`Web    -> ${web.url}`);

await app.finalize();

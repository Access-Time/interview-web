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
  entrypoint: "../finalizer/src/worker.ts",
  eventSources: [
    {
      queue: finalizationQueue,
      settings: { batchSize: 1, maxConcurrency: 1, maxRetries: 5 },
    },
  ],
});

console.log(`Web    -> ${web.url}`);

await app.finalize();

import alchemy from "alchemy";
import { D1Database, R2Bucket, TanStackStart } from "alchemy/cloudflare";
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

export const web = await TanStackStart("web", {
  bindings: {
    CORS_ORIGIN: alchemy.env.CORS_ORIGIN ?? "*",
    DB: db,
    RECORDINGS: recordings,
  },
  cwd: "../../apps/web",
});

console.log(`Web    -> ${web.url}`);

await app.finalize();

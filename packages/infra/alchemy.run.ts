import alchemy from "alchemy";
import { D1Database, TanStackStart } from "alchemy/cloudflare";
import { config } from "dotenv";

config({ path: "./.env" });
config({ path: "../../apps/web/.env" });

const app = await alchemy("interview-web");

const db = await D1Database("database", {
  migrationsDir: "../../packages/db/src/migrations",
});

export const web = await TanStackStart("web", {
  bindings: {
    CORS_ORIGIN: alchemy.env.CORS_ORIGIN ?? "*",
    DB: db,
  },
  cwd: "../../apps/web",
});

console.log(`Web    -> ${web.url}`);

await app.finalize();

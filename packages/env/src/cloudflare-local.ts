import { fileURLToPath, URL } from "node:url";
import { config } from "dotenv";

const envFileUrl = new URL("../../../.env", import.meta.url);
if (envFileUrl.protocol === "file:") {
  config({ path: fileURLToPath(envFileUrl) });
}
config();

const runtimeEnv = typeof process === "undefined" ? {} : process.env;

export const env = new Proxy({} as WorkerEnv, {
  get(_target, prop) {
    if (typeof prop !== "string") {
      return;
    }

    return runtimeEnv[prop];
  },
});

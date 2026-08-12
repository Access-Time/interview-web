import { env } from "@interview-web/env/server";
import { drizzle } from "drizzle-orm/d1";
import { todo } from "./schema/todo";

export function createDb() {
  return drizzle(env.DB, { schema: { todo } });
}

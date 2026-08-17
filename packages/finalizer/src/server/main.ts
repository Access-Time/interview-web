import { createServer } from "node:http";
import { HttpServer } from "@effect/platform";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Layer } from "effect";
import { Ffmpeg } from "./ffmpeg.ts";
import { finalizerHttpApp } from "./http.ts";
import { JobStore } from "./job-store.ts";

const ServerLive = HttpServer.serve()(finalizerHttpApp).pipe(
  Layer.provide(JobStore.Default),
  Layer.provide(Ffmpeg.Default),
  Layer.provide(
    NodeHttpServer.layer(createServer, {
      port: Number(process.env.PORT) || 8080,
    })
  )
);

NodeRuntime.runMain(Layer.launch(ServerLive));

import { serve } from "bun";
import { openDb, migrate } from "./db";
import { createPipelineScheduler } from "./pipeline";
import { createAppFetchHandler } from "./app";

const db = openDb();
migrate(db);
const scheduler = createPipelineScheduler(db);
scheduler.resumePending();

const server = serve({
  port: Number(process.env.PORT ?? 3001),
  fetch: createAppFetchHandler(db, { onQueued: (id) => scheduler.schedule(id) }),
});

console.log(`argue-api listening on :${server.port}`);

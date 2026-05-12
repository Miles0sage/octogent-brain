import { serve } from "bun";
import { openDb, migrate } from "./db";
import { handleArguePost } from "./routes/argue.post";

const db = openDb();
migrate(db);

const server = serve({
  port: Number(process.env.PORT ?? 3001),
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return new Response("ok");
    if (url.pathname === "/argue" && req.method === "POST") return handleArguePost(req, db);
    return new Response("not found", { status: 404 });
  },
});

console.log(`argue-api listening on :${server.port}`);

import { serve } from "bun";

const server = serve({
  port: Number(process.env.PORT ?? 3001),
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return new Response("ok");
    return new Response("not found", { status: 404 });
  },
});

console.log(`argue-api listening on :${server.port}`);

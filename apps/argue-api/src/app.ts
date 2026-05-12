import type { Db } from "./db";
import { handleArguePost } from "./routes/argue.post";
import { handleArgumentJsonGet, handleArgumentPageGet } from "./results";

export interface AppDeps {
  onQueued?: (id: string) => void;
}

export function createAppFetchHandler(db: Db, deps: AppDeps = {}) {
  return async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/healthz") {
      return new Response("ok");
    }

    if (url.pathname === "/argue" && req.method === "POST") {
      return handleArguePost(req, db, { onQueued: deps.onQueued });
    }

    if (req.method === "GET") {
      const json = handleArgumentJsonGet(req, db);
      if (json) return json;

      const page = handleArgumentPageGet(req, db);
      if (page) return page;
    }

    return new Response("not found", { status: 404 });
  };
}

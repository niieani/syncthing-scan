import { serve } from "bun";
import index from "./index.html";

const workerSource = new URL("./workers/traceParser.ts", import.meta.url);
const transpiler = new Bun.Transpiler({ loader: "ts" });

const server = serve({
  routes: {
    "/workers/traceParser.js": async () => {
      const source = await Bun.file(workerSource).text();
      const result = transpiler.transformSync(source);
      const code = typeof result === "string" ? result : result.code;
      return new Response(code, {
        headers: {
          "Content-Type": "text/javascript",
          "Cache-Control": "no-cache",
        },
      });
    },
    // Serve index.html for all unmatched routes.
    "/*": index,

    "/api/hello": {
      async GET(req) {
        return Response.json({
          message: "Hello, world!",
          method: "GET",
        });
      },
      async PUT(req) {
        return Response.json({
          message: "Hello, world!",
          method: "PUT",
        });
      },
    },

    "/api/hello/:name": async req => {
      const name = req.params.name;
      return Response.json({
        message: `Hello, ${name}!`,
      });
    },
  },

  development: process.env.NODE_ENV !== "production" && {
    // Enable browser hot reloading in development
    hmr: true,

    // Echo console logs from the browser to the server
    console: true,
  },
});

console.log(`🚀 Server running at ${server.url}`);

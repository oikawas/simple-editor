import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const { server, store } = createApp(config);

await server.listen();
console.log(`simple-editor listening on :${config.port} (data: ${config.dataDir})`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    server.hocuspocus.flushPendingStores();
    await server.destroy();
    store.close();
    process.exit(0);
  });
}

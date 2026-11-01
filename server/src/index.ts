import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const { server, store } = createApp(config);

await server.listen();
// The actual port, which differs from PORT=0 (tests let the system choose one).
console.log(`simple-editor listening on :${server.address.port} (data: ${config.dataDir})`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    server.hocuspocus.flushPendingStores();
    await server.destroy();
    store.close();
    process.exit(0);
  });
}

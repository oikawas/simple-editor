// Presence from a Yjs client built on the same libraries as the web app: it
// opens a note as the device "web", the way the web app announces itself,
// waits until it sees another device's name in the awareness states (or
// gives up), prints the names it saw, and stays a moment before leaving.
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import * as Y from "yjs";

const [url, token, name, expected] = process.argv.slice(2);
const doc = new Y.Doc();
const websocketProvider = new HocuspocusProviderWebsocket({ url });
const provider = new HocuspocusProvider({ name, document: doc, token, websocketProvider });
provider.awareness.setLocalStateField("user", { name: "web", color: "#2f6fde" });
const names = () =>
  [...provider.awareness.getStates()]
    .filter(([client]) => client !== provider.awareness.clientID)
    .map(([, state]) => state?.user?.name)
    .filter(Boolean)
    .sort();
const finish = (code) => {
  console.log(JSON.stringify({ seen: names() }));
  // Stay so the other side can see this device, then leave.
  setTimeout(() => {
    provider.destroy();
    websocketProvider.destroy();
    process.exit(code);
  }, 1500);
};
provider.awareness.on("change", () => {
  if (names().includes(expected)) finish(0);
});
provider.attach();
setTimeout(() => finish(2), 10000);

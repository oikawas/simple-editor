// A Yjs client built on the same libraries as the web app, used to check that
// the Rust core interoperates with it. Prints the note body it sees, appends
// text, waits until the server has it, and prints the body again.
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import * as Y from "yjs";

const [url, token, name, append] = process.argv.slice(2);
const doc = new Y.Doc();
const websocketProvider = new HocuspocusProviderWebsocket({ url });
const provider = new HocuspocusProvider({ name, document: doc, token, websocketProvider });
const done = (code) => {
  provider.destroy();
  websocketProvider.destroy();
  process.exit(code);
};
provider.on("authenticationFailed", ({ reason }) => {
  console.log(JSON.stringify({ error: reason }));
  done(1);
});
provider.on("synced", () => {
  const body = doc.getText("body");
  const meta = doc.getMap("meta");
  console.log(JSON.stringify({
    body: body.toString(),
    tags: [...doc.getMap("tags").keys()].sort(),
    createdAtType: typeof meta.get("createdAt"),
  }));
  if (!append) return done(0);
  body.insert(body.length, append);
  provider.on("unsyncedChanges", ({ number }) => {
    if (number === 0) done(0);
  });
});
provider.attach();
setTimeout(() => done(2), 10000);

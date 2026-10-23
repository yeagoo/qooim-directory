// Strings Qoo.IM needs that toolso's messages do not have, one module per area so they can
// be edited independently. Looked up after the ported messages (see runtime.ts translator).
import home from "./qooim-home.js";
import catalog from "./qooim-catalog.js";
import client from "./qooim-client.js";

export const extra = {
  en: { qooim: { home: home.en, catalog: catalog.en, client: client.en } },
  zh: { qooim: { home: home.zh, catalog: catalog.zh, client: client.zh } },
};

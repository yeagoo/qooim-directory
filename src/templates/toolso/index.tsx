/** toolso: the directory look of toolso-ai-open, ported onto template API v1. See NOTICE.md. */
import { defineTemplate } from "../../public/sdk.js";
import { DetailPage } from "./pages/detail.js";
import { DirectoryPage } from "./pages/directory.js";
import { HomePage } from "./pages/home.js";
import { MissingPage } from "./pages/missing.js";

export default defineTemplate({
  id: "toolso",
  apiVersion: 1,
  render: (page) =>
    page.kind === "detail" ? (
      <DetailPage page={page} />
    ) : page.kind === "missing" ? (
      <MissingPage page={page} />
    ) : (
      <DirectoryPage page={page} />
    ),
  renderHome: (page) => <HomePage page={page} />,
});

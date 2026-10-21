/** Isolated Docker test receiver. Never include in production Compose. */
import { createServer } from "node:http";
import { smtpReceiver } from "../tests/p3/smtp.js";
const smtp = await smtpReceiver(1025, "0.0.0.0");
createServer((request, response) => {
  if (request.url === "/repos/acme/docker-project") {
    response.setHeader("content-type", "application/json");
    response.setHeader("etag", '"docker-42"');
    response.end(
      JSON.stringify({
        id: 4242,
        full_name: "acme/docker-project",
        private: false,
        description: "Docker project fixture",
        stargazers_count: 42,
        forks_count: 3,
        open_issues_count: 1,
        language: "TypeScript",
        license: { spdx_id: "MIT" },
        topics: ["tools"],
        archived: false,
        disabled: false,
        pushed_at: "2026-10-01T00:00:00Z",
      }),
    );
    return;
  }
  if (request.url !== "/messages") {
    response.writeHead(404).end();
    return;
  }
  const messages = smtp.messages.map((raw) => {
    const text = raw
      .replace(/=\r\n/g, "")
      .replace(/=([0-9a-f]{2})/gi, (_, hex) =>
        String.fromCharCode(parseInt(hex, 16)),
      );
    return {
      to: text.match(/^To: (.+)$/m)?.[1].trim(),
      url: text.match(/https:\/\/[^\s]+/)?.[0],
    };
  });
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(messages));
}).listen(8025, "0.0.0.0");

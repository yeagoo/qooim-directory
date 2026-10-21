import { writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
const pg = randomBytes(24).toString("hex");
const content = `# Local HTTPS demo: use compose.yaml with compose.demo.yaml.
POSTGRES_PASSWORD=${pg}
DATABASE_URL=postgresql://network:${pg}@127.0.0.1:5432/network
AUTH_ENCRYPTION_KEY=${randomBytes(32).toString("hex")}
PROXY_TRUST_TOKEN=${randomBytes(32).toString("hex")}
ADMIN_ORIGIN=https://admin.localhost:8443
ALLOW_INSECURE_HTTP=false
OPERATOR_EMAIL=owner@example.test
OPERATOR_PASSWORD=${randomBytes(24).toString("base64url")}
SEED_DEMO=true
DEMO_ORIGINS=https://atlas.localhost:8443,https://notes.localhost:8443,https://library.localhost:8443
# Local demo has no SMTP receiver; production must set true with SMTP.
AUTH_REQUIRE_EMAIL=false
`;
writeFileSync(".env", content, { flag: "wx", mode: 0o600 });
console.log(
  "Created .env with random secrets. Read OPERATOR_PASSWORD locally; existing files are never overwritten.",
);

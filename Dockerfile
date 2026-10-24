FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm install -g pnpm@10.11.1
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
# Runtime needs only production dependencies (tsx runs the CLI and worker); drop
# build-only tooling such as Tailwind and TypeScript, and the Next build cache.
RUN pnpm prune --prod && rm -rf .next/cache

FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build /usr/local/lib/node_modules/pnpm /usr/local/lib/node_modules/pnpm
RUN ln -s /usr/local/lib/node_modules/pnpm/bin/pnpm.cjs /usr/local/bin/pnpm
COPY --from=build --chown=node:node /app /app
# P0 test harness is build/test-only; keep it out of the runtime image.
RUN rm -rf /app/p0 && mkdir -p /app/data/media && chown node:node /app/data/media
USER node
EXPOSE 3000
# node:http rather than fetch(): fetch drops the Host header, which /health routing needs.
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s CMD node -e 'require("node:http").get({host:"127.0.0.1",port:3000,path:"/health",headers:{host:new URL(process.env.ADMIN_ORIGIN).host},timeout:4000},r=>process.exit(r.statusCode===200?0:1)).on("error",()=>process.exit(1)).on("timeout",()=>process.exit(1))'
ENTRYPOINT ["sh","scripts/start-container.sh"]
CMD ["web"]

# syntax=docker/dockerfile:1
# Rehearsal and approved-source contexts are produced by prepare-image.ts.
FROM node:22.22.3-bookworm-slim AS build
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.rebuild.json ./
COPY apps/ ./apps/
COPY packages/ ./packages/
COPY tools/rebuild/build-api.mjs ./tools/rebuild/build-api.mjs
COPY tools/rebuild/build-analytics-manifest.ts ./tools/rebuild/build-analytics-manifest.ts
RUN npm ci --no-audit --no-fund && npm run build:rebuild && npm prune --omit=dev --no-audit --no-fund

FROM node:22.22.3-bookworm-slim
ARG QGROUP_UID=994
ARG QGROUP_GID=992
ARG QGROUP_COMMIT
LABEL org.opencontainers.image.title="qgroup-unified" org.opencontainers.image.revision="${QGROUP_COMMIT}"
ENV NODE_ENV=production QGROUP_BUILD_INFO=/app/release-source.json
RUN groupadd --gid "${QGROUP_GID}" qgroupsvc && useradd --uid "${QGROUP_UID}" --gid "${QGROUP_GID}" --no-create-home --shell /usr/sbin/nologin qgroupsvc && mkdir -p /var/lib/qgroup && chown qgroupsvc:qgroupsvc /var/lib/qgroup
WORKDIR /app
COPY --from=build /build/node_modules/ ./node_modules/
COPY --from=build /build/.rebuild-dist/ ./.rebuild-dist/
COPY release-source.json ./release-source.json
RUN ["node", "-e", "const s=JSON.parse(require('fs').readFileSync('/app/release-source.json'));if(!/^[a-f0-9]{40}$/.test(process.env.QGROUP_COMMIT||'')||s.commit!==process.env.QGROUP_COMMIT)throw Error('Image label and archived source must agree')"]
USER qgroupsvc
EXPOSE 8791
CMD ["node", ".rebuild-dist/api/start.mjs"]

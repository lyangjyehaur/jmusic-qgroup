# syntax=docker/dockerfile:1
# One image for both processes: they share code and differ only by `command`.
# The HTTP service is stdlib-only; websockets is the bot's sole extra dependency.
FROM python:3.11-slim

# Must match the owner of the bind-mounted SQLite directory on the host.
# server2's static qgroupsvc account is 994:992; override with --build-arg if not.
ARG QGROUP_UID=994
ARG QGROUP_GID=992

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN groupadd --gid "${QGROUP_GID}" qgroupsvc \
 && useradd --uid "${QGROUP_UID}" --gid "${QGROUP_GID}" \
            --no-create-home --shell /usr/sbin/nologin qgroupsvc \
 && pip install --no-cache-dir "websockets==17.4"

WORKDIR /app

# Explicit COPY instead of COPY . .: no build context secret can be baked in.
COPY --chown=qgroupsvc:qgroupsvc server.py public_api.py ./
COPY --chown=qgroupsvc:qgroupsvc qgroup_core/ ./qgroup_core/
COPY --chown=qgroupsvc:qgroupsvc qgroup_bot/ ./qgroup_bot/
COPY --chown=qgroupsvc:qgroupsvc public/ ./public/
COPY --chown=qgroupsvc:qgroupsvc deploy/ ./deploy/
COPY --chown=qgroupsvc:qgroupsvc tests/ ./tests/
COPY --chown=qgroupsvc:qgroupsvc music_site/ ./music_site/

USER qgroupsvc
# Informational only: the compose file uses host networking (see compose.yaml).
EXPOSE 8791

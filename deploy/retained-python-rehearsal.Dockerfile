# Isolated verification only. Built from a separately archived original bot.
FROM python:3.11-slim-bookworm
ARG QGROUP_PYTHON_COMMIT
ARG QGROUP_VERIFICATION_COMMIT
LABEL org.opencontainers.image.title="qgroup-retained-python-rehearsal" \
      org.opencontainers.image.revision="${QGROUP_PYTHON_COMMIT}" \
      qgroup.verification.revision="${QGROUP_VERIFICATION_COMMIT}"
ENV PYTHONDONTWRITEBYTECODE=1
RUN groupadd --gid 992 qgroupsvc && useradd --uid 994 --gid 992 --no-create-home --shell /usr/sbin/nologin qgroupsvc
# Same sole third-party dependency as the pinned original Dockerfile.
RUN pip install --no-cache-dir --disable-pip-version-check "websockets==17.4"
WORKDIR /app
COPY original-python/ ./original-python/
COPY retained-source.json ./retained-source.json
COPY original-Dockerfile ./original-Dockerfile
COPY retained-python-fixture.py ./retained-python-fixture.py
RUN chmod -R a+rX /app/original-python
RUN python -c 'import json,os; s=json.load(open("retained-source.json")); assert s["pythonCommit"] == os.environ["QGROUP_PYTHON_COMMIT"]; assert s["verificationCommit"] == os.environ["QGROUP_VERIFICATION_COMMIT"]'
USER qgroupsvc
# Only the orchestrator starts original worker fixtures, through docker exec.
CMD ["python", "-c", "import signal,sys,time; signal.signal(signal.SIGTERM,lambda *_:sys.exit(0)); time.sleep(600)"]

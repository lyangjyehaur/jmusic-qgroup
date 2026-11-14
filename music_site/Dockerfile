FROM python:3.11-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
COPY music_site/ ./music_site/
USER 994:992
CMD ["python3", "-m", "music_site.service"]

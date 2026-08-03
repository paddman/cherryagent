FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN groupadd --system cherry \
    && useradd --system --gid cherry --home-dir /app --shell /usr/sbin/nologin cherry

WORKDIR /app
COPY pyproject.toml ./
COPY app ./app
RUN pip install --no-cache-dir . \
    && chown -R cherry:cherry /app

USER cherry
EXPOSE 8790
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8790"]

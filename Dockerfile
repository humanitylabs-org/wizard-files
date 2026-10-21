FROM python:3.12-alpine@sha256:1b668429b3511ab407d8e00648891631b0b1a4d7e15e3ca70f38ab5b91ad4ab4
COPY requirements.lock /app/requirements.lock
RUN apk add --no-cache ffmpeg && pip install --no-cache-dir --require-hashes --only-binary=:all: -r /app/requirements.lock
ARG REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/humanitylabs-org/wizard-files" org.opencontainers.image.revision=$REVISION
WORKDIR /app
COPY server.py provenance.py thumbnails.py thumbnail_worker.py media-gallery.js index.html app.js my-files.js styles.css my-files.css restyle.css integration.css icon.png ./
USER 1000:1000
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health')"
CMD ["python", "-B", "server.py"]

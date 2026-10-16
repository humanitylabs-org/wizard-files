FROM python:3.12-alpine
RUN apk add --no-cache ffmpeg && pip install --no-cache-dir Pillow==11.3.0
ARG REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/humanitylabs-org/wizard-files" org.opencontainers.image.revision=$REVISION
WORKDIR /app
COPY server.py provenance.py thumbnails.py thumbnail_worker.py media-gallery.js index.html app.js my-files.js styles.css my-files.css restyle.css integration.css icon.png ./
USER 1000:1000
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health')"
CMD ["python", "-B", "server.py"]

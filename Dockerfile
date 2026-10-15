FROM python:3.12-alpine
ARG REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/humanitylabs-org/wizard-files" org.opencontainers.image.revision=$REVISION
WORKDIR /app
COPY server.py index.html app.js my-files.js styles.css my-files.css restyle.css integration.css icon.png ./
USER 1000:1000
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health')"
CMD ["python", "-B", "server.py"]

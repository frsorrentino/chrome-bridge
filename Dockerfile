# Glama/registry introspection build — avvia il server MCP in stdio.
# Senza estensione collegata i tool browser rispondono "extension not connected",
# ma initialize/tools/list funzionano: è ciò che i check di Glama verificano.
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server/ ./server/
# --caps all: i registry enumerano i tool via tools/list; col default
# caps=core pubblicavano 30 tool contro i 59 dichiarati.
CMD ["node", "server/index.js", "--caps", "all"]

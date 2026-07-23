# Glama/registry introspection build — avvia il server MCP in stdio.
# Senza estensione collegata i tool browser rispondono "extension not connected",
# ma initialize/tools/list funzionano: è ciò che i check di Glama verificano.
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server/ ./server/
CMD ["node", "server/index.js"]

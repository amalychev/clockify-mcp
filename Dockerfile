FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production MCP_TRANSPORT=http PORT=8080
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/dist ./dist
# Served at / by the HTTP transport, together with its icons and preview image.
COPY landing.html ./landing.html
COPY assets ./assets
EXPOSE 8080
USER node
CMD ["node", "dist/index.js"]

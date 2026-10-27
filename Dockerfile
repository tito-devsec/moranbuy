FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
COPY services ./services
RUN npm ci --omit=dev --no-audit --no-fund
COPY apps ./apps
COPY database ./database
COPY scripts ./scripts
ENV NODE_ENV=production
EXPOSE 4000
CMD ["node", "services/api/src/server.js"]

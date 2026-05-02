FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY public ./public

ENV NODE_ENV=production
EXPOSE 4100

CMD ["node", "src/server.js"]

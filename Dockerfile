FROM node:22-slim
WORKDIR /app
# OG card text renders from the bundled fonts/ TTFs (fonts/*.ttf) — no OS fonts needed.
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]

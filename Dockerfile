FROM node:22-slim
WORKDIR /app
# DejaVu fonts for server-side OG card text rendering (@resvg/resvg-js)
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]

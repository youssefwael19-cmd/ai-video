FROM node:20-bookworm-slim

WORKDIR /app

# Dependencies first so a source edit does not reinstall or re-download ffmpeg.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 3000

CMD ["npm", "start"]

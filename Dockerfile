FROM node:22-alpine

WORKDIR /app

# copia tutto il sistema licenze
COPY backend/ ./backend/
COPY dashboard/ ./dashboard/

RUN mkdir -p /data

ENV PORT=4000

EXPOSE 4000

CMD ["node", "--experimental-sqlite", "backend/server.js"]

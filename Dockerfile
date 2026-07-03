FROM node:22-alpine

WORKDIR /app

# copia tutto il sistema licenze
COPY backend/ ./backend/
COPY dashboard/ ./dashboard/

RUN mkdir -p /data

ENV PORT=4000
# il DB vive sul volume persistente montato in /data (sopravvive ai deploy)
ENV DB_PATH=/data/licenses.db

EXPOSE 4000

CMD ["node", "--experimental-sqlite", "backend/server.js"]

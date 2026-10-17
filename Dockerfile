FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production PORT=4000 MUSIC_DIR=/music
WORKDIR /app
COPY --from=build /app/server ./server
COPY --from=build /app/dist ./dist
EXPOSE 4000
VOLUME ["/music"]
CMD ["node", "server/index.js"]
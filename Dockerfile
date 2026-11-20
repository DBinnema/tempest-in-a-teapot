FROM node:22-slim
WORKDIR /app
COPY package*.json ./
# devDependencies are needed to build (TypeScript, Vite, Phaser).
RUN npm ci --include=dev
COPY . .
# Public Discord application ID, baked into the client bundle at build time.
# Paste yours here (it is not a secret) or pass --build-arg.
ARG VITE_DISCORD_CLIENT_ID=
ENV VITE_DISCORD_CLIENT_ID=$VITE_DISCORD_CLIENT_ID
RUN npm run build
ENV NODE_ENV=production
# Cloud Run sets PORT (8080).
CMD ["npm", "start"]

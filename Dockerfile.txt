# Färdig Playwright-bild med Chromium och alla OS-beroenden
FROM mcr.microsoft.com/playwright:v1.47.2-jammy

WORKDIR /app

# Installera npm-paket
COPY package*.json ./
RUN npm ci --omit=dev

# Kopiera appens källkod
COPY . .

# Render exponerar PORT som env-variabel. Vår server läser process.env.PORT.
ENV PORT=3000
EXPOSE 3000

# Starta servern
CMD ["npm", "start"]

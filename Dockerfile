# Färdig Playwright-bild med Chromium och alla OS-beroenden
FROM mcr.microsoft.com/playwright:v1.47.2-jammy

WORKDIR /app

# Installera npm-paket (utan att kräva package-lock.json)
COPY package*.json ./
RUN npm install --omit=dev

# Kopiera appens källkod
COPY . .

# Render sätter PORT i env; Express läser process.env.PORT
ENV PORT=3000
EXPOSE 3000

# Starta servern
CMD ["npm", "start"]

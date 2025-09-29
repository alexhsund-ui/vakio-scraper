# Matcha exakt samma Playwright-version som i package.json
FROM mcr.microsoft.com/playwright:v1.55.1-jammy

WORKDIR /app

# Installera npm-paket
COPY package*.json ./
RUN npm install --omit=dev

# Kopiera appens källkod
COPY . .

# Render sätter PORT som env; Express läser process.env.PORT
ENV PORT=3000
EXPOSE 3000

# Kör Node direkt (undviker npm:s SIGTERM-logg)
CMD ["node", "server.js"]

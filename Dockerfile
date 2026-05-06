FROM node:20-slim

# Herramientas necesarias para compilar dependencias nativas de Baileys
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    gcc \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY wa_sender_bot.js ./

# Carpeta de sesión
RUN mkdir -p /app/wa_session

CMD ["node", "wa_sender_bot.js"]

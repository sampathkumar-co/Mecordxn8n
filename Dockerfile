FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --omit=dev \
    && rm -rf /usr/local/lib/node_modules/npm \
              /usr/local/lib/node_modules/corepack \
              /opt/yarn-v1.22.22 \
    && rm -f /usr/local/bin/npm \
              /usr/local/bin/npx \
              /usr/local/bin/corepack \
              /usr/local/bin/yarn \
              /usr/local/bin/yarnpkg

COPY src ./src
COPY db ./db
COPY scripts ./scripts
COPY web ./web

RUN chown -R node:node /app
USER node

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "src/server.js"]

# Debian slim (not Alpine) so Playwright's Chromium + its system libraries install
# cleanly — the media-kit PDF/PNG export renders our own pages with headless Chromium,
# and Alpine lacks the glibc/deps Chromium needs.
FROM node:20-bookworm-slim

WORKDIR /app

# Keep build and runtime browser locations identical so render.js finds Chromium.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV NODE_ENV=production

COPY package*.json ./
RUN npm install --omit=dev

# Install the Chromium binary + OS deps. Non-fatal: if it fails the app still boots
# and only /api/export degrades to 503 (graceful, by design).
RUN npx playwright install --with-deps chromium || echo "WARN: Chromium install failed — /api/export will return 503"

COPY . .

RUN mkdir -p uploads

EXPOSE 5000

CMD ["node", "server/index.js"]

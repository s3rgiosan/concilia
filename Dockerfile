FROM node:22-alpine AS client-builder
COPY client/ /client/
RUN cd /client && npm ci && npm run build

FROM node:22-alpine

# poppler-utils: pdftotext (text extraction) and pdftoppm (image conversion)
RUN apk add --no-cache poppler-utils

# Install bank statement parsers
COPY parsers/ /parsers/
RUN cd /parsers && npm install --production

# Install worker scripts
COPY worker/ /worker/
RUN cd /worker && npm install --production

# Install server and copy built client
COPY server/ /server/
COPY --from=client-builder /client/dist /server/public
RUN apk add --no-cache python3 make g++ && cd /server && npm install --production && apk del python3 make g++

WORKDIR /server

# Run as non-root — node user is built into node:22-alpine
# /data created here so Docker initializes the named volume with node ownership on first mount
RUN mkdir -p /data && chown -R node:node /server /data
USER node

EXPOSE 3000
CMD ["node", "index.mjs"]

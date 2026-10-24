ARG NUSQLITE3_DIR="/usr/local/lib/nusqlite3"
ARG NUSQLITE3_PATH="${NUSQLITE3_DIR}/libnusqlite3.so"

### STAGE 0: Build client ###
FROM node:24-alpine AS build-client

WORKDIR /client
COPY /client /client
RUN npm ci && npm cache clean --force
RUN npm run generate

### STAGE 1: Compile server on the builder CPU (avoid QEMU SIGILL from tsc on arm64) ###
FROM --platform=$BUILDPLATFORM node:24-alpine AS compile-server

WORKDIR /server
COPY index.js package* tsconfig.server.json /server
COPY /server /server/server
RUN npm ci --include=dev --ignore-scripts && npm run build:server

### STAGE 2: Install native server deps for the target arch ###
FROM node:24-alpine AS build-server

ARG NUSQLITE3_DIR
ARG TARGETPLATFORM

ENV NODE_ENV=production

RUN apk add --no-cache --update \
  curl \
  make \
  python3 \
  g++ \
  unzip

WORKDIR /server
COPY index.js package* /server
COPY /server /server/server
COPY --from=compile-server /server/dist-server /server/dist-server

RUN case "$TARGETPLATFORM" in \
  "linux/amd64") \
  curl -L -o /tmp/library.zip "https://github.com/mikiher/nunicode-sqlite/releases/download/v1.2/libnusqlite3-linux-musl-x64.zip" ;; \
  "linux/arm64") \
  curl -L -o /tmp/library.zip "https://github.com/mikiher/nunicode-sqlite/releases/download/v1.2/libnusqlite3-linux-musl-arm64.zip" ;; \
  *) echo "Unsupported platform: $TARGETPLATFORM" && exit 1 ;; \
  esac && \
  unzip /tmp/library.zip -d $NUSQLITE3_DIR && \
  rm /tmp/library.zip

RUN npm ci --omit=dev

### STAGE 2b: PostgreSQL 14 client. Alpine ships only newer majors, and backups must restore on the production server (14). ###
FROM node:24-alpine AS pg-client

ARG PG_VERSION=14.23
ARG PG_SHA256=cc7216822b546330e29c2f91e123c8734a4c41795082145bb962aa712e8c94a5
RUN apk add --no-cache --virtual .pg-build build-base linux-headers openssl-dev zlib-dev perl bison flex \
  && wget -q -O /tmp/postgresql.tar.bz2 "https://ftp.postgresql.org/pub/source/v${PG_VERSION}/postgresql-${PG_VERSION}.tar.bz2" \
  && echo "${PG_SHA256}  /tmp/postgresql.tar.bz2" | sha256sum -c - \
  && tar -xjf /tmp/postgresql.tar.bz2 -C /tmp \
  && cd /tmp/postgresql-${PG_VERSION} \
  && ./configure --prefix=/opt/pg14 --with-openssl --without-readline --without-icu --without-ldap --without-gssapi --without-libxml --without-zstd --without-lz4 \
  && make -j"$(nproc)" world-bin \
  && make install-world-bin \
  && cd / && rm -rf /tmp/postgresql-${PG_VERSION} /tmp/postgresql.tar.bz2 \
  && apk del .pg-build

### STAGE 3: Create minimal runtime image ###
FROM node:24-alpine

ARG NUSQLITE3_DIR
ARG NUSQLITE3_PATH

# Install only runtime dependencies
RUN apk add --no-cache --update \
  tzdata \
  ffmpeg \
  libssl3 \
  zlib \
  tini

WORKDIR /app

# Copy compiled frontend and server from build stages
COPY --from=build-client /client/dist /app/client/dist
COPY --from=build-server /server /app
COPY --from=build-server ${NUSQLITE3_PATH} ${NUSQLITE3_PATH}
COPY --from=pg-client /opt/pg14 /opt/pg14

EXPOSE 80

ENV PORT=80
ENV NODE_ENV=production
ENV PG_BIN_DIR=/opt/pg14/bin
ENV CONFIG_PATH="/config"
ENV METADATA_PATH="/metadata"
ENV SOURCE="docker"
ENV NUSQLITE3_DIR=${NUSQLITE3_DIR}
ENV NUSQLITE3_PATH=${NUSQLITE3_PATH}

ENTRYPOINT ["tini", "--"]
CMD ["node", "dist-server/index.js"]

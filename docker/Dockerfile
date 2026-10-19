ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-trixie-slim AS node

FROM debian:trixie-slim AS pi-pocket

COPY --from=node /usr/local/bin /usr/local/bin
COPY --from=node /usr/local/lib /usr/local/lib

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

WORKDIR /app
COPY package.json package-lock.json /app
RUN npm ci --omit=dev

#COPY . /app
COPY --parents bin/ docs/ src/ types/ web/ .

EXPOSE 8787
WORKDIR /workspace

RUN groupadd --system --gid 65532 nonroot \
 && useradd --system --uid 65532 --gid nonroot --no-create-home nonroot

RUN mkdir /home/nonroot && chown -R nonroot:nonroot /home/nonroot /workspace

USER 65532

RUN ["mkdir", "--parents", "/home/nonroot/.pi", "/home/nonroot/.pi-pocket"]
VOLUME "/home/nonroot/.pi"
VOLUME "/home/nonroot/.pi-pocket"
VOLUME "/workspace"

ENTRYPOINT ["node", "/app/bin/pi-pocket.js"]
CMD ["--access", "lan", "--cwd", "/workspace"]
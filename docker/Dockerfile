FROM debian:trixie-slim AS pi-pocket

ARG NODE_VERSION=24
COPY --from=node:${NODE_VERSION}-trixie-slim /usr/local/bin /usr/local/bin
COPY --from=node:${NODE_VERSION}-trixie-slim /usr/local/lib /usr/local/lib

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

RUN mkdir /home/nonroot && chown -R nonroot:nonroot /home/nonroot

USER 65532

RUN ["mkdir", "--parents", "/home/nonroot/.pi", "/home/nonroot/.pi-pocket"]
VOLUME "/home/nonroot/.pi"
VOLUME "/home/nonroot/.pi-pocket"
VOLUME "/workspace"

ENTRYPOINT ["node", "/app/bin/pi-pocket.js"]
CMD ["--access", "lan", "--cwd", "/workspace"]
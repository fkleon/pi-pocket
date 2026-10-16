FROM node:24 AS build

# Application and depenencies
WORKDIR /app
COPY package.json package-lock.json /app
RUN ["npm", "ci", "--omit=dev"]

#COPY --parents bin/ docs/ src/ web/ /app
COPY . /app

RUN ["mkdir", "--parents", "/home/nonroot/.pi", "/home/nonroot/.pi-pocket"]

FROM gcr.io/distroless/nodejs24-debian13:nonroot AS app

# Application and depenencies
#WORKDIR /app
#COPY package.json package-lock.json /app
#RUN ["npm", "ci", "--omit=dev"]

#COPY --parents bin/ docs/ src/ web/ /app
#COPY . /app
COPY --from=build /app /app

# App config
COPY --from=build --chown=nonroot /home/nonroot/.pi /home/nonroot/.pi
COPY --from=build --chown=nonroot /home/nonroot/.pi-pocket /home/nonroot/.pi-pocket
VOLUME "/home/nonroot/.pi"
VOLUME "/home/nonroot/.pi-pocket"

# Workspace
WORKDIR /workspace

EXPOSE 8787
ENV NODE_ENV=production

#ENTRYPOINT ["node", "/app/bin/pi-pocket.js"]
CMD ["/app/bin/pi-pocket.js", "--access", "lan", "--cwd", "/workspace"]

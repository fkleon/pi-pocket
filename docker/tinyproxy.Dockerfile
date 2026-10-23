FROM alpine:3.24
RUN apk add --no-cache tinyproxy curl
ENTRYPOINT ["tinyproxy", "-d", "-c", "/etc/tinyproxy/tinyproxy.conf"]

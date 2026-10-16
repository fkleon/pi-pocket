FROM alpine:3.24
RUN apk add --no-cache tinyproxy curl \
 && addgroup -g 10004 -S tinyproxy2 \
 && adduser -u 10004 -S -G tinyproxy2 -H -s /sbin/nologin tinyproxy2
USER 10004:10004
ENTRYPOINT ["tinyproxy", "-d", "-c", "/etc/tinyproxy/tinyproxy.conf"]

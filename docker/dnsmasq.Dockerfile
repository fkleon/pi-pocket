FROM alpine:3.24
RUN apk add --no-cache dnsmasq
#COPY dnsmasq.conf /etc/dnsmasq.conf
ENTRYPOINT ["dnsmasq", "--no-daemon", "--conf-file=/etc/dnsmasq.conf"]

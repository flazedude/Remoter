FROM golang:1.26-alpine AS build
WORKDIR /src
COPY native/go.mod native/go.sum ./
RUN go mod download
COPY native/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/remoter-relay ./cmd/remoter-relay

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/remoter-relay /remoter-relay
USER nonroot:nonroot
ENTRYPOINT ["/remoter-relay"]

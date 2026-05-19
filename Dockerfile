FROM node:22-alpine

WORKDIR /app
COPY package.json proxy.mjs ./
COPY config/default-models.json config/default-models.json
COPY public/ public/

ENV PORT=31415
ENV CONFIG_FILE=config/models.json

# Create config dir; models.json will be auto-seeded from default on first boot
RUN mkdir -p config

EXPOSE 31415

CMD ["node", "proxy.mjs"]

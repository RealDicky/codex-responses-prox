FROM node:22-alpine

WORKDIR /app
COPY package.json proxy.mjs ./

ENV PORT=31415
ENV UPSTREAM_BASE_URL=https://maas-coding-api.cn-huabei-1.xf-yun.com/v2
ENV UPSTREAM_API_KEY=""
ENV UPSTREAM_MODEL=""

EXPOSE 31415

CMD ["node", "proxy.mjs"]

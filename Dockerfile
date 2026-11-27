# HDS review server. Build: docker build -t hdf-review .
# Run:   docker run -p 8787:8787 -v hdf-reviews:/data --env-file deploy/review-server/hive.env hdf-review
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY cli ./cli
COPY src ./src
ENV PORT=8787 HDF_DATA=/data
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8787
USER node
CMD ["npx", "tsx", "cli/hdfstudio.ts", "review-server"]

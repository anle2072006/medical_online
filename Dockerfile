FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY common ./common
COPY services ./services
COPY frontend ./frontend
COPY scripts ./scripts
COPY docs/openapi ./docs/openapi
ENV NODE_ENV=production TZ=Asia/Ho_Chi_Minh
# Khong chay bang root: dung user "node" co san trong image
USER node

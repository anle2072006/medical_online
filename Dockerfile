FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY common ./common
COPY services ./services
COPY frontend ./frontend
ENV NODE_ENV=production TZ=Asia/Ho_Chi_Minh

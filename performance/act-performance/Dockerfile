FROM node:22-alpine
WORKDIR /
COPY package.json tsconfig.json ./
RUN apk add --no-cache curl
COPY src ./src
RUN npm install
CMD ["npm", "run", "serve"] 
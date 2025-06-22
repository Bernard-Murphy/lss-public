FROM node:18
RUN mkdir -p /usr/src/app
WORKDIR /usr/src/app
RUN pwd
COPY ./live-stream-server .

RUN apt-get update && \
      apt-get -y install sudo 
RUN apt-get update \
    && apt-get install -y wget gnupg \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
      --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

RUN npm install
ENV PORT=3000
ENV STREAM_KEY=''
ENV PEER_HOST='peer.carbonvalley.win'
ENV PEER_PORT=443
ENV FILE_HOST="https://carbonvalley.win"
ENV RECORD_STREAMS="true"
ENV REGION="us-east-1"
ENV STORJ_SECRET_ACCESS_ID=""
ENV STORJ_SECRET_ACCESS_KEY=""
ENV STORJ_ENDPOINT="https://gateway.storjshare.io"
ENV MONGO_USER=''
ENV MONGO_PASSWORD=''
ENV MONGO_HOST=''

WORKDIR /usr/src/app
EXPOSE 3000
CMD [ "node", "./index.js" ]
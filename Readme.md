# Live Stream Server

![Carbon Valley Logo](https://carbonvalley.win/icons/apple-touch-icon-152x152.png)

#### Server that handles live streams for Carbon Valley apps

Note: This was originally a private repo. Most commits are not public, though I can walk you through them if you are curious.

[Screenshot](https://f.feednana.com/files/10dc829b8b4a43858823c943de55dc7d.png)

[Screenshot](https://f.feednana.com/files/5f03d9a6f273448ea036071e28718541.png)

## How it Works

- Socket connection is initiated by app server, peerID provided
- Headless browser spawned, peer connection made to peerID
- Peer will provide media stream
- Viewers will make their own peer connection, stream will be served to these peers
- On disconnect or stream end, stream is saved and stored in s3 bucket
- If streaming over size (CLIP_SIZE) or length (CLIP_LENGTH) specified in .env, create a clip

## Clip process (Happens automatically)

- Emit 'clip' event to client
- Client opens up a new peer connection
- Client emits 'start-stream' event to pigger server
- Pigger server opens new socket connection (and puppeteer instance) with stream server
- Stream server opens new p2p connection with streamer
- Streamer closes old p2p connection with stream server
- Old puppeteer instance directs all viewers to the new puppeteer instance
- Old puppeteer instance terminated, stream clip saved and broadcast

## Running the App

- Set environment variables
- node app.js

* OR -

- Zip directory, start AWS EBS instance with zip file
- Add environment variables
- Launch the app

* OR -

- Fill in the blanks with provided Dockerfile
- Run as docker container

## Environment Variables

PORT: Number - Port that the app runs on

STREAM_KEY: String - Key that must be provided in socket query handshake by clients to start streams

PEER_HOST: String - Peer server host

PEER_PORT: Number - Peer server port

FILE_HOST: String - File server host

RECORD_STREAMS: String - Lowercase Boolean (ie. "true") - Whether streams are to be recorded

REGION: String - AWS Region

STORJ_SECRET_ACCESS_ID: String - Storj secret access id

STORJ_SECRET_ACCESS_KEY: String - Storj secret access key

MONGO_USER: String - Mongo DB user

MONGO_PASSWORD: String - Mongo DB password

MONGO_HOST: String - Mongo DB Host

WHITELIST_KEY: String - Key used to request that the server's host's ip is whitelisted on the MongoDB server

CLIP_SIZE: String - Size in MB of clips

CLIP_LENGTH: String - Length in seconds of clips

ENVIRONMENT (Optional): String - If 'dev', skips the IP whitelisting process

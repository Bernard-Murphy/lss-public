const http = require("http");
const ioServer = require("socket.io");
const puppeteer = require("puppeteer");
const mongodb = require("mongodb");
const AWS = require("aws-sdk");
const crypto = require("crypto");
const { dataUriToBuffer } = require("data-uri-to-buffer");
const axios = require("axios");

const clipSize = Number(process.env.CLIP_SIZE);
const clipLength = Number(process.env.CLIP_LENGTH);

// Mongo connection uri
const mongoUrl =
  process.env.MONGO_URL ||
  "mongodb+srv://" +
    process.env.MONGO_USER +
    ":" +
    encodeURIComponent(process.env.MONGO_PASSWORD) +
    "@" +
    process.env.MONGO_HOST +
    "/?retryWrites=true&w=majority";

// Initialize s3 connection
AWS.config.update({
  region: process.env.REGION,
});

const s3 = new AWS.S3({
  endpoint: process.env.STORJ_ENDPOINT,
  credentials: {
    accessKeyId: process.env.STORJ_SECRET_ACCESS_ID,
    secretAccessKey: process.env.STORJ_SECRET_ACCESS_KEY,
  },
});

/**
 *
 * @param {String} str - Any string
 * @returns That string converted into a buffer
 */
const stringToArrayBuffer = (str) => {
  const buf = new ArrayBuffer(str.length);
  let bufView = new Uint8Array(buf);
  for (let i = 0; i < str.length; i++) bufView[i] = str.charCodeAt(i);
  return buf;
};

/**
 *
 * @param {Object} socketQuery - Query object that the client (Instance server) used to make the socket connection
 * @param {String} filename - Filename of the stream
 * @param {String} chunkString - Livestream video as raw string
 * @param {String} type - Mimetype of the live stream - "video/webm" | "audio/webm"
 * @param {String} thumbnail - Video thumbnail as data uri
 *
 * If stream is a video stream, generate an md5 hash from the thumbnail to create the file name
 * Convert the thumbnail to a buffer
 * Upload thumbnail to s3 bucket
 * Upload stream to s3 bucket
 * Connect to instance database
 * Insert new emission for the stream
 * Ping instance server directly so that it can notify affected users via socket
 */
const saveStream = (
  socketQuery,
  filename,
  chunkString,
  type,
  thumbnail,
  clip,
  clipCount
) =>
  new Promise(async (resolve, reject) => {
    try {
      let md5Thumbnail;
      let thumbnailBuffer;
      const ContentType = type.split(";")[0];
      if (thumbnail) {
        md5Thumbnail = crypto.createHash("md5").update(thumbnail).digest("hex");
        thumbnailBuffer = dataUriToBuffer(thumbnail);

        if (!thumbnailBuffer.type.includes("text"))
          await s3
            .putObject({
              Body: thumbnailBuffer,
              Bucket: "f.filepimps.com",
              Key:
                socketQuery.instanceID + "/thumbnails/" + md5Thumbnail + ".png",
              ACL: "public-read",
              ContentType: "image/png",
            })
            .promise();
      }
      const Bucket = "f.filepimps.com";
      const Key =
        socketQuery.instanceID +
        (type.includes("video") ? "/videos/" : "/audio/") +
        filename;
      await s3
        .putObject({
          Body: Buffer.from(stringToArrayBuffer(chunkString)),
          Bucket,
          Key,
          ACL: "public-read",
          ContentType,
        })
        .promise();

      const fileData = await s3
        .headObject({
          Bucket,
          Key,
        })
        .promise();
      mongodb.MongoClient.connect(
        mongoUrl,
        { useUnifiedTopology: true },
        async (err, client) => {
          try {
            if (err) throw err;
            else {
              const db = client.db(socketQuery.database);
              await db.collection("files").insertOne({
                _id: crypto.randomBytes(8).toString("hex"),
                timestamp: new Date(),
                filename: "livestream." + filename.split(".")[1],
                encoding: ContentType,
                mimeType: ContentType,
                mimetype: ContentType,
                contentType: ContentType,
                md5: filename.split(".")[0],
                size: fileData.ContentLength,
                name: "livestream." + filename.split(".")[1],
                thumbnail:
                  socketQuery.instanceID +
                  "/thumbnails/" +
                  md5Thumbnail +
                  ".png",
                Key:
                  socketQuery.instanceID +
                  (type.includes("video") ? "/videos/" : "/audio/") +
                  filename,
                metadata: {
                  userID: socketQuery.userID,
                },
              });
              const Emissions = db.collection("emissions");
              const emissionText = `
                      Live Stream
                      ${socketQuery.streamTitle}
                  `;

              let emissionID = await db.collection("hrIDs").findOneAndUpdate(
                {},
                {
                  $inc: {
                    emissionID: 1,
                  },
                },
                {
                  returnDocument: "after",
                }
              );
              emissionID = emissionID.value.emissionID;
              const emission = {
                _id: crypto.randomBytes(8).toString("hex"),
                replyID: false,
                threadID: false,
                emissionID: emissionID,
                signalBoost: false,
                files: [
                  {
                    main: filename,
                    thumbnail: !thumbnailBuffer?.type?.includes("text")
                      ? md5Thumbnail + ".png"
                      : "speaker.svg",
                    type: type.includes("video") ? "video" : "audio",
                  },
                ],
                html: `
                          <h5 class="text-success">
                              <i class="fas fa-broadcast-tower me-2"></i>
                              Live Stream
                          </h5>
                          <h5>${socketQuery.streamTitle}${
                  clip || clipCount > 1 ? ` - Part ${clipCount}` : ""
                }</h5>
                      `,
                text: emissionText,
                pollData: false,
                userID: socketQuery.userID,
                username: socketQuery.username,
                timestamp: new Date(),
                likes: 0,
                signalBoosts: 0,
                remove: {
                  removed: false,
                  reason: false,
                  user: false,
                  details: false,
                },
                replies: 0,
                views: 0,
                tags: [],
                pinned: false,
                headers: socketQuery.headers,
                visibility: { flavor: "Public", viewers: [] },
              };
              await Emissions.insertOne(emission);
              await db.collection("searchBlobs").insertOne({
                _id: crypto.randomBytes(8).toString("hex"),
                type: "emission",
                emissionID: emissionID,
                emissionText: emissionText,
              });

              axios
                .post(process.env.SOCKET_SERVER + "/emissions/new-live", {
                  emissionID,
                  userID: socketQuery.userID,
                  instanceID: socketQuery.instanceID,
                  streamKey: process.env.STREAM_KEY,
                })
                .then(resolve)
                .catch((err) => {
                  console.log("Notification error", err);
                })
                .finally(() => client.close());
            }
          } catch (err) {
            console.log("Error inserting emission", err);
            reject();
          }
        }
      );
    } catch (err) {
      console.log("Error during stream save", err);
      reject();
    }
  });

/**
 * Initialize socket server
 * Stream starts up on connection after stream key is validated
 */

const port = process.env.PORT || 3000;

const server = http.createServer();
ioServer(server).on("connection", async (socket) => {
  // console.log("connection", socket.handshake.query);
  let browser;
  let page;
  let chunks = [];
  let streamViewers = [];
  try {
    if (
      socket.handshake &&
      socket.handshake.query &&
      process.env.STREAM_KEY === socket.handshake.query.key
    ) {
      socket.handshake.query.avatar = JSON.parse(socket.handshake.query.avatar);
      socket.handshake.query.headers = JSON.parse(
        socket.handshake.query.headers
      );
      if (socket.handshake.query.depth === "undefined")
        socket.handshake.query.depth = 1;

      const initialPeers = JSON.parse(socket.handshake.query.peers);
      let initialDepth = Number(socket.handshake.query.depth);
      const peerID = socket.handshake.query.peerID;
      const clipCount = Number(socket.handshake.query.clipCount) || 0;
      const html = `
            <!DOCTYPE html>
                <html lang="en">
                <head>
                    <meta charset="UTF-8">
                    <meta http-equiv="X-UA-Compatible" content="IE=edge">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Document</title>
                    <script>let exports = {};</script>
                    <script src="${process.env.FILE_HOST}/scripts/peerjs.newest.js"></script>
                    <script src="${process.env.FILE_HOST}/scripts/vs.js"></script>
                </head>
                <body>
                    <audio autoplay controls id="player"></audio>
                    <video name="video_download" id="video_download" autoplay controls></video>
                    <button id="start">button</button>
                    <button id="download">download</button>
                    <button id="terminate">terminate</button>
                </body>
                </html>
            `;

      /**
       * Launch puppeteer instance
       * Enable JavaScript
       * Launch new page with Peer and VideoSnapshot scripts
       */
      browser = await puppeteer.launch({
        args: ["--single-process", "--no-zygote", "--no-sandbox"],
      });

      page = await browser.newPage();
      await page.setJavaScriptEnabled(true);
      await page.setContent(html, {
        waitLoad: true,
        waitNetworkIdle: true,
      });

      await page.exposeFunction("setViewers", (viewers) => {
        socket.emit("viewers", Number(viewers));
      });

      /**
       * Passes environment and other outside variables into browser context
       */
      await page.exposeFunction("getEnv", (variable) => {
        switch (variable) {
          case "peerHost":
            return process.env.PEER_HOST;
          case "peerPort":
            return process.env.PEER_PORT;
          case "peerID":
            return peerID;
          case "recordStreams":
            return process.env.RECORD_STREAMS;
          case "clipSize":
            return clipSize;
          case "clipLength":
            return clipLength;
          case "childKey":
            return process.env.CHILD_KEY;
          case "clipCount":
            return clipCount;
          case "initialPeers":
            return initialPeers;
          case "initialDepth":
            return initialDepth;
          default:
            console.log("Oob env variable", variable);
            return "";
        }
      });

      /**
       * Forcibly closes the browser
       */
      await page.exposeFunction("killBrowser", () => {
        try {
          // console.log("kill");
          if (browser && browser.close) browser.close();
          socket.disconnect();
        } catch (err) {
          console.log("killBrowser error", err);
        }
      });

      /**
       * MediaRecorder chunk is passed from browser context into application context
       */
      await page.exposeFunction("handleChunk", (chunk) => {
        chunks.push(chunk);
      });

      await page.exposeFunction("setStreaming", (peerID) =>
        socket.emit("streaming", peerID)
      );

      /**
       * @param {String} type - Mimetype of the live stream - "video/webm" | "audio/webm"
       * @param {String} thumbnail - Video thumbnail as data uri
       *
       * Stream chunks are joined together as a single string
       * Md5 hash is generated from the stream - will be the file name of the stream
       * saveStream function continues to run after the user is disconnected and the browser is killed
       */
      await page.exposeFunction(
        "saveStream",
        async (type, thumbnail, clip, clipCount) => {
          try {
            if (chunks.length) {
              const extension = type
                .split("/")[1]
                .split(" ")[0]
                .split(";")[0]
                .toLowerCase();
              const chunkString = chunks.join("");
              const md5Stream = crypto
                .createHash("md5")
                .update(chunkString)
                .digest("hex");
              const filename = md5Stream + "." + extension;

              chunks = [];
              await saveStream(
                socket.handshake.query,
                filename,
                chunkString,
                type,
                thumbnail,
                clip,
                clipCount
              );
            }
            if (socket && socket.disconnect) socket.disconnect();
            if (browser && browser.close) browser.close();
          } catch (err) {
            console.log("An error occurred while saving the stream", err);
          }
        }
      );
      page.on("console", (message) => console.log(message.text()));

      await page.click("#start"); // Initializes the peer connection

      /**
       * This function will execute upon clicking the #start button
       */
      await page.evaluate(async () => {
        let closePeers;
        try {
          console.log("peer", window.Peer);
          let stream;
          let callConnection;
          let closeCall;
          let connection;
          let recorder;
          window.chunks = [];
          let peers = [];
          let type = "video/webm;codecs=vp8";
          let start = new Date();
          let end = new Date();
          const clipSize = await window.getEnv("clipSize");
          const clipLength = await window.getEnv("clipLength");
          const childKey = await window.getEnv("childKey");
          const initialPeers = await window.getEnv("initialPeers");
          let currentRoot = initialPeers[0];
          const bumpedPeers = [];
          let dummyTracks = {};
          let clipCount = await window.getEnv("clipCount");
          let clip = false;
          let limboConnections = [];
          let depth = await window.getEnv("initialDepth");

          closePeers = () => {
            if (connection && connection.close) connection.close();
            if (callConnection?.close) callConnection.close();
            if (closeCall) closeCall();
            peers = peers.filter((peer) => {
              // console.log("terminated, closing", peer.peer);
              peer.close();
              peer.connection.close();
              peer.peerConnection.close();
              return false;
            });
            window.killBrowser();
          };

          // Converts an ArrayBuffer to a UTF-8 String
          const arrayBufferToString = (buffer) => {
            const bufView = new Uint8Array(buffer);
            const length = bufView.length;
            let result = "";
            let addition = Math.pow(2, 8) - 1;

            for (let i = 0; i < length; i += addition) {
              if (i + addition > length) {
                addition = length - i;
              }
              result += String.fromCharCode.apply(
                null,
                bufView.subarray(i, i + addition)
              );
            }
            return result;
          };

          const stopRecording = () => {
            if (recorder && recorder.stop) {
              stopped = true;
              recorder.stop();
            } else {
              console.log("stop");
              closePeers();
            }
          };

          // When #download button is clicked, stop the media recorder
          document
            .getElementById("download")
            .addEventListener("click", stopRecording);
          document.getElementById("terminate").addEventListener("click", () => {
            console.log("terminate");
            closePeers();
          });

          const peerHost = await window.getEnv("peerHost");
          const peerPort = await window.getEnv("peerPort");
          const peerID = await window.getEnv("peerID");
          const recordStreams = await window.getEnv("recordStreams");

          const peer = new window.Peer(undefined, {
            host: peerHost,
            port: peerPort,
            secure: Number(peerPort) === 443,
          });

          const contactInitialPeers = () =>
            initialPeers.forEach((peerID) => {
              peer.connect(peerID, {
                metadata: {
                  childKey,
                },
              });
            });

          /**
           * When peer server connection established, make p2p connection with the streamaer
           */
          peer.on("open", async () => {
            try {
              // console.log("peer open", peerID);
              connection = peer.connect(peerID);
              connection.on("data", (data) => {
                try {
                  // console.log("data", JSON.stringify(data));
                  if (data.event === "device-change") {
                    console.log("device change");
                    peers.forEach((peer) =>
                      peer.connection.send({
                        ...data,
                        event: "device-change",
                      })
                    );
                  }
                } catch (err) {
                  console.log(`Data error: ${err}`);
                }
              });
              contactInitialPeers();
            } catch (err) {
              console.log("open error", String(err));
              closePeers();
            }
          });

          /**
           * When p2p connection is made with the streamer, the streamer, will call the server with their MediaStream
           */
          peer.on("call", (call) => {
            closeCall = call.close;
            callConnection = call.peerConnection;
            metadata = call.metadata;
            if (call.peer === peerID) {
              /**
               * Caller is the streamer
               * Answer with nothing
               */
              call.answer();

              /**
               *
               * @param {MediaStream} track - The streamer's media stream
               *
               */
              call.peerConnection.ontrack = async (track) => {
                try {
                  if (!stream) {
                    stream = new MediaStream(track.streams[0]);
                    document.getElementById("player").srcObject = stream;
                    document.getElementById("player").play();
                  } else {
                    stream.addTrack(track.track);
                    limboConnections.forEach(processConnection);

                    await window.setStreaming(peer._id);
                    if (recordStreams === "true" && !recorder) {
                      try {
                        // console.log("record");
                        start = new Date();
                        recorder = new MediaRecorder(stream);
                        recorder.ondataavailable = async (e) => {
                          /**
                           * Store MediaRecorder chunks in browser window
                           */
                          try {
                            if (e.data.size) {
                              if (
                                !type ||
                                (type.includes("audio") &&
                                  e.data.type.includes("video"))
                              )
                                type = e.data.type;
                              window.chunks.push(e);
                              if (recorder.state === "inactive") return;
                              if (
                                !clip &&
                                (window.chunks.reduce(
                                  (prev, curr) => prev + curr.data.size,
                                  0
                                ) /
                                  (1024 * 1024) >
                                  clipSize ||
                                  (new Date().getTime() - start.getTime()) /
                                    1000 >=
                                    clipLength)
                              ) {
                                // console.log("clip");
                                clip = true;
                                connection.send({
                                  event: "clip",
                                  depth,
                                });
                              }
                            }
                          } catch (err) {
                            console.log("chunk error", String(err));
                          }
                        };

                        /**
                         * Calculate duration of stream in seconds
                         * Take VideoSnapshot (thumbnail) at the midway point
                         */
                        recorder.onstop = async () => {
                          end = new Date();
                          const secondsElapsed =
                            (end.getTime() - start.getTime()) / 1000;
                          console.log(
                            secondsElapsed,
                            "seconds elapsed",
                            window.chunks.length,
                            "chunks",
                            clipCount,
                            "clip(s)",
                            depth,
                            "depth"
                          );
                          try {
                            for (let c = 0; c < chunks.length; c++) {
                              try {
                                const chunk = chunks[c];
                                const buffer = await chunk.data.arrayBuffer();
                                const data = arrayBufferToString(buffer);
                                window.handleChunk(data);
                              } catch (err) {
                                console.log("chunk error", String(err));
                              }
                            }
                            let thumbnail = "";
                            try {
                              if (type.includes("video"))
                                thumbnail = await new VideoSnapshot(
                                  new File(
                                    [
                                      new Blob(
                                        chunks.map((chunk) => chunk.data),
                                        { type }
                                      ),
                                    ],
                                    "file." +
                                      type
                                        .split("/")[1]
                                        .split(" ")[0]
                                        .split(";")[0]
                                        .toLowerCase(),
                                    {
                                      lastModified: new Date().getTime(),
                                      type,
                                    }
                                  )
                                ).takeSnapshot(secondsElapsed / 2);
                            } catch (err) {
                              console.log("thumbnail error", err);
                            }
                            window.saveStream(type, thumbnail, clip, clipCount);
                            if (clip) clip = false;
                          } catch (err) {
                            console.log("stop error", String(err));
                            closePeers();
                          }
                        };
                        recorder.start(100);
                      } catch (err) {
                        console.log("Recorder error", String(err));
                        closePeers();
                      }
                    }
                  }
                } catch (err) {
                  console.log("track error", String(err));
                }
              };
            }
          });

          const processConnection = (connection) =>
            setTimeout(async () => {
              try {
                // console.log(
                //   "currentRoot",
                //   currentRoot,
                //   "peer",
                //   connection.peer,
                //   "viewers",
                //   connection.metadata?.viewers
                // );
                if (connection.metadata?.viewers)
                  await window.setViewers(Number(connection.metadata.viewers));
                // When main receives connection, direct child to new connector, depth++

                if (bumpedPeers.indexOf(connection.peer) > -1) {
                  // console.log("Old root");
                  return connection.close();
                }

                if (connection.peer !== currentRoot) {
                  depth++;
                  if (currentRoot) {
                    bumpedPeers.push(currentRoot);
                    // console.log("to bump");
                    connection.send({
                      childKey,
                      bump: currentRoot,
                      depth,
                    });
                    peers = peers.filter((peer) => {
                      // console.log("disconnected, closing", peer.peer);
                      peer.close();
                      peer.connection.close();
                      peer.peerConnection.close();
                      return false;
                    });
                  }
                  currentRoot = connection.peer;
                }

                connection.on("data", async (data) => {
                  try {
                    // console.log("data", JSON.stringify(data));
                    if (data.event === "viewers") {
                      await window.setViewers(Number(data.viewers));
                    }
                  } catch (err) {
                    console.log("Set RTC session error", String(err));
                  }
                });
                // console.log(
                //   "calling",
                //   connection.peer,
                //   stream.getTracks().length
                // );
                const call = peer.call(connection.peer, stream, {
                  metadata,
                });
                call.peerConnection.oniceconnectionstatechange = () => {
                  if (
                    ["failed", "disconnected"].indexOf(
                      call.peerConnection.iceConnectionState
                    ) > -1
                  ) {
                    peers = peers.filter((peer) => {
                      if (peer.peer === connection.peer) {
                        console.log("disconnected, closing", peer.peer);
                        peer.close();
                        peer.connection.close();
                        peer.peerConnection.close();
                        return false;
                      }

                      return true;
                    });
                  }
                };
                peers.push({
                  peer: connection.peer,
                  connection: connection,
                  peerConnection: call.peerConnection,
                  close: call.close,
                });
              } catch (err) {
                console.log("processConnection error", String(err));
              }
            }, 100);

          /**
           * When viewers initiate p2p connection with the server, call peers with new stream
           */
          peer.on("connection", async (connection) => {
            try {
              // Connection initiating before stream
              // console.log(
              //   "connection",
              //   connection.peer,
              //   JSON.stringify(connection.metadata)
              // );
              if (connection.metadata?.childKey !== childKey)
                connection.close();
              else {
                if (stream) processConnection(connection);
                else limboConnections.push(connection);
              }
            } catch (err) {
              console.log("Connection error", String(err));
            }
          });
        } catch (err) {
          console.log("error starting the stream", String(err));
          if (closePeers) closePeers();
        }
      });

      /**
       * Save the stream even when unexpected disconnect occurs.
       */
      const disconnect = async () => {
        try {
          console.log("disconnecting", new Date());
          if (process.env.RECORD_STREAMS === "true") {
            if (page && page.click) await page.click("#download");
            else
              console.log(
                "An error occurred while saving the stream - headless browser unexpectedly closed."
              );
          } else if (page && page.click) await page.click("#terminate");
          else {
            if (browser && browser.close) await browser.close();
          }
        } catch (err) {
          try {
            if (browser && browser.close) await browser.close();
          } catch (err) {
            console.log("Browser close error", err);
          }
        }
      };

      socket.on("disconnecting", disconnect);
    }
  } catch (err) {
    console.log("connection error", err);
  }
});

server.listen(port, () => {
  console.log(`Live stream server running on port ${port}`);
  console.log("socket host", process.env.SOCKET_SERVER);
});

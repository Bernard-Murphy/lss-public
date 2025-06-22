git -C live-stream-server pull
CONTAINERID=$(docker ps -aqf "name=^live-stream-server$")
docker stop "${CONTAINERID}"
docker container rm "${CONTAINERID}"
IMAGEID=$(docker images -aqf "reference=^live-stream-server$")
docker rmi -f "${IMAGEID}"
docker system prune -f
docker build --no-cache -t live-stream-server .
docker run --name live-stream-server -p 3000:3000 -d live-stream-server:latest
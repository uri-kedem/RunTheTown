#!/bin/bash
# Double-click to run RunTheTown locally at http://localhost:8080
cd "$(dirname "$0")"
PORT=8080
echo "RunTheTown is running at http://localhost:$PORT  (close this window to stop)"
(sleep 1; open "http://localhost:$PORT") &
python3 -m http.server $PORT

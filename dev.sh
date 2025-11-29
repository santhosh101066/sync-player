#!/bin/bash

# Start Server
echo "Starting Server..."
npx ts-node server.ts &
SERVER_PID=$!

# Start Client
echo "Starting Client..."
cd client
npm run dev &
CLIENT_PID=$!

# Handle shutdown
trap "kill $SERVER_PID $CLIENT_PID; exit" SIGINT

wait

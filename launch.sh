#!/usr/bin/env bash
while true; do
  npm start
  echo "Script exited with code $?, restarting in 5 seconds..."
  sleep 5
done

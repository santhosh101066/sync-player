#!/bin/bash

# --- Setup Paths ---
# Use BASH_SOURCE to get the directory of the current script, 
# then find the root directory of the entire project.
SCRIPT_DIR=$(dirname "${BASH_SOURCE[0]}")
PROJECT_ROOT=$(cd "$SCRIPT_DIR" && pwd)
CLIENT_DIR="$PROJECT_ROOT/../syncplayer-ui"
DIST_DIR="$CLIENT_DIR/dist"
PUBLIC_DIR="$PROJECT_ROOT/public"

echo "Building Client..."

# 1. Navigate to the client directory and run the build command.
cd "$CLIENT_DIR"
npm run build || { echo "Client build failed. Exiting."; exit 1; }
cd "$PROJECT_ROOT" # Navigate back to the script's original location

echo "Deploying to public..."

# 2. Clean and create the public directory
rm -rf "$PUBLIC_DIR"
mkdir "$PUBLIC_DIR"

# 3. Check if the dist directory exists before copying
if [ -d "$DIST_DIR" ]; then
    # Use the absolute path for copying
    cp -r "$DIST_DIR"/* "$PUBLIC_DIR"/
else
    echo "ERROR: Client build completed but '$DIST_DIR' was not found."
    exit 1
fi

echo "Build Complete. Files are in 'public/'."
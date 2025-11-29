#!/bin/bash

echo "Building Client..."
cd client
npm run build
cd ..

echo "Deploying to public..."
rm -rf public
mkdir public
cp -r client/dist/* public/

echo "Build Complete. Files are in 'public/'."

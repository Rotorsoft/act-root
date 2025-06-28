#!/bin/sh

find . -type d \
  \( -name node_modules \
  -o -name dist \
  -o -name .turbo \
  -o -name coverage \
  -o -name .next \
  -o -name .out \
  -o -name .cache \
  -o -name build \
  -o -name .build \
  \) -prune -exec rm -rf {} + 
#!/bin/bash
# Railway entry point
export PYTHONPATH=$PYTHONPATH:.
uvicorn backend.app.main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers --forwarded-allow-ips "*"

FROM python:3.10-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    gcc \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy backend requirements
COPY backend/requirements.txt .

# Install python dependencies
RUN pip install --upgrade pip && pip install --no-cache-dir -r requirements.txt && pip install email-validator

# Copy backend code to root of workdir
COPY backend/ .

# Copy frontend to /app/frontend
COPY frontend/ /app/frontend

# Set PYTHONPATH to /app so 'app.main' is found
ENV PYTHONPATH=/app

# Expose port
EXPOSE 8000

# Command to run the application
CMD uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers --forwarded-allow-ips "*"

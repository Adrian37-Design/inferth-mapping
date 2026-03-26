# Oracle Cloud Migration Guide: Inferth Mapping

This guide helps you move the entire platform from Railway to your own "Free Forever" Oracle Cloud VPS.

## 1. Oracle Cloud Setup (OCI Console)

1.  **Create Instance**:
    - Image: **Ubuntu 22.04** (Canonical).
    - Shape: **VM.Standard.A1.Flex** (4 OCPUs, 24 GB RAM) — this is the "Always Free" ARM shape.
    - Networking: Create a new VCN and Public Subnet.
    - **SSH Keys**: Download your Private Key (you'll need it to log in).
2.  **Configure VCN Security List (Firewall)**:
    - Go to your VCN -> Security Lists -> Default Security List.
    - Add **Ingress Rules**:
        - **Port 80/443**: Type TCP, Source `0.0.0.0/0` (For the website).
        - **Port 9005**: Type TCP, Source `0.0.0.0/0` (For the GPS Trackers).
        - **Port 22**: Type TCP (For your SSH access).

## 2. Server Preparation (SSH)

Connect to your server:
```bash
ssh -i /path/to/your/private_key.key ubuntu@YOUR_ORACLE_IP
```

Install Docker & Compose:
```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y docker.io docker-compose
sudo usermod -aG docker ubuntu
# Log out and log back in to apply group changes
```

## 3. Deployment

1.  **Clone the Repository**:
    ```bash
    git clone https://github.com/YOUR_USERNAME/Inferth-Mapping.git
    cd Inferth-Mapping
    ```
2.  **Configure Environment**:
    Create `.env` in the `backend` folder:
    ```bash
    cp backend/.env.example backend/.env 
    # OR manually edit it. Ensure DATABASE_URL uses host 'db' (the docker service)
    ```
3.  **Start Services**:
    ```bash
    sudo docker-compose up -d --build
    ```

## 4. Database Migration (from Railway)

1.  **Export from Railway**:
    Use `pg_dump` (from your local machine or a temporary server):
    ```bash
    pg_dump -h YOUR_RAILWAY_DB_HOST -U postgres -d inferth > backup.sql
    ```
2.  **Import to Oracle**:
    Copy `backup.sql` to the Oracle VPS, then:
    ```bash
    cat backup.sql | docker exec -i inferth-db psql -U postgres -d inferth
    ```

## 5. Domain & SSL

Update your DNS (A record) to point `inferth-mapping.up.railway.app` (or your custom domain) to the **YOUR_ORACLE_IP**.

> [!TIP]
> Once the app is running, I recommend setting up **Certbot**/Nginx on the host or adding an Nginx container to `docker-compose.yml` for automatic HTTPS.
